import * as assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, describe, test } from "node:test"

import { runIndex } from "../src/indexer.ts"
import { createMemoryStorage } from "../src/storage.ts"
import type { EmbeddingProfile, IndexingSettings, QdrantPoint, QueryHit } from "../src/types.ts"
import type { ExportBatch, StoreSearchOptions, VectorStoreAdapter, VectorStoreInfo } from "../src/vector-store.ts"

const PROFILE: EmbeddingProfile = { provider: "mistral", modelId: "codestral-embed-2500-test", dimension: 4 }
const temporaries: string[] = []

function makeWorkspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "oi-indexer-"))
  temporaries.push(dir)
  mkdirSync(path.join(dir, "src"), { recursive: true })
  return dir
}

after(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true })
})

function makeSettings(root: string, overrides: Partial<IndexingSettings> = {}): IndexingSettings {
  return {
    provider: PROFILE.provider,
    modelId: PROFILE.modelId,
    dimension: PROFILE.dimension,
    vectorStore: "lancedb",
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
        // Fake qdrant that fails: discovery treats it as unreachable and falls back.
        qdrant: {
          async listCollections() {
            throw new Error("connection refused")
          },
        } as never,
      },
      { mode: "build" },
    )
    assert.equal(report.errors.length, 0, report.errors.join("; "))
    assert.equal(report.imported, undefined)
    assert.ok(report.chunksUpserted > 0, "indexed from scratch when no source exists")
  })
})
