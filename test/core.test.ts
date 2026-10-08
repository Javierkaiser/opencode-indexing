import * as assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, describe, test } from "node:test"

import { resolveSettings, stripJsonComments, withProfile } from "../src/config.ts"
import { diffFiles, emptyManifest, loadManifest, manifestKey, saveManifest, setRecord } from "../src/manifest.ts"
import { getModelDimension, getModelQueryPrefix, getModelScoreThreshold, normalizeExtensions, workspaceHash } from "../src/registry.ts"
import { createMemoryStorage } from "../src/storage.ts"
import { CHUNK_NAMESPACE, uuidv5 } from "../src/uuid.ts"

describe("uuidv5", () => {
  test("matches the known Kilo point id vector", () => {
    // Real point from ws-43dfc9b3ee33fcfd whose segmentHash produced this UUID.
    const id = uuidv5("7fd49fc5dd708dc47bf278fc3bfbfdbaf4314139faf4fc6f4dae7f7ea3983ee3", CHUNK_NAMESPACE)
    assert.equal(id, "0001d11f-9c0b-55ce-9682-7b22b71bd41b")
  })

  test("is deterministic and version 5", () => {
    const a = uuidv5("hello", CHUNK_NAMESPACE)
    const b = uuidv5("hello", CHUNK_NAMESPACE)
    assert.equal(a, b)
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test("rejects invalid namespace", () => {
    assert.throws(() => uuidv5("x", "not-a-uuid"))
  })
})

describe("registry", () => {
  test("workspace hash matches the known value for D:\\Proyectos", () => {
    assert.equal(workspaceHash("D:\\Proyectos").slice(0, 16), "43dfc9b3ee33fcfd")
  })

  test("workspace hash matches the known value for servicio-comprobantes", () => {
    const expected = createHash("sha256").update("D:\\Proyectos\\servicio-comprobantes").digest("hex").slice(0, 16)
    assert.equal(expected, "aca4a17f8c91eb53")
    assert.equal(workspaceHash("D:\\Proyectos\\servicio-comprobantes").slice(0, 16), expected)
  })

  test("model catalog mirrors Kilo", () => {
    assert.equal(getModelDimension("mistral", "codestral-embed-2505"), 1536)
    assert.equal(getModelDimension("openai", "text-embedding-3-small"), 1536)
    assert.equal(getModelDimension("openai", "text-embedding-3-large"), 3072)
    assert.equal(getModelDimension("ollama", "nomic-embed-text"), 768)
    assert.equal(getModelScoreThreshold("mistral", "codestral-embed-2505"), 0.35)
    assert.equal(getModelScoreThreshold("openai", "text-embedding-3-small"), 0.4)
    assert.equal(getModelQueryPrefix("ollama", "nomic-embed-text"), "search_query: ")
  })

  test("normalizeExtensions handles dots, case and empties", () => {
    assert.deepEqual(normalizeExtensions(["TS", ".cs", " php "]), [".ts", ".cs", ".php"])
    assert.ok(normalizeExtensions(undefined).includes(".cs"))
    assert.ok(normalizeExtensions([]).includes(".php"))
  })
})

describe("config", () => {
  test("stripJsonComments preserves strings and removes comments", () => {
    const input = `{
      // line comment
      "url": "http://localhost:6333", /* block */
      "key": "a//b",
      "list": [1, 2,],
    }`
    const parsed = JSON.parse(stripJsonComments(input)) as Record<string, unknown>
    assert.equal(parsed.url, "http://localhost:6333")
    assert.equal(parsed.key, "a//b")
    assert.deepEqual(parsed.list, [1, 2])
  })

  test("resolveSettings defaults to mistral/codestral and localhost qdrant", () => {
    const settings = resolveSettings({ ignoreKiloConfig: true })
    assert.equal(settings.provider, "mistral")
    assert.equal(settings.modelId, "codestral-embed-2505")
    assert.equal(settings.dimension, 1536)
    assert.equal(settings.qdrantUrl, "http://localhost:6333")
    assert.equal(settings.scoreThreshold, 0.35)
    assert.equal(settings.searchMaxResults, 50)
    assert.equal(settings.embeddingBatchSize, 60)
    assert.ok(settings.fileExtensions.includes(".cs"))
  })

  test("options override kilo config and env", () => {
    const settings = resolveSettings({
      ignoreKiloConfig: true,
      provider: "openai",
      model: "text-embedding-3-large",
      qdrantUrl: "http://example:6333/",
      searchMaxResults: 10,
    })
    assert.equal(settings.provider, "openai")
    assert.equal(settings.modelId, "text-embedding-3-large")
    assert.equal(settings.dimension, 3072)
    assert.equal(settings.qdrantUrl, "http://example:6333/")
    assert.equal(settings.scoreThreshold, 0.4)
    assert.equal(settings.searchMaxResults, 10)
  })

  test("reads indexing config from a kilo.jsonc home", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "oi-config-"))
    try {
      mkdirSync(path.join(home, ".config", "kilo"), { recursive: true })
      writeFileSync(
        path.join(home, ".config", "kilo", "kilo.jsonc"),
        `{
          "indexing": {
            "enabled": true,
            "provider": "mistral", // comment
            "mistral": { "apiKey": "test-key" },
            "vectorStore": "qdrant",
            "searchMinScore": 0.42,
          }
        }`,
      )
      const settings = resolveSettings({ homeDir: home })
      assert.equal(settings.provider, "mistral")
      assert.equal(settings.credentials.mistralApiKey, "test-key")
      assert.equal(settings.searchMinScore, 0.42)
      assert.equal(settings.scoreThreshold, 0.42)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("withProfile swaps model metadata", () => {
    const base = resolveSettings({ ignoreKiloConfig: true })
    const swapped = withProfile(base, { provider: "openai", modelId: "text-embedding-3-small", dimension: 1536 })
    assert.equal(swapped.modelId, "text-embedding-3-small")
    assert.equal(swapped.scoreThreshold, 0.4)
    assert.equal(swapped.dimension, 1536)
  })
})

describe("manifest", () => {
  const root = "D:\\Projects\\demo"
  const collection = "oc-deadbeefdeadbeef"

  test("roundtrip through KVStore", async () => {
    const kv = createMemoryStorage()
    const manifest = emptyManifest(root, collection, { provider: "mistral", modelId: "codestral-embed-2505", dimension: 1536 })
    setRecord(manifest, "a.ts", { hash: "h1", size: 10, mtimeMs: 1000, indexedAt: 1 })
    manifest.lastRun = 42
    await saveManifest(kv, manifest)
    const loaded = await loadManifest(kv, root)
    assert.ok(loaded)
    assert.equal(loaded!.files["a.ts"]!.hash, "h1")
    assert.equal(loaded!.lastRun, 42)
    assert.equal(manifestKey(root), `manifest/${workspaceHash(root).slice(0, 16)}`)
  })

  test("loadManifest ignores malformed entries", async () => {
    const kv = createMemoryStorage({ [manifestKey(root)]: { version: 99 } })
    assert.equal(await loadManifest(kv, root), undefined)
    const kv2 = createMemoryStorage({ [manifestKey(root)]: "nope" })
    assert.equal(await loadManifest(kv2, root), undefined)
  })

  test("diffFiles classifies added/stale/unchanged/deleted", () => {
    const manifest = emptyManifest(root, collection, { provider: "mistral", modelId: "codestral-embed-2505", dimension: 1536 })
    setRecord(manifest, "same.ts", { hash: "h", size: 5, mtimeMs: 100, indexedAt: 1 })
    setRecord(manifest, "stale.ts", { hash: "h", size: 5, mtimeMs: 100, indexedAt: 1 })
    setRecord(manifest, "gone.ts", { hash: "h", size: 5, mtimeMs: 100, indexedAt: 1 })

    const files = [
      { absPath: path.join(root, "same.ts"), relPath: "same.ts", size: 5, mtimeMs: 100 },
      { absPath: path.join(root, "stale.ts"), relPath: "stale.ts", size: 6, mtimeMs: 200 },
      { absPath: path.join(root, "new.ts"), relPath: "new.ts", size: 1, mtimeMs: 1 },
    ]
    const diff = diffFiles(manifest, files)
    assert.deepEqual(
      diff.added.map((f) => f.relPath),
      ["new.ts"],
    )
    assert.deepEqual(
      diff.maybeStale.map((f) => f.relPath),
      ["stale.ts"],
    )
    assert.deepEqual(
      diff.unchanged.map((f) => f.relPath),
      ["same.ts"],
    )
    assert.deepEqual(diff.deleted, ["gone.ts"])
  })
})

after(() => {
  // no global cleanup needed
})
