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
import { getOwnStoreInfo, OWN_COLLECTION_PREFIX, type OwnStoreInfo } from "./src/own-store.ts"
import { forgetWorkspace, readWorkspaces } from "./src/workspaces.ts"
import { IndexingRpc } from "./src/rpc.ts"
import {
  COMMAND_USAGE,
  applySettingValue,
  applySettingsChange,
  describeSettingValue,
  parseIndexingCommand,
  settingReport,
} from "./src/settings-commands.ts"
import type { IndexingSettings, KVStore } from "./src/types.ts"
import type { Qdrant } from "./src/qdrant.ts"

/** One row of `workspaces.list`; the contract lives in `src/rpc.ts`. */
interface WorkspaceListRow {
  store: string
  root: string | null
  points: number | null
  complete: boolean | null
  profile: string | null
  updatedAt: string | null
  source: "registry" | "collection"
}

/** Points and completion state of one own collection; null when unreadable. */
async function readOwnCollectionInfo(client: Qdrant, store: string): Promise<OwnStoreInfo | null> {
  try {
    return await getOwnStoreInfo(client, store)
  } catch {
    // Raced with a deletion, or the collection vanished mid-listing.
    return null
  }
}

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

## Configuration

\`indexing_config\` reports the effective settings (backend, model, credentials —
masked, search and behaviour). \`indexing_config_set { key, value }\` changes one
and persists it. Use them when the user asks what the indexing configuration is,
or asks to change it. Credentials are refused by design: an API key has to come
from the environment or from plugin options, never from a tool call.

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
  warnings: string[]
}): string {
  const parts = [`Finished in ${(report.durationMs / 1000).toFixed(1)}s`]
  if (report.imported) parts.push(`imported ${report.imported.chunks} chunks from ${report.imported.kind} ${report.imported.source} (no embedding calls)`)
  parts.push(`${report.chunksUpserted} chunks in ${report.batches} batch(es)`)
  if (report.errors.length > 0) parts.push(`errors: ${report.errors.slice(0, 3).join("; ")}`)
  if (report.warnings.length > 0) parts.push(`warnings: ${report.warnings.slice(0, 3).join("; ")}`)
  return parts.join(" · ")
}

const plugin = {
  id: "opencode.indexing",
  async setup(ctx: Plugin.Context): Promise<void> {
    const root = ctx.location.directory as string

    /**
     * Workspace a call is about.
     *
     * Callers that run somewhere else — the TUI opened in another folder — pass
     * their directory, and everything for that call (status, index, import) uses
     * it. Falls back to the instance's own directory.
     */
    const rootFor = (input: unknown): string => {
      const directory = (input as { directory?: string } | undefined)?.directory
      return typeof directory === "string" && directory.trim() !== "" ? directory : root
    }
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

    /**
     * Configuration has to be readable from every client.
     *
     * Slash commands are only dispatched by clients that choose to: the Desktop
     * app submits `/indexing-config` to the model instead of executing it, and
     * the server plugin has no UI surface (the SDK's toast lives in the TUI
     * context). A tool runs server-side, so it works everywhere.
     */
    const CONFIG_TOOL_DESCRIPTION = `Show the current semantic indexing configuration: the vector store, the embedding provider and model, which credentials are configured (always masked), search and behavior settings, the settings file path, and which Kilo Code index sources exist for this workspace.

