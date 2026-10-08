import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, test } from "node:test"

import type { Qdrant } from "../src/qdrant.ts"
import type { EmbeddingProfile, QdrantFilter, QdrantPoint, QueryHit } from "../src/types.ts"
import {
  KILO_METADATA_ID,
  getKiloStoreInfo,
  kiloCollectionCandidates,
  resolveKiloCollection,
  searchKiloCollection,
} from "../src/kilo-store.ts"
import {
  OWN_METADATA_ID,
  OWN_SCHEMA,
  deleteOwnByFilePaths,
  ensureOwnCollection,
  getOwnStoreInfo,
  markOwnComplete,
  ownCollectionName,
  searchOwnCollection,
  upsertChunkPoints,
} from "../src/own-store.ts"

/**
 * The tests intentionally avoid importing `src/qdrant.ts` (only a type-only
 * import is used, which is erased at runtime) and drive a plain-object fake
 * implementing just the methods these modules consume.
 */

// ---------------------------------------------------------------------------
// Fake Qdrant
// ---------------------------------------------------------------------------

interface CapturedQueryOptions {
  vector: number[]
  filter?: QdrantFilter
  scoreThreshold?: number
  limit?: number
  include?: string[]
  hnswEf?: number
}

interface CapturedCreateConfig {
  vectors: { size: number; distance: string; on_disk?: boolean }
  hnsw_config?: { m?: number; ef_construct?: number; on_disk?: boolean }
}

interface RetrievedPoint {
  id: string | number
  payload: Record<string, unknown> | null
}

class FakeQdrant {
  collections = new Set<string>()
  collectionInfos = new Map<string, Record<string, any>>()
  retrieveResponses = new Map<string, RetrievedPoint[]>()
  queryResponse: QueryHit[] = []
  queryError: Error | null = null

  queryCalls: Array<{ name: string; options: CapturedQueryOptions }> = []
  retrieveCalls: Array<{ name: string; ids: Array<string | number> }> = []
  createdCollections: Array<{ name: string; config: CapturedCreateConfig }> = []
  upserts: Array<{ name: string; points: QdrantPoint[]; wait?: boolean }> = []
  deletedFilters: Array<{ name: string; filter: QdrantFilter | undefined; wait?: boolean }> = []
  payloadIndexes: Array<{ name: string; field: string; schema?: unknown }> = []

  async listCollections(): Promise<string[]> {
    return [...this.collections]
  }

  async getCollection(name: string): Promise<Record<string, any> | null> {
    return this.collectionInfos.get(name) ?? null
  }

  async collectionExists(name: string): Promise<boolean> {
    return this.collections.has(name)
  }

  async createCollection(name: string, config: CapturedCreateConfig): Promise<void> {
    this.createdCollections.push({ name, config })
    this.collections.add(name)
  }

  async deleteCollection(name: string): Promise<void> {
    this.collections.delete(name)
  }

  async retrieve(name: string, ids: Array<string | number>): Promise<RetrievedPoint[]> {
    this.retrieveCalls.push({ name, ids })
    return this.retrieveResponses.get(name) ?? []
  }

  async scroll(): Promise<{ points: RetrievedPoint[]; next?: unknown }> {
    return { points: [] }
  }

  async query(name: string, options: CapturedQueryOptions): Promise<QueryHit[]> {
    this.queryCalls.push({ name, options })
    if (this.queryError) throw this.queryError
    return this.queryResponse
  }

  async upsert(name: string, points: QdrantPoint[], wait?: boolean): Promise<void> {
    this.upserts.push({ name, points, wait })
  }

  async deletePoints(name: string, filter: QdrantFilter | undefined, wait?: boolean): Promise<void> {
    this.deletedFilters.push({ name, filter, wait })
  }

  async createPayloadIndex(name: string, field: string, schema?: unknown): Promise<void> {
    this.payloadIndexes.push({ name, field, schema })
  }
}

function makeFake(): { fake: FakeQdrant; client: Qdrant } {
  const fake = new FakeQdrant()
  return { fake, client: fake as unknown as Qdrant }
}

