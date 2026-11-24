import * as fs from "node:fs"
import * as path from "node:path"

import { createQdrant, type Qdrant } from "./qdrant.ts"
import { getKiloStoreInfo, resolveKiloCollection } from "./kilo-store.ts"
import { readLanceDbInfoAt, openLanceDbReader, lanceDbNames, type LanceDbReader } from "./lancedb-store.ts"
import { kiloLanceDbDirectories } from "./settings.ts"
import { VALID_PROVIDERS } from "./config.ts"
import type { KiloConfigIndexing } from "./kilo-config.ts"
import { mainWorktree } from "./worktree.ts"
import { recordWorkspace } from "./workspaces.ts"
import { describeError } from "./errors.ts"
import type { EmbeddingProfile, QdrantPoint, IndexReport } from "./types.ts"
import type { VectorStoreAdapter } from "./vector-store.ts"
import { profileKey } from "./registry.ts"

/**
 * Import engine: copies chunk points (vectors + payloads) from a Kilo Code
 * index into the plugin's own store WITHOUT calling any embedding API.
 *
 * Sources:
 *  - Kilo Qdrant collection  (`ws-<hash16>`)
 *  - Kilo LanceDB database   (`<basename>-<hash16>` under Kilo's state dir)
 *
 * When `root` is a linked git worktree, the main worktree's index is discovered
 * as well (`role: "baseline"`), next to the one this checkout has (`role:
 * "delta"`): Kilo indexed the main checkout, and the linked one is usually
 * empty until something indexes it on its own.
 *
 * Compatibility: the embedding profile (provider:model:dimension) must match
 * the destination profile; mismatched vectors are never copied.
 */

/** Why a Kilo source cannot be imported as-is. */
export type KiloSourceReason = "profile" | "schema" | "provider"

/** Which checkout a source belongs to when the workspace is a linked worktree. */
export type KiloSourceRole = "baseline" | "delta"

export interface KiloSourceInfo {
  kind: "qdrant" | "lancedb"
  /** Collection name or database path. */
  name: string
  pointsCount: number | null
  profile?: EmbeddingProfile
  complete?: boolean | null
  schema?: number | null
  compatible: boolean
  /**
   * Why `compatible` is false. `provider` is a provider this plugin cannot
   * embed with at all, `schema` a Kilo index layout it does not read, and
   * `profile` a different provider:model:dimension than the target.
   */
  reason?: KiloSourceReason
  /** Set only when the workspace is a linked worktree; see above. */
  role?: KiloSourceRole
}

export interface ImportReport {
  source: KiloSourceInfo
  imported: number
  batches: number
  skipped: number
  durationMs: number
  errors: string[]
  /** Unique files seen during the import (relPath -> fileHash), for manifest seeding. */
  files: Record<string, string>
}

