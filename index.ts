/**
 * opencode-indexing — OpenCode plugin entry point (server side).
 *
 * Exposes:
 *   indexing_search, indexing_status, indexing_refresh, indexing_build, indexing_import
 *   RPC methods (settings/status/index) consumed by the TUI plugin.
 *   A skill teaching when to use semantic search vs grep/read.
 *
 * Only TYPE imports from @opencode/plugin are used: the plugin has no runtime
 * dependency beyond Node/Bun built-ins and optional packages (ignore, lancedb,
 * tree-sitter wasm).
 */
import type { Plugin } from "@opencode/plugin"

import { resolveSettings, type PluginOptionsInput } from "./src/config.ts"
import { maskSecret, settingsFilePath } from "./src/settings.ts"
import { createPluginStorage } from "./src/storage.ts"
import { createTools, type ToolDefinition } from "./src/tools.ts"
import { runIndex } from "./src/indexer.ts"
import { getStatus } from "./src/status.ts"
import { discoverKiloSources, importFromKilo } from "./src/import.ts"
import { createOwnStore, createSettingsQdrant } from "./src/store-factory.ts"
import { createEmbedder } from "./src/embedder.ts"
import { IndexingRpc } from "./src/rpc.ts"
import {
  COMMAND_USAGE,
  applySettingValue,
  describeSettingValue,
  parseIndexingCommand,
} from "./src/settings-commands.ts"
import type { IndexingSettings, KVStore } from "./src/types.ts"

const SKILL_CONTENT = `# Semantic code search (opencode-indexing)

The \`indexing_search\` tool searches the project's semantic code index: chunks of
code embedded by meaning, combining a Kilo Code index (when present) with this
plugin's own incremental index (Qdrant or LanceDB backend).

## When to use indexing_search

- Open-ended exploration when you know the intent but not the identifiers:
  "user login and password hashing", "database connection pooling", "retry logic".
- Finding conceptually similar implementations across the codebase.
- Locating code whose names you do not know.

## When NOT to use it (use other tools instead)

- Exact symbol or string: use Grep.
- Filenames or extensions: use Glob.
- Reading a known file: use Read.
- Verifying whether code exists that must be fresh: the index may lag behind
  recent edits; check \`indexing_status\` (freshness) or use Grep for certainty.

## Freshness

If \`indexing_status\` reports new/changed/deleted files, run \`indexing_refresh\`
before trusting results for recently edited code. Empty search results are not
proof the code does not exist.

## Setup (only when explicitly asked)

- \`indexing_build\` creates the index; when a Kilo Code index exists it can be
  imported without embedding costs (controlled by the "import from Kilo" toggle
  in \`/indexing\`).
- The \`/indexing\` command opens the settings menu (backend, Qdrant URL, API
  keys, import toggle).
`

function settingsView(settings: IndexingSettings, homeDir?: string): Record<string, unknown> {
  return {
    vectorStore: settings.vectorStore,
    qdrantUrl: settings.qdrantUrl,
    qdrantApiKey: maskSecret(settings.qdrantApiKey) ?? "",
    lancedbDirectory: settings.lancedbDirectory,
    provider: settings.provider,
    model: settings.modelId,
    dimension: settings.dimension,
    importFromKilo: settings.importFromKilo,
    autoRefresh: settings.autoRefresh,
    enabled: settings.enabled,
    searchMaxResults: settings.searchMaxResults,
    hasMistralKey: Boolean(settings.credentials.mistralApiKey),
    hasOpenAiKey: Boolean(settings.credentials.openAiApiKey),
    settingsFile: settingsFilePath(homeDir),
    warnings: settings.warnings,
  }
}

function summarizeReport(report: {
  durationMs: number
  chunksUpserted: number
  batches: number
  imported?: { source: string; kind: string; chunks: number }
  errors: string[]
}): string {
  const parts = [`Finished in ${(report.durationMs / 1000).toFixed(1)}s`]
  if (report.imported) parts.push(`imported ${report.imported.chunks} chunks from ${report.imported.kind} ${report.imported.source} (no embedding calls)`)
  parts.push(`${report.chunksUpserted} chunks in ${report.batches} batch(es)`)
  if (report.errors.length > 0) parts.push(`errors: ${report.errors.slice(0, 3).join("; ")}`)
  return parts.join(" · ")
}