const METADATA_MUST_NOT = { key: "type", match: { value: "metadata" } }
const OWN_METADATA_MUST_NOT = { key: "type", match: { value: "oc_metadata" } }

const METADATA_PAYLOAD: Record<string, unknown> = {
  index_schema: 2,
  indexing_complete: true,
  embedding_provider: "mistral",
  embedding_model_id: "codestral-embed-2505",
  embedding_dimension: 1536,
}

const PROFILE: EmbeddingProfile = {
  provider: "mistral",
  modelId: "codestral-embed-2505",
  dimension: 1536,
}

function usableHit(filePath: string, score = 0.9): QueryHit {
  return {
    id: `id-${filePath}`,
    score,
    payload: {
      filePath,
      fileHash: "abc123",
      codeChunk: "export const x = 1",
      startLine: 1,
      endLine: 1,
      pathSegments: { "0": "src" },
    },
  }
}

const WORKSPACE = "D:\\Proyectos"

// ---------------------------------------------------------------------------
// Collection names / candidates
// ---------------------------------------------------------------------------

describe("collection names", () => {
  test("ownCollectionName uses oc- prefix and workspaceHash", () => {
    const expected = "oc-" + createHash("sha256").update(WORKSPACE).digest("hex").slice(0, 16)
    assert.equal(ownCollectionName(WORKSPACE), expected)
    assert.equal(ownCollectionName(WORKSPACE), "oc-43dfc9b3ee33fcfd")
  })

  test("kiloCollectionCandidates first candidate is the raw root hash with ws- prefix", () => {
    const candidates = kiloCollectionCandidates(WORKSPACE)
    assert.ok(candidates.length > 0)
    assert.equal(candidates[0], "ws-43dfc9b3ee33fcfd")
    for (const candidate of candidates) {
      assert.match(candidate, /^ws-[0-9a-f]{16}$/)
    }
    // Deduplicated.
    assert.equal(new Set(candidates).size, candidates.length)
  })

  test("kiloCollectionCandidates adds separator-normalized variants on win32", () => {
    if (process.platform !== "win32") return
    const candidates = kiloCollectionCandidates("D:/Proyectos")
    const expectedBackslash = "ws-" + createHash("sha256").update(WORKSPACE).digest("hex").slice(0, 16)
    assert.ok(candidates.includes(expectedBackslash))
    assert.ok(candidates.length >= 2)
  })
})

describe("resolveKiloCollection", () => {
  test("returns cached collection when it still exists", async () => {
    const { fake, client } = makeFake()
    fake.collections.add("oc-something")
    const resolved = await resolveKiloCollection(client, WORKSPACE, "oc-something")
    assert.equal(resolved, "oc-something")
  })

  test("falls back to hash candidates in order", async () => {
    const { fake, client } = makeFake()
    // Forward slashes + trailing slash guarantee several distinct spellings.
    const root = "D:/Proyectos/"
    const candidates = kiloCollectionCandidates(root)
    assert.ok(candidates.length >= 2, `expected multiple candidates, got ${JSON.stringify(candidates)}`)
    fake.collections.add(candidates[1]!)
    const resolved = await resolveKiloCollection(client, root)
    assert.equal(resolved, candidates[1])
  })

  test("returns null when no candidate exists", async () => {
    const { client } = makeFake()
    assert.equal(await resolveKiloCollection(client, WORKSPACE), null)
  })
})

// ---------------------------------------------------------------------------
// Kilo store info
// ---------------------------------------------------------------------------

