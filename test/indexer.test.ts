import * as assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, describe, test } from "node:test"

import { runIndex, seedImportedManifest, embeddingConcurrency, planKiloImport } from "../src/indexer.ts"
import { emptyManifest, loadManifest, saveManifest, setRecord } from "../src/manifest.ts"
import { createMemoryStorage } from "../src/storage.ts"
import { KILO_METADATA_ID, kiloCollectionCandidates } from "../src/kilo-store.ts"
import type { KiloSourceInfo } from "../src/import.ts"
import type { EmbeddingProfile, IndexingSettings, KVStore, QdrantPoint, QueryHit } from "../src/types.ts"
import type { ExportBatch, StoreSearchOptions, VectorStoreAdapter, VectorStoreInfo } from "../src/vector-store.ts"

const PROFILE: EmbeddingProfile = { provider: "mistral", modelId: "codestral-embed-2500-test", dimension: 4 }
const temporaries: string[] = []

// Every run is recorded in the workspace registry, which lives next to the
// user's settings file: point XDG at a temp dir so tests never write there.
const configHome = mkdtempSync(path.join(os.tmpdir(), "oi-xdg-"))
process.env.XDG_CONFIG_HOME = configHome

function makeWorkspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "oi-indexer-"))
  temporaries.push(dir)
  mkdirSync(path.join(dir, "src"), { recursive: true })
  return dir
}

after(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true })
  rmSync(configHome, { recursive: true, force: true })
})

function makeSettings(root: string, overrides: Partial<IndexingSettings> = {}): IndexingSettings {
  return {
    provider: PROFILE.provider,
    modelId: PROFILE.modelId,
    dimension: PROFILE.dimension,
    vectorStore: "lancedb",
    kiloVectorStore: null,
    qdrantUrl: "http://localhost:6333",
    lancedbDirectory: path.join(root, ".lancedb"),
    scoreThreshold: 0.35,
    searchMaxResults: 20,
    embeddingBatchSize: 60,
    maxFileSizeBytes: 1024 * 1024,
    fileExtensions: [".ts", ".md"],
    autoRefresh: false,
    importFromKilo: false,
    enabled: true,
    credentials: {},
    warnings: [],
    ...overrides,
  }
}

/** In-memory adapter. kind "lancedb" with a real temp path keeps recreate() hermetic. */
class FakeStore implements VectorStoreAdapter {
  readonly kind = "lancedb" as const
  readonly name: string
  points = new Map<string, QdrantPoint>()
  profile?: EmbeddingProfile
  complete: boolean | null = null
  forgery: "none" | "mismatch" = "none"
  ensureCalls = 0
  /** Every `deleteByFilePaths` batch, in call order. */
  deleteCalls: string[][] = []
  /** 1-based call number that should reject, to simulate a partial cleanup outage. */
  failDeleteCall?: number

  constructor(dbPath: string) {
    this.name = dbPath
    mkdirSync(dbPath, { recursive: true })
  }

  async exists() {
    return this.profile !== undefined
  }

  async info(): Promise<VectorStoreInfo> {
    return {
      kind: this.kind,
      name: this.name,
      exists: this.profile !== undefined,
      pointsCount: this.points.size,
      profile:
        this.forgery === "mismatch"
          ? { provider: "openai", modelId: "text-embedding-3-small", dimension: 8 }
          : this.profile,
      complete: this.complete,
    }
  }

  async ensure(dimension: number, profile: EmbeddingProfile) {
    this.ensureCalls++
    // Simulates a dropped database directory (recreateOwnStore removes it).
    if (!existsSync(this.name)) {
      mkdirSync(this.name, { recursive: true })
      this.points.clear()
      this.forgery = "none"
      this.profile = { ...profile, dimension }
      return { created: true }
    }
    const created = this.profile === undefined
    if (created) this.profile = { ...profile, dimension }
    return { created }
  }

  async upsert(points: QdrantPoint[]) {
    for (const point of points) this.points.set(point.id, point)
  }

  async deleteByFilePaths(relPaths: string[]) {
    this.deleteCalls.push([...relPaths])
    if (this.failDeleteCall !== undefined && this.deleteCalls.length === this.failDeleteCall) {
      throw new Error("simulated delete outage")
    }
    const wanted = new Set(relPaths)
    for (const [id, point] of this.points) {
      if (wanted.has(String(point.payload.filePath))) this.points.delete(id)
    }
  }

