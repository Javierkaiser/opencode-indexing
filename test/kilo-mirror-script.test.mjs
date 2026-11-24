import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import { compareRegistry, extractObject, extractStringConstant, SUPPORTED_PROVIDERS } from "../scripts/check-kilo-mirror.mjs"

/**
 * The script's pure half. Nothing here touches the network: the live fetch only
 * runs when the file is executed directly, which the scheduled workflow does.
 */

const SAMPLE_REGISTRY = `
import type { EmbedderProvider } from "./interfaces/manager"

interface ModelProfile {
  dimension: number
  scoreThreshold?: number
  queryPrefix?: string
}

// A comment between the type annotation and the initializer.
const profiles: Record<string, Record<string, ModelProfile>> = {
  openai: {
    "text-embedding-3-small": { dimension: 1536, scoreThreshold: 0.4 },
    "text-embedding-3-large": { dimension: 3072, scoreThreshold: 0.4 },
  },
  ollama: {
    "nomic-embed-text": { dimension: 768, scoreThreshold: 0.3, queryPrefix: "search_query: " },
  },
  "openai-compatible": {},
}

const defaults: Record<string, string> = {
  openai: "text-embedding-3-small",
  ollama: "nomic-embed-text",
  "openai-compatible": "",
}
`

function cleanInputs() {
  const upstream = {
    profiles: {
      openai: { "text-embedding-3-small": { dimension: 1536, scoreThreshold: 0.4 } },
      ollama: { "nomic-embed-text": { dimension: 768, scoreThreshold: 0.3, queryPrefix: "search_query: " } },
      "openai-compatible": {},
    },
    defaults: { openai: "text-embedding-3-small", ollama: "nomic-embed-text", "openai-compatible": "" },
    vectorStore: "lancedb",
  }
  return { upstream, ours: structuredClone(upstream) }
}

test("SUPPORTED_PROVIDERS is exactly the set this plugin can index with", () => {
  assert.deepEqual([...SUPPORTED_PROVIDERS], [
    "local",
    "mistral",
    "openai",
    "ollama",
    "openai-compatible",
    "gemini",
    "voyage",
    "openrouter",
  ])
})

test("extractObject reads a typed, nested object literal", () => {
  const profiles = extractObject(SAMPLE_REGISTRY, "profiles")
  assert.deepEqual(profiles, {
    openai: {
      "text-embedding-3-small": { dimension: 1536, scoreThreshold: 0.4 },
      "text-embedding-3-large": { dimension: 3072, scoreThreshold: 0.4 },
    },
    ollama: { "nomic-embed-text": { dimension: 768, scoreThreshold: 0.3, queryPrefix: "search_query: " } },
    "openai-compatible": {},
  })
  assert.deepEqual(extractObject(SAMPLE_REGISTRY, "defaults"), {
    openai: "text-embedding-3-small",
    ollama: "nomic-embed-text",
    "openai-compatible": "",
  })
})

test("extractObject supports arrays, booleans, null, negatives and numeric separators", () => {
  const text = `const profiles: Foo = {
    local: {
      "model-1": { dimension: 128, tags: ["a", "b", 3], nested: { deep: true, missing: null }, offset: -1, tokens: 300_000 },
    },
  }`
  assert.deepEqual(extractObject(text, "profiles"), {
    local: {
      "model-1": {
        dimension: 128,
        tags: ["a", "b", 3],
        nested: { deep: true, missing: null },
        offset: -1,
        tokens: 300000,
      },
    },
  })
})

test("extractObject reads the real registry, type annotation and comments included", async () => {
  const source = await readFile(new URL("../src/registry.ts", import.meta.url), "utf8")
  const profiles = extractObject(source, "profiles")
  assert.equal(profiles.openai["text-embedding-3-small"].dimension, 1536)
  assert.equal(profiles.ollama["nomic-embed-text"].queryPrefix, "search_query: ")
  assert.equal(extractObject(source, "defaults").mistral, "codestral-embed-2505")
})

test("extractStringConstant reads a string literal with as const", () => {
  const text = 'export const DEFAULT_VECTOR_STORE = "lancedb" as const'
  assert.equal(extractStringConstant(text, "DEFAULT_VECTOR_STORE"), "lancedb")
})

test("a clean registry comparison reports no drift", () => {
  const { upstream, ours } = cleanInputs()
  const diff = compareRegistry(upstream, ours)
  assert.equal(diff.ok, true)
  assert.deepEqual(diff.counts, { providers: 3, models: 2 })
  assert.deepEqual(diff.providers.missing, [])
  assert.deepEqual(diff.missingModels, [])
  assert.deepEqual(diff.extraModels, [])
  assert.deepEqual(diff.defaultModelMismatches, [])
  assert.deepEqual(diff.vectorStore, { upstream: "lancedb", ours: "lancedb", ok: true })
})

test("a dimension change is drift", () => {
  const { upstream, ours } = cleanInputs()
  ours.profiles.openai["text-embedding-3-small"].dimension = 1024
  const diff = compareRegistry(upstream, ours)
  assert.equal(diff.ok, false)
  assert.deepEqual(diff.dimensionMismatches, [
    { provider: "openai", modelId: "text-embedding-3-small", upstream: 1536, ours: 1024 },
  ])
})