const plugin = {
  id: "opencode.indexing",
  async setup(ctx: Plugin.Context): Promise<void> {
    const root = ctx.location.directory as string
    const options = (ctx.options ?? {}) as unknown as PluginOptionsInput
    const kv: KVStore = createPluginStorage(ctx.storage as never)
    const getSettings = (): Promise<IndexingSettings> => Promise.resolve(resolveSettings(options))

    // Log effective configuration (never secrets).
    const initial = await getSettings()
    for (const warning of initial.warnings) console.warn(`[opencode-indexing] ${warning}`)
    console.log(
      `[opencode-indexing] ready for ${root} (${initial.vectorStore} backend, ${initial.provider}/${initial.modelId}${initial.dimension ? `, ${initial.dimension}d` : ""}, importFromKilo=${initial.importFromKilo})`,
    )

    // ---- Tools ----
    const tools: ToolDefinition[] = createTools({ kv, root, getSettings })
    try {
      await ctx.tool.transform((editor) => {
        editor.namespace({ name: "indexing", description: "Semantic code index tools" })
        for (const tool of tools) {
          editor.add({
            name: tool.name,
            description: tool.description,
            input: tool.input as never,
            options: { namespace: "indexing" },
            execute: async (input, context) => {
              const result = await tool.execute(input as Record<string, unknown>, {
                signal: context.signal,
                progress: context.progress as never,
              })
              return { content: result.output, metadata: result.metadata as never }
            },
          })
        }
      })
    } catch (error) {
      // Setup errors must never crash the OpenCode server process.
      console.error(`[opencode-indexing] tool registration failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    // ---- Skill ----
    try {
      await ctx.skill.transform((editor) => {
        editor.add({
          id: "opencode-indexing",
          name: "Semantic code search (indexing)",
          description:
            "Use the indexing_search tool for intent-based code search; run indexing_refresh when the index is stale. Explains when not to use it (exact terms, filenames).",
          path: "opencode-indexing://skill/indexing",
          content: SKILL_CONTENT,
          autoinvoke: true,
        } as never)
      })
    } catch (error) {
      console.warn(`[opencode-indexing] skill registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    // ---- Server commands (work in every client, including Desktop/Web) ----

    /**
     * Connectivity check for one backend.
     *
     * Extracted so the `settings.test` RPC and the `/indexing-config test`
     * subcommand answer identically instead of drifting apart.
     */
    async function testTarget(target: string): Promise<{ ok: boolean; message: string }> {
      const settings = await getSettings()
      try {
        if (target === "qdrant") {
          const client = createSettingsQdrant(settings)
          const names = await client.listCollections()
          return { ok: true, message: `Qdrant reachable at ${settings.qdrantUrl} (${names.length} collections)` }
        }
        if (target === "lancedb") {
          const mod = await import("@lancedb/lancedb").catch(() => null)
          if (!mod) return { ok: false, message: "LanceDB module is not installed (npm install @lancedb/lancedb@0.26.2)" }
          const fs = await import("node:fs")
          fs.mkdirSync(settings.lancedbDirectory, { recursive: true })
          await mod.connect(settings.lancedbDirectory)
          return { ok: true, message: `LanceDB available (${settings.lancedbDirectory})` }
        }
        if (target === "provider") {
          const embedder = createEmbedder(settings)
          const [vector] = await embedder.embed(["connection test"])
          return { ok: true, message: `${settings.provider}/${settings.modelId} OK (${vector?.length ?? 0} dimensions)` }
        }
        if (target === "kilo") {
          const sources = await discoverKiloSources(root, { qdrant: createSettingsQdrant(settings), homeDir: undefined })
          const list = sources.map((s) => `${s.kind} ${s.name} (${s.pointsCount ?? "?"} pts, ${s.compatible ? "compatible" : "INCOMPATIBLE"})`)
          return {
            ok: sources.length > 0,
            message: sources.length > 0 ? list.join(" · ") : "No Kilo index found for this workspace",
          }
        }
        return { ok: false, message: `Unknown test target: ${target}` }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }

    /**
     * Runs one Kilo import, or the first compatible one when none is named.
     *
     * Shared with the `index.import` RPC so the command and the tools cannot
     * disagree about which source gets picked or what the summary says.
     */
    async function runImport(wanted?: string): Promise<string> {
      const settings = await getSettings()
      if (settings.enabled === false) {
        throw new Error("Indexing is paused for this workspace. Re-enable it first: `set enabled=true`")
      }
      const store = createOwnStore(settings, root)
      const dimension = settings.dimension || (await store.info()).profile?.dimension || 0
      if (!dimension) throw new Error("Embedding dimension unknown")
      const targetProfile = { provider: settings.provider, modelId: settings.modelId, dimension }
      const sources = await discoverKiloSources(root, { qdrant: createSettingsQdrant(settings), targetProfile })
      const source = wanted
        ? sources.find((item) => item.name === wanted)
        : (sources.find((item) => item.compatible) ?? sources[0])
      if (!source) throw new Error("No Kilo source found for this workspace")
      if (!source.compatible) throw new Error(`Source ${source.name} has an incompatible embedding profile`)
      await store.ensure(dimension, targetProfile)
      const report = await importFromKilo({
        root,
        source,
        target: store,
        targetProfile,
        qdrant: createSettingsQdrant(settings),
      })
      return `Imported ${report.imported} chunks from ${report.source.kind} ${report.source.name} · ${report.batches} batches · 0 embedding calls`
    }

    /** Renders the configuration report used by `show` and by the bare form. */
    async function renderConfigReport(): Promise<string> {
      const settings = await getSettings()
      const lines: string[] = [
        "## Indexing configuration",
        "",
        `- **Vector store (own index):** ${settings.vectorStore}${settings.vectorStore === "qdrant" ? ` — ${settings.qdrantUrl}` : ` — ${settings.lancedbDirectory}`}`,
        `- **Embedding model:** ${settings.provider}/${settings.modelId}${settings.dimension ? ` (${settings.dimension}d)` : ""}`,
        `- **Import from Kilo:** ${settings.importFromKilo ? "ON (build imports existing Kilo indexes without embedding cost)" : "OFF (always index from scratch)"}`,
        `- **Auto-refresh on search:** ${settings.autoRefresh ? "ON" : "OFF"}`,
        `- **Indexing:** ${settings.enabled === false ? "PAUSED (nothing is written or refreshed; search still reads Kilo's index)" : "ON"}`,
        `- **Settings file:** \`${settingsFilePath()}\``,
      ]
      const sources = await discoverKiloSources(root, {
        qdrant: createSettingsQdrant(settings),
        homeDir: undefined,
      }).catch(() => [])
      lines.push(
        "",
        sources.length > 0
          ? `**Kilo sources detected:** ${sources.map((source) => `${source.kind} ${source.name} (${source.pointsCount ?? "?"} pts, ${source.compatible ? "compatible" : "INCOMPATIBLE"})`).join("; ")}`
          : "**Kilo sources detected:** none for this workspace",
      )
      lines.push(
        "",
        "To change settings:",
        "- `/indexing-config help` lists every subcommand and key, or",
        "- Edit `~/.config/opencode/indexing.json` (backend, Qdrant URL/key, provider/model, API keys), or",
        "- Terminal TUI: `/indexing` opens the settings page, and `e` there opens the editor.",
      )
      return lines.join("\n")
    }

    try {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "indexing-config",
          description: "Show the semantic indexing configuration (backend, models, import toggle, index state)",
          execute: async (invocation: { sessionID: string; prompt?: { text?: string } }) => {
            const sessionID = invocation.sessionID
            const parsed = parseIndexingCommand(invocation.prompt?.text ?? "")
            const reply = async (text: string): Promise<void> => {
              await ctx.session.synthetic({ sessionID, text } as never)
            }

            try {
              switch (parsed.action) {
                case "help": {
                  await reply(COMMAND_USAGE)
                  return
                }
                case "error": {
                  await reply(`${parsed.message}\n\n${COMMAND_USAGE}`)
                  return
                }
                case "show": {
                  await reply(await renderConfigReport())
                  return
                }
                case "set": {
                  const applied = applySettingValue(parsed.key, parsed.rawValue)
                  if (!applied.ok) {
                    await reply(`${applied.error}\n\n${COMMAND_USAGE}`)
                    return
                  }
                  if (!parsed.hasValue) {
                    // `set <key>` with no value reports the current one.
                    const settings = await getSettings()
                    const current = describeSettingValue(parsed.key, settings)
                    await reply(
                      current === undefined
                        ? `Unknown setting \`${parsed.key}\`.\n\n${COMMAND_USAGE}`
                        : `${parsed.key} = ${current}`,
                    )
                    return
                  }
                  const { writeSettingsFile } = await import("./src/settings.ts")
                  writeSettingsFile(applied.patch as never)
                  await reply(`${parsed.key} = ${applied.display}\n\nSaved to ${settingsFilePath()}`)
                  return
                }
                case "test": {
                  const targets =
                    parsed.target === "all" ? ["qdrant", "lancedb", "provider", "kilo"] : [parsed.target]
                  const results: string[] = []
                  for (const target of targets) {
                    const result = await testTarget(target)
                    results.push(`${target}: ${result.ok ? "OK" : "FAIL"} — ${result.message}`)
                  }
                  await reply(results.join("\n"))
                  return
                }
                case "import": {
                  await reply(await runImport(parsed.source))
                  return
                }
              }
            } catch (error) {
              await reply(`Failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          },
        } as never)
      })
    } catch (error) {
      console.warn(`[opencode-indexing] command registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    // ---- RPC (for the TUI settings view and external clients) ----
    try {
      await ctx.rpc.register(IndexingRpc, {
        "settings.get": async () => {
          const settings = await getSettings()
          return { settings: settingsView(settings) }
        },

        "settings.set": async (input: unknown) => {
          const { writeSettingsFile } = await import("./src/settings.ts")
          const patch = (input as { patch?: Record<string, unknown> }).patch ?? {}
          writeSettingsFile(patch as never)
          const settings = await getSettings()
          return { settings: settingsView(settings) }
        },

        "settings.test": async (input: unknown) => {
          return testTarget((input as { target: string }).target)
        },

        "kilo.discover": async () => {
          const settings = await getSettings()
          const targetProfile =
            settings.dimension > 0 ? { provider: settings.provider, modelId: settings.modelId, dimension: settings.dimension } : undefined
          const sources = await discoverKiloSources(root, {
            qdrant: createSettingsQdrant(settings),
            homeDir: undefined,
            targetProfile,
          })
          return {
            sources: sources.map((source) => ({
              kind: source.kind,
              name: source.name,
              pointsCount: source.pointsCount,
              complete: source.complete,
              profile: source.profile
                ? `${source.profile.provider}:${source.profile.modelId}:${source.profile.dimension}`
                : null,
              compatible: source.compatible,
            })),
          }
        },

        "status.get": async (input: unknown) => {
          const settings = await getSettings()
          const status = await getStatus(
            { qdrant: createSettingsQdrant(settings), kv, root, settings },
            { checkFreshness: (input as { checkFreshness?: boolean }).checkFreshness === true },
          )
          const summary = [
            `Own index (${status.own.kind}): ${status.own.exists ? `${status.own.points} points, ${status.own.complete ? "complete" : "incomplete"}` : "not built"}`,
            status.kilo.collection ? `Kilo: ${status.kilo.collection} (${status.kilo.points} points)` : "Kilo: none",
            status.freshness.checked
              ? `Freshness: ${status.freshness.added} new / ${status.freshness.maybeStale} changed / ${status.freshness.deleted} deleted`
              : "Freshness: not checked",
          ].join(" · ")
          return {
            summary,
            ownKind: status.own.kind,
            ownStore: status.own.store,
            ownPoints: status.own.points,
            ownComplete: status.own.complete,
            kiloCollection: status.kilo.collection,
            recommendation: status.recommendation,
          }
        },

        "index.build": async (input: unknown) => {
          const settings = await getSettings()
          const report = await runIndex(
            { kv, root, settings, qdrant: createSettingsQdrant(settings) },
            {
              mode: "build",
              rebuild: (input as { rebuild?: boolean }).rebuild === true,
              skipImport: (input as { skipImport?: boolean }).skipImport === true,
            },
          )
          return { summary: summarizeReport(report) }
        },

        "index.refresh": async (input: unknown) => {
          const settings = await getSettings()
          const report = await runIndex(
            { kv, root, settings, qdrant: createSettingsQdrant(settings) },
            { mode: "refresh", maxFiles: (input as { maxFiles?: number }).maxFiles },
          )
          return { summary: summarizeReport(report) }
        },

        "index.import": async (input: unknown) => {
          return { summary: await runImport((input as { source?: string }).source) }
        },
      } as never)
    } catch (error) {
      console.warn(`[opencode-indexing] RPC registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
} satisfies Plugin.Plugin

export default plugin