/** Read-only description of Kilo sources available for a workspace. */
export async function discoverKiloSources(
  root: string,
  options: {
    qdrant?: Qdrant
    /** Single LanceDB root (legacy); `lancedbDirectories` wins when both are set. */
    lancedbDirectory?: string
    /** Candidate LanceDB roots; overrides the default Kilo locations. */
    lancedbDirectories?: string[]
    homeDir?: string
    /** Effective Kilo config for this workspace (store, paths, Qdrant). */
    kiloConfig?: KiloConfigIndexing
    /** Main worktree to read the full index from when `root` is a linked worktree. */
    baselineRoot?: string
    targetProfile?: EmbeddingProfile
    /**
     * Called when a source exists but could not be read.
     *
     * A backend that is down and a source that does not exist look identical
     * once the error is swallowed, and both are reported to the user as "no Kilo
     * index found". That is a wrong answer in the first case: the index is
     * sitting on disk, and what is missing is a native module or a running
     * server. The caller decides where the message surfaces.
     */
    onProblem?: (message: string) => void
  },
): Promise<KiloSourceInfo[]> {
  const sources: KiloSourceInfo[] = []
  const seen = new Set<string>()
  const reported = new Set<string>()
  const problem = (message: string): void => {
    // Both checkouts can hit the same outage; one line per distinct cause is
    // enough to explain why discovery came back empty.
    if (reported.has(message)) return
    reported.add(message)
    options.onProblem?.(message)
  }

  /**
   * Why a source cannot be imported, if it cannot.
   *
   * The reason replaces a bare boolean because the remedies differ: a different
   * profile is fixed by switching the model, an unsupported provider or a newer
   * index schema is not.
   */
  const incompatibility = (profile?: EmbeddingProfile, schema?: number | null): KiloSourceReason | undefined => {
    // A provider this plugin has no embedder for can never be reused, whatever
    // the target is, so this check does not depend on having one.
    if (profile && !VALID_PROVIDERS.includes(profile.provider)) return "provider"
    // Schemas 1 and 2 are the layouts Kilo writes; anything else is newer than
    // what this reads. Absent is treated as readable.
    if (schema !== null && schema !== undefined && schema !== 1 && schema !== 2) return "schema"
    if (!options.targetProfile || !profile) return undefined
    return profileKey(profile) === profileKey(options.targetProfile) ? undefined : "profile"
  }

  // A linked worktree shares the repository but not its index. The baseline
  // comes from the main checkout, which is what Kilo actually indexed.
  const baselineRoot = options.baselineRoot ?? mainWorktree(root)
  const targets: Array<{ root: string; role?: KiloSourceRole }> =
    baselineRoot && path.resolve(baselineRoot) !== path.resolve(root)
      ? [
          { root: baselineRoot, role: "baseline" },
          { root, role: "delta" },
        ]
      : [{ root }]

  /** Append once: baseline and delta can resolve to the same collection/path. */
  const add = (source: KiloSourceInfo, role?: KiloSourceRole): void => {
    const key = `${source.kind}\u0000${source.name}`
    if (seen.has(key)) return
    seen.add(key)
    sources.push(role ? { ...source, role } : source)
  }

  // Qdrant source(s)
  let client: Qdrant | undefined
  try {
    const url = options.kiloConfig?.qdrant?.url?.trim() || "http://localhost:6333"
    const apiKey = options.kiloConfig?.qdrant?.apiKey?.trim() || undefined
    client = options.qdrant ?? createQdrant({ url, apiKey })
  } catch (error) {
    problem(`Could not reach the Qdrant server to look for a Kilo index: ${describeError(error)}`)
  }
  if (client) {
    for (const target of targets) {
      try {
        const collection = await resolveKiloCollection(client, target.root)
        if (!collection) continue
        const info = await getKiloStoreInfo(client, collection)
        const schema = info.schema ?? null
        const reason = incompatibility(info.profile, schema)
        add(
          {
            kind: "qdrant",
            name: collection,
            pointsCount: info.pointsCount,
            profile: info.profile,
            complete: info.complete ?? null,
            schema,
            compatible: reason === undefined,
            reason,
          },
          target.role,
        )
      } catch (error) {
        // A backend that answers with no matching collection is not a failure; a
        // backend that never answered is.
        problem(`Could not reach the Qdrant server to look for a Kilo index: ${describeError(error)}`)
      }
    }
  }

  // LanceDB source(s). An explicit directory in Kilo's config is authoritative:
  // probing the defaults after it is how a database left behind by a store
  // switch gets imported instead of the one Kilo actually writes.
  const configured = options.kiloConfig?.lancedb?.directory?.trim()
  const directories =
    options.lancedbDirectories ??
    (configured
      ? [path.resolve(root, configured)]
      : options.lancedbDirectory
        ? [options.lancedbDirectory]
        : kiloLanceDbDirectories(options.homeDir))
  const roots = [...new Set(directories.map((directory) => path.resolve(directory)))]
  for (const target of targets) {
    for (const directory of roots) {
      // Probe every spelling of the workspace path; the first database that
      // exists is the one Kilo wrote for this directory.
      for (const name of lanceDbNames(target.root)) {
        const dbPath = path.join(directory, name)
        if (!fs.existsSync(dbPath)) continue
        try {
          const info = await readLanceDbInfoAt(dbPath)
          if (!info.vectorExists) break
          const schema = info.schema ?? null
          const reason = incompatibility(info.profile, schema)
          add(
            {
              kind: "lancedb",
              name: dbPath,
              pointsCount: info.pointsCount,
              profile: info.profile,
              complete: info.complete ?? null,
              schema,
              compatible: reason === undefined,
              reason,
            },
            target.role,
          )
        } catch (error) {
          // The directory is there, so this is "found but unreadable", never
          // "not indexed". Say so, with the reason.
          problem(`A Kilo LanceDB index exists at ${dbPath} but could not be read: ${describeError(error)}`)
        }
        break
      }
    }
  }

  return sources
}