describe("getKiloStoreInfo", () => {
  test("parses points_count and metadata payload", async () => {
    const { fake, client } = makeFake()
    const name = "ws-43dfc9b3ee33fcfd"
    fake.collectionInfos.set(name, { points_count: 321 })
    fake.retrieveResponses.set(name, [{ id: KILO_METADATA_ID, payload: METADATA_PAYLOAD }])

    const info = await getKiloStoreInfo(client, name)
    assert.equal(info.collection, name)
    assert.equal(info.pointsCount, 321)
    assert.deepEqual(info.profile, PROFILE)
    assert.equal(info.complete, true)
    assert.equal(info.schema, 2)
    assert.deepEqual(fake.retrieveCalls[0], { name, ids: [KILO_METADATA_ID] })
  })

  test("tolerates a collection without a metadata point", async () => {
    const { fake, client } = makeFake()
    fake.collectionInfos.set("ws-x", { points_count: 0 })
    const info = await getKiloStoreInfo(client, "ws-x")
    assert.equal(info.pointsCount, 0)
    assert.equal(info.profile, undefined)
    assert.equal(info.complete, undefined)
    assert.equal(info.schema, undefined)
  })

  test("throws when the collection does not exist", async () => {
    const { client } = makeFake()
    await assert.rejects(getKiloStoreInfo(client, "ws-missing"), /does not exist/)
  })
})

// ---------------------------------------------------------------------------
// Kilo search filters
// ---------------------------------------------------------------------------

describe("searchKiloCollection", () => {
  test("forwards filters and drops payload-incomplete hits", async () => {
    const { fake, client } = makeFake()
    fake.queryResponse = [
      usableHit("src\\sub\\a.ts"),
      { id: "broken", score: 0.8, payload: { filePath: "src\\sub\\b.ts", codeChunk: "x", startLine: 1, endLine: 2 } },
      { id: "meta", score: 0.7, payload: null },
    ]

    const hits = await searchKiloCollection(client, "ws-x", {
      vector: [0.1, 0.2],
      pathPrefix: "src\\sub",
      minScore: 0.62,
      maxResults: 7,
      hnswEf: 200,
    })

    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.id, "id-src\\sub\\a.ts")

    assert.equal(fake.queryCalls.length, 1)
    const call = fake.queryCalls[0]!
    assert.equal(call.name, "ws-x")
    assert.deepEqual(call.options.vector, [0.1, 0.2])
    assert.deepEqual(call.options.filter, {
      must_not: [METADATA_MUST_NOT],
      must: [
        { key: "pathSegments.0", match: { value: "src" } },
        { key: "pathSegments.1", match: { value: "sub" } },
      ],
    })
    assert.equal(call.options.scoreThreshold, 0.62)
    assert.equal(call.options.limit, 7)
    assert.equal(call.options.hnswEf, 200)
    assert.deepEqual(call.options.include, ["filePath", "fileHash", "codeChunk", "startLine", "endLine", "pathSegments"])
  })

  test("without pathPrefix only excludes metadata points and applies defaults", async () => {
    const { fake, client } = makeFake()
    await searchKiloCollection(client, "ws-x", { vector: [1] })
    const call = fake.queryCalls[0]!
    assert.equal(call.options.filter!.must, undefined)
    assert.deepEqual(call.options.filter, { must_not: [METADATA_MUST_NOT] })
    assert.equal((call.options.filter as { must?: unknown } | undefined)?.must, undefined)
    assert.equal(call.options.scoreThreshold, 0.4)
    assert.equal(call.options.limit, 50)
    assert.equal(call.options.hnswEf, 128)
  })

  test("ignores trivial path prefixes", async () => {
    const { fake, client } = makeFake()
    await searchKiloCollection(client, "ws-x", { vector: [1], pathPrefix: "." })
    assert.equal(fake.queryCalls[0]!.options.filter!.must, undefined)
  })

  test("returns [] when the collection is missing (404)", async () => {
    const { fake, client } = makeFake()
    fake.queryError = new Error("Collection ws-x not found: 404")
    assert.deepEqual(await searchKiloCollection(client, "ws-x", { vector: [1] }), [])
  })

  test("rethrows non-missing errors", async () => {
    const { fake, client } = makeFake()
    fake.queryError = new Error("connection refused")
    await assert.rejects(searchKiloCollection(client, "ws-x", { vector: [1] }), /connection refused/)
  })
})

// ---------------------------------------------------------------------------
// Own store: naming, creation, info
// ---------------------------------------------------------------------------

