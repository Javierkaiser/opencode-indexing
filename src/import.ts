import * as fs from "node:fs"
import * as path from "node:path"

import { createQdrant, type Qdrant } from "./qdrant.ts"
import { getKiloStoreInfo, resolveKiloCollection } from "./kilo-store.ts"
import { readLanceDbInfoAt, readLanceDbBatch, lanceDbName } from "./lancedb-store.ts"
import { kiloLanceDbDirectory } from "./settings.ts"
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
 * Compatibility: the embedding profile (provider:model:dimension) must match
 * the destination profile; mismatched vectors are never copied.
 */

export interface KiloSourceInfo {
  kind: "qdrant" | "lancedb"
  /** Collection name or database path. */
  name: string
  pointsCount: number | null
  profile?: EmbeddingProfile
  complete?: boolean | null
  schema?: number | null
  compatible: boolean
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
    lancedbDirectory?: string
    homeDir?: string
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
  const problem = options.onProblem ?? ((): void => {})
  const isCompatible = (profile?: EmbeddingProfile): boolean => {
    if (!options.targetProfile || !profile) return true
    return profileKey(profile) === profileKey(options.targetProfile)
  }

  // Qdrant source
  try {
    const client = options.qdrant ?? createQdrant({ url: "http://localhost:6333" })
    const collection = await resolveKiloCollection(client, root)
    if (collection) {
      const info = await getKiloStoreInfo(client, collection)
      sources.push({
        kind: "qdrant",
        name: collection,
        pointsCount: info.pointsCount,
        profile: info.profile,
        complete: info.complete ?? null,
        schema: info.schema ?? null,
        compatible: isCompatible(info.profile),
      })
    }
  } catch (error) {
    // A backend that answers with no matching collection is not a failure; a
    // backend that never answered is.
    problem(`Could not reach the Qdrant server to look for a Kilo index: ${describeError(error)}`)
  }

  // LanceDB source
  const directory = options.lancedbDirectory ?? kiloLanceDbDirectory(options.homeDir)
  const dbPath = path.join(directory, lanceDbName(root))
  if (fs.existsSync(dbPath)) {
    try {
      const info = await readLanceDbInfoAt(dbPath)
      if (info.vectorExists) {
        sources.push({
          kind: "lancedb",
          name: dbPath,
          pointsCount: info.pointsCount,
          profile: info.profile,
          complete: info.complete ?? null,
          schema: info.schema ?? null,
          compatible: isCompatible(info.profile),
        })
      }
    } catch (error) {
      // The directory is there, so this is "found but unreadable", never
      // "not indexed". Say so, with the reason.
      problem(`A Kilo LanceDB index exists at ${dbPath} but could not be read: ${describeError(error)}`)
    }
  }

  return sources
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
  const report: ImportReport = {
    source,
    imported: 0,
    batches: 0,
    skipped: 0,
    durationMs: 0,
    errors: [],
    files: {},
  }

  if (!source.compatible) {
    throw new Error(
      `Kilo index profile (${source.profile ? profileKey(source.profile) : "unknown"}) does not match the target profile ` +
        `(${profileKey(targetProfile)}). Re-index with matching settings or switch the embedding model.`,
    )
  }

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
        points.push({
          id: typeof point.id === "string" ? point.id : String(point.id),
          vector: point.vector,
          payload: point.payload,
        })
        const filePath = point.payload.filePath
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
    let offset = 0
    for (;;) {
      const page = await readLanceDbBatch(source.name, { limit: batchLimit, offset })
      if (page.points.length > 0) {
        await target.upsert(page.points)
        report.imported += page.points.length
        report.batches++
        for (const point of page.points) {
          const filePath = point.payload.filePath
          const fileHash = point.payload.fileHash
          if (typeof filePath === "string" && typeof fileHash === "string") {
            report.files[filePath] = fileHash
          }
        }
        await options.onProgress?.({ imported: report.imported, total: source.pointsCount })
      }
      offset += page.points.length
      if (page.done) break
    }
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
