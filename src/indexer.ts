import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import * as path from "node:path"

import { chunkFile } from "./chunking.ts"
import { createEmbedder } from "./embedder.ts"
import { deleteRecords, diffFiles, emptyManifest, loadManifest, saveManifest, setRecord } from "./manifest.ts"
import { discoverKiloSources, importFromKilo } from "./import.ts"
import { createOwnStore, createSettingsQdrant, recreateOwnStore } from "./store-factory.ts"
import { scanWorkspace } from "./scanner.ts"
import { profileKey } from "./registry.ts"
import { recordWorkspace } from "./workspaces.ts"
import type { Qdrant } from "./qdrant.ts"
import type {
  Chunk,
  Embedder,
  FileEntry,
  IndexReport,
  IndexingSettings,
  KVStore,
  Manifest,
  QdrantPoint,
} from "./types.ts"
import type { VectorStoreAdapter } from "./vector-store.ts"
import { CHUNK_NAMESPACE, uuidv5 } from "./uuid.ts"

export interface IndexerDeps {
  kv: KVStore
  root: string
  settings: IndexingSettings
  /** Own-index adapter; created from settings when omitted. */
  store?: VectorStoreAdapter
  /** Qdrant client (Kilo reads + import source discovery); created when omitted. */
  qdrant?: Qdrant
  embedder?: Embedder
  onProgress?: (update: {
    phase: string
    processed: number
    total: number
    detail?: string
  }) => void | Promise<void>
}

export interface IndexOptions {
  mode: "refresh" | "build"
  /** Delete the own collection/database and reindex everything. */
  rebuild?: boolean
  maxFiles?: number
  /** Disable the Kilo import for this run (overrides settings.importFromKilo). */
  skipImport?: boolean
}

function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}

async function tryRead(root: string, relPath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path.join(root, relPath))
  } catch {
    return undefined
  }
}

/**
 * Index the workspace into our own store.
 * - refresh: incremental (manifest diff).
 * - build: creates/validates the store; when `importFromKilo` is enabled and a
 *   compatible Kilo index exists, seeds from it WITHOUT embedding calls, then
 *   incrementally indexes the delta. Otherwise indexes everything from scratch.
 */
