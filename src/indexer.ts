import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import * as path from "node:path"

import { chunkFile } from "./chunking.ts"
import { mapConcurrent } from "./concurrency.ts"
import { createEmbedder } from "./embedder.ts"
import { deleteRecords, diffFiles, emptyManifest, loadManifest, saveManifest, setRecord } from "./manifest.ts"
import {
  discoverKiloSources,
  importFromKilo,
  type ImportReport,
  type KiloSourceInfo,
  type KiloSourceRole,
} from "./import.ts"
import { createOwnStore, createSettingsQdrant, recreateOwnStore } from "./store-factory.ts"
import { scanWorkspace } from "./scanner.ts"
import { profileKey } from "./registry.ts"
import { recordWorkspace } from "./workspaces.ts"
import type { Qdrant } from "./qdrant.ts"
import type {
  Chunk,
  Embedder,
  EmbeddingProfile,
  FileEntry,
  IndexReport,
  IndexingSettings,
  KVStore,
  Manifest,
  QdrantPoint,
} from "./types.ts"
import type { VectorStoreAdapter } from "./vector-store.ts"
import { CHUNK_NAMESPACE, uuidv5 } from "./uuid.ts"
import { describeError } from "./errors.ts"

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

/** Store-delete calls carry at most this many paths (Qdrant request limits). */
const DELETE_BATCH_SIZE = 500
/** Minimum time between manifest writes while batches are still running. */
const MANIFEST_SAVE_INTERVAL_MS = 2000
/** …or every N batches, whichever comes first. */
const MANIFEST_SAVE_EVERY_BATCHES = 10
/** Parallel `stat` calls while seeding an imported manifest. */
const IMPORT_STAT_CONCURRENCY = 32

/**
 * How many embedding batches may be in flight at once.
 *
 * A local model already saturates the machine, so it stays sequential; hosted
 * providers tolerate a few requests in flight before rate limits answer with
 * 429s. `KILO_INDEX_EMBEDDING_CONCURRENCY` overrides both when set to a
 * positive integer.
 */
export function embeddingConcurrency(settings: IndexingSettings): number {
  const override = Number.parseInt(process.env.KILO_INDEX_EMBEDDING_CONCURRENCY ?? "", 10)
  if (Number.isFinite(override) && override > 0) return override
  return settings.provider === "local" ? 1 : 3
}

/**
 * Seed manifest records from an imported Kilo index.
 *
 * The import knows each file's hash but not its size/mtime. Recording `-1/0`
 * makes every later refresh re-hash the whole workspace, so one bounded `stat`
 * pass fills in the real values; files that vanished keep `-1/0` and are
 * re-checked by the next scan.
 *
 * `verifyAll` keeps every record at `-1/0` instead: hashes imported from the
 * main worktree's baseline describe another checkout, so the scan that follows
 * has to read the worktree's files to confirm them.
 */
export async function seedImportedManifest(
  manifest: Manifest,
  root: string,
  files: Record<string, string>,
  options: { verifyAll?: boolean } = {},
): Promise<void> {
  const seeded = await mapConcurrent(
    Object.entries(files),
    IMPORT_STAT_CONCURRENCY,
    async ([relPath, hash]) => {
      const indexedAt = Date.now()
      if (options.verifyAll) {
        return [relPath, { hash, size: -1, mtimeMs: 0, indexedAt }] as const
      }
      try {
        const stats = await stat(path.join(root, relPath))
        return [relPath, { hash, size: stats.size, mtimeMs: stats.mtimeMs, indexedAt }] as const
      } catch {
        return [relPath, { hash, size: -1, mtimeMs: 0, indexedAt }] as const
      }
    },
  )
  for (const [relPath, record] of seeded) setRecord(manifest, relPath, record)
}

/** One import step: a source plus the role whose files it must not copy again. */
export interface KiloImportStep {
  source: KiloSourceInfo
  skipRole?: KiloSourceRole
}

export interface KiloImportPlan {
  /** Sources to import, in order. Empty when nothing can be imported. */
  steps: KiloImportStep[]
  /** Seed every imported file as stale so the following scan re-hashes it. */
  verifyAll: boolean
  /** Non-fatal notices for the report (a role missing from the worktree pair). */
  warnings: string[]
  /** Why no source can be imported, when sources were found but refused. */
  unavailable?: string
}

