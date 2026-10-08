import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  applySettingValue,
  describeSettingValue,
  listSettingKeys,
  parseIndexingCommand,
  suggestKey,
} from "../src/settings-commands.ts"
import type { IndexingSettings } from "../src/types.ts"

function settings(overrides: Partial<IndexingSettings> = {}): IndexingSettings {
  return {
    provider: "mistral",
    modelId: "codestral-embed-2505",
    dimension: 1536,
    vectorStore: "qdrant",
    qdrantUrl: "http://localhost:6333",
    lancedbDirectory: "C:\\Users\\test\\.local\\state\\opencode-indexing\\lancedb",
    scoreThreshold: 0.35,
    searchMaxResults: 50,
    embeddingBatchSize: 60,
    maxFileSizeBytes: 1024 * 1024,
    fileExtensions: [".ts", ".cs"],
    autoRefresh: false,
    importFromKilo: true,
    enabled: true,
    // Fixture, not a credential: keep secrets out of the repository.
    credentials: { mistralApiKey: "test-mistral-key-0000000000000000" },
    warnings: [],
    ...overrides,
  }
}

describe("parseIndexingCommand", () => {
  test("empty or show shows configuration", () => {
    assert.deepEqual(parseIndexingCommand(""), { action: "show" })
    assert.deepEqual(parseIndexingCommand("   "), { action: "show" })
    assert.deepEqual(parseIndexingCommand("show"), { action: "show" })
  })

  test("accepts full command line and bare arguments", () => {
    assert.deepEqual(parseIndexingCommand("/indexing-config set provider=openai"), {
      action: "set",
      key: "provider",
      rawValue: "openai",
      hasValue: true,
    })
    assert.deepEqual(parseIndexingCommand("set provider=openai"), {
      action: "set",
      key: "provider",
      rawValue: "openai",
      hasValue: true,
    })
  })

  test("set without a value queries the current value", () => {
    assert.deepEqual(parseIndexingCommand("set provider"), {
      action: "set",
      key: "provider",
      rawValue: "",
      hasValue: false,
    })
  })

  test("values may contain equals signs", () => {
    const parsed = parseIndexingCommand("set qdrantApiKey=abc=def==")
    assert.equal(parsed.action, "set")
    if (parsed.action === "set") assert.equal(parsed.rawValue, "abc=def==")
  })

  test("test defaults to all, import accepts a source", () => {
    assert.deepEqual(parseIndexingCommand("test"), { action: "test", target: "all" })
    assert.deepEqual(parseIndexingCommand("test qdrant"), { action: "test", target: "qdrant" })
    assert.deepEqual(parseIndexingCommand("import"), { action: "import" })
    assert.deepEqual(parseIndexingCommand("import ws-abc"), { action: "import", source: "ws-abc" })
  })

  test("help and unknown", () => {
    assert.deepEqual(parseIndexingCommand("help"), { action: "help" })
    const unknown = parseIndexingCommand("frobnicate")
    assert.equal(unknown.action, "error")
  })
})

describe("applySettingValue", () => {
  test("boolean values with common spellings", () => {
    for (const value of ["true", "ON", "yes", "1"]) {
      const result = applySettingValue("importfromkilo", value)
      assert.equal(result.ok, true)
      if (result.ok) assert.deepEqual(result.patch, { importFromKilo: true })
    }
    const off = applySettingValue("importfromkilo", "off")
    assert.equal(off.ok, true)
    if (off.ok) assert.deepEqual(off.patch, { importFromKilo: false })
    assert.equal(applySettingValue("importfromkilo", "maybe").ok, false)
  })

  test("enum validation and patch", () => {
    const ok = applySettingValue("vectorstore", "lancedb")
    assert.equal(ok.ok, true)
    if (ok.ok) assert.deepEqual(ok.patch, { vectorStore: "lancedb" })
    assert.equal(applySettingValue("vectorstore", "postgres") .ok, false)
    const provider = applySettingValue("provider", "openai")
    assert.equal(provider.ok, true)
    if (provider.ok) assert.deepEqual(provider.patch, { provider: "openai" })
  })

  test("integers and scores with bounds", () => {
    const batch = applySettingValue("embeddingbatchsize", "100")
    assert.equal(batch.ok, true)
    if (batch.ok) assert.deepEqual(batch.patch, { embeddingBatchSize: 100 })
    assert.equal(applySettingValue("embeddingbatchsize", "0").ok, false)
    assert.equal(applySettingValue("embeddingbatchsize", "1.5").ok, false)

    const score = applySettingValue("searchminscore", "0.5")
    assert.equal(score.ok, true)
    if (score.ok) assert.deepEqual(score.patch, { searchMinScore: 0.5 })
    assert.equal(applySettingValue("searchminscore", "1.2").ok, false)
    const reset = applySettingValue("searchminscore", "default")
    assert.equal(reset.ok, true)
    if (reset.ok) assert.deepEqual(reset.patch, { searchMinScore: null })
  })

  test("URLs require a protocol", () => {
    const ok = applySettingValue("qdranturl", "http://192.168.1.50:6333")
    assert.equal(ok.ok, true)
    if (ok.ok) assert.deepEqual(ok.patch, { qdrant: { url: "http://192.168.1.50:6333" } })
    assert.equal(applySettingValue("qdranturl", "192.168.1.50:6333").ok, false)
  })

  test("secret keys are masked in the display and can be cleared", () => {
    const set = applySettingValue("mistralkey", "sk-super-secret-value-1234")
    assert.equal(set.ok, true)
    if (set.ok) {
      assert.deepEqual(set.patch, { apiKeys: { mistral: "sk-super-secret-value-1234" } })
      assert.ok(!set.display.includes("super-secret"), "display must not leak the key")
    }
    const cleared = applySettingValue("mistralkey", "")
    assert.equal(cleared.ok, true)
    if (cleared.ok) assert.deepEqual(cleared.patch, { apiKeys: { mistral: "" } })
  })

  test("extensions list normalizes and resets", () => {
    const list = applySettingValue("fileextensions", ".TS, cs; php")
    assert.equal(list.ok, true)
    if (list.ok) assert.deepEqual(list.patch, { fileExtensions: [".ts", ".cs", ".php"] })
    const reset = applySettingValue("fileextensions", "default")
    assert.equal(reset.ok, true)
    if (reset.ok) assert.deepEqual(reset.patch, { fileExtensions: null })
  })

  test("unknown keys are rejected with the valid list", () => {
    const result = applySettingValue("nope", "x")
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.error.includes("Valid keys"))
  })
})

describe("descriptions and suggestions", () => {
  test("describeSettingValue masks secrets and shows effective values", () => {
    assert.equal(describeSettingValue("vectorstore", settings()), "qdrant")
    const key = describeSettingValue("mistralkey", settings())
    assert.ok(key && !key.includes("gCYaPCOzNU6S"))
    assert.equal(describeSettingValue("nope", settings()), undefined)
  })

  test("suggestKey finds near matches", () => {
    assert.equal(suggestKey("vector"), "vectorstore")
    assert.equal(suggestKey("imprt"), undefined)
  })

  test("listSettingKeys exposes every configurable key", () => {
    const keys = listSettingKeys().map((entry) => entry.key)
    for (const expected of ["vectorstore", "qdranturl", "provider", "model", "importfromkilo", "autorefresh"]) {
      assert.ok(keys.includes(expected), `missing ${expected}`)
    }
  })
})