  async deleteAll() {
    this.points.clear()
  }

  async search(_options: StoreSearchOptions): Promise<QueryHit[]> {
    return []
  }

  async exportBatch(): Promise<ExportBatch> {
    return { points: [] }
  }

  async markComplete(_profile: EmbeddingProfile, complete: boolean) {
    this.complete = complete
  }
}

/** Deterministic embedder: one 4-d vector per text, no network. */
const fakeEmbedder = {
  provider: "mistral" as const,
  modelId: PROFILE.modelId,
  dimension: 4,
  async embed(texts: string[], _options?: { asQuery?: boolean }): Promise<number[][]> {
    return texts.map((text, index) => [text.length % 10, index % 10, 0.5, 0.1])
  },
}

function fileWithChunk(name: string, id: number): string {
  // >50 chars per line group ensures the line chunker produces content.
  return `// file ${name} id ${id}\nexport const value${id} = "a long enough line to be chunked for the tests"\nexport function fn${id}() { return ${id} }\n`
}

describe("runIndex (incremental, fake store)", () => {
  test("build indexes files; refresh detects new/changed/deleted", async () => {
    const root = makeWorkspace()
    const store = new FakeStore(path.join(root, ".lancedb", "db"))
    const kv = createMemoryStorage()
    const settings = makeSettings(root)

    writeFileSync(path.join(root, "src", "a.ts"), fileWithChunk("a", 1))
    writeFileSync(path.join(root, "src", "b.ts"), fileWithChunk("b", 2))

    const build = await runIndex({ kv, root, settings, store, embedder: fakeEmbedder }, { mode: "build" })
    assert.equal(build.errors.length, 0, build.errors.join("; "))
    assert.equal(build.scanned, 2)
    assert.ok(build.chunksUpserted > 0)
    assert.ok(store.points.size > 0)
    const pointsAfterBuild = store.points.size

    // No changes -> no-op refresh.
    const noop = await runIndex({ kv, root, settings, store, embedder: fakeEmbedder }, { mode: "refresh" })
    assert.equal(noop.newFiles, 0)
    assert.equal(noop.changedFiles, 0)
    assert.equal(noop.chunksUpserted, 0)

    // Change one file, add one, delete one.
    writeFileSync(path.join(root, "src", "a.ts"), fileWithChunk("a", 11) + "// extra\n")
    writeFileSync(path.join(root, "src", "c.ts"), fileWithChunk("c", 3))
    rmSync(path.join(root, "src", "b.ts"))

    const refresh = await runIndex({ kv, root, settings, store, embedder: fakeEmbedder }, { mode: "refresh" })
    assert.equal(refresh.errors.length, 0, refresh.errors.join("; "))
    assert.equal(refresh.newFiles, 1)
    assert.equal(refresh.changedFiles, 1)
    assert.equal(refresh.deletedFiles, 1)
    assert.ok(refresh.chunksUpserted > 0)

    // b.ts points are gone; a.ts and c.ts present.
    const files = new Set([...store.points.values()].map((point) => String(point.payload.filePath)))
    assert.ok(files.has("src\\a.ts") || files.has("src/a.ts"))
    assert.ok([...files].some((file) => file.includes("c.ts")))
    assert.ok(![...files].some((file) => file.includes("b.ts")))
    assert.ok(store.points.size !== pointsAfterBuild || refresh.chunksUpserted > 0)
  })

  test("profile mismatch recreates the store (no stale vectors)", async () => {
    const root = makeWorkspace()
    const store = new FakeStore(path.join(root, ".lancedb", "db"))
    store.profile = { provider: "openai", modelId: "text-embedding-3-small", dimension: 8 }
    store.forgery = "mismatch"
    store.points.set("old", { id: "old", vector: [1], payload: {} })
    const kv = createMemoryStorage()
    writeFileSync(path.join(root, "src", "a.ts"), fileWithChunk("a", 1))

    const report = await runIndex({ kv, root, settings: makeSettings(root), store, embedder: fakeEmbedder }, { mode: "refresh" })
    assert.equal(report.errors.length, 0, report.errors.join("; "))
    assert.equal(store.points.has("old"), false, "stale store contents dropped")
    assert.ok(store.ensureCalls >= 1)
    assert.equal(report.chunksUpserted > 0, true)
  })

  test("build with rebuild drops the store first", async () => {
    const root = makeWorkspace()
    const store = new FakeStore(path.join(root, ".lancedb", "db"))
    const kv = createMemoryStorage()
    const settings = makeSettings(root)
    writeFileSync(path.join(root, "src", "a.ts"), fileWithChunk("a", 1))

    await runIndex({ kv, root, settings, store, embedder: fakeEmbedder }, { mode: "build" })
    const firstSize = store.points.size
    assert.ok(firstSize > 0)
    store.points.set("stale", { id: "stale", vector: [0], payload: {} })

    const rebuilt = await runIndex({ kv, root, settings, store, embedder: fakeEmbedder }, { mode: "build", rebuild: true })
    assert.equal(rebuilt.errors.length, 0, rebuilt.errors.join("; "))
    assert.equal(store.points.has("stale"), false)
    assert.ok(rebuilt.chunksUpserted > 0)
  })

  test("importFromKilo with no Kilo source falls back to embedding cleanly", async () => {
    const root = makeWorkspace()
    const store = new FakeStore(path.join(root, ".lancedb", "db"))
    const kv = createMemoryStorage()
    writeFileSync(path.join(root, "src", "a.ts"), fileWithChunk("a", 1))
    // Settings enable import, but no Kilo index exists for this temp root.
    const settings = makeSettings(root, { importFromKilo: true })

    const report = await runIndex(
      {
        kv,
        root,
        settings,
        store,
        embedder: fakeEmbedder,
        // Reachable, with nothing indexed for this workspace. The alternative —
        // a Qdrant that throws — is not "no source exists", it is "could not
        // look", and it is reported as such by the test below.
        qdrant: {
          async listCollections() {
            return []
          },
          async collectionExists() {
            return false
          },
        } as never,
      },
      { mode: "build" },
    )
    assert.equal(report.errors.length, 0, report.errors.join("; "))
    assert.equal(report.imported, undefined)
    assert.ok(report.chunksUpserted > 0, "indexed from scratch when no source exists")
  })

  test("a build that cannot read Kilo's index says so before re-embedding everything", async () => {
    // The expensive failure: the index is there, the read failed, and the scan
    // that follows re-embeds the whole workspace. Reporting it as "no Kilo
    // index" made the cost look like the normal path.
    const root = makeWorkspace()
    const store = new FakeStore(path.join(root, ".lancedb", "db"))
    const kv = createMemoryStorage()
    writeFileSync(path.join(root, "src", "a.ts"), fileWithChunk("a", 1))
    const settings = makeSettings(root, { importFromKilo: true })

    const report = await runIndex(
      {
        kv,
        root,
        settings,
        store,
        embedder: fakeEmbedder,
        qdrant: {
          async listCollections() {
            throw new Error("connection refused")
          },
          async collectionExists() {
            throw new Error("connection refused")
          },
        } as never,
      },
      { mode: "build" },
    )

    assert.equal(report.errors.length, 1, report.errors.join("; "))
    assert.match(report.errors[0], /Could not reach the Qdrant server/)
    assert.match(report.errors[0], /connection refused/, "the reason has to survive")
    // The fallback still happens; it is the silence that was wrong.
    assert.equal(report.imported, undefined)
    assert.ok(report.chunksUpserted > 0, "still indexes from scratch")
  })
})

/** In-memory KV that counts manifest writes. */
function countingStorage(): { kv: KVStore; sets: () => number } {
  const inner = createMemoryStorage()
  let sets = 0
  return {
    kv: {
      get: (key) => inner.get(key),
      set: async (key, value) => {
        sets++
        await inner.set(key, value)
      },
      remove: (key) => inner.remove(key),
      scan: (options) => inner.scan(options),
    },
    sets: () => sets,
  }
}

/** Embedder that tracks how many requests are in flight at once. */
function trackingEmbedder(delayMs = 5) {
  const stats = { active: 0, maxActive: 0, calls: 0 }
  const embedder = {
    provider: "openai" as const,
    modelId: "text-embedding-3-small",
    dimension: 4,
    async embed(texts: string[]): Promise<number[][]> {
      stats.calls++
      stats.active++
      stats.maxActive = Math.max(stats.maxActive, stats.active)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      stats.active--
      return texts.map(() => [1, 0, 0, 0])
    },
  }
  return { embedder, stats }
}

async function withEmbeddingConcurrencyEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.KILO_INDEX_EMBEDDING_CONCURRENCY
  if (value === undefined) delete process.env.KILO_INDEX_EMBEDDING_CONCURRENCY
  else process.env.KILO_INDEX_EMBEDDING_CONCURRENCY = value
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env.KILO_INDEX_EMBEDDING_CONCURRENCY
    else process.env.KILO_INDEX_EMBEDDING_CONCURRENCY = saved
  }
}