Use this whenever the user asks to see, review or check the indexing configuration, or before suggesting a change to it. It is read-only and never writes settings. To change a value, use \`/indexing-config set <key>=<value>\` in a client that dispatches commands, or edit the settings file.`

    tools.push({
      name: "config",
      description: CONFIG_TOOL_DESCRIPTION,
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ output: await renderConfigReport() }),
    })

    /**
     * Writing configuration, for the clients that cannot dispatch a slash
     * command.
     *
     * Read and write are separate tools on purpose: the permission gate is what
     * makes a write safe to expose to a model, and a tool that both read and
     * wrote could not carry one without also gating the read.
     */
    const CONFIG_SET_TOOL_DESCRIPTION = `Change one semantic indexing setting and persist it to the settings file.

Use this when the user asks to change a setting: switching the vector store, changing the embedding provider or model, adjusting search limits, toggling import-from-Kilo or auto-refresh, or pausing/resuming indexing. Run \`indexing_config\` first to see the current values and the exact key names.

Behavior:
- Validated with the same rules as \`/indexing-config set <key>=<value>\`, and persisted immediately.
- Credentials are refused. A tool call is recorded in the conversation, and the settings file never stores keys in plain text, so an API key has to come from the environment or from plugin options in \`opencode.json\`.
- The host asks the user to confirm before this runs; nothing is written unless they approve.`

    tools.push({
      name: "config_set",
      description: CONFIG_SET_TOOL_DESCRIPTION,
      permission: "indexing_config_set",
      input: {
        type: "object",
        properties: {
          key: { type: "string", description: "Setting name, case-insensitive. Run indexing_config for the list." },
          value: {
            type: "string",
            description: "New value as a string: booleans as true/false, numbers as digits, extension lists comma-separated.",
          },
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const key = String(input.key ?? "")
          .trim()
          .toLowerCase()
        const value = String(input.value ?? "")

        const applied = applySettingsChange(key, value)
        if (!applied.ok) return { output: applied.error }

        const { writeSettingsFile } = await import("./src/settings.ts")
        writeSettingsFile(applied.patch as never)

        // Read back rather than echoing what was asked for: the file may clamp
        // or normalise a value, and reporting the request would hide that.
        const settings = await getSettings()
        const current = describeSettingValue(key, settings)
        const warnings = settings.warnings.length > 0 ? `\n\nWarnings: ${settings.warnings.join("; ")}` : ""
        return {
          output: `Saved: ${key} = ${current ?? applied.display}${warnings}`,
          metadata: { key, value: current ?? applied.display },
        }
      },
    })

    try {
      await ctx.tool.transform((editor) => {
        editor.namespace({ name: "indexing", description: "Semantic code index tools" })
        for (const tool of tools) {
          editor.add({
            name: tool.name,
            description: tool.description,
            input: tool.input as never,
            options: { namespace: "indexing", ...(tool.permission ? { permission: tool.permission } : {}) },
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
    async function runImport(wantedDirectory?: string, wanted?: string): Promise<string> {
      const settings = await getSettings()
      const workspace = wantedDirectory ?? root
      if (settings.enabled === false) {
        throw new Error("Indexing is paused for this workspace. Re-enable it first: `set enabled=true`")
      }
      const store = createOwnStore(settings, workspace)
      const dimension = settings.dimension || (await store.info()).profile?.dimension || 0
      if (!dimension) throw new Error("Embedding dimension unknown")
      const targetProfile = { provider: settings.provider, modelId: settings.modelId, dimension }
      const sources = await discoverKiloSources(workspace, { qdrant: createSettingsQdrant(settings), targetProfile })
      const source = wanted
        ? sources.find((item) => item.name === wanted)
        : (sources.find((item) => item.compatible) ?? sources[0])
      if (!source) throw new Error("No Kilo source found for this workspace")
      if (!source.compatible) throw new Error(`Source ${source.name} has an incompatible embedding profile`)
      await store.ensure(dimension, targetProfile)
      const report = await importFromKilo({
        root: workspace,
        source,
        target: store,
        targetProfile,
        qdrant: createSettingsQdrant(settings),
      })
      return `Imported ${report.imported} chunks from ${report.source.kind} ${report.source.name} · ${report.batches} batches · 0 embedding calls`
    }

    /**
     * Every workspace the server has an own index for.
     *
     * Qdrant only knows the hashed collection name, so the registry written
     * after each run is what maps `oc-<hash16>` back to a directory. Collections
     * without a record are listed as well: they hold indexed points, so they
     * must stay visible and forgettable. An unreachable Qdrant costs the point
     * counts, never the list itself.
     */
    async function listWorkspaces(): Promise<{ workspaces: WorkspaceListRow[] }> {
      const settings = await getSettings()
      const client = createSettingsQdrant(settings)
      let collections: string[] = []
      try {
        collections = await client.listCollections()
      } catch {
        collections = []
      }
      const records = new Map(readWorkspaces().map((record) => [record.store, record]))

      const workspaces: WorkspaceListRow[] = []
      for (const store of collections.filter((name) => name.startsWith(OWN_COLLECTION_PREFIX)).sort()) {
        const record = records.get(store)
        const info = await readOwnCollectionInfo(client, store)
        workspaces.push({
          store,
          root: record?.root ?? null,
          points: info?.pointsCount ?? null,
          // A recorded workspace is described by its record; completeness is a
          // property of the collection alone, reported for unidentified rows.
          complete: record ? null : (info?.complete ?? null),
          profile: record?.profile ?? null,
          updatedAt: record?.updatedAt ?? null,
          source: record ? "registry" : "collection",
        })
      }

      // Named directories first (alphabetical), unidentified collections after.
      workspaces.sort((left, right) => {
        if (left.root !== null && right.root !== null) return left.root.localeCompare(right.root)
        if (left.root !== null) return -1
        if (right.root !== null) return 1
        return left.store.localeCompare(right.store)
      })
      return { workspaces }
    }

    /**
     * Drop one own collection and forget its registry entry.
     *
     * Only `oc-` names are accepted: those are the plugin's own, nothing else in
     * Qdrant may be deleted from here. A collection that is already gone is not
     * an error — the registry entry is stale bookkeeping worth removing anyway.
     */
    async function forgetOwnWorkspace(
      store: string,
    ): Promise<{ ok: boolean; summary: string; pointsDeleted: number | null }> {
      const name = store.trim()
      if (!name.startsWith(OWN_COLLECTION_PREFIX) || name.length === OWN_COLLECTION_PREFIX.length) {
        throw new ForgetRefusedError(
          `Only the plugin's own collections (${OWN_COLLECTION_PREFIX}…) can be forgotten, not "${store}"`,
        )
      }
      const settings = await getSettings()
      const client = createSettingsQdrant(settings)
      const record = readWorkspaces().find((entry) => entry.store === name)
      const label = record ? `${record.root} (${name})` : name

      const info = await readOwnCollectionInfo(client, name)
      if (info) await client.deleteCollection(name)
      const forgotten = forgetWorkspace(name)

      if (!info && !forgotten) {
        return { ok: true, summary: `Nothing to forget for ${label}: no such collection and no registry entry.`, pointsDeleted: null }
      }
      const parts = [info ? `${info.pointsCount} points deleted` : "collection did not exist"]
      if (forgotten) parts.push("registry entry removed")
      return { ok: true, summary: `Forgot ${label}: ${parts.join(", ")}.`, pointsDeleted: info?.pointsCount ?? null }
    }

    /**
 * Thrown when a caller asks to forget something that is not ours.
 *
 * Kept as its own type so the RPC handler can tell a policy refusal apart from
 * an infrastructure failure: only the refusal becomes `ok: false`.
 */
class ForgetRefusedError extends Error {}

    /**
     * Renders the configuration report.
     *
     * Shared by `show`, the bare command form and the `indexing_config` tool so
     * all three always agree.
     */
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

      // Every settable key, so a value can be verified from the same command
      // that set it. Derived from the catalogue: a key cannot be hidden by
      // being left out of a hand-written list.
      lines.push("", "### All settings", "")
      for (const group of settingReport(settings)) {
        lines.push(`**${group.title}**`)
        for (const entry of group.entries) {
          lines.push(`- \`${entry.key}\` = \`${entry.value}\` — ${entry.description}`)
        }
        lines.push("")
      }
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
                  // The session knows which workspace the user is in; the plugin
                  // instance directory is the one the service runs in, which is
                  // usually a different directory entirely.
                  const sessionDirectory = await ctx.session
                    .get({ sessionID } as never)
                    .then((info: { location?: { directory?: string } }) => info?.location?.directory)
                    .catch(() => undefined)
                  await reply(await runImport(sessionDirectory, parsed.source))
                  return
                }
              }
            } catch (error) {
              await reply(`Failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          },
        } as never)
      })

      // Reading the registry already sees the command; this is for clients.
      // They keep their own copy of the command list, and a client that
      // snapshotted it before this plugin loaded never shows the command at
      // all. Reloading marks the registry changed so the `command.updated`
      // event reaches them.
      await ctx.command.reload()
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
            { qdrant: createSettingsQdrant(settings), kv, root: rootFor(input), settings },
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
            workspace: rootFor(input),
          }
        },

        "index.build": async (input: unknown) => {
          const settings = await getSettings()
          const report = await runIndex(
            { kv, root: rootFor(input), settings, qdrant: createSettingsQdrant(settings) },
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
            { kv, root: rootFor(input), settings, qdrant: createSettingsQdrant(settings) },
            { mode: "refresh", maxFiles: (input as { maxFiles?: number }).maxFiles },
          )
          return { summary: summarizeReport(report) }
        },

        "index.import": async (input: unknown) => {
          return { summary: await runImport((input as { directory?: string }).directory, (input as { source?: string }).source) }
        },

        "workspaces.list": async () => {
          return listWorkspaces()
        },

        "workspace.forget": async (input: unknown) => {
          try {
            return await forgetOwnWorkspace((input as { store?: string }).store ?? "")
          } catch (error) {
            // Returning the failure as data keeps the message readable instead
            // of collapsing it into an opaque internal RPC error, and `reason`
            // lets a caller tell a refusal from an infrastructure failure.
            return {
              ok: false,
              reason: error instanceof ForgetRefusedError ? "refused" : "failed",
              summary: error instanceof Error ? error.message : String(error),
              pointsDeleted: null,
            }
          }
        },
      } as never)
    } catch (error) {
      console.warn(`[opencode-indexing] RPC registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
} satisfies Plugin.Plugin

export default plugin