export async function runIndex(deps: IndexerDeps, options: IndexOptions): Promise<IndexReport> {
  const started = Date.now()
  const { kv, root, settings } = deps
  const store = deps.store ?? createOwnStore(settings, root)
  const qdrant = deps.qdrant ?? createSettingsQdrant(settings)
  const report: IndexReport = {
    mode: options.mode,
    scanned: 0,
    newFiles: 0,
    changedFiles: 0,
    deletedFiles: 0,
    unchangedFiles: 0,
    chunksUpserted: 0,
    batches: 0,
    durationMs: 0,
    errors: [],
    warnings: [],
  }

  let embedder = deps.embedder
  const getEmbedder = (): Embedder => (embedder ??= createEmbedder(settings))

  // Determine dimension (probe embedder if unknown).
  let dimension = settings.dimension
  const existingInfo = await store.info()
  if (!dimension && existingInfo.profile?.dimension) dimension = existingInfo.profile.dimension
  if (!dimension) {
    const probe = await getEmbedder().embed(["dimension probe"])
    dimension = probe[0]?.length ?? 0
    if (!dimension) throw new Error("Could not determine embedding dimension")
  }
  const profile = profileFor(settings, dimension)

  // Explicit rebuild: drop the store so ensure recreates it empty.
  if (options.rebuild) {
    await recreateOwnStore(store, settings, dimension, profile)
  }
  const infoAfterRebuild = options.rebuild ? await store.info() : existingInfo

  // Profile change since last index => full rebuild in a fresh store.
  let manifest = await loadManifest(kv, root)
  let forceFull = options.mode === "build" || options.rebuild === true
  if (infoAfterRebuild.exists && infoAfterRebuild.profile) {
    const stored = infoAfterRebuild.profile
    if (stored.provider !== profile.provider || stored.modelId !== profile.modelId || stored.dimension !== profile.dimension) {
      await recreateOwnStore(store, settings, dimension, profile)
      manifest = undefined
      forceFull = true
    }
  }
  if (
    manifest &&
    (manifest.profile.provider !== profile.provider ||
      manifest.profile.modelId !== profile.modelId ||
      manifest.profile.dimension !== profile.dimension)
  ) {
    manifest = undefined
    forceFull = true
  }

  const { created } = await store.ensure(dimension, profile)
  if (created) forceFull = true
  if (!manifest) manifest = emptyManifest(root, store.name, profile)

  // ---- Kilo import (build only, no API cost) ----
  const freshStore = created || (infoAfterRebuild.pointsCount ?? 0) === 0
  const shouldImport =
    options.mode === "build" &&
    options.rebuild !== true &&
    options.skipImport !== true &&
    settings.importFromKilo &&
    freshStore

  if (shouldImport) {
    await deps.onProgress?.({ phase: "importing", processed: 0, total: 0 })
    try {
      const sources = await discoverKiloSources(root, {
        qdrant,
        homeDir: undefined,
        targetProfile: profile,
      })
      const source = sources.find((item) => item.compatible) ?? sources[0]
      if (source && source.compatible) {
        const importReport = await importFromKilo({
          root,
          source,
          target: store,
          targetProfile: profile,
          qdrant,
          onProgress: (update) =>
            deps.onProgress?.({
              phase: "importing",
              processed: update.imported,
              total: update.total ?? 0,
            }),
        })
        report.chunksUpserted += importReport.imported
        report.batches += importReport.batches
        report.imported = { source: source.name, kind: source.kind, chunks: importReport.imported }
        // Seed the manifest so the incremental pass below only handles deltas.
        for (const [relPath, hash] of Object.entries(importReport.files)) {
          setRecord(manifest, relPath, { hash, size: -1, mtimeMs: 0, indexedAt: Date.now() })
        }
        manifest.collection = store.name
        forceFull = false
      } else if (source && !source.compatible) {
        report.errors.push(
          `Kilo index found (${source.name}) but its embedding profile does not match ${profile.provider}:${profile.modelId}:${profile.dimension}; indexing from scratch`,
        )
      }
    } catch (error) {
      report.errors.push(`import failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ---- Scan + diff ----
  await deps.onProgress?.({ phase: "scanning", processed: 0, total: 0 })
  const scan = await scanWorkspace(root, {
    extensions: settings.fileExtensions,
    maxFileSizeBytes: settings.maxFileSizeBytes,
    maxFiles: options.maxFiles,
  })
  report.scanned = scan.files.length

  // A truncated scan (maxFiles cap) is not authoritative: never treat unseen
  // files as deleted, or a capped refresh would purge the rest of the index.
  const truncated = scan.truncated === true
  const diff = diffFiles(manifest, scan.files)
  if (truncated) {
    diff.deleted = []
    report.notes = [
      ...(report.notes ?? []),
      `scan truncated at ${scan.files.length} files: deletion detection skipped for this run`,
    ]
  }
  report.deletedFiles = diff.deleted.length

  let toIndex: FileEntry[]
  if (forceFull) {
    toIndex = scan.files
    report.newFiles = diff.added.length
    report.changedFiles = Math.max(0, toIndex.length - report.newFiles)
    report.unchangedFiles = 0
  } else {
    const staleFiles: FileEntry[] = []
    for (const file of diff.maybeStale) {
      const buf = await tryRead(root, file.relPath)
      if (!buf) continue
      const hash = sha256Buffer(buf)
      const record = manifest.files[file.relPath]
      if (record && record.hash === hash) {
        record.mtimeMs = file.mtimeMs
        record.size = file.size
        diff.unchanged.push(file)
      } else {
        staleFiles.push(file)
      }
    }
    toIndex = [...diff.added, ...staleFiles]
    report.newFiles = diff.added.length
    report.changedFiles = staleFiles.length
    report.unchangedFiles = diff.unchanged.length
  }

  if (diff.deleted.length > 0) {
    try {
      await store.deleteByFilePaths(diff.deleted)
      deleteRecords(manifest, diff.deleted)
    } catch (error) {
      // Cleanup only: stale points for deleted files may linger, but no file
      // went unindexed, so this must not poison completion.
      report.warnings.push(`delete phase: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const total = toIndex.length

  // ---- Chunking ----
  const chunks: Chunk[] = []
  const perFile: Array<{ file: FileEntry; fileHash: string }> = []
  const chunkFailures = new Set<string>()
  await deps.onProgress?.({ phase: "chunking", processed: 0, total })
  let processed = 0
  for (const file of toIndex) {
    const buf = await tryRead(root, file.relPath)
    if (!buf) {
      report.errors.push(`read failed: ${file.relPath}`)
      chunkFailures.add(file.relPath)
      processed++
      continue
    }
    const fileHash = sha256Buffer(buf)
    const content = buf.toString("utf8")
    try {
      const fileChunks = await chunkFile(file.relPath, content, fileHash)
      chunks.push(...fileChunks)
    } catch (error) {
      report.errors.push(`chunk ${file.relPath}: ${error instanceof Error ? error.message : String(error)}`)
      chunkFailures.add(file.relPath)
    }
    perFile.push({ file, fileHash })
    processed++
    if (processed % 50 === 0) await deps.onProgress?.({ phase: "chunking", processed, total })
  }
  await deps.onProgress?.({ phase: "chunking", processed: total, total })

  // Remove stale points for changed files before inserting fresh ones.
  const changedPaths = perFile.map((entry) => entry.file.relPath)
  if (changedPaths.length > 0) {
    try {
      await store.deleteByFilePaths(changedPaths)
    } catch (error) {
      // Cleanup only: stale tail points for changed files may linger, but the
      // fresh chunks are still upserted below, so this is non-fatal.
      report.warnings.push(`clearing changed files: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ---- Embed + upsert ----
  const hashes = new Map(perFile.map((entry) => [entry.file.relPath, entry.fileHash]))
  const fileByRelPath = new Map(perFile.map((entry) => [entry.file.relPath, entry.file]))
  const batchSize = Math.max(1, settings.embeddingBatchSize)
  const embedderInstance = getEmbedder()

  // Track which files still have chunks pending in failed batches. A file is
  // only recorded in the manifest once every one of its chunks was upserted,
  // otherwise a failed batch would be silently "indexed" forever (a refresh
  // would skip it and never repair the gap).
  const pendingByFile = new Map<string, number>()
  for (const chunk of chunks) {
    pendingByFile.set(chunk.filePath, (pendingByFile.get(chunk.filePath) ?? 0) + 1)
  }
  const completedFiles = new Set<string>()

  const recordCompleted = () => {
    for (const relPath of completedFiles) {
      const file = fileByRelPath.get(relPath)
      const hash = hashes.get(relPath)
      if (!file || !hash) continue
      setRecord(manifest, relPath, { hash, size: file.size, mtimeMs: file.mtimeMs, indexedAt: Date.now() })
    }
  }

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize)
    let succeeded = false
    try {
      const vectors = await embedderInstance.embed(
        batch.map((chunk) => chunk.content),
        { asQuery: false },
      )
      if (vectors.length !== batch.length) {
        throw new Error(`embedding count mismatch (${vectors.length} != ${batch.length})`)
      }
      const points: QdrantPoint[] = batch.map((chunk, index) => ({
        id: uuidv5(chunk.segmentHash, CHUNK_NAMESPACE),
        vector: vectors[index]!,
        payload: {
          filePath: chunk.filePath,
          fileHash: chunk.fileHash,
          codeChunk: chunk.content,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          segmentHash: chunk.segmentHash,
        },
      }))
      await store.upsert(points)
      report.chunksUpserted += points.length
      report.batches++
      succeeded = true
    } catch (error) {
      report.errors.push(`batch ${Math.floor(i / batchSize) + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }

    for (const chunk of batch) {
      if (!succeeded) continue
      const remaining = (pendingByFile.get(chunk.filePath) ?? 1) - 1
      pendingByFile.set(chunk.filePath, remaining)
      if (remaining <= 0) completedFiles.add(chunk.filePath)
    }

    recordCompleted()
    manifest.collection = store.name
    await saveManifest(kv, manifest)
    await deps.onProgress?.({
      phase: "embedding",
      processed: Math.min(i + batch.length, chunks.length),
      total: chunks.length,
    })
  }

  // Files whose chunks all succeeded (including files that produced no chunks
  // legitimately). Files that failed to read or chunk stay unrecorded so the
  // next refresh retries them.
  for (const { file } of perFile) {
    if (chunkFailures.has(file.relPath)) continue
    if ((pendingByFile.get(file.relPath) ?? 0) <= 0) completedFiles.add(file.relPath)
  }
  recordCompleted()
  manifest.lastRun = Date.now()
  // Only fatal errors (files left unindexed) mark the run incomplete; cleanup
  // warnings do not, because every file's fresh chunks were still upserted.
  const complete = report.errors.length === 0
  manifest.complete = complete
  await saveManifest(kv, manifest)

  try {
    await store.markComplete(profile, complete, dimension)
  } catch (error) {
    report.errors.push(`mark complete: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Registry: a collection name is a one-way hash of the root, so remember the
  // mapping that makes the store nameable (and forgettable) later on. Recorded
  // even when files failed: the store exists and must stay discoverable.
  try {
    recordWorkspace({
      root,
      store: store.name,
      kind: store.kind,
      profile: profileKey(profile),
      updatedAt: new Date().toISOString(),
    })
  } catch {
    // Best-effort only: never fail a finished run over bookkeeping.
  }

  report.durationMs = Date.now() - started
  await deps.onProgress?.({ phase: "done", processed: total, total })
  return report
}

function profileFor(settings: IndexingSettings, dimension: number) {
  return { provider: settings.provider, modelId: settings.modelId, dimension }
}