describe("ensureOwnCollection", () => {
  test("creates collection with vector config and payload indexes", async () => {
    const { fake, client } = makeFake()
    const name = ownCollectionName(WORKSPACE)
    const result = await ensureOwnCollection(client, name, 1536)

    assert.deepEqual(result, { created: true })
    assert.equal(fake.createdCollections.length, 1)
    assert.equal(fake.createdCollections[0]!.name, name)
    assert.deepEqual(fake.createdCollections[0]!.config, {
      vectors: { size: 1536, distance: "Cosine", on_disk: true },
      hnsw_config: { m: 64, ef_construct: 512, on_disk: true },
    })
    assert.deepEqual(
      fake.payloadIndexes.map((entry) => entry.field),
      ["type", "pathSegments.0", "pathSegments.1", "pathSegments.2", "pathSegments.3", "pathSegments.4"],
    )
    assert.ok(fake.payloadIndexes.every((entry) => entry.name === name && entry.schema === "keyword"))
  })

  test("keeps an existing collection with matching vector size", async () => {
    const { fake, client } = makeFake()
    const name = ownCollectionName(WORKSPACE)
    fake.collectionInfos.set(name, { config: { params: { vectors: { size: 1536, distance: "Cosine" } } } })

    const result = await ensureOwnCollection(client, name, 1536)
    assert.deepEqual(result, { created: false })
    assert.equal(fake.createdCollections.length, 0)
    assert.equal(fake.payloadIndexes.length, 0)
  })

  test("throws on vector size mismatch instead of recreating", async () => {
    const { fake, client } = makeFake()
    const name = ownCollectionName(WORKSPACE)
    fake.collectionInfos.set(name, { config: { params: { vectors: { size: 768, distance: "Cosine" } } } })

    await assert.rejects(ensureOwnCollection(client, name, 1536), /vector size 768/)
    assert.equal(fake.createdCollections.length, 0)
  })
})

describe("getOwnStoreInfo", () => {
  test("returns null for a missing collection", async () => {
    const { client } = makeFake()
    assert.equal(await getOwnStoreInfo(client, "oc-missing"), null)
  })

  test("parses points_count and metadata payload", async () => {
    const { fake, client } = makeFake()
    const name = ownCollectionName(WORKSPACE)
    fake.collectionInfos.set(name, { points_count: 42 })
    fake.retrieveResponses.set(name, [{ id: OWN_METADATA_ID, payload: { ...METADATA_PAYLOAD, indexing_complete: false } }])

    const info = await getOwnStoreInfo(client, name)
    assert.ok(info)
    assert.equal(info.collection, name)
    assert.equal(info.pointsCount, 42)
    assert.deepEqual(info.profile, PROFILE)
    assert.equal(info.complete, false)
    assert.equal(info.schema, 2)
  })
})

// ---------------------------------------------------------------------------
// Own store: payloads and deletion
// ---------------------------------------------------------------------------

describe("upsertChunkPoints", () => {
  test("enriches payload with string-keyed pathSegments", async () => {
    const { fake, client } = makeFake()
    const name = ownCollectionName(WORKSPACE)
    const point: QdrantPoint = {
      id: "chunk-1",
      vector: [0.5],
      payload: { filePath: "src\\sub\\file.ts", fileHash: "h", codeChunk: "c", startLine: 1, endLine: 3 },
    }

    await upsertChunkPoints(client, name, [point])

    assert.equal(fake.upserts.length, 1)
    const stored = fake.upserts[0]!.points[0]!
    assert.equal(stored.id, "chunk-1")
    assert.deepEqual(stored.payload.pathSegments, { "0": "src", "1": "sub", "2": "file.ts" })
    assert.ok(Object.keys(stored.payload.pathSegments as object).every((key) => typeof key === "string"))
    // Existing payload fields survive.
    assert.equal(stored.payload.fileHash, "h")
  })

  test("handles mixed separators and remains a no-op for empty input", async () => {
    const { fake, client } = makeFake()
    await upsertChunkPoints(client, "oc-x", [
      { id: "p", vector: [1], payload: { filePath: "src/sub\\file.ts" } },
    ])
    assert.deepEqual(fake.upserts[0]!.points[0]!.payload.pathSegments, { "0": "src", "1": "sub", "2": "file.ts" })

    await upsertChunkPoints(client, "oc-x", [])
    assert.equal(fake.upserts.length, 1)
  })
})

