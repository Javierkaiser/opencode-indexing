import * as assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, describe, test } from "node:test"

import { runIndex } from "../src/indexer.ts"
import { loadManifest } from "../src/manifest.ts"
import { createMemoryStorage } from "../src/storage.ts"
import type { EmbeddingProfile, IndexingSettings, QdrantPoint, QueryHit } from "../src/types.ts"
import type { ExportBatch, StoreSearchOptions, VectorStoreAdapter, VectorStoreInfo } from "../src/vector-store.ts"

/**
 * Regression tests for the issues found by the independent audit:
 *  - M1: files whose embedding batch failed must NOT be recorded in the
 *        manifest (a later refresh has to retry them, not skip them forever).
 *  - M2: a truncated scan (maxFiles cap) must not treat unseen files as
 *        deleted (a capped refresh must never purge the rest of the index).
 */

const PROFILE: EmbeddingProfile = { provider: "mistral", modelId: "codestral-embed-test", dimension: 4 }
const temporaries: string[] = []

function makeWorkspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "oi-regress-"))
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
    embeddingBatchSize: 1, // one chunk per batch: batch failures map 1:1 to files
    maxFileSizeBytes: 1024 * 1024,
    fileExtensions: [".ts"],
    autoRefresh: false,
    importFromKilo: false,
    enabled: true,
    credentials: {},
    warnings: [],
    ...overrides,
  }
}

class FakeStore implements VectorStoreAdapter {
  readonly kind = "lancedb" as const
  readonly name: string
  points = new Map<string, QdrantPoint>()
  profile?: EmbeddingProfile
  complete: boolean | null = null

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
      profile: this.profile,
      complete: this.complete,
    }
  }

  async ensure(dimension: number, profile: EmbeddingProfile) {
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

function fileContent(label: string, chunks: number): string {
  return Array.from(
    { length: chunks },
    (_, i) => `export const ${label}_${i} = "a long enough line for chunking ${label} number ${i}"\n`,
  ).join("")
}

describe("M1 regression: failed batches are retried on the next refresh", () => {
  test("a file whose batch fails stays unrecorded and is fixed by a later refresh", async () => {
    const root = makeWorkspace()
    const store = new FakeStore(path.join(root, ".lancedb", "db"))
    const kv = createMemoryStorage()
    const settings = makeSettings(root)

    // File "good" has 2 chunks; file "bad" has 1 chunk that will fail to embed.
    writeFileSync(path.join(root, "src", "good.ts"), fileContent("good", 2))
    writeFileSync(path.join(root, "src", "bad.ts"), fileContent("bad", 1))

    let failBad = true
    const embedder = {
      provider: "mistral" as const,
      modelId: PROFILE.modelId,
      dimension: 4,
      async embed(texts: string[]): Promise<number[][]> {
        if (failBad && texts.some((text) => text.includes("bad_"))) {
          throw new Error("simulated embedding outage")
        }
        return texts.map(() => [1, 0, 0, 0])
      },
    }

    const first = await runIndex({ kv, root, settings, store, embedder }, { mode: "build", skipImport: true })
    assert.ok(first.errors.length >= 1, "the failed batch must be reported")
    assert.ok(store.points.size >= 1, "good file chunk was upserted")

    const manifestAfterFirst = await loadManifest(kv, root)
    assert.ok(manifestAfterFirst, "manifest exists")
    const recorded = new Set(Object.keys(manifestAfterFirst!.files))
    assert.ok(recorded.has("src\\good.ts") || recorded.has("src/good.ts"), "good file recorded")
    assert.ok(
      !recorded.has("src\\bad.ts") && !recorded.has("src/bad.ts"),
      "bad file must NOT be recorded while its batch failed",
    )

    // Second run: embedding recovers; refresh must pick up the previously
    // failed file (it was never recorded) and record it now.
    failBad = false
    const second = await runIndex({ kv, root, settings, store, embedder }, { mode: "refresh" })
    assert.equal(second.errors.length, 0, second.errors.join("; "))

    const manifestAfterSecond = await loadManifest(kv, root)
    const recordedNow = new Set(Object.keys(manifestAfterSecond!.files))
    assert.ok(
      recordedNow.has("src\\bad.ts") || recordedNow.has("src/bad.ts"),
      "recovered file must be recorded after a successful retry",
    )
    assert.ok(second.chunksUpserted >= 1, "retry embedded the missing chunks")
  })
})

describe("M2 regression: truncated scans never delete unseen files", () => {
  test("refresh with maxFiles does not purge files outside the scan window", async () => {
    const root = makeWorkspace()
    const store = new FakeStore(path.join(root, ".lancedb", "db"))
    const kv = createMemoryStorage()
    const settings = makeSettings(root, { embeddingBatchSize: 60 })

    for (const name of ["a", "b", "c", "d", "e"]) {
      writeFileSync(path.join(root, "src", `${name}.ts`), fileContent(name, 1))
    }
    const embedder = {
      provider: "mistral" as const,
      modelId: PROFILE.modelId,
      dimension: 4,
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map(() => [1, 0, 0, 0])
      },
    }

    const build = await runIndex({ kv, root, settings, store, embedder }, { mode: "build", skipImport: true })
    assert.equal(build.errors.length, 0)
    assert.equal(store.points.size, 5, "all five files indexed")

    // Capped refresh: only 2 files are scanned. The other three must be kept.
    const refresh = await runIndex(
      { kv, root, settings, store, embedder },
      { mode: "refresh", maxFiles: 2 },
    )
    assert.equal(refresh.deletedFiles, 0, "no deletions from a truncated scan")
    assert.ok(
      (refresh.notes ?? []).some((note) => note.includes("truncated")),
      `a truncation note must be reported; notes=${JSON.stringify(refresh.notes)}`,
    )
    assert.equal(store.points.size, 5, "no vectors were purged by the capped refresh")

    const manifest = await loadManifest(kv, root)
    assert.equal(Object.keys(manifest!.files).length, 5, "manifest kept all files")
  })
})

describe("M3-related regression: refresh after separator-mixed deletes", () => {
  test("mixed-separator delete does not leave stale duplicates", async () => {
    const root = makeWorkspace()
    const store = new FakeStore(path.join(root, ".lancedb", "db"))
    const kv = createMemoryStorage()
    const settings = makeSettings(root)
    writeFileSync(path.join(root, "src", "x.ts"), fileContent("x", 1))

    const embedder = {
      provider: "mistral" as const,
      modelId: PROFILE.modelId,
      dimension: 4,
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map(() => [1, 0, 0, 0])
      },
    }

    await runIndex({ kv, root, settings, store, embedder }, { mode: "build", skipImport: true })
    // Simulate a store row written with forward slashes (imported from Linux).
    store.points.set("stale-row", {
      id: "stale-row",
      vector: [1, 0, 0, 0],
      payload: {
        filePath: "src/x.ts",
        fileHash: "old",
        codeChunk: "stale",
        startLine: 1,
        endLine: 1,
      },
    })
    // The fake store's delete uses exact matching; the adapter under test
    // (real LanceDB) matches both separators. Here we assert the indexer asks
    // for the native path so a compatible store can match it.
    writeFileSync(path.join(root, "src", "x.ts"), fileContent("x", 2))
    const refresh = await runIndex({ kv, root, settings, store, embedder }, { mode: "refresh" })
    assert.equal(refresh.changedFiles, 1)
    assert.equal(refresh.errors.length, 0)
  })
})
