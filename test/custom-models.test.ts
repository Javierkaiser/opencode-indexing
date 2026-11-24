import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, before, describe, test } from "node:test"

import { resolveSettings, withProfile } from "../src/config.ts"
import { createEmbedder } from "../src/embedder.ts"
import { applySettingValue } from "../src/settings-commands.ts"
import { writeSettingsFile } from "../src/settings.ts"
import { modelDimensionFor, modelMaxInputTokensFor, modelProfileFor, modelQueryPrefixFor } from "../src/registry.ts"
import type { IndexingSettings } from "../src/types.ts"

/**
 * A user-defined model entry is the escape hatch for a self-hosted or
 * newly-released embedding model: dimension, prefix and limits without a plugin
 * release. The static catalog remains the import-compatibility contract.
 */

const configHome = mkdtempSync(path.join(os.tmpdir(), "oi-custom-config-"))
const previousXdg = process.env.XDG_CONFIG_HOME
const realFetch = globalThis.fetch
let requests: Array<{ body: string }> = []

before(() => {
  process.env.XDG_CONFIG_HOME = configHome
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ body: String(init?.body ?? "") })
    return new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)), index: 0 }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as unknown as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousXdg
  rmSync(configHome, { recursive: true, force: true })
})

function baseSettings(overrides: Partial<IndexingSettings> = {}): IndexingSettings {
  return {
    provider: "openai-compatible",
    modelId: "my-model",
    dimension: 768,
    vectorStore: "lancedb",
    kiloVectorStore: null,
    qdrantUrl: "http://localhost:6333",
    lancedbDirectory: "C:\\state\\lancedb",
    scoreThreshold: 0.4,
    searchMaxResults: 20,
    embeddingBatchSize: 60,
    maxFileSizeBytes: 1024 * 1024,
    fileExtensions: [],
    autoRefresh: false,
    importFromKilo: false,
    enabled: true,
    credentials: { openAiCompatibleBaseUrl: "http://localhost:1234/v1" },
    warnings: [],
    ...overrides,
  }
}

describe("custom model metadata", () => {
  test("resolves dimension, prefix, limits and threshold from the models map", () => {
    writeSettingsFile(
      {
        models: {
          "openai-compatible": {
            "my-model": {
              dimension: 768,
              queryPrefix: "search_query: ",
              maxInputTokens: 4096,
              maxBatchItems: 32,
              maxBatchTokens: 12000,
              scoreThreshold: 0.25,
            },
          },
        },
      },
      os.homedir(),
    )

    const settings = resolveSettings({ provider: "openai-compatible", model: "my-model" })
    assert.equal(settings.dimension, 768)
    assert.equal(settings.queryPrefix, "search_query: ")
    assert.equal(settings.scoreThreshold, 0.25)
    assert.equal(modelDimensionFor(settings, "openai-compatible", "my-model"), 768)
    assert.equal(modelQueryPrefixFor(settings, "openai-compatible", "my-model"), "search_query: ")
    assert.equal(modelMaxInputTokensFor(settings, "openai-compatible", "my-model"), 4096)
  })

  test("a partial override keeps the catalog metadata it does not replace", () => {
    const settings = baseSettings({
      provider: "openai",
      modelId: "text-embedding-3-small",
      dimension: 1536,
      customProfiles: {
        openai: { "text-embedding-3-small": { queryPrefix: "query: " } },
      },
    })
    const profile = modelProfileFor(settings, "openai", "text-embedding-3-small")
    assert.equal(profile?.dimension, 1536)
    assert.equal(profile?.maxInputTokens, 8192)
    assert.equal(profile?.queryPrefix, "query: ")
  })

  test("the prefix is applied to indexing and query embeddings", async () => {
    const settings = baseSettings({
      customProfiles: {
        "openai-compatible": { "my-model": { dimension: 768, queryPrefix: "search_query: " } },
      },
    })
    await createEmbedder(settings).embed(["where is the invoice"], { asQuery: true })
    requests = []
    await createEmbedder(settings).embed(["document body"], { asQuery: false })
    assert.equal(requests.length, 1)
    assert.match(requests[0]!.body, /search_query: document body/)
  })

  test("withProfile picks the target model's custom prefix", () => {
    const settings = baseSettings({
      customProfiles: {
        "openai-compatible": { "other-model": { queryPrefix: "passage: " } },
      },
    })
    const other = withProfile(settings, { provider: "openai-compatible", modelId: "other-model", dimension: 512 })
    assert.equal(other.queryPrefix, "passage: ")
  })

  test("a custom entry that diverges from Kilo's mirror warns about import compatibility", () => {
    writeSettingsFile(
      {
        models: {
          openai: { "text-embedding-3-small": { dimension: 1024 } },
        },
      },
      os.homedir(),
    )
    const settings = resolveSettings({ provider: "openai", model: "text-embedding-3-small" })
    assert.equal(settings.dimension, 1024, "the specific entry wins over the catalog")
    assert.match(settings.warnings.join(" "), /may no longer be importable/)
  })

  test("the settings command writes model metadata under provider/model", () => {
    const settings = baseSettings()
    const dimension = applySettingValue("dimension", "1024", settings)
    assert.equal(dimension.ok, true)
    assert.deepEqual(dimension.ok ? dimension.patch : undefined, {
      models: { "openai-compatible": { "my-model": { dimension: 1024 } } },
    })
    const prefix = applySettingValue("queryprefix", "search_query: ", settings)
    assert.equal(prefix.ok, true)
    assert.deepEqual(prefix.ok ? prefix.patch : undefined, {
      models: { "openai-compatible": { "my-model": { queryPrefix: "search_query: " } } },
    })
    const missing = applySettingValue("dimension", "1024")
    assert.equal(missing.ok, false)
  })
})