describe("embedding concurrency (A1)", () => {
  test("defaults per provider, overridable by KILO_INDEX_EMBEDDING_CONCURRENCY", async () => {
    await withEmbeddingConcurrencyEnv(undefined, async () => {
      assert.equal(embeddingConcurrency(makeSettings("root", { provider: "local" })), 1)
      assert.equal(embeddingConcurrency(makeSettings("root", { provider: "openai" })), 3)
    })
    await withEmbeddingConcurrencyEnv("5", async () => {
      assert.equal(embeddingConcurrency(makeSettings("root", { provider: "local" })), 5)
    })
    await withEmbeddingConcurrencyEnv("0", async () => {
      assert.equal(embeddingConcurrency(makeSettings("root", { provider: "openai" })), 3, "non-positive falls back")
    })
  })

  test("hosted providers embed several batches at once, up to the limit", async () => {
    const root = makeWorkspace()
    const store = new FakeStore(path.join(root, ".lancedb", "db"))
    const kv = createMemoryStorage()
    const settings = makeSettings(root, { provider: "openai", modelId: "text-embedding-3-small" })
    settings.embeddingBatchSize = 1
    for (let i = 0; i < 8; i++) writeFileSync(path.join(root, "src", `f${i}.ts`), fileWithChunk(`f${i}`, i))
    const { embedder, stats } = trackingEmbedder()

    const report = await withEmbeddingConcurrencyEnv(undefined, () =>
      runIndex({ kv, root, settings, store, embedder }, { mode: "build", skipImport: true }),
    )

    assert.equal(report.errors.length, 0, report.errors.join("; "))
    assert.ok(report.batches >= 3, `need several batches to observe parallelism; batches=${report.batches}`)
    assert.ok(stats.maxActive > 1, `batches must overlap; maxActive=${stats.maxActive}`)
    assert.ok(stats.maxActive <= 3, `never above the default limit; maxActive=${stats.maxActive}`)
  })

  test("KILO_INDEX_EMBEDDING_CONCURRENCY=1 restores sequential embedding", async () => {
    const root = makeWorkspace()
    const store = new FakeStore(path.join(root, ".lancedb", "db"))
    const kv = createMemoryStorage()
    const settings = makeSettings(root, { provider: "openai", modelId: "text-embedding-3-small" })
    settings.embeddingBatchSize = 1
    for (let i = 0; i < 5; i++) writeFileSync(path.join(root, "src", `g${i}.ts`), fileWithChunk(`g${i}`, i))
    const { embedder, stats } = trackingEmbedder()

    const report = await withEmbeddingConcurrencyEnv("1", () =>
      runIndex({ kv, root, settings, store, embedder }, { mode: "build", skipImport: true }),
    )

    assert.equal(report.errors.length, 0, report.errors.join("; "))
    assert.ok(report.batches > 1, "more than one batch ran")
    assert.equal(stats.maxActive, 1)
  })
})

