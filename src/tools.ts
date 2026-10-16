import { runIndex } from "./indexer.ts"
import { searchCode } from "./search.ts"
import { getStatus } from "./status.ts"
import { indexStatusLine } from "./index-state.ts"
import { discoverKiloSources, importFromKilo, type KiloSourceInfo } from "./import.ts"
import { createOwnStore, createSettingsQdrant } from "./store-factory.ts"
import { assessScope } from "./scope.ts"
import { codegraphStatusLine, indexWithCodegraph, type CodegraphOutcome } from "./codegraph.ts"
import type { IndexingSettings, KVStore } from "./types.ts"
import type { Qdrant } from "./qdrant.ts"

export interface ToolDeps {
  kv: KVStore
  /**
   * Fallback workspace, used when the host does not report one per call.
   *
   * This is the plugin instance's own directory — the one the service runs in,
   * which is usually not the directory the user is working in. Prefer
   * `context.directory`; this is the last resort, not the normal path.
   */
  root: string
  /**
   * Live settings getter. Tools resolve settings on every execution so config
   * changes made from the TUI apply without restarting the server.
   */
  getSettings: () => IndexingSettings | Promise<IndexingSettings>
}

/**
 * Host context as far as the tools read it.
 *
 * `directory` is the session's workspace. Older hosts omit it, which is why it
 * is optional: `toolRoot` falls back rather than indexing nothing.
 */
export interface ToolContext {
  signal?: AbortSignal
  progress?: (m: unknown) => Promise<void>
  directory?: string
}

/**
 * The workspace one tool call is about.
 *
 * The host knows which directory the user is in; the plugin instance does not.
 * Indexing the service's directory because that is what `deps.root` happened to
 * hold writes a perfectly good index of the wrong codebase and reports it as the
 * user's, so the session directory wins whenever the host reports one.
 */
function toolRoot(deps: ToolDeps, context: ToolContext): string {
  const directory = context.directory
  return typeof directory === "string" && directory.trim() !== "" ? directory : deps.root
}

export interface ToolDefinition {
  name: string
  description: string
  input: Record<string, unknown>
  /**
   * Permission the host asks the user for before this tool runs.
   *
   * Only set on tools that write. Reading needs no gate, and a tool that both
   * reads and writes could not ask for one without blocking the read too, which
   * is why configuration read and write are separate tools.
   */
  permission?: string
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<{ output: string; metadata?: Record<string, unknown> }>
}

const SEARCH_DESCRIPTION = `Find code snippets by semantic meaning in the project's code index.

Use this tool early for open-ended exploration when you know the intent but not the exact identifiers (e.g. "user login and password hashing", "database connection pooling"). Prefer Grep when exact terms are already known, Glob to find files by name, and Read for known files.

Notes:
- The index combines Kilo Code's index (when present and profile-compatible) with the plugin's own index, which can be backed by Qdrant or LanceDB.
- If the index reports stale/incomplete, results may be incomplete — indexed files might not include recent edits.
- Pass \`path\` to limit results to a subdirectory, relative to the workspace root.
- This finds code by meaning. For structure — who calls a symbol, what depends on it, what breaks if it changes — use the codegraph tools when that MCP server is available; a similarity search cannot answer those.`

const STATUS_DESCRIPTION = `Report the state of the project's semantic code index.

Shows:
- Qdrant connectivity and the configured own store (Qdrant collection or LanceDB database).
- Kilo Code index sources available for import (Qdrant collection and/or local LanceDB database), with embedding profile and compatibility.
- The plugin's own index (points, completion, embedding profile, last run).
- Freshness: number of workspace files that were never indexed, possibly changed, or deleted since the last run.
- The codegraph companion's state for this folder, when that setting is on: whether it is indexed, and that the next build will sync it.
- A recommended next action (import/build/refresh).`

const REFRESH_DESCRIPTION = `Incrementally update the plugin's own code index for this workspace.

Only new/changed/deleted files are processed (based on the stored file manifest), so this is cheap to run after edits. Use it when indexing_status reports new/changed/deleted files, or before relying on indexing_search for recently changed code. It never modifies Kilo Code's index.`

