import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import { importFromKilo, importReportToIndexReport, type KiloSourceInfo } from "../src/import.ts"
import type { EmbeddingProfile, QdrantPoint, QueryHit } from "../src/types.ts"
import type { ExportBatch, StoreSearchOptions, VectorStoreAdapter, VectorStoreInfo } from "../src/vector-store.ts"

const PROFILE: EmbeddingProfile = { provider: "mistral", modelId: "codestral-embed-2505", dimension: 4 }

/** In-memory adapter used as import target. */
class FakeTarget implements VectorStoreAdapter {
  readonly kind = "qdrant" as const
  readonly name = "oc-test"
  points: QdrantPoint[] = []
  upserts = 0
  markedComplete: Array<{ complete: boolean; dimension: number }> = []

  async exists() {
    return true
  }
  async info(): Promise<VectorStoreInfo> {
    return { kind: this.kind, name: this.name, exists: true, pointsCount: this.points.length, profile: PROFILE, complete: false }
  }
  async ensure() {
    return { created: false }
  }
  async upsert(points: QdrantPoint[]) {
    this.upserts++
    this.points.push(...points)
  }
  async deleteByFilePaths() {}
  async deleteAll() {}
  async search(_options: StoreSearchOptions): Promise<QueryHit[]> {
    return []
  }
  async exportBatch(): Promise<ExportBatch> {
    return { points: [] }
  }
  async markComplete(_profile: EmbeddingProfile, complete: boolean, dimension: number) {
    this.markedComplete.push({ complete, dimension })
  }
}

function chunkPayload(filePath: string, fileHash: string) {
  return {
    filePath,
    fileHash,
    codeChunk: `chunk for ${filePath}`,
    startLine: 1,
    endLine: 10,
    segmentHash: `hash-${filePath}`,
  }
}

/** Fake Qdrant REST surface used by the import engine for qdrant sources. */
function makeFakeQdrant(pages: Array<{ points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> | null }>; next?: unknown }>) {
  let index = 0
  const scrollCalls: unknown[] = []
  return {
    scrollCalls,
    client: {
      async scroll(_name: string, _options: unknown) {
        scrollCalls.push(_options)
        const page = pages[Math.min(index, pages.length - 1)]
        index++
        return { points: page?.points ?? [], next: index < pages.length ? (page?.next ?? index) : undefined }
      },
    } as never,
  }
}

describe("importFromKilo (qdrant source)", () => {
  test("copies vectors and payloads without embedding, paginating via next", async () => {
    const fake = makeFakeQdrant([
      {
        points: [
          { id: "1", vector: [0.1, 0.2, 0.3, 0.4], payload: chunkPayload("src\\a.ts", "h1") },
          { id: "2", vector: [0.5, 0.6, 0.7, 0.8], payload: chunkPayload("src\\b.ts", "h2") },
        ],
        next: "cursor-1",
      },
      {
        points: [{ id: "3", vector: [0.9, 0.1, 0.2, 0.3], payload: chunkPayload("lib\\c.ts", "h3") }],
      },
    ])
    const target = new FakeTarget()
    const source: KiloSourceInfo = {
      kind: "qdrant",
      name: "ws-abc",
      pointsCount: 3,
      profile: PROFILE,
      complete: true,
      schema: 2,
      compatible: true,
    }
    const progress: number[] = []
    const report = await importFromKilo({
      root: "D:\\proj",
      source,
      target,
      targetProfile: PROFILE,
      qdrant: fake.client,
      batchLimit: 2,
      onProgress: (update) => {
        progress.push(update.imported)
      },
    })

    assert.equal(report.imported, 3)
    assert.equal(report.batches, 2)
    assert.equal(report.skipped, 0)
    assert.deepEqual(target.points.map((point) => point.id), ["1", "2", "3"])
    assert.deepEqual(target.points[0]!.vector, [0.1, 0.2, 0.3, 0.4], "vectors copied verbatim")
    assert.deepEqual(progress, [2, 3])
    assert.deepEqual(report.files, { "src\\a.ts": "h1", "src\\b.ts": "h2", "lib\\c.ts": "h3" })
    assert.equal(target.markedComplete.length, 1)
    assert.equal(target.markedComplete[0]!.complete, true)
    // Metadata exclusion filter is always sent.
    assert.deepEqual((fake.scrollCalls[0] as { filter: unknown }).filter, {
      must_not: [{ key: "type", match: { value: "metadata" } }],
    })
  })

  test("skips metadata-looking and invalid payloads", async () => {
    const fake = makeFakeQdrant([
      {
        points: [
          { id: "1", vector: [1, 2, 3, 4], payload: { type: "metadata", indexing_complete: true } },
          { id: "2", vector: [1, 2, 3, 4], payload: { filePath: "x.ts" } },
          { id: "3", vector: [1, 2, 3, 4], payload: chunkPayload("ok.ts", "h") },
        ],
      },
    ])
    const target = new FakeTarget()
    const report = await importFromKilo({
      root: "D:\\proj",
      source: { kind: "qdrant", name: "ws-x", pointsCount: 3, profile: PROFILE, compatible: true },
      target,
      targetProfile: PROFILE,
      qdrant: fake.client,
    })
    assert.equal(report.imported, 1)
    assert.equal(report.skipped, 2)
    assert.equal(target.points[0]!.id, "3")
  })

  test("rejects incompatible profiles before touching the target", async () => {
    const target = new FakeTarget()
    await assert.rejects(
      importFromKilo({
        root: "D:\\proj",
        source: {
          kind: "qdrant",
          name: "ws-x",
          pointsCount: 1,
          profile: { provider: "openai", modelId: "text-embedding-3-small", dimension: 1536 },
          compatible: false,
        },
        target,
        targetProfile: PROFILE,
      }),
      /does not match/,
    )
    assert.equal(target.upserts, 0)
  })
})

describe("importReportToIndexReport", () => {
  test("maps counters for tool output", () => {
    const report = importReportToIndexReport({
      source: { kind: "lancedb", name: "dir", pointsCount: 10, compatible: true },
      imported: 8,
      batches: 2,
      skipped: 2,
      durationMs: 123,
      errors: [],
      files: {},
    })
    assert.equal(report.mode, "build")
    assert.equal(report.chunksUpserted, 8)
    assert.equal(report.batches, 2)
    assert.equal(report.durationMs, 123)
  })
})