/**
 * One Kilo backend per workspace, never a mix of a new store and a stale one.
 *
 * Kilo writes either Qdrant or LanceDB. Both may exist on disk after a switch,
 * and importing/searching both would duplicate or resurrect old chunks. The
 * configured store wins; without a config, LanceDB is Kilo's current default.
 * If the configured store has no source at all, the other one is used so an
 * older Kilo setup still works.
 */
export function selectKiloSources(
  sources: readonly KiloSourceInfo[],
  configuredStore?: string | null,
): KiloSourceInfo[] {
  const kinds = new Set(sources.map((source) => source.kind))
  const configured =
    configuredStore === "qdrant" || configuredStore === "lancedb" ? configuredStore : undefined
  const kind = configured && kinds.has(configured) ? configured : kinds.has("lancedb") ? "lancedb" : kinds.has("qdrant") ? "qdrant" : undefined
  return kind ? sources.filter((source) => source.kind === kind) : []
}

export interface ImportOptions {
  root: string
  source: KiloSourceInfo
  target: VectorStoreAdapter
  targetProfile: EmbeddingProfile
  batchLimit?: number
  onProgress?: (update: { imported: number; total: number | null }) => void | Promise<void>
  /** Qdrant client for qdrant sources (created on demand when omitted). */
  qdrant?: Qdrant
  qdrantUrl?: string
  qdrantApiKey?: string
  /** LanceDB reader factory for lancedb sources (opened on demand when omitted). */
  lanceDbReader?: (dbPath: string) => Promise<LanceDbReader | null>
  /**
   * Files already imported from a more authoritative source.
   *
   * A linked worktree imports its own (delta) index first and the main
   * checkout's baseline second. Every file the delta already covers is skipped
   * here instead of being copied again with the older baseline hash.
   */
  skipFiles?: ReadonlySet<string>
}

/**
 * Why a source was refused, in the terms of what actually fixes it.
 *
 * A profile mismatch is fixed by switching the model; a provider this plugin
 * has no embedder for and a newer index schema are not.
 */
function incompatibleSourceError(source: KiloSourceInfo, targetProfile: EmbeddingProfile): Error {
  const label = `${source.kind} ${source.name}`
  switch (source.reason) {
    case "provider":
      return new Error(
        `Kilo index (${label}) was built with the ${source.profile?.provider ?? "unknown"} embedding provider, ` +
          `which this plugin cannot embed with. Re-index this workspace in Kilo with a supported provider, or index it from scratch.`,
      )
    case "schema":
      return new Error(
        `Kilo index (${label}) uses index schema ${source.schema ?? "unknown"}; this build reads schemas 1 and 2. ` +
          `Rebuild the Kilo index, or update the plugin.`,
      )
    default:
      return new Error(
        `Kilo index profile (${source.profile ? profileKey(source.profile) : "unknown"}) does not match the target profile ` +
          `(${profileKey(targetProfile)}). Re-index with matching settings or switch the embedding model.`,
      )
  }
}

/**
 * Copy every chunk point from the source into `target`.
 * Vectors are copied verbatim; no embedding API is involved.
 *
 * The caller must have created `target` first, with `target.ensure(dimension,
 * profile)`. Skipping that step does not fail here: it surfaces later as a bare
 * "collection doesn't exist" on the first upsert.
 *
 * Throws when the import copied nothing, rather than reporting an empty run.
 */
export async function importFromKilo(options: ImportOptions): Promise<ImportReport> {
  const started = Date.now()
  const { root, source, target, targetProfile } = options
  const batchLimit = options.batchLimit ?? 500
  const skipFiles = options.skipFiles
  // Points dropped because a more authoritative source already imported their
  // file. Unlike an invalid payload this is not a failed read, so an
  // all-filtered pass is a complete answer rather than an empty import.
  let filtered = 0
  const report: ImportReport = {
    source,
    imported: 0,
    batches: 0,
    skipped: 0,
    durationMs: 0,
    errors: [],
    files: {},
  }

  if (!source.compatible) throw incompatibleSourceError(source, targetProfile)

  if (source.kind === "qdrant") {
    const client = options.qdrant ?? createQdrant({ url: options.qdrantUrl ?? "http://localhost:6333", apiKey: options.qdrantApiKey })
    let cursor: unknown
    for (;;) {
      const page = await client.scroll(source.name, {
        filter: { must_not: [{ key: "type", match: { value: "metadata" } }] },
        limit: batchLimit,
        withPayload: true,
        withVector: true,
        offset: cursor,
      })
      const points: QdrantPoint[] = []
      for (const point of page.points) {
        if (!point.vector || !point.payload || !isChunkPayload(point.payload)) {
          report.skipped++
          continue
        }
        const filePath = point.payload.filePath
        if (typeof filePath === "string" && skipFiles?.has(filePath)) {
          filtered++
          report.skipped++
          continue
        }
        points.push({
          id: typeof point.id === "string" ? point.id : String(point.id),
          vector: point.vector,
          payload: point.payload,
        })
        const fileHash = point.payload.fileHash
        if (typeof filePath === "string" && typeof fileHash === "string") {
          report.files[filePath] = fileHash
        }
      }
      if (points.length > 0) {
        await target.upsert(points)
        report.imported += points.length
        report.batches++
        await options.onProgress?.({ imported: report.imported, total: source.pointsCount })
      }
      if (page.next === undefined || page.next === null) break
      cursor = page.next
    }
  } else {
    const openReader = options.lanceDbReader ?? openLanceDbReader
    const reader = await openReader(source.name)
    if (reader) {
      // One connection for the whole import, released even when a page or the
      // destination upsert fails.
      try {
        for (;;) {
          const page = await reader.next(batchLimit)
          const points = skipFiles
            ? page.points.filter((point) => {
                const filePath = point.payload.filePath
                return !(typeof filePath === "string" && skipFiles.has(filePath))
              })
            : page.points
          const dropped = page.points.length - points.length
          if (dropped > 0) {
            filtered += dropped
            report.skipped += dropped
          }
          if (points.length > 0) {
            await target.upsert(points)
            report.imported += points.length
            report.batches++
            for (const point of points) {
              const filePath = point.payload.filePath
              const fileHash = point.payload.fileHash
              if (typeof filePath === "string" && typeof fileHash === "string") {
                report.files[filePath] = fileHash
              }
            }
            await options.onProgress?.({ imported: report.imported, total: source.pointsCount })
          }
          if (page.done) break
        }
      } finally {
        reader.close()
      }
    }
  }

  if (report.imported === 0 && filtered > 0) {
    // Every point belonged to a file another source already imported. That is
    // a complete answer, not a failed read: it must not become an error, and it
    // must not claim completion on the shared store either.
    report.durationMs = Date.now() - started
    return report
  }

  if (report.imported === 0) {
    // Marking complete here would turn a silent failure into a healthy-looking
    // empty index: the manifest would claim the workspace is fully indexed
    // while holding nothing, and the freshness check would agree with it.
    throw new Error(
      `Imported 0 chunks from ${source.kind} ${source.name}, which reports ` +
        `${source.pointsCount ?? "?"} points. Either the payload shape is not recognised, or every point was ` +
        `filtered out as metadata. Nothing was written.`,
    )
  }

  await target.markComplete(targetProfile, true, targetProfile.dimension)

  // Registry: the store name is a one-way hash of the root, so remember the
  // mapping that makes it nameable (and forgettable) later on.
  try {
    recordWorkspace({
      root,
      store: target.name,
      kind: target.kind,
      profile: profileKey(targetProfile),
      updatedAt: new Date().toISOString(),
    })
  } catch {
    // Best-effort only: never fail a finished import over bookkeeping.
  }

  report.durationMs = Date.now() - started
  return report
}

/** Build a report-shaped object for an import (used by the build tool). */
export function importReportToIndexReport(report: ImportReport): IndexReport {
  return {
    mode: "build",
    scanned: report.source.pointsCount ?? report.imported + report.skipped,
    newFiles: 0,
    changedFiles: 0,
    deletedFiles: 0,
    unchangedFiles: 0,
    chunksUpserted: report.imported,
    batches: report.batches,
    durationMs: report.durationMs,
    errors: [...report.errors],
    warnings: [],
  }
}

function isChunkPayload(payload: Record<string, unknown>): boolean {
  return ["filePath", "fileHash", "codeChunk", "startLine", "endLine"].every((key) => key in payload)
}