describe("batch failures and manifest saves (A1)", () => {
  test("a failed batch leaves its files unrecorded and the run incomplete", async () => {
    const root = makeWorkspace()
    const store = new FakeStore(path.join(root, ".lancedb", "db"))
    const kv = createMemoryStorage()
    const settings = makeSettings(root)
    writeFileSync(path.join(root, "src", "a.ts"), fileWithChunk("a", 1))
    writeFileSync(path.join(root, "src", "b.ts"), fileWithChunk("b", 2))

    const failingEmbedder = {
      provider: PROFILE.provider,
      modelId: PROFILE.modelId,
      dimension: 4,
      async embed(): Promise<number[][]> {
        throw new Error("simulated embedding outage")
      },
    }

    const report = await runIndex({ kv, root, settings, store, embedder: failingEmbedder }, { mode: "build", skipImport: true })

    assert.ok(report.errors.length >= 1, "the failed batch must be reported")
    assert.equal(store.complete, false)
    const manifest = await loadManifest(kv, root)
    assert.equal(Object.keys(manifest!.files).length, 0, "no file is recorded when its chunks failed")
    assert.equal(manifest!.complete, false)
  })

  test("manifest writes are fewer than the batches they cover", async () => {
    const root = makeWorkspace()
    const store = new FakeStore(path.join(root, ".lancedb", "db"))
    const { kv, sets } = countingStorage()
    const settings = makeSettings(root)
    settings.embeddingBatchSize = 1
    for (let i = 0; i < 15; i++) writeFileSync(path.join(root, "src", `h${i}.ts`), fileWithChunk(`h${i}`, i))

    const report = await runIndex({ kv, root, settings, store, embedder: fakeEmbedder }, { mode: "build", skipImport: true })

    assert.equal(report.errors.length, 0, report.errors.join("; "))
    assert.ok(report.batches >= 15, `many batches; batches=${report.batches}`)
    assert.ok(
      sets() < report.batches,
      `manifest saves must be throttled: saves=${sets()} batches=${report.batches}`,
    )
  })

  test("a failing manifest save is reported and does not abort the run", async () => {
    const root = makeWorkspace()
    const store = new FakeStore(path.join(root, ".lancedb", "db"))
    const inner = createMemoryStorage()
    let attempts = 0
    const kv: KVStore = {
      get: (key) => inner.get(key),
      set: async () => {
        attempts++
        throw new Error("storage offline")
      },
      remove: (key) => inner.remove(key),
      scan: (options) => inner.scan(options),
    }
    const settings = makeSettings(root)
    writeFileSync(path.join(root, "src", "a.ts"), fileWithChunk("a", 1))

    const report = await runIndex({ kv, root, settings, store, embedder: fakeEmbedder }, { mode: "build", skipImport: true })

    assert.ok(store.points.size > 0, "the work itself still happened")
    assert.ok(
      report.errors.some((error) => error.includes("manifest save")),
      `losing the completion record must be fatal to the run's report; errors=${JSON.stringify(report.errors)}`,
    )
    assert.ok(attempts >= 2, `the final save is still attempted after an earlier one failed; attempts=${attempts}`)
  })
})

describe("batched store deletes (A1)", () => {
  test("more than DELETE_BATCH_SIZE deleted files are split across store calls", async () => {
    const root = makeWorkspace()
    const store = new FakeStore(path.join(root, ".lancedb", "db"))
    const kv = createMemoryStorage()
    const settings = makeSettings(root)

    // 501 recorded files that no longer exist on disk: no read or embed work,
    // only the deletion path.
    const manifest = emptyManifest(root, store.name, PROFILE)
    for (let i = 0; i < 501; i++) {
      setRecord(manifest, `src/gone${i}.ts`, { hash: `hash-${i}`, size: 1, mtimeMs: 1, indexedAt: 1 })
    }
    await saveManifest(kv, manifest)

    const report = await runIndex({ kv, root, settings, store, embedder: fakeEmbedder }, { mode: "refresh", skipImport: true })

    assert.equal(report.deletedFiles, 501)
    assert.equal(report.errors.length, 0, report.errors.join("; "))
    assert.deepEqual(
      store.deleteCalls.map((batch) => batch.length),
      [500, 1],
      "deletes must respect the store batch size",
    )
    const after = await loadManifest(kv, root)
    assert.equal(Object.keys(after!.files).length, 0, "records dropped for every successful delete")
  })

  test("a failed delete chunk is warned about and keeps its manifest records", async () => {
    const root = makeWorkspace()
    const store = new FakeStore(path.join(root, ".lancedb", "db"))
    store.failDeleteCall = 2
    const kv = createMemoryStorage()
    const settings = makeSettings(root)

    const manifest = emptyManifest(root, store.name, PROFILE)
    for (let i = 0; i < 501; i++) {
      setRecord(manifest, `src/gone${i}.ts`, { hash: `hash-${i}`, size: 1, mtimeMs: 1, indexedAt: 1 })
    }
    await saveManifest(kv, manifest)

    const report = await runIndex({ kv, root, settings, store, embedder: fakeEmbedder }, { mode: "refresh", skipImport: true })

    assert.equal(store.deleteCalls.length, 2)
    assert.ok(
      report.warnings.some((warning) => warning.includes("delete phase")),
      `the failed chunk must be surfaced; warnings=${JSON.stringify(report.warnings)}`,
    )
    assert.equal(report.errors.length, 0, "cleanup failures stay warnings")
    const after = await loadManifest(kv, root)
    assert.equal(Object.keys(after!.files).length, 1, "only the failed chunk's records survive")
  })
})