/**
 * Decide what a build imports from Kilo, and in which order.
 *
 * A linked worktree has two sources: the delta indexed from the worktree
 * itself, and the baseline from the main checkout that Kilo usually indexed.
 * The delta goes first and the baseline skips its files, so the hashes that
 * reach the manifest describe this checkout rather than the main one.
 */
export function planKiloImport(
  sources: readonly KiloSourceInfo[],
  targetProfile?: EmbeddingProfile,
): KiloImportPlan {
  const compatible = sources.filter((source) => source.compatible)
  const worktree = sources.some((source) => source.role !== undefined)

  if (!worktree) {
    // One workspace, one index: the old choice (first compatible) still holds.
    const first = compatible[0]
    if (first) return { steps: [{ source: first }], verifyAll: false, warnings: [] }
    return {
      steps: [],
      verifyAll: false,
      warnings: [],
      unavailable: sources[0] ? unavailableMessage(sources[0], targetProfile) : undefined,
    }
  }

  const delta = compatible.find((source) => source.role === "delta")
  const baseline = compatible.find((source) => source.role === "baseline")

  if (delta && baseline) {
    return {
      steps: [{ source: delta }, { source: baseline, skipRole: "delta" }],
      // The delta's hashes describe this checkout, but the baseline's describe
      // the main one. A file that changed here without being re-indexed in Kilo
      // would otherwise be seeded with a hash the scan trusts and never
      // verifies; re-hash everything once instead.
      verifyAll: true,
      warnings: [],
    }
  }
  if (baseline) {
    return {
      steps: [{ source: baseline }],
      // The baseline describes the main checkout: its hashes cannot be trusted
      // for this one, so every record is seeded stale and the scan re-reads it.
      verifyAll: true,
      warnings: [
        "the worktree's Kilo delta index is unavailable, so only the main checkout's baseline is imported; " +
          "files changed in this worktree are re-indexed by the scan that follows",
      ],
    }
  }
  if (delta) {
    return {
      steps: [{ source: delta }],
      verifyAll: false,
      warnings: [
        "the main checkout's Kilo baseline index is unavailable, so only this worktree's delta is imported; " +
          "the rest of the workspace is indexed by the scan that follows",
      ],
    }
  }

  // Neither checkout is importable. The delta is the more actionable one to
  // name: it is what this workspace would use, and a profile fix can enable it.
  const unusable =
    sources.find((source) => source.role === "delta" && source.reason) ??
    sources.find((source) => source.role === "baseline" && source.reason) ??
    sources.find((source) => source.reason)
  return {
    steps: [],
    verifyAll: false,
    warnings: [],
    unavailable: unusable ? unavailableMessage(unusable, targetProfile) : undefined,
  }
}

