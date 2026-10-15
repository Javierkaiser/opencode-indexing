import * as assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, describe, test } from "node:test"

import { discoverKiloSources, importFromKilo, importReportToIndexReport, type KiloSourceInfo } from "../src/import.ts"
import type { EmbeddingProfile, QdrantPoint, QueryHit } from "../src/types.ts"
import type { ExportBatch, StoreSearchOptions, VectorStoreAdapter, VectorStoreInfo } from "../src/vector-store.ts"

const PROFILE: EmbeddingProfile = { provider: "mistral", modelId: "codestral-embed-2505", dimension: 4 }

// Every import is recorded in the workspace registry, which lives next to the
// user's settings file: point XDG at a temp dir so tests never write there.
const configHome = mkdtempSync(path.join(os.tmpdir(), "oi-xdg-"))
process.env.XDG_CONFIG_HOME = configHome

after(() => rmSync(configHome, { recursive: true, force: true }))

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

  test("fails instead of marking the index complete when nothing was imported", async () => {
    // Every point filtered out as metadata. Marking the manifest complete here
    // would make an empty index look healthy: the manifest would claim the
    // workspace is fully indexed and the freshness check would agree.
    const fake = makeFakeQdrant([
      { points: [{ id: "1", vector: [1, 2, 3, 4], payload: { type: "metadata", indexing_complete: true } }] },
    ])
    const target = new FakeTarget()
    await assert.rejects(
      importFromKilo({
        root: "D:\\proj",
        source: { kind: "qdrant", name: "ws-x", pointsCount: 1, profile: PROFILE, compatible: true },
        target,
        targetProfile: PROFILE,
        qdrant: fake.client,
      }),
      /Imported 0 chunks/,
    )
    assert.equal(target.upserts, 0)
    assert.deepEqual(target.markedComplete, [], "an import that copied nothing must not mark complete")
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

describe("discoverKiloSources", () => {
  const ROOT = path.join(os.tmpdir(), "discover-root")

  /** A reachable Qdrant with no collection for this workspace. */
  function emptyQdrant() {
    return { listCollections: async () => [] } as never
  }

  test("says nothing was found when nothing exists", async () => {
    const problems: string[] = []
    const sources = await discoverKiloSources(ROOT, {
      qdrant: emptyQdrant(),
      lancedbDirectory: path.join(os.tmpdir(), "oi-absent-lancedb"),
      onProblem: (message) => problems.push(message),
    })

    assert.deepEqual(sources, [])
    // Silence here is correct: there is no index and nothing failed.
    assert.deepEqual(problems, [])
  })

  test("reports an unreadable LanceDB index instead of calling it absent", async () => {
    // The directory is present but the native module cannot load, which is what
    // a missing `apache-arrow` looks like. Swallowing it produced "No Kilo
    // index found" for an index that was sitting on disk.
    const directory = mkdtempSync(path.join(os.tmpdir(), "oi-lancedb-"))
    try {
      const { lanceDbName } = await import("../src/lancedb-store.ts")
      const dbPath = path.join(directory, lanceDbName(ROOT))
      // A database directory with an unreadable table inside: connecting throws
      // rather than returning an empty schema, which is what a corrupt or
      // half-written store does in practice.
      mkdirSync(path.join(dbPath, "vector.lance"), { recursive: true })
      writeFileSync(path.join(dbPath, "vector.lance", "_versions"), "not a lance manifest")

      const problems: string[] = []
      const sources = await discoverKiloSources(ROOT, {
        qdrant: emptyQdrant(),
        lancedbDirectory: directory,
        onProblem: (message) => problems.push(message),
      })

      assert.deepEqual(sources, [], "an unreadable source is not an importable one")
      assert.equal(problems.length, 1, "exactly one problem, so the message cannot be mistaken for 'nothing here'")
      assert.match(problems[0], /exists at/, "the message must say the index is there")
      assert.match(problems[0], /could not be read: \S/, "and carry the reason, not just the verdict")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("reports an unreachable Qdrant rather than reporting no index", async () => {
    const problems: string[] = []
    const sources = await discoverKiloSources(ROOT, {
      qdrant: {
        listCollections: async () => {
          throw new Error("Unable to connect to Qdrant at localhost:6333")
        },
      } as never,
      lancedbDirectory: path.join(os.tmpdir(), "oi-absent-lancedb"),
      onProblem: (message) => problems.push(message),
    })

    assert.deepEqual(sources, [])
    assert.equal(problems.length, 1)
    assert.match(problems[0], /Could not reach the Qdrant server/)
    assert.match(problems[0], /Unable to connect/, "the underlying reason must survive")
  })

  test("an optional onProblem does not have to be provided", async () => {
    // Discovery runs on hot paths (every status read) that have nowhere to put a
    // message, so the hook is genuinely optional.
    const sources = await discoverKiloSources(ROOT, {
      qdrant: emptyQdrant(),
      lancedbDirectory: path.join(os.tmpdir(), "oi-absent-lancedb"),
    })
    assert.deepEqual(sources, [])
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