describe("imported manifest seeding (A4)", () => {
  test("records real size/mtime and leaves missing files at -1/0", async () => {
    const root = makeWorkspace()
    const manifest = emptyManifest(root, "collection", PROFILE)
    const present = path.join("src", "a.ts")
    const missing = path.join("src", "gone.ts")
    const content = "export const a = 1\n"
    writeFileSync(path.join(root, present), content)
    const stats = statSync(path.join(root, present))

    await seedImportedManifest(manifest, root, { [present]: "hash-present", [missing]: "hash-missing" })

    const record = manifest.files[present]!
    assert.equal(record.hash, "hash-present")
    assert.equal(record.size, stats.size)
    assert.equal(record.mtimeMs, stats.mtimeMs)
    assert.ok(record.indexedAt > 0)

    const absent = manifest.files[missing]!
    assert.equal(absent.hash, "hash-missing")
    assert.equal(absent.size, -1, "a missing file stays undetectable as unchanged")
    assert.equal(absent.mtimeMs, 0)
  })

  test("verifyAll keeps every record stale so the next scan re-hashes it", async () => {
    // A baseline hash was computed in the main checkout, so even an existing
    // file has to be read here before its content is trusted.
    const root = makeWorkspace()
    const manifest = emptyManifest(root, "collection", PROFILE)
    const present = path.join("src", "a.ts")
    writeFileSync(path.join(root, present), "export const a = 1\n")

    await seedImportedManifest(manifest, root, { [present]: "baseline-hash" }, { verifyAll: true })

    const record = manifest.files[present]!
    assert.equal(record.hash, "baseline-hash")
    assert.equal(record.size, -1, "the record must look changed to the scan")
    assert.equal(record.mtimeMs, 0)
  })
})