describe("deleteOwnByFilePaths", () => {
  test("builds a should-filter of per-file segment conditions", async () => {
    const { fake, client } = makeFake()
    const name = ownCollectionName(WORKSPACE)
    await deleteOwnByFilePaths(client, name, WORKSPACE, ["src\\a.ts", "lib/b.ts"])

    assert.equal(fake.deletedFilters.length, 1)
    const call = fake.deletedFilters[0]!
    assert.equal(call.name, name)
    assert.equal(call.wait, true)
    assert.deepEqual(call.filter, {
      should: [
        {
          must: [
            { key: "pathSegments.0", match: { value: "src" } },
            { key: "pathSegments.1", match: { value: "a.ts" } },
          ],
        },
        {
          must: [
            { key: "pathSegments.0", match: { value: "lib" } },
            { key: "pathSegments.1", match: { value: "b.ts" } },
          ],
        },
      ],
      must_not: [OWN_METADATA_MUST_NOT],
    })
  })

  test("does nothing for an empty path list", async () => {
    const { fake, client } = makeFake()
    await deleteOwnByFilePaths(client, "oc-x", WORKSPACE, [])
    assert.equal(fake.deletedFilters.length, 0)
  })
})

// ---------------------------------------------------------------------------
// Own store: search and completion marker
// ---------------------------------------------------------------------------

describe("searchOwnCollection", () => {
  test("excludes own metadata points and applies defaults", async () => {
    const { fake, client } = makeFake()
    fake.queryResponse = [usableHit("src/a.ts")]
    const hits = await searchOwnCollection(client, "oc-x", { vector: [1, 2, 3] })
    assert.equal(hits.length, 1)
    const call = fake.queryCalls[0]!
    assert.deepEqual(call.options.filter, { must_not: [OWN_METADATA_MUST_NOT] })
    assert.equal(call.options.scoreThreshold, 0.4)
    assert.equal(call.options.limit, 50)
    assert.equal(call.options.hnswEf, 128)
    assert.deepEqual(call.options.include, ["filePath", "fileHash", "codeChunk", "startLine", "endLine", "pathSegments"])
  })

  test("honors pathPrefix with normalized segments", async () => {
    const { fake, client } = makeFake()
    await searchOwnCollection(client, "oc-x", { vector: [1], pathPrefix: "./src\\sub" })
    assert.deepEqual(fake.queryCalls[0]!.options.filter, {
      must_not: [OWN_METADATA_MUST_NOT],
      must: [
        { key: "pathSegments.0", match: { value: "src" } },
        { key: "pathSegments.1", match: { value: "sub" } },
      ],
    })
  })

  test("returns [] when the collection is missing", async () => {
    const { fake, client } = makeFake()
    fake.queryError = new Error("Collection oc-x does not exist")
    assert.deepEqual(await searchOwnCollection(client, "oc-x", { vector: [1] }), [])
  })
})

describe("markOwnComplete", () => {
  test("upserts the metadata point with profile, schema and zero vector", async () => {
    const { fake, client } = makeFake()
    const name = ownCollectionName(WORKSPACE)
    const before = Date.now()
    await markOwnComplete(client, name, PROFILE, true, 8)

    assert.equal(fake.upserts.length, 1)
    const stored = fake.upserts[0]!.points[0]!
    assert.equal(stored.id, OWN_METADATA_ID)
    assert.equal(stored.vector.length, 8)
    assert.ok(stored.vector.every((value) => value === 0))
    assert.equal(stored.payload.type, "oc_metadata")
    assert.equal(stored.payload.writer, "opencode")
    assert.equal(stored.payload.index_schema, OWN_SCHEMA)
    assert.equal(stored.payload.indexing_complete, true)
    assert.equal(stored.payload.embedding_provider, PROFILE.provider)
    assert.equal(stored.payload.embedding_model_id, PROFILE.modelId)
    assert.equal(stored.payload.embedding_dimension, PROFILE.dimension)
    assert.equal(typeof stored.payload.updated_at, "number")
    assert.ok((stored.payload.updated_at as number) >= before)
  })
})
