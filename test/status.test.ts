import assert from "node:assert/strict"
import { test } from "node:test"

import { getStatus } from "../src/status.ts"
import type { Qdrant } from "../src/qdrant.ts"
import type { VectorStoreAdapter, VectorStoreInfo } from "../src/vector-store.ts"
import type { EmbeddingProfile, IndexingSettings, KVStore } from "../src/types.ts"

/**
 * A provider change deletes the own index and re-embeds the whole workspace.
 *
 * The status report is where a user looks before running a build, so it is the
 * only place that can warn them in time. Discovering it afterwards means the
 * embeddings have already been paid for.
 */

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

function ownStore(profile: EmbeddingProfile | undefined, points: number): VectorStoreAdapter {
  return {
    kind: "lancedb",
    name: "own",
    async info(): Promise<VectorStoreInfo> {
      return { exists: points > 0, pointsCount: points, complete: true, profile } as VectorStoreInfo
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

test("a changed model warns that the index will be destroyed and rebuilt", async () => {
  const status = await getStatus({
    qdrant: emptyQdrant,
    kv: memoryKv(),
    root: "D:\\Projects\\demo",
    settings: settings({ provider: "voyage", modelId: "voyage-code-4", dimension: 1024 }),
    ownStore: ownStore({ provider: "mistral", modelId: "codestral-embed-2505", dimension: 1536 }, 2233),
  })

  const warning = status.warnings.find((entry) => /re-embed/.test(entry))
  assert.ok(warning, `expected a re-embed warning, got ${JSON.stringify(status.warnings)}`)
  assert.match(warning, /2233 points/, "the count is the only estimate of what the rebuild costs")
  assert.match(warning, /mistral:codestral-embed-2505:1536/, "it must name what the index was built with")
  assert.match(warning, /voyage:voyage-code-4:1024/, "and what it would be rebuilt as")
  assert.match(status.recommendation, /embedding model changed/i)
})

test("the same model is not a warning", async () => {
  const status = await getStatus({
    qdrant: emptyQdrant,
    kv: memoryKv(),
    root: "D:\\Projects\\demo",
    settings: settings(),
    ownStore: ownStore({ provider: "mistral", modelId: "codestral-embed-2505", dimension: 1536 }, 2233),
  })

  assert.equal(
    status.warnings.some((entry) => /re-embed/.test(entry)),
    false,
    `an unchanged model must not warn: ${JSON.stringify(status.warnings)}`,
  )
})

test("an empty index is not a warning, however different the model", async () => {
  // Nothing to destroy, so nothing to warn about.
  const status = await getStatus({
    qdrant: emptyQdrant,
    kv: memoryKv(),
    root: "D:\\Projects\\demo",
    settings: settings({ provider: "voyage", modelId: "voyage-code-4", dimension: 1024 }),
    ownStore: ownStore({ provider: "mistral", modelId: "codestral-embed-2505", dimension: 1536 }, 0),
  })

  assert.equal(status.warnings.some((entry) => /re-embed/.test(entry)), false)
})

test("configuration warnings reach the status report", async () => {
  // They were resolved once and read by nobody, so a store that cannot work on
  // this platform looked simply absent rather than misconfigured.
  const status = await getStatus({
    qdrant: emptyQdrant,
    kv: memoryKv(),
    root: "D:\\Projects\\demo",
    settings: settings({ warnings: ["LanceDB has no native binary for darwin-x64"] }),
    ownStore: ownStore(undefined, 0),
  })

  assert.ok(
    status.warnings.some((entry) => /no native binary/.test(entry)),
    "a warning raised while resolving configuration has to be visible here",
  )
})
