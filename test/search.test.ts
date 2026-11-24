import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, before, beforeEach, describe, test } from "node:test"

import { invalidateSearchCaches, searchCode, type SearchDeps } from "../src/search.ts"
import { KILO_METADATA_ID, kiloCollectionCandidates, resolveKiloCollection } from "../src/kilo-store.ts"
import { createTools } from "../src/tools.ts"
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

// Search metadata is cached per workspace for a few seconds; each test builds
// its own store, so a value from the previous one must not leak in.
beforeEach(() => invalidateSearchCaches())

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

/** A Qdrant fake for the Kilo read path: existence probes, metadata, queries. */
function kiloQdrant(options: {
  collections: string[]
  info?: Record<string, unknown>
  payload?: Record<string, unknown> | null
  hits?: QueryHit[]
  onProbe?: (name: string) => void
  onRead?: () => void
}): Qdrant {
  const collections = new Set(options.collections)
  return {
    async collectionExists(name: string): Promise<boolean> {
      options.onProbe?.(name)
      return collections.has(name)
    },
    async getCollection(name: string): Promise<Record<string, any> | null> {
      options.onRead?.()
      return collections.has(name) ? (options.info ?? { points_count: 5 }) : null
    },
    async retrieve(): Promise<Array<{ id: string | number; payload: Record<string, unknown> | null }>> {
      return [{ id: KILO_METADATA_ID, payload: options.payload ?? null }]
    },
    async query(): Promise<QueryHit[]> {
      return options.hits ?? []
    },
  } as unknown as Qdrant
}

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

test("searchKilo: false leaves Kilo's index out instead of failing on its profile", async () => {
  // A workspace whose Kilo collection was built by a cloud profile this machine
  // can no longer embed (an expired key, an exhausted budget) used to fail the
  // whole search, because answering from half the corpus would look complete.
  // With the switch off, the own index stays searchable — which is the point.
  const exploding = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("Kilo's store must not be queried when searchKilo is false")
      },
    },
  ) as unknown as Qdrant

  const hit: QueryHit = {
    id: "p1",
    score: 0.8,
    payload: { filePath: "src/b.ts", fileHash: "h", codeChunk: "code", startLine: 5, endLine: 9 },
  }
  const outcome = await searchCode(
    {
      qdrant: exploding,
      kv: memoryKv(),
      root: "D:\\Projects\\demo",
      settings: settings({ vectorStore: "qdrant", searchKilo: false, credentials: { mistralApiKey: "k" } }),
      ownStore: fakeOwnStore({ provider: "mistral", modelId: "codestral-embed-2505", dimension: 1536 }, 10, [hit]),
    },
    "where is the auth check",
  )

  assert.equal(outcome.hits.length, 1)
  assert.equal(outcome.hits[0]!.filePath, "src/b.ts")
  assert.equal(outcome.meta.kilo.collection, null, "Kilo must not appear in the metadata")
  assert.equal(outcome.meta.kilo.searched, false, "not searched is not the same as absent")
  assert.deepEqual(outcome.errors, [], "skipping Kilo on purpose is not an error")
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
  assert.equal(outcome.meta.kilo.searched, true, "the default looks for Kilo, even when there is none")
  assert.equal(outcome.meta.kilo.collection, null, "searched and absent still means no collection")
})

test("a query embeds every distinct profile and returns hits from both indexes", async () => {
  // The own index and Kilo's were built with different models. Waiting for one
  // provider before even starting the other doubles the latency of the search
  // that touches both, for two requests that do not depend on each other.
  const root = mkdtempSync(path.join(os.tmpdir(), "oi-search-dual-"))
  mkdirSync(path.join(root, "src"))
  writeFileSync(path.join(root, "src", "kilo.ts"), "export const kilo = 1\n")
  writeFileSync(path.join(root, "src", "own.ts"), "export const own = 1\n")

  const kiloProfile: EmbeddingProfile = { provider: "mistral", modelId: "codestral-embed-2505", dimension: 1536 }
  const ownProfile: EmbeddingProfile = { provider: "voyage", modelId: "voyage-code-4", dimension: 1024 }
  const collection = kiloCollectionCandidates(root)[0]!
  const models: string[] = []

  const real = globalThis.fetch
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string }
    models.push(String(body.model))
    return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch

  try {
    const outcome = await searchCode(
      {
        qdrant: kiloQdrant({
          collections: [collection],
          info: { points_count: 7 },
          payload: {
            embedding_provider: kiloProfile.provider,
            embedding_model_id: kiloProfile.modelId,
            embedding_dimension: kiloProfile.dimension,
            indexing_complete: true,
          },
          hits: [
            {
              id: "k1",
              score: 0.82,
              payload: { filePath: "src/kilo.ts", fileHash: "h", codeChunk: "kilo", startLine: 1, endLine: 1 },
            },
          ],
        }),
        kv: memoryKv(),
        root,
        settings: settings({ vectorStore: "qdrant", credentials: { mistralApiKey: "m", voyageApiKey: "v" } }),
        ownStore: fakeOwnStore(ownProfile, 10, [
          {
            id: "o1",
            score: 0.71,
            payload: { filePath: "src/own.ts", fileHash: "h", codeChunk: "own", startLine: 1, endLine: 1 },
          },
        ]),
      },
      "where is the auth check",
    )

    assert.deepEqual([...models].sort(), ["codestral-embed-2505", "voyage-code-4"], "both embeds ran")
    assert.deepEqual(
      outcome.hits.map((hit) => hit.source).sort(),
      ["kilo", "own"],
      "a hit from each index survives the merge",
    )
    assert.deepEqual(outcome.meta.profiles.sort(), [
      "mistral:codestral-embed-2505:1536",
      "voyage:voyage-code-4:1024",
    ])
  } finally {
    globalThis.fetch = real
    rmSync(root, { recursive: true, force: true })
  }
})

