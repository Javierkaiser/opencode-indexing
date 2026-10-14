import assert from "node:assert/strict"
import { after, before, beforeEach, test } from "node:test"

import { searchCode } from "../src/search.ts"
import type { Qdrant } from "../src/qdrant.ts"
import type { VectorStoreAdapter, VectorStoreInfo } from "../src/vector-store.ts"
import type { EmbeddingProfile, IndexingSettings, KVStore, QueryHit } from "../src/types.ts"

/**
 * A search that cannot read part of the corpus must say so.
 *
 * The original code caught an embedding failure per profile, pushed it onto a
 * list the tool renders as "Warnings", and returned the other half of the
 * results as though it were the whole answer. Nothing distinguished that from a
 * complete search whose missing half simply ranked lower.
 */

const realFetch = globalThis.fetch

before(() => {
  // Embedding goes over the network; the search itself must not. A stub keeps
  // these tests hermetic and, more importantly, stops them calling a paid API.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
})

function memoryKv(): KVStore {
  const store = new Map<string, unknown>()
  return {
    async get(key: string): Promise<unknown> {
      return store.get(key)
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value)
    },
    async remove(key: string): Promise<void> {
      store.delete(key)
    },
    async scan(): Promise<{ keys: string[]; next: undefined }> {
      return { keys: [], next: undefined }
    },
  } as unknown as KVStore
}

function settings(overrides: Partial<IndexingSettings> = {}): IndexingSettings {
  return {
    provider: "mistral",
    modelId: "codestral-embed-2505",
    dimension: 1536,
    vectorStore: "lancedb",
    kiloVectorStore: null,
    qdrantUrl: "http://localhost:6333",
    lancedbDirectory: "C:\\state\\lancedb",
    scoreThreshold: 0.35,
    searchMaxResults: 20,
    embeddingBatchSize: 60,
    maxFileSizeBytes: 1024 * 1024,
    fileExtensions: [],
    autoRefresh: false,
    importFromKilo: false,
    enabled: true,
    credentials: {},
    warnings: [],
    ...overrides,
  }
}

/** An own store that reports whatever profile it is given, with no server behind it. */
function fakeOwnStore(profile: EmbeddingProfile | undefined, points: number, hits: QueryHit[] = []): VectorStoreAdapter {
  return {
    kind: "lancedb",
    name: "own",
    async info(): Promise<VectorStoreInfo> {
      return { exists: points > 0, pointsCount: points, complete: true, profile } as VectorStoreInfo
    },
    async search(): Promise<QueryHit[]> {
      return hits
    },
  } as unknown as VectorStoreAdapter
}

const emptyQdrant = {
  async listCollections(): Promise<string[]> {
    return []
  },
  async getCollection(): Promise<null> {
    return null
  },
  async collectionExists(): Promise<boolean> {
    return false
  },
} as unknown as Qdrant

test("a search that cannot embed the own index's profile fails instead of shrinking", async () => {
  // The own index holds points built by a provider whose credential is missing,
  // which is exactly what an index imported from Kilo looks like when its
  // provider is not configured here.
  const profile: EmbeddingProfile = { provider: "voyage", modelId: "voyage-code-4", dimension: 1024 }

  await assert.rejects(
    () =>
      searchCode(
        {
          qdrant: emptyQdrant,
          kv: memoryKv(),
          root: "D:\\Projects\\demo",
          settings: settings(),
          ownStore: fakeOwnStore(profile, 120),
        },
        "where is the auth check",
      ),
    (error: Error) => {
      assert.match(error.message, /Cannot search the own index/)
      assert.match(error.message, /voyage:voyage-code-4:1024/, "it must name the profile it could not embed")
      assert.match(error.message, /incomplete result set/, "and say why returning the rest would mislead")
      return true
    },
  )
})

test("an index with no points needs no query vector and is not an error", async () => {
  // Nothing to search means nothing to be incomplete about.
  const outcome = await searchCode(
    {
      qdrant: emptyQdrant,
      kv: memoryKv(),
      root: "D:\\Projects\\demo",
      settings: settings(),
      ownStore: fakeOwnStore({ provider: "voyage", modelId: "voyage-code-4", dimension: 1024 }, 0),
    },
    "anything",
  )
  assert.deepEqual(outcome.hits, [])
})

test("a healthy profile returns its hits", async () => {
  const hit: QueryHit = {
    id: "p1",
    score: 0.9,
    payload: { filePath: "src/a.ts", fileHash: "h", codeChunk: "code", startLine: 1, endLine: 2 },
  }
  const outcome = await searchCode(
    {
      qdrant: emptyQdrant,
      kv: memoryKv(),
      root: "D:\\Projects\\demo",
      settings: settings({ credentials: { mistralApiKey: "k" } }),
      ownStore: fakeOwnStore({ provider: "mistral", modelId: "codestral-embed-2505", dimension: 1536 }, 10, [hit]),
    },
    "where is the auth check",
  )
  assert.equal(outcome.hits.length, 1)
  assert.equal(outcome.hits[0]!.filePath, "src/a.ts")
})