const BUILD_DESCRIPTION = `Build (or rebuild) the plugin's own code index for the workspace.

Behavior:
- If a compatible Kilo Code index exists (Qdrant collection or local LanceDB) and "import from Kilo" is enabled in settings, vectors and chunks are imported WITHOUT calling the embedding API, then only the delta is embedded. This is the fastest path.
- If no Kilo index exists (or the import toggle is off), the workspace is indexed from scratch with the configured embedding model.
- \`rebuild: true\` drops the own index first and re-imports/re-indexes everything.
- \`skipImport: true\` forces indexing from scratch even when a Kilo index exists.

If the codegraph CLI is installed, it is also started for this folder in the
background (\`init\` the first time, \`sync\` afterwards) so the companion code
graph stays in step. It never blocks this tool and never fails it: without
codegraph this build is identical.

This can take a while for large workspaces and may consume embedding API credits (except when importing).`

const IMPORT_DESCRIPTION = `Import an existing Kilo Code index into the plugin's own index WITHOUT re-embedding.

Vectors and chunks are copied as-is (zero embedding API cost), which requires a matching embedding profile. Sources:
- Kilo's Qdrant collection (\`ws-*\`).
- Kilo's local LanceDB database for this workspace, when present.

Use indexing_status to list detected sources. If profiles do not match, rebuild with the matching model instead.

If the codegraph CLI is installed, it is also started for this folder in the background, so the companion code graph covers the files this import brought in. Without codegraph this import is identical.`

const jsonSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

function sourceLine(source: KiloSourceInfo): string {
  const profile = source.profile
    ? `${source.profile.provider}:${source.profile.modelId}:${source.profile.dimension}`
    : "unknown profile"
  const points = source.pointsCount ?? "?"
  const complete = source.complete === true ? "complete" : source.complete === false ? "INCOMPLETE" : "unknown state"
  const compat = source.compatible ? "compatible" : "INCOMPATIBLE (different embedding profile)"
  return `${source.kind} ${source.name} — ${points} points, ${complete}, ${profile}, ${compat}`
}

/**
 * Scope warning for the workspace being indexed, or `""` when it looks like a
 * single project. Deliberately non-blocking: the operator decides.
 */
function scopeWarning(root: string): string {
  const assessment = assessScope(root)
  if (assessment.level !== "warn") return ""
  return `Warning: ${root} is ${assessment.reason}. Indexing continues; scope the workspace to a single project for a smaller, sharper index.`
}