describe("Kilo import planning (B4)", () => {
  const source = (overrides: Partial<KiloSourceInfo> & { name: string }): KiloSourceInfo => ({
    kind: "qdrant",
    pointsCount: 1,
    compatible: true,
    ...overrides,
  })

  test("a single workspace keeps the first compatible source, as before", () => {
    const plan = planKiloImport(
      [source({ name: "incompatible", compatible: false, reason: "profile" }), source({ name: "usable" })],
      PROFILE,
    )
    assert.deepEqual(plan.steps.map((step) => step.source.name), ["usable"])
    assert.equal(plan.steps[0]!.skipRole, undefined)
    assert.equal(plan.verifyAll, false)
    assert.deepEqual(plan.warnings, [])
    assert.equal(plan.unavailable, undefined)
  })

  test("the worktree delta shadows the baseline", () => {
    const plan = planKiloImport(
      [source({ name: "main", role: "baseline" }), source({ name: "feature", role: "delta" })],
      PROFILE,
    )

    assert.deepEqual(
      plan.steps.map((step) => [step.source.name, step.skipRole]),
      [["feature", undefined], ["main", "delta"]],
      "delta first, and the baseline skips everything the delta covers",
    )
    assert.equal(plan.verifyAll, true, "baseline hashes describe the main checkout and must be re-checked here")
    assert.deepEqual(plan.warnings, [])
  })

  test("baseline only imports it, forces verification and says the delta is missing", () => {
    const plan = planKiloImport([source({ name: "main", role: "baseline" })], PROFILE)

    assert.deepEqual(plan.steps.map((step) => step.source.name), ["main"])
    assert.equal(plan.verifyAll, true, "baseline hashes describe the main checkout")
    assert.match(plan.warnings.join(" "), /delta index is unavailable/)
    assert.match(plan.warnings.join(" "), /scan that follows/)
  })

  test("delta only imports it and says the baseline is missing", () => {
    const plan = planKiloImport([source({ name: "feature", role: "delta" })], PROFILE)

    assert.deepEqual(plan.steps.map((step) => step.source.name), ["feature"])
    assert.equal(plan.verifyAll, false, "the delta was indexed from this checkout")
    assert.match(plan.warnings.join(" "), /baseline index is unavailable/)
    assert.match(plan.warnings.join(" "), /scan that follows/)
  })

  test("neither worktree source is compatible: the delta's reason is the actionable one", () => {
    const plan = planKiloImport(
      [
        source({ name: "main", role: "baseline", compatible: false, reason: "provider" }),
        source({
          name: "feature",
          role: "delta",
          compatible: false,
          reason: "profile",
          profile: PROFILE,
        }),
      ],
      { ...PROFILE, dimension: 8 },
    )

    assert.deepEqual(plan.steps, [])
    assert.match(plan.unavailable!, /feature, delta/)
    assert.match(plan.unavailable!, /does not match/)
    assert.doesNotMatch(plan.unavailable!, /cannot embed with/, "the delta's reason wins over the baseline's")
  })

  test("a refused single source names the provider or schema, not always a profile mismatch", () => {
    const provider = planKiloImport(
      [
        source({
          name: "ws-bedrock",
          compatible: false,
          reason: "provider",
          profile: {
            provider: "bedrock" as unknown as EmbeddingProfile["provider"],
            modelId: "amazon.titan-embed-text-v2",
            dimension: 1024,
          },
        }),
      ],
      PROFILE,
    )
    assert.equal(provider.steps.length, 0)
    assert.match(provider.unavailable!, /bedrock/)
    assert.match(provider.unavailable!, /cannot embed with/)
    assert.doesNotMatch(provider.unavailable!, /embedding profile does not match/)

    const schema = planKiloImport([source({ name: "ws-new", compatible: false, reason: "schema", schema: 3 })], PROFILE)
    assert.match(schema.unavailable!, /schema 3/)
    assert.match(schema.unavailable!, /\(1\/2\)/)
  })

  test("no sources means nothing to plan and nothing to report", () => {
    const plan = planKiloImport([], PROFILE)
    assert.deepEqual(plan.steps, [])
    assert.equal(plan.unavailable, undefined)
    assert.deepEqual(plan.warnings, [])
  })
})

/** A Kilo-shaped chunk point, as both the import and the scan would see one. */
function kiloPoint(id: string, filePath: string, fileHash: string): QdrantPoint {
  return {
    id,
    vector: [0.1, 0.2, 0.3, 0.4],
    payload: {
      filePath,
      fileHash,
      codeChunk: `chunk for ${filePath}`,
      startLine: 1,
      endLine: 2,
      segmentHash: `seg-${id}`,
    },
  }
}

/** Qdrant holding one Kilo collection per workspace root, with matching metadata. */
function fakeKiloQdrant(
  collections: Map<string, QdrantPoint[]>,
  profile: EmbeddingProfile,
  unreadable: ReadonlySet<string> = new Set(),
) {
  return {
    async listCollections() {
      return [...collections.keys()]
    },
    async collectionExists(name: string) {
      return collections.has(name)
    },
    async getCollection(name: string) {
      return collections.has(name) ? { points_count: collections.get(name)!.length } : null
    },
    async retrieve(name: string) {
      if (!collections.has(name)) return []
      return [
        {
          id: KILO_METADATA_ID,
          payload: {
            embedding_provider: profile.provider,
            embedding_model_id: profile.modelId,
            embedding_dimension: profile.dimension,
            index_schema: 2,
            indexing_complete: true,
          },
        },
      ]
    },
    async scroll(name: string) {
      if (unreadable.has(name)) throw new Error(`collection ${name} is unavailable`)
      return { points: collections.get(name) ?? [] }
    },
  } as never
}

