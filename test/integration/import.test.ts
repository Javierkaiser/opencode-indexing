import * as assert from "node:assert/strict"
import * as os from "node:os"
import { after, before, describe, test } from "node:test"

import { resolveSettings } from "../../src/config.ts"
import { createQdrant } from "../../src/qdrant.ts"
import { createOwnStore } from "../../src/store-factory.ts"
import { importFromKilo } from "../../src/import.ts"
import { KILO_METADATA_ID } from "../../src/kilo-store.ts"
import type { EmbeddingProfile, QdrantPoint } from "../../src/types.ts"

/**
 * The import path, end to end against a real Qdrant.
 *
 * It seeds its own Kilo-shaped source rather than relying on whatever happens
 * to be indexed on the machine, so the same test runs on a developer box, in CI
 * and after a Kilo upgrade. `import.test.ts` covers the branch logic against
 * fakes; this covers what fakes cannot: scroll pagination over a real
 * collection, the payload surviving a round trip, and whether what landed is
 * actually searchable.
 *
 * Kept out of `npm test` on purpose: the first write into a fresh collection
 * costs seconds, which would dominate every unit run. Run it with
 * `npm run test:integration`.
 */
const CHUNKS = 20
const DIM = CHUNKS
const PROFILE: EmbeddingProfile = { provider: "mistral", modelId: "codestral-embed-2505", dimension: DIM }

const settings = resolveSettings({ homeDir: os.homedir() })
const qdrant = createQdrant({ url: settings.qdrantUrl, apiKey: settings.qdrantApiKey })

const unavailable = await qdrant
  .listCollections()
  .then(() => undefined as string | undefined)
  .catch(
    (error: unknown) =>
      `qdrant unreachable at ${settings.qdrantUrl}: ${error instanceof Error ? error.message : String(error)}`,
  )

const stamp = Date.now()
const sourceName = `zz-import-src-${stamp}`
const targetRoot = `zz-import-dst-${stamp}`

/** One distinct axis per chunk, so a search can identify exactly one chunk. */
function vectorFor(index: number): number[] {
  const vector = new Array(DIM).fill(0)
  vector[index % DIM] = 1
  return vector
}

/**
 * Qdrant only accepts an unsigned integer or a UUID as a point id, and Kilo
 * uses UUIDs, so the seed has to as well.
 */
function idFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
}

function chunkPoint(index: number): QdrantPoint {
  return {
    id: idFor(index),
    vector: vectorFor(index),
    payload: {
      filePath: `src/mod${index % 3}.ts`,
      fileHash: `hash-${index % 3}`,
      codeChunk: `export const value${index} = ${index}`,
      startLine: index + 1,
      endLine: index + 4,
      segmentHash: `seg-${index}`,
    },
  }
}

function sourceInfo(overrides: { name?: string; pointsCount?: number } = {}) {
  return {
    kind: "qdrant" as const,
    name: overrides.name ?? sourceName,
    pointsCount: overrides.pointsCount ?? CHUNKS + 1,
    profile: PROFILE,
    complete: true,
    schema: 2,
    compatible: true,
  }
}

describe("importFromKilo against a real Qdrant", { skip: unavailable }, () => {
  const target = createOwnStore({ ...settings, vectorStore: "qdrant" }, targetRoot)

  before(async () => {
    await qdrant.createCollection(sourceName, { vectors: { size: DIM, distance: "Cosine", on_disk: true } })
    const points: QdrantPoint[] = Array.from({ length: CHUNKS }, (_, index) => chunkPoint(index))
    points.push({
      id: KILO_METADATA_ID,
      vector: new Array(DIM).fill(0),
      payload: { type: "metadata", indexing_complete: true, index_schema: 2 },
    } as unknown as QdrantPoint)
    await qdrant.upsert(sourceName, points)
  })

  after(async () => {
    await qdrant.deleteCollection(sourceName).catch(() => {})
    await qdrant.deleteCollection(target.name).catch(() => {})
  })

  test("imports every chunk and leaves the metadata point behind", async () => {
    await target.ensure(DIM, PROFILE)
    const report = await importFromKilo({
      root: targetRoot,
      source: sourceInfo(),
      target,
      targetProfile: PROFILE,
      qdrant,
    })

    assert.equal(report.imported, CHUNKS)
    // The metadata entry is filtered out by the scroll filter, so it never
    // reaches the skip counter either.
    assert.equal(report.skipped, 0)
    assert.deepEqual(report.errors, [])
    assert.equal(Object.keys(report.files).length, 3)

    const info = await target.info()
    assert.equal(info.complete, true)
  })

  test("paginates when the batch limit is smaller than the source", async () => {
    const report = await importFromKilo({
      root: targetRoot,
      source: sourceInfo(),
      target,
      targetProfile: PROFILE,
      qdrant,
      batchLimit: 3,
    })

    assert.equal(report.imported, CHUNKS)
    assert.ok(report.batches >= Math.ceil(CHUNKS / 3), `expected several batches, got ${report.batches}`)
  })

  test("imported chunks are searchable", async () => {
    const hits = await target.search({ vector: vectorFor(7), maxResults: 5 })
    assert.ok(hits.length > 0, "nothing came back for an imported vector")
    assert.equal(hits[0]?.payload?.filePath, "src/mod1.ts")
    assert.ok((hits[0]?.score ?? 0) > 0.99, `expected an exact match, got ${hits[0]?.score}`)
  })

  test("an empty source fails instead of marking the index complete", async () => {
    const emptyName = `zz-import-empty-${Date.now()}`
    await qdrant.createCollection(emptyName, { vectors: { size: DIM, distance: "Cosine" } })
    try {
      await assert.rejects(
        importFromKilo({
          root: targetRoot,
          source: sourceInfo({ name: emptyName, pointsCount: 0 }),
          target,
          targetProfile: PROFILE,
          qdrant,
        }),
        /Imported 0 chunks/,
      )
    } finally {
      await qdrant.deleteCollection(emptyName).catch(() => {})
    }
  })
})