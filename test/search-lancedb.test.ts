import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, before, describe, test } from "node:test"

import { createLanceDbStore } from "../src/lancedb-store.ts"
import { lanceDbSupport } from "../src/lancedb-support.ts"
import { invalidateSearchCaches, searchCode } from "../src/search.ts"
import type { Qdrant } from "../src/qdrant.ts"
import type { VectorStoreAdapter } from "../src/vector-store.ts"
import type { EmbeddingProfile, IndexingSettings, KVStore, QdrantPoint } from "../src/types.ts"

/**
 * Kilo's current default is LanceDB. Importing from it worked before, but a
 * live search still only asked Qdrant, so a workspace with a healthy Kilo
 * LanceDB answered as if Kilo had no index. This exercises the full path:
 * discovery -> profile -> native search -> merge.
 */

const native = lanceDbSupport().supported
const profile: EmbeddingProfile = { provider: "mistral", modelId: "codestral-embed-2505", dimension: 1536 }
const vector = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0))
const other = Array.from({ length: 1536 }, (_, index) => (index === 1 ? 1 : 0))
const realFetch = globalThis.fetch
const temporaries: string[] = []

before(() => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ embedding: vector, index: 0 }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaries.push(dir)
  return dir
}

function settings(directory: string): IndexingSettings {
  return {
    provider: "mistral",
    modelId: "codestral-embed-2500-test",
    dimension: 1536,
    vectorStore: "lancedb",
    kiloVectorStore: null,
    qdrantUrl: "http://localhost:6333",
    lancedbDirectory: directory,
    scoreThreshold: 0.35,
    searchMaxResults: 20,
    embeddingBatchSize: 60,
    maxFileSizeBytes: 1024 * 1024,
    fileExtensions: [],
    autoRefresh: false,
    importFromKilo: false,
    enabled: true,
    credentials: { mistralApiKey: "test" },
    warnings: [],
  }
}

function emptyKv(): KVStore {
  return {
    async get() {
      return undefined
    },
    async set() {},
    async remove() {},
  } as unknown as KVStore
}

function fakeOwnStore(): VectorStoreAdapter {
  return {
    kind: "lancedb",
    name: "own",
    async info() {
      return { exists: false, pointsCount: 0, complete: null, profile: undefined }
    },
    async search() {
      return []
    },
  } as unknown as VectorStoreAdapter
}

function emptyQdrant(): Qdrant {
  return { async collectionExists() { return false } } as unknown as Qdrant
}

describe("live Kilo LanceDB search", { skip: !native }, () => {
  test("finds a Kilo-only workspace through the configured LanceDB directory", async () => {
    const root = tempDir("oi-kilo-lance-root-")
    const directory = tempDir("oi-kilo-lance-dir-")
    const store = createLanceDbStore({ root, directory })
    await store.ensure(profile.dimension, profile)
    const point = (id: string, filePath: string, value: number[]): QdrantPoint => ({
      id,
      vector: value,
      payload: {
        filePath,
        fileHash: `${id}-hash`,
        codeChunk: `code for ${filePath}`,
        startLine: 1,
        endLine: 3,
      },
    })
    await store.upsert([point("a", "src/a.ts", vector), point("b", "src/b.ts", other)])
    await store.markComplete(profile, true, profile.dimension)

    invalidateSearchCaches()
    const outcome = await searchCode(
      {
        qdrant: emptyQdrant(),
        kv: emptyKv(),
        root,
        settings: settings(directory),
        ownStore: fakeOwnStore(),
        kiloConfig: { vectorStore: "lancedb", lancedb: { directory } },
      },
      "where is the invoice",
    )

    assert.equal(outcome.meta.kilo.sources?.[0]?.kind, "lancedb")
    assert.equal(outcome.meta.kilo.sources?.[0]?.points, 2)
    assert.equal(outcome.hits[0]?.filePath, "src/a.ts")
    assert.equal(outcome.hits[0]?.source, "kilo")
    assert.deepEqual(outcome.errors, [])
  })
})
