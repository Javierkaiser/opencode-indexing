import * as assert from "node:assert/strict"
import * as os from "node:os"
import * as path from "node:path"
import { describe, test } from "node:test"

import { createOwnStore, describeOwnStore } from "../src/store-factory.ts"
import type { IndexingSettings } from "../src/types.ts"

function settings(overrides: Partial<IndexingSettings> = {}): IndexingSettings {
  return {
    provider: "mistral",
    modelId: "codestral-embed-2505",
    dimension: 1536,
    vectorStore: "qdrant",
    qdrantUrl: "http://localhost:6333",
    lancedbDirectory: path.join(os.tmpdir(), "oi-factory-lancedb"),
    scoreThreshold: 0.35,
    searchMaxResults: 50,
    embeddingBatchSize: 60,
    maxFileSizeBytes: 1024 * 1024,
    fileExtensions: [],
    autoRefresh: false,
    importFromKilo: true,
    enabled: true,
    credentials: {},
    warnings: [],
    ...overrides,
  }
}

describe("store-factory", () => {
  test("qdrant backend returns the oc- collection adapter", () => {
    const root = "D:\\Proyectos\\demo"
    const store = createOwnStore(settings(), root)
    assert.equal(store.kind, "qdrant")
    assert.match(store.name, /^oc-[0-9a-f]{16}$/)
  })

  test("lancedb backend returns the db-path adapter", () => {
    const root = "D:\\Proyectos\\demo"
    const directory = path.join(os.tmpdir(), "oi-factory-lancedb")
    const store = createOwnStore(settings({ vectorStore: "lancedb", lancedbDirectory: directory }), root)
    assert.equal(store.kind, "lancedb")
    assert.ok(store.name.startsWith(directory))
    assert.ok(store.name.includes("demo-"))
  })

  test("describeOwnStore summarizes backend + location", () => {
    const described = describeOwnStore(settings(), "D:\\Proyectos\\demo")
    assert.equal(described.kind, "qdrant")
    assert.match(described.name, /^oc-/)
  })
})
