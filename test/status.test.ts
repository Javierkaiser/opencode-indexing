import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { getStatus } from "../src/status.ts"
import { kiloCollectionCandidates, KILO_METADATA_ID } from "../src/kilo-store.ts"
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

/** A Qdrant that holds one readable Kilo collection for the demo workspace. */
function qdrantWithKilo(root: string): Qdrant {
  const collection = kiloCollectionCandidates(root)[0]!
  return {
    async listCollections(): Promise<string[]> {
      return [collection]
    },
    async getCollection(): Promise<Record<string, unknown>> {
      return { points_count: 4242 }
    },
    async retrieve(): Promise<unknown[]> {
      return []
    },
    async collectionExists(): Promise<boolean> {
      return true
    },
  } as unknown as Qdrant
}

test("with searchKilo off the recommendation does not send the user to Kilo", async () => {
  // "Kilo index available. Search works now" is false when the search never
  // reads Kilo: the recommendation has to describe the own index instead.
  const root = "D:\\Projects\\demo"
  const status = await getStatus({
    qdrant: qdrantWithKilo(root),
    kv: memoryKv(),
    root,
    settings: settings({ searchKilo: false }),
    ownStore: ownStore(undefined, 0),
  })

  assert.ok(status.kilo.collection, "the Kilo index is still discovered, just not searched")
  assert.doesNotMatch(
    status.recommendation,
    /kilo index available|search works now|switch to the matching model|import it/i,
    `the advice must not send the user to a source the search never reads: ${status.recommendation}`,
  )
  assert.match(status.recommendation, /own index/i, "it has to name where results will come from")
  assert.match(status.recommendation, /indexing_build/, "the own index is what has to be built")
})

test("with searchKilo off a healthy own index is recommended as-is", async () => {
  const status = await getStatus({
    qdrant: qdrantWithKilo("D:\\Projects\\demo"),
    kv: memoryKv(),
    root: "D:\\Projects\\demo",
    settings: settings({ searchKilo: false }),
    ownStore: ownStore({ provider: "mistral", modelId: "codestral-embed-2505", dimension: 1536 }, 2233),
  })

  assert.match(status.recommendation, /own index/i)
  assert.doesNotMatch(status.recommendation, /kilo/i, "a healthy own index is the whole story with Kilo excluded")
})

test("with searchKilo on the Kilo-only advice is unchanged", async () => {
  // With the switch on, Kilo is part of the corpus, so the recommendation may
  // point at it; only the off case had to stop doing that.
  const root = "D:\\Projects\\demo"
  const status = await getStatus({
    qdrant: qdrantWithKilo(root),
    kv: memoryKv(),
    root,
    settings: settings({ searchKilo: true }),
    ownStore: ownStore(undefined, 0),
  })

  assert.match(status.recommendation, /kilo/i)
})

/** A Qdrant whose Kilo collection carries a specific metadata payload. */
function qdrantWithKiloMeta(root: string, payload: Record<string, unknown>): Qdrant {
  const collection = kiloCollectionCandidates(root)[0]!
  return {
    async listCollections(): Promise<string[]> {
      return [collection]
    },
    async getCollection(): Promise<Record<string, unknown>> {
      return { points_count: 4242 }
    },
    async retrieve(): Promise<unknown[]> {
      return [{ id: KILO_METADATA_ID, payload }]
    },
    async collectionExists(): Promise<boolean> {
      return true
    },
  } as unknown as Qdrant
}

test("a provider this plugin cannot call is not sold as a model mismatch", async () => {
  // "Switch to the matching model" is impossible advice for a source built with
  // Bedrock: there is no model choice that makes it importable.
  const root = "D:\\Projects\\demo"
  const status = await getStatus({
    qdrant: qdrantWithKiloMeta(root, {
      embedding_provider: "bedrock",
      embedding_model_id: "amazon.titan-embed-text-v2",
      embedding_dimension: 1024,
      index_schema: 2,
      indexing_complete: true,
    }),
    kv: memoryKv(),
    root,
    settings: settings(),
    ownStore: ownStore(undefined, 0),
  })

  assert.equal(status.kiloSources[0]?.reason, "provider")
  assert.match(status.recommendation, /bedrock/)
  assert.doesNotMatch(status.recommendation, /switch to the matching model/)
})

test("a newer index schema is named, with the action that works", async () => {
  const root = "D:\\Projects\\demo"
  const status = await getStatus({
    qdrant: qdrantWithKiloMeta(root, {
      embedding_provider: "mistral",
      embedding_model_id: "codestral-embed-2505",
      embedding_dimension: 1536,
      index_schema: 3,
      indexing_complete: true,
    }),
    kv: memoryKv(),
    root,
    settings: settings(),
    ownStore: ownStore(undefined, 0),
  })

  assert.equal(status.kiloSources[0]?.reason, "schema")
  assert.match(status.recommendation, /schema 3/)
  assert.match(status.recommendation, /upgrade the plugin/)
})

test("a linked worktree reports its baseline instead of claiming there is no Kilo index", async () => {
  // Kilo indexed the main checkout, so the linked worktree has no collection of
  // its own. "Kilo: none" was wrong: the baseline is right there, and the
  // summary read as if nothing could be imported.
  const main = mkdtempSync(path.join(os.tmpdir(), "oi-status-main-"))
  const linked = mkdtempSync(path.join(os.tmpdir(), "oi-status-linked-"))
  try {
    writeFileSync(path.join(linked, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`)
    const baseline = kiloCollectionCandidates(main)[0]!
    const qdrant = {
      async listCollections(): Promise<string[]> {
        return [baseline]
      },
      async getCollection(name: string): Promise<Record<string, unknown> | null> {
        return name === baseline ? { points_count: 99 } : null
      },
      async retrieve(): Promise<unknown[]> {
        return []
      },
      async collectionExists(name: string): Promise<boolean> {
        return name === baseline
      },
    } as unknown as Qdrant

    const status = await getStatus({
      qdrant,
      kv: memoryKv(),
      root: linked,
      settings: settings(),
      ownStore: ownStore(undefined, 0),
    })

    assert.equal(status.kilo.collection, baseline, "the effective source must not be reported as none")
    assert.equal(status.kilo.points, 99)
    assert.equal(status.kiloSources[0]?.role, "baseline")
    assert.doesNotMatch(status.recommendation, /No index found/)
    assert.match(status.recommendation, /import it without re-embedding/)
  } finally {
    rmSync(main, { recursive: true, force: true })
    rmSync(linked, { recursive: true, force: true })
  }
})