describe("search metadata cache", () => {
  test("own store info is reused within the ttl and refreshed after invalidation", async () => {
    const root = "D:\\Projects\\cached-own"
    const profile: EmbeddingProfile = { provider: "mistral", modelId: "codestral-embed-2505", dimension: 1536 }
    let infoCalls = 0
    const store = {
      kind: "lancedb",
      name: "own",
      async info(): Promise<VectorStoreInfo> {
        infoCalls += 1
        return { exists: true, pointsCount: 3, complete: true, profile } as VectorStoreInfo
      },
      async search(): Promise<QueryHit[]> {
        return []
      },
    } as unknown as VectorStoreAdapter
    const deps: SearchDeps = {
      qdrant: emptyQdrant,
      kv: memoryKv(),
      root,
      settings: settings({ credentials: { mistralApiKey: "k" } }),
      ownStore: store,
    }

    await searchCode(deps, "first")
    await searchCode(deps, "second")
    assert.equal(infoCalls, 1, "the second search must reuse the metadata instead of asking the store again")

    invalidateSearchCaches(root)
    await searchCode(deps, "third")
    assert.equal(infoCalls, 2, "invalidation forces a fresh read")

    await searchCode({ ...deps, root: "D:\\Projects\\cached-own-other" }, "fourth")
    assert.equal(infoCalls, 3, "another workspace has its own cache entry")
  })

  test("the resolved Kilo collection and its metadata are cached until invalidated", async () => {
    const root = "D:/Projects/cached-kilo"
    const collection = kiloCollectionCandidates(root)[0]!
    let probes = 0
    let infoReads = 0
    const client = kiloQdrant({
      collections: [collection],
      onProbe: () => {
        probes += 1
      },
      onRead: () => {
        infoReads += 1
      },
    })
    const deps: SearchDeps = {
      qdrant: client,
      kv: memoryKv(),
      root,
      settings: settings({ vectorStore: "qdrant", credentials: { mistralApiKey: "k" } }),
      ownStore: fakeOwnStore(undefined, 0),
    }

    await searchCode(deps, "first")
    await searchCode(deps, "second")
    assert.equal(probes, 1, "the second search must not probe Qdrant again")
    assert.equal(infoReads, 1, "nor re-read the Kilo collection metadata")

    invalidateSearchCaches(root)
    await searchCode(deps, "third")
    assert.equal(probes, 2)
    assert.equal(infoReads, 2)
  })
})

describe("resolveKiloCollection probing", () => {
  test("probes the cached name and candidate names without listing collections", async () => {
    const root = "D:/Projects/probe"
    const candidates = kiloCollectionCandidates(root)
    const target = candidates[candidates.length - 1]!
    const probed: string[] = []
    const client = {
      async listCollections(): Promise<string[]> {
        throw new Error("resolving one workspace must not list every collection")
      },
      async collectionExists(name: string): Promise<boolean> {
        probed.push(name)
        return name === target
      },
    } as unknown as Qdrant

    assert.equal(await resolveKiloCollection(client, root, "ws-cached"), target)
    assert.deepEqual(probed, ["ws-cached", ...candidates])
  })

  test("returns null when neither the cached name nor a candidate exists", async () => {
    const root = "D:/Projects/probe-missing"
    const probed: string[] = []
    const client = {
      async collectionExists(name: string): Promise<boolean> {
        probed.push(name)
        return false
      },
    } as unknown as Qdrant

    assert.equal(await resolveKiloCollection(client, root), null)
    assert.deepEqual(probed, kiloCollectionCandidates(root))
  })

  test("a failed probe is an error, not an absent collection", async () => {
    // "Kilo never indexed this workspace" and "Qdrant is unreachable" call for
    // different actions; collapsing the second into the first hides the outage.
    const client = {
      async collectionExists(): Promise<boolean> {
        throw new Error("connect ECONNREFUSED")
      },
    } as unknown as Qdrant

    await assert.rejects(() => resolveKiloCollection(client, "D:/Projects/down"), /ECONNREFUSED/)
  })
})

describe("search tool: why Kilo contributed nothing", () => {
  const root = "D:\\Projects\\demo"

  /** Runs the `search` tool against an unreachable backend, which answers empty. */
  async function searchOutput(overrides: Partial<IndexingSettings>): Promise<string> {
    const tools = createTools({
      kv: memoryKv(),
      root,
      getSettings: async () => settings({ vectorStore: "qdrant", qdrantUrl: "http://127.0.0.1:1", ...overrides }),
    })
    const tool = tools.find((entry) => entry.name === "search")
    assert.ok(tool, "the search tool must exist")
    const result = await tool.execute({ query: "anything" }, { directory: root })
    return result.output
  }

  test("with searchKilo off it says the search is disabled, not that Kilo is missing", async () => {
    // Both cases leave `meta.kilo.collection` null. Reporting the second when
    // the first is true tells the user Kilo has no index when it was never read.
    const output = await searchOutput({ searchKilo: false })

    assert.match(output, /Kilo index: search disabled/i)
    assert.doesNotMatch(output, /Kilo index: not found/i)
  })

  test("with searchKilo on an absent Kilo index is still reported as not found", async () => {
    const output = await searchOutput({ searchKilo: true })

    assert.match(output, /Kilo index: not found/i)
    assert.doesNotMatch(output, /search disabled/i)
  })
})