describe("runIndex worktree import (B4)", () => {
  test("imports the delta first and the baseline without copying delta files", async () => {
    const main = makeWorkspace()
    const linked = makeWorkspace()
    // A linked worktree is a `.git` file pointing into the main checkout's
    // metadata, which is all mainWorktree() needs to find the baseline.
    writeFileSync(path.join(linked, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`)
    // Kilo stores sha256 of the file content; using the real hash here keeps the
    // post-import verification from mistaking a valid delta for a changed file.
    const deltaContent = fileWithChunk("a", 1)
    const deltaHash = createHash("sha256").update(deltaContent).digest("hex")
    writeFileSync(path.join(linked, "src", "a.ts"), deltaContent)

    const baselineName = kiloCollectionCandidates(main)[0]!
    const deltaName = kiloCollectionCandidates(linked)[0]!
    const collections = new Map<string, QdrantPoint[]>([
      [deltaName, [kiloPoint("delta-a", "src\\a.ts", deltaHash)]],
      [
        baselineName,
        [kiloPoint("baseline-a", "src\\a.ts", "baseline-hash"), kiloPoint("baseline-b", "src\\b.ts", "baseline-hash")],
      ],
    ])
    const store = new FakeStore(path.join(linked, ".lancedb", "db"))
    const kv = createMemoryStorage()
    const settings = makeSettings(linked, { importFromKilo: true })

    const report = await runIndex(
      {
        kv,
        root: linked,
        settings,
        store,
        embedder: fakeEmbedder,
        qdrant: fakeKiloQdrant(collections, PROFILE),
      },
      { mode: "build" },
    )

    assert.equal(report.errors.length, 0, report.errors.join("; "))
    assert.deepEqual(
      report.importedSources?.map((entry) => [entry.source, entry.role, entry.chunks]),
      [
        [deltaName, "delta", 1],
        [baselineName, "baseline", 1],
      ],
      "delta first, and the baseline copies only what the delta does not cover",
    )
    assert.equal(report.imported?.source, deltaName, "the primary source stays the delta")
    assert.equal(report.imported?.chunks, 1)

    const manifest = await loadManifest(kv, linked)
    assert.equal(manifest!.files["src\\a.ts"]!.hash, deltaHash, "the delta's hash wins for a shared file")
    assert.equal(manifest!.files["src\\b.ts"], undefined, "a baseline-only file missing here is deleted by the scan")

    const kept = [...store.points.values()]
    assert.equal(kept.length, 1)
    assert.equal(kept[0]!.payload.fileHash, deltaHash)
  })

  test("a failed delta never leaves its files trusted against baseline hashes", async () => {
    const main = makeWorkspace()
    const linked = makeWorkspace()
    writeFileSync(path.join(linked, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`)
    writeFileSync(path.join(linked, "src", "a.ts"), fileWithChunk("a", 1))

    const baselineName = kiloCollectionCandidates(main)[0]!
    const deltaName = kiloCollectionCandidates(linked)[0]!
    const collections = new Map<string, QdrantPoint[]>([
      [deltaName, [kiloPoint("delta-a", "src\\a.ts", "delta-hash")]],
      [baselineName, [kiloPoint("baseline-a", "src\\a.ts", "baseline-hash")]],
    ])
    const store = new FakeStore(path.join(linked, ".lancedb", "db"))
    const kv = createMemoryStorage()
    const settings = makeSettings(linked, { importFromKilo: true })

    const report = await runIndex(
      {
        kv,
        root: linked,
        settings,
        store,
        embedder: fakeEmbedder,
        qdrant: fakeKiloQdrant(collections, PROFILE, new Set([deltaName])),
      },
      { mode: "build" },
    )

    assert.ok(
      report.errors.some((error) => error.includes("import failed (delta)")),
      `the delta failure must be reported; errors=${JSON.stringify(report.errors)}`,
    )
    assert.equal(report.imported?.source, baselineName, "the baseline still seeds what it can")

    const manifest = await loadManifest(kv, linked)
    const record = manifest!.files["src\\a.ts"]!
    assert.notEqual(
      record.hash,
      "baseline-hash",
      "the scan must re-hash the file instead of trusting the main checkout's hash",
    )
  })
})