export function createTools(deps: ToolDeps): ToolDefinition[] {
  return [
    {
      name: "search",
      description: SEARCH_DESCRIPTION,
      input: jsonSchema(
        {
          query: { type: "string", description: "The search query, expressed in natural language." },
          path: {
            type: "string",
            description:
              "Limit search to a subdirectory, relative to the workspace root. Leave empty to search the whole workspace.",
          },
        },
        ["query"],
      ),
      async execute(input, context) {
        const settings = await deps.getSettings()
        const qdrant = createSettingsQdrant(settings)
        const root = toolRoot(deps, context)
        const query = typeof input.query === "string" ? input.query.trim() : ""
        if (!query) throw new Error("query is required")
        const pathPrefix = typeof input.path === "string" && input.path.trim() !== "" ? input.path.trim() : undefined

        // Auto-refresh (M6): when enabled, refresh inline if the delta is small.
        // Skipped while indexing is paused, otherwise a search would keep writing.
        if (settings.autoRefresh && settings.enabled !== false) {
          try {
            await maybeAutoRefresh(root, deps, settings, qdrant)
          } catch {
            // Auto-refresh failures never block the search.
          }
        }

        const outcome = await searchCode({ qdrant, kv: deps.kv, root, settings }, query, pathPrefix)
        const { hits, meta, errors } = outcome
        if (hits.length === 0) {
          const lines: string[] = [`No results for "${query}" in ${meta.root}.`]
          const kiloState = meta.kilo.collection
            ? `Kilo index: ${meta.kilo.points ?? "?"} points, ${meta.kilo.complete === true ? "complete" : "INCOMPLETE"}.`
            : "Kilo index: not found."
          const ownState = meta.own.complete === null
            ? `Own index (${meta.own.kind}): not built (run indexing_build).`
            : `Own index (${meta.own.kind}): ${meta.own.points ?? "?"} points, ${meta.own.complete ? "complete" : "INCOMPLETE"}.`
          lines.push(kiloState, ownState)
          lines.push("Empty results are not proof that no matching code exists; only indexed files are searchable.")
          if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`)
          return { output: lines.join("\n"), metadata: { root: meta.root, results: [], state: { kilo: meta.kilo, own: meta.own } } }
        }
        const header = `Found ${hits.length} result${hits.length === 1 ? "" : "s"} for "${query}" in ${meta.root}${pathPrefix ? `/${pathPrefix.replaceAll("\\", "/")}` : ""}.`
        const body = hits.flatMap((hit, index) => [
          `${index + 1}. [${hit.source}] ${hit.filePath}:${hit.startLine}-${hit.endLine} (score ${hit.score.toFixed(4)})`,
          hit.codeChunk,
          "",
        ])
        if (errors.length > 0) body.push(`Warnings: ${errors.join("; ")}`)
        // Chat clients have no footer slot and the Desktop app has no status
        // area at all, so the index state travels with the results. The
        // empty-result branch above already reports it in more detail, together
        // with the action to take, and does not repeat the line.
        body.push(
          indexStatusLine({
            enabled: settings.enabled !== false,
            ownPoints: meta.own.points,
            ownComplete: meta.own.complete,
            hasKilo: meta.kilo.collection !== null,
            kiloPoints: meta.kilo.points,
            root: meta.root,
          }),
        )
        return {
          output: [header, "", ...body].join("\n").trim(),
          metadata: { root: meta.root, results: hits, state: { kilo: meta.kilo, own: meta.own } },
        }
      },
    },
    {
      name: "status",
      description: STATUS_DESCRIPTION,
      input: jsonSchema({
        checkFreshness: { type: "boolean", description: "Scan the workspace to compute file freshness (slower)." },
      }),
      async execute(input, context) {
        const settings = await deps.getSettings()
        const qdrant = createSettingsQdrant(settings)
        const root = toolRoot(deps, context)
        const status = await getStatus({ qdrant, kv: deps.kv, root, settings }, { checkFreshness: input.checkFreshness !== false })
        const lines: string[] = [
          `Workspace: ${status.root}`,
          `Qdrant: ${status.qdrant.url} (${status.qdrant.reachable ? "reachable" : "UNREACHABLE"})`,
        ]
        lines.push(
          status.kilo.exists
            ? `Kilo Qdrant index: ${status.kilo.collection} — ${status.kilo.points ?? "?"} points, ${status.kilo.complete === true ? "complete" : "incomplete"}${status.kilo.profile ? `, ${status.kilo.profile}` : ""}`
            : "Kilo Qdrant index: none for this workspace",
        )
        if (status.kiloSources.length > 0) {
          lines.push("Kilo import sources:")
          for (const source of status.kiloSources) lines.push(`  - ${sourceLine(source)}`)
        }
        lines.push(
          status.own.exists
            ? `Own index (${status.own.kind}): ${status.own.store} — ${status.own.points ?? "?"} points, ${status.own.complete === true ? "complete" : "incomplete"}${status.own.profile ? `, ${status.own.profile}` : ""}${status.own.lastRun ? `, last run ${new Date(status.own.lastRun).toISOString()}` : ""}`
            : `Own index (${status.own.kind}): not built`,
        )
        if (status.freshness.checked) {
          lines.push(
            `Freshness: ${status.freshness.total} files scanned, ${status.freshness.added} new, ${status.freshness.maybeStale} possibly changed, ${status.freshness.deleted} deleted.`,
          )
        }
        // Only when the companion indexer is actually in play: saying
        // "codegraph: not indexed" to someone who never asked for codegraph is
        // noise. Read from the filesystem, so this costs no process.
        if (settings.codegraph !== false) {
          const codegraph = codegraphStatusLine(root)
          if (codegraph) lines.push(codegraph)
        }
        lines.push(`Recommendation: ${status.recommendation}`)
        if (status.warnings.length > 0) lines.push(`Warnings: ${status.warnings.join("; ")}`)
        return { output: lines.join("\n"), metadata: status as unknown as Record<string, unknown> }
      },
    },
    {
      name: "refresh",
      description: REFRESH_DESCRIPTION,
      input: jsonSchema({ maxFiles: { type: "number", description: "Cap the number of files processed in this run." } }),
      async execute(input, context) {
        const settings = await deps.getSettings()
        assertIndexingEnabled(settings)
        const qdrant = createSettingsQdrant(settings)
        const root = toolRoot(deps, context)
        const maxFiles = typeof input.maxFiles === "number" && input.maxFiles > 0 ? Math.floor(input.maxFiles) : undefined
        const report = await runIndex(
          {
            kv: deps.kv,
            root,
            settings,
            qdrant,
            onProgress: makeProgress(context),
          },
          { mode: "refresh", maxFiles },
        )
        const summary = formatReport("refresh", report)
        const warning = scopeWarning(root)
        return {
          output: warning ? `${warning}\n${summary}` : summary,
          metadata: report as unknown as Record<string, unknown>,
        }
      },
    },
    {
      name: "build",
      description: BUILD_DESCRIPTION,
      input: jsonSchema({
        rebuild: { type: "boolean", description: "Drop the own index first and rebuild (import or re-index) everything from scratch." },
        skipImport: { type: "boolean", description: "Ignore Kilo Code's index and index from scratch with embeddings." },
      }),
      async execute(input, context) {
        const settings = await deps.getSettings()
        assertIndexingEnabled(settings)
        const qdrant = createSettingsQdrant(settings)
        const root = toolRoot(deps, context)
        const report = await runIndex(
          {
            kv: deps.kv,
            root,
            settings,
            qdrant,
            onProgress: makeProgress(context),
          },
          { mode: "build", rebuild: input.rebuild === true, skipImport: input.skipImport === true },
        )
        const summary = formatReport("build", report)
        const lines = [scopeWarning(root), summary, await codegraphLine(root, settings)].filter(Boolean)
        return {
          output: lines.join("\n"),
          metadata: report as unknown as Record<string, unknown>,
        }
      },
    },
    {
      name: "import",
      description: IMPORT_DESCRIPTION,
      input: jsonSchema({
        source: { type: "string", description: "Optional source name to import from (as shown by indexing_status). Defaults to the first compatible source." },
        rebuild: { type: "boolean", description: "Drop the own index before importing." },
      }),
      async execute(input, context) {
        const settings = await deps.getSettings()
        assertIndexingEnabled(settings)
        const qdrant = createSettingsQdrant(settings)
        const root = toolRoot(deps, context)
        const store = createOwnStore(settings, root)
        const profile = { provider: settings.provider, modelId: settings.modelId, dimension: settings.dimension }

        let dimension = settings.dimension
        const info = await store.info()
        if (!dimension && info.profile?.dimension) dimension = info.profile.dimension
        if (!dimension) throw new Error("Embedding dimension unknown; run indexing_build once or set the model dimension")
        const targetProfile = { provider: profile.provider, modelId: profile.modelId, dimension }

        if (input.rebuild === true) {
          if (store.kind === "qdrant") {
            const client = createSettingsQdrant(settings)
            if (await client.collectionExists(store.name)) await client.deleteCollection(store.name)
          } else {
            const fs = await import("node:fs")
            fs.rmSync(store.name, { recursive: true, force: true })
          }
        }
        await store.ensure(dimension, targetProfile)

        const problems: string[] = []
        const sources = await discoverKiloSources(root, { qdrant, targetProfile, onProblem: (m) => problems.push(m) })
        if (sources.length === 0) {
          throw new Error(
            problems.length > 0
              ? `No Kilo Code index found for ${root}. ${problems.join(" · ")}`
              : "No Kilo Code index found for this workspace (neither Qdrant collection nor local LanceDB)",
          )
        }
        const wanted = typeof input.source === "string" && input.source.trim() !== "" ? input.source.trim() : undefined
        const source = wanted ? sources.find((item) => item.name === wanted) : (sources.find((item) => item.compatible) ?? sources[0])
        if (!source) throw new Error(`Source not found: ${wanted}. Available: ${sources.map((s) => s.name).join(", ")}`)
        if (!source.compatible) {
          throw new Error(
            `Source ${source.name} has an incompatible embedding profile. ` +
              `Expected ${targetProfile.provider}:${targetProfile.modelId}:${targetProfile.dimension}. Re-index with embeddings instead.`,
          )
        }

        const report = await importFromKilo({
          root,
          source,
          target: store,
          targetProfile,
          qdrant,
          onProgress: (update) =>
            context.progress?.({ status: `importing ${update.imported}/${update.total ?? "?"}` }) ?? Promise.resolve(),
        })
        const lines = [
          `Imported ${report.imported} chunks from ${report.source.kind} ${report.source.name} in ${(report.durationMs / 1000).toFixed(1)}s.`,
          `Batches: ${report.batches}, skipped: ${report.skipped}. Embedding API calls: 0.`,
          await codegraphLine(root, settings),
        ]
        if (report.errors.length > 0) lines.push(`Errors: ${report.errors.join("; ")}`)
        return { output: lines.filter(Boolean).join("\n"), metadata: report as unknown as Record<string, unknown> }
      },
    },
  ]
}

/**
 * One line about the companion indexer, for the write tools.
 *
 * Never throws and never reports success: the launch is detached, so by the time
 * this returns the CLI has only started. Anything that went wrong afterwards
 * lands in `.codegraph/daemon.log`, which is where the message points.
 */
async function codegraphLine(root: string, settings: IndexingSettings): Promise<string> {
  let outcome: CodegraphOutcome
  try {
    outcome = await indexWithCodegraph({ root, enabled: settings.codegraph !== false })
  } catch (error) {
    return `Codegraph: not indexed (${error instanceof Error ? error.message : String(error)})`
  }
  if (outcome.kind === "launched") {
    return `Codegraph: \`${outcome.launch.command}\` started in the background — ${outcome.launch.detail}.`
  }
  // A skip while the CLI is absent is the common case and not worth a line on
  // every build; the other two say something the user may want to act on.
  if (outcome.reason.startsWith("the codegraph CLI is not installed")) return ""
  return `Codegraph: not indexed (${outcome.reason})`
}

function makeProgress(context: { progress?: (m: unknown) => Promise<void> }): (update: {
  phase: string
  processed: number
  total: number
}) => Promise<void> {
  return (update) => context.progress?.({ status: `${update.phase} ${update.processed}/${update.total}` }) ?? Promise.resolve()
}

/**
 * Refuses any tool that would write the own index while `enabled` is false.
 *
 * Search is deliberately allowed to keep working: it still reads Kilo's index, it
 * just stops refreshing or writing the plugin's own.
 */
function assertIndexingEnabled(settings: { enabled?: boolean }): void {
  if (settings.enabled === false) {
    throw new Error(
      "Indexing is paused for this workspace. Re-enable it from the TUI footer indicator, " +
        '`/indexing-config set enabled true`, or by setting "enabled" in the plugin options.',
    )
  }
}

/** Max changed files that trigger an inline refresh on search. */
const AUTO_REFRESH_MAX_FILES = 200

async function maybeAutoRefresh(
  root: string,
  deps: ToolDeps,
  settings: IndexingSettings,
  qdrant: Qdrant,
): Promise<void> {
  // Cheap pre-check: diff the manifest against a bounded workspace scan.
  const { loadManifest, diffFiles } = await import("./manifest.ts")
  const { scanWorkspace } = await import("./scanner.ts")
  const manifest = await loadManifest(deps.kv, root)
  const scan = await scanWorkspace(root, {
    extensions: settings.fileExtensions,
    maxFileSizeBytes: settings.maxFileSizeBytes,
    maxFiles: AUTO_REFRESH_MAX_FILES + 1,
  })
  const diff = diffFiles(manifest, scan.files)
  const delta = diff.added.length + diff.maybeStale.length + diff.deleted.length
  if (delta === 0 || delta > AUTO_REFRESH_MAX_FILES) return
  await runIndex(
    { kv: deps.kv, root, settings, qdrant },
    { mode: "refresh", maxFiles: AUTO_REFRESH_MAX_FILES },
  )
}

function formatReport(kind: "refresh" | "build", report: {
  scanned: number
  newFiles: number
  changedFiles: number
  deletedFiles: number
  unchangedFiles: number
  chunksUpserted: number
  batches: number
  durationMs: number
  errors: string[]
  warnings: string[]
  imported?: { source: string; kind: string; chunks: number }
}): string {
  const lines = [
    `Index ${kind} finished in ${(report.durationMs / 1000).toFixed(1)}s.`,
  ]
  if (report.imported) {
    lines.push(
      `Imported ${report.imported.chunks} chunks from Kilo ${report.imported.kind} source ${report.imported.source} (no embedding calls).`,
    )
  }
  lines.push(
    `Files: ${report.scanned} scanned, ${report.newFiles} new, ${report.changedFiles} changed, ${report.deletedFiles} deleted, ${report.unchangedFiles} unchanged.`,
    `Chunks: ${report.chunksUpserted} upserted in ${report.batches} batch(es).`,
  )
  if (report.errors.length > 0) {
    lines.push(`Errors (${report.errors.length}): ${report.errors.slice(0, 5).join("; ")}${report.errors.length > 5 ? " …" : ""}`)
  }
  if (report.warnings.length > 0) {
    lines.push(
      `Warnings (${report.warnings.length}): ${report.warnings.slice(0, 5).join("; ")}${report.warnings.length > 5 ? " …" : ""} — the index is complete, but stale points may linger.`,
    )
  }
  return lines.join("\n")
}