/** Why a refused source is refused, and what the user can do about it. */
function unavailableMessage(source: KiloSourceInfo, targetProfile?: EmbeddingProfile): string {
  const label = `${source.kind} ${source.name}${source.role ? `, ${source.role}` : ""}`
  switch (source.reason) {
    case "provider":
      return (
        `Kilo index found (${label}) but it was built with the ${source.profile?.provider ?? "unknown"} embedding provider, ` +
        `which this plugin cannot embed with; indexing from scratch`
      )
    case "schema":
      return (
        `Kilo index found (${label}) but it uses index schema ${source.schema ?? "unknown"}, ` +
        `which this build does not read (1/2); indexing from scratch`
      )
    default:
      return (
        `Kilo index found (${label}) but its embedding profile does not match ` +
        `${targetProfile ? profileKey(targetProfile) : "the configured model"}; indexing from scratch`
      )
  }
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
 *   compatible Kilo index exists, seeds from it WITHOUT embedding calls — both
 *   checkouts when the workspace is a linked worktree — then incrementally
 *   indexes what the import did not cover. Otherwise indexes everything from
 *   scratch.
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
  const existingProfile = existingInfo.profile
  // The stored dimension is only authoritative for the profile we are about to
  // write. Inheriting it across a provider change is how a 1536-wide Mistral
  // index makes an OpenAI model look 1536-dimensional: the probe that would
  // have asked the provider never runs, and the inherited number is then
  // persisted as though it had been measured, which makes the mismatch
  // self-consistent and undetectable on every later run.
  const sameProfile =
    existingProfile !== undefined &&
    existingProfile.provider === settings.provider &&
    existingProfile.modelId === settings.modelId
  if (!dimension && sameProfile && existingProfile?.dimension) dimension = existingProfile.dimension
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
      // Collected rather than thrown: discovery no longer fails on an
      // unreadable source, and the caller has to be told why the scan below is
      // about to re-embed the whole workspace at their expense.
      const problems: string[] = []
      const sources = await discoverKiloSources(root, {
        qdrant,
        homeDir: undefined,
        targetProfile: profile,
        onProblem: (message) => problems.push(message),
      })
      const plan = planKiloImport(sources, profile)
      report.warnings.push(...plan.warnings)
      if (plan.unavailable) {
        report.errors.push(plan.unavailable)
      } else if (plan.steps.length === 0 && problems.length > 0) {
        // No usable source and a reason why. Without this the build reads as a
        // workspace that has no Kilo index at all, and the full re-embedding
        // that follows looks like the normal path rather than the expensive
        // fallback it is.
        report.errors.push(`${problems.join(" · ")} Indexing from scratch instead.`)
      }

      // Files imported per role, so a later baseline can skip what the delta
      // already covers instead of copying the older hashes over it.
      const filesByRole = new Map<KiloSourceRole, Record<string, string>>()
      const imported: ImportReport[] = []
      for (const step of plan.steps) {
        const skipped = step.skipRole ? filesByRole.get(step.skipRole) : undefined
        try {
          const importReport = await importFromKilo({
            root,
            source: step.source,
            target: store,
            targetProfile: profile,
            qdrant,
            skipFiles: skipped ? new Set(Object.keys(skipped)) : undefined,
            onProgress: (update) =>
              deps.onProgress?.({
                phase: "importing",
                processed: update.imported,
                total: update.total ?? 0,
              }),
          })
          imported.push(importReport)
          if (step.source.role) {
            filesByRole.set(step.source.role, { ...filesByRole.get(step.source.role), ...importReport.files })
          }
          report.chunksUpserted += importReport.imported
          report.batches += importReport.batches
        } catch (error) {
          // One refused source must not discard the other's work: the delta of
          // a worktree is still worth importing when its baseline fails.
          const role = step.source.role ? ` (${step.source.role})` : ""
          report.errors.push(`import failed${role}: ${describeError(error)}`)
        }
      }

      if (imported.length > 0) {
        // Delta hashes win: they were indexed from this checkout, while the
        // baseline describes the main one.
        const files: Record<string, string> = {}
        for (const entry of imported) if (entry.source.role !== "delta") Object.assign(files, entry.files)
        for (const entry of imported) if (entry.source.role === "delta") Object.assign(files, entry.files)
        await seedImportedManifest(manifest, root, files, { verifyAll: plan.verifyAll })
        manifest.collection = store.name
        forceFull = false
        const primary = imported.find((entry) => entry.source.role === "delta") ?? imported[0]!
        report.imported = { source: primary.source.name, kind: primary.source.kind, chunks: primary.imported }
        report.importedSources = imported.map((entry) => ({
          source: entry.source.name,
          kind: entry.source.kind,
          chunks: entry.imported,
          ...(entry.source.role ? { role: entry.source.role } : {}),
        }))
      }
    } catch (error) {
      report.errors.push(`import failed: ${describeError(error)}`)
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

  /**
   * Delete points for `paths` in store-sized chunks.
   *
   * Best effort: a failed chunk is warned about and its files are left for a
   * later run; only the chunks the store accepted are reported back, so the
   * manifest drops exactly the records whose points are gone.
   */
  const deletePathsInBatches = async (paths: readonly string[], label: string): Promise<string[]> => {
    const deleted: string[] = []
    for (let i = 0; i < paths.length; i += DELETE_BATCH_SIZE) {
      const batch = paths.slice(i, i + DELETE_BATCH_SIZE)
      try {
        await store.deleteByFilePaths(batch)
        deleted.push(...batch)
      } catch (error) {
        report.warnings.push(`${label}: ${describeError(error)}`)
      }
    }
    return deleted
  }

  if (diff.deleted.length > 0) {
    // Cleanup only: stale points for deleted files may linger, but no file
    // went unindexed, so this must not poison completion.
    const deleted = await deletePathsInBatches(diff.deleted, "delete phase")
    deleteRecords(manifest, deleted)
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
      report.errors.push(`chunk ${file.relPath}: ${describeError(error)}`)
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
    // Cleanup only: stale tail points for changed files may linger, but the
    // fresh chunks are still upserted below, so this is non-fatal.
    await deletePathsInBatches(changedPaths, "clearing changed files")
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

  // Manifest writes are serialized and spaced out: batches now finish out of
  // order, and saving after every batch rewrote the whole manifest thousands
  // of times on a large workspace. `lastSaveAt` is updated before the save is
  // queued so concurrent workers see the interval as taken.
  let saveTail: Promise<void> = Promise.resolve()
  let lastSaveAt = Date.now()
  let batchesSinceSave = 0
  const queueManifestSave = (fatal = false): Promise<void> => {
    manifest.collection = store.name
    saveTail = saveTail.then(async () => {
      try {
        await saveManifest(kv, manifest)
      } catch (error) {
        // A lost save costs the next run some work but never leaves a file
        // unindexed, so it is a warning unless it is the one that would have
        // recorded completion.
        const message = `manifest save: ${describeError(error)}`
        if (fatal) report.errors.push(message)
        else report.warnings.push(message)
      }
    })
    return saveTail
  }

  const batches: Chunk[][] = []
  for (let i = 0; i < chunks.length; i += batchSize) batches.push(chunks.slice(i, i + batchSize))

  let processedChunks = 0
  await mapConcurrent(batches, embeddingConcurrency(settings), async (batch, batchIndex) => {
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
      report.errors.push(`batch ${batchIndex + 1}: ${describeError(error)}`)
    }

    if (succeeded) {
      for (const chunk of batch) {
        const remaining = (pendingByFile.get(chunk.filePath) ?? 1) - 1
        pendingByFile.set(chunk.filePath, remaining)
        if (remaining <= 0) completedFiles.add(chunk.filePath)
      }
      recordCompleted()
    }

    processedChunks += batch.length
    await deps.onProgress?.({
      phase: "embedding",
      processed: processedChunks,
      total: chunks.length,
    })

    // A failed batch saves immediately: the files it would have completed stay
    // unrecorded, and losing this run's successful progress to a crash would
    // repeat embedding calls that were already paid for.
    batchesSinceSave++
    const due =
      !succeeded ||
      batchesSinceSave >= MANIFEST_SAVE_EVERY_BATCHES ||
      Date.now() - lastSaveAt >= MANIFEST_SAVE_INTERVAL_MS
    if (!due) return
    lastSaveAt = Date.now()
    batchesSinceSave = 0
    await queueManifestSave()
  })

  // Files whose chunks all succeeded (including files that produced no chunks
  // legitimately). Files that failed to read or chunk stay unrecorded so the
  // next refresh retries them.
  for (const { file } of perFile) {
    if (chunkFailures.has(file.relPath)) continue
    if ((pendingByFile.get(file.relPath) ?? 0) <= 0) completedFiles.add(file.relPath)
  }
  recordCompleted()
  manifest.lastRun = Date.now()
  // Progress reaches the KV before completion is claimed anywhere: if the
  // store later refuses the flag, the work of this run still survives.
  lastSaveAt = Date.now()
  batchesSinceSave = 0
  await queueManifestSave()
  // Only fatal errors (files left unindexed) mark the run incomplete; cleanup
  // warnings do not, because every file's fresh chunks were still upserted.
  let complete = report.errors.length === 0
  // The store is told first, and the manifest is written from what the store
  // accepted: if completion cannot be recorded there, the run must not claim it
  // either, or the two disagree about the same run.
  try {
    await store.markComplete(profile, complete, dimension)
  } catch (error) {
    report.errors.push(`mark complete: ${describeError(error)}`)
    complete = false
  }
  manifest.complete = complete
  // The manifest is the last writer: a save that fails here is fatal to the
  // run's bookkeeping (the completion flag never persists), even though the
  // store already accepted it.
  await queueManifestSave(true)

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