test("a model Kilo added is missing here", () => {
  const { upstream, ours } = cleanInputs()
  upstream.profiles.openai["text-embedding-4"] = { dimension: 1024, scoreThreshold: 0.4 }
  const diff = compareRegistry(upstream, ours)
  assert.equal(diff.ok, false)
  assert.deepEqual(diff.missingModels, [{ provider: "openai", modelId: "text-embedding-4", dimension: 1024 }])
})

test("a model Kilo dropped is an extra mirror here", () => {
  const { upstream, ours } = cleanInputs()
  delete upstream.profiles.ollama["nomic-embed-text"]
  delete upstream.defaults.ollama
  const diff = compareRegistry(upstream, ours)
  assert.equal(diff.ok, false)
  assert.deepEqual(diff.extraModels, [{ provider: "ollama", modelId: "nomic-embed-text", dimension: 768 }])
})

test("a whole provider missing here is reported once, not per model", () => {
  const { upstream, ours } = cleanInputs()
  delete ours.profiles.ollama
  const diff = compareRegistry(upstream, ours)
  assert.deepEqual(diff.providers.missing, [{ provider: "ollama", models: ["nomic-embed-text"] }])
  assert.deepEqual(diff.missingModels, [])
})

test("our own models marked kiloMirror: false are not drift", () => {
  const { upstream, ours } = cleanInputs()
  ours.profiles.local = { "potion-base-8M-128d": { dimension: 128, kiloMirror: false } }
  const diff = compareRegistry(upstream, ours)
  assert.equal(diff.ok, true)
  assert.deepEqual(diff.extraModels, [])
})

test("a queryPrefix or scoreThreshold change is drift", () => {
  const { upstream, ours } = cleanInputs()
  ours.profiles.ollama["nomic-embed-text"].queryPrefix = "query: "
  ours.profiles.ollama["nomic-embed-text"].scoreThreshold = 0.35
  const diff = compareRegistry(upstream, ours)
  assert.equal(diff.ok, false)
  assert.deepEqual(diff.queryPrefixMismatches, [
    { provider: "ollama", modelId: "nomic-embed-text", upstream: "search_query: ", ours: "query: " },
  ])
  assert.deepEqual(diff.scoreThresholdMismatches, [
    { provider: "ollama", modelId: "nomic-embed-text", upstream: 0.3, ours: 0.35 },
  ])
})

test("a default model change is drift", () => {
  const { upstream, ours } = cleanInputs()
  ours.defaults.openai = "text-embedding-3-large"
  const diff = compareRegistry(upstream, ours)
  assert.equal(diff.ok, false)
  assert.deepEqual(diff.defaultModelMismatches, [
    { provider: "openai", upstream: "text-embedding-3-small", ours: "text-embedding-3-large" },
  ])
})

test("a vector store default change is drift", () => {
  const { upstream, ours } = cleanInputs()
  upstream.vectorStore = "qdrant"
  const diff = compareRegistry(upstream, ours, { ourVectorStore: "lancedb" })
  assert.equal(diff.ok, false)
  assert.deepEqual(diff.vectorStore, { upstream: "qdrant", ours: "lancedb", ok: false })
})

test("providers we have no adapter for are reported but not failures", () => {
  const { upstream, ours } = cleanInputs()
  upstream.profiles.bedrock = { "amazon.titan-embed-text-v2:0": { dimension: 1024, scoreThreshold: 0.35 } }
  upstream.profiles["vercel-ai-gateway"] = { "text-embedding-3-small": { dimension: 1536, scoreThreshold: 0.4 } }
  upstream.defaults.kilo = ""
  upstream.defaults.bedrock = "amazon.titan-embed-text-v2:0"
  upstream.defaults["vercel-ai-gateway"] = "text-embedding-3-small"
  const diff = compareRegistry(upstream, ours)
  assert.equal(diff.ok, true)
  assert.deepEqual(diff.providers.unsupported, [
    { provider: "bedrock", models: 1 },
    { provider: "kilo", models: 0 },
    { provider: "vercel-ai-gateway", models: 1 },
  ])
})

test("a missing or unsupported declaration throws a clear error", () => {
  assert.throws(() => extractObject("const other = { a: 1 }", "profiles"), /const profiles/)
  assert.throws(() => extractObject("const profiles = makeProfiles()", "profiles"), /not an object literal/)
  assert.throws(() => extractObject("const profiles: Foo = { a: makeModel() }", "profiles"), /unsupported reference/)
  assert.throws(() => extractStringConstant('const DEFAULT_VECTOR_STORE = "lancedb"', "OTHER"), /const OTHER/)
  assert.throws(() => compareRegistry({ defaults: {} }, { profiles: {} }), /upstream registry has no profiles/)
  assert.throws(() => compareRegistry({ profiles: {} }, { profiles: [] }), /ours registry has no profiles/)
})
