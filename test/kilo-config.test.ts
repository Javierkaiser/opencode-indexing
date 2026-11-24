import * as assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, beforeEach, describe, test } from "node:test"

import { readKiloConfig, readKiloIndexingConfig } from "../src/kilo-config.ts"

/**
 * Kilo's store and embedding profile can be configured per project. The plugin
 * has to read the same files Kilo reads, with the same precedence, or a live
 * search looks in the wrong database.
 */

const dirs: string[] = []
const ENV_NAMES = [
  "KILO_CONFIG",
  "KILO_CONFIG_DIR",
  "KILO_CONFIG_CONTENT",
  "KILO_DISABLE_PROJECT_CONFIG",
  "XDG_CONFIG_HOME",
] as const
const originalEnv = new Map<string, string | undefined>(ENV_NAMES.map((name) => [name, process.env[name]]))

function tempDir(prefix = "oi-kilo-config-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2))
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  for (const name of ENV_NAMES) setEnv(name, undefined)
})

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  for (const [name, value] of originalEnv) setEnv(name, value)
})

describe("readKiloConfig", () => {
  test("reads the global kilo.jsonc", () => {
    const home = tempDir()
    const global = path.join(home, ".config", "kilo")
    writeJson(path.join(global, "kilo.jsonc"), {
      indexing: { enabled: true, vectorStore: "lancedb", provider: "mistral", model: "codestral-embed-2505" },
    })

    const result = readKiloConfig(undefined, home)
    assert.equal(result.indexing?.vectorStore, "lancedb")
    assert.equal(result.indexing?.provider, "mistral")
    assert.deepEqual(result.files, [path.join(global, "kilo.jsonc")])
  })

  test("project config overrides global and merges nested objects", () => {
    const home = tempDir()
    const root = tempDir("oi-kilo-project-")
    writeJson(path.join(home, ".config", "kilo", "kilo.jsonc"), {
      indexing: {
        vectorStore: "qdrant",
        qdrant: { url: "http://global:6333", apiKey: "global-key" },
        lancedb: { directory: "/global/lancedb" },
      },
    })
    writeJson(path.join(root, ".kilo", "kilo.jsonc"), {
      indexing: { vectorStore: "lancedb", qdrant: { url: "http://project:6333" } },
    })

    const result = readKiloConfig(root, home)
    assert.equal(result.indexing?.vectorStore, "lancedb")
    assert.equal(result.indexing?.qdrant?.url, "http://project:6333")
    assert.equal(result.indexing?.qdrant?.apiKey, "global-key", "nested fields survive a project override")
    assert.equal(result.indexing?.lancedb?.directory, "/global/lancedb")
  })

  test("a root kilo.jsonc and .kilo/kilo.jsonc are both loaded, .kilo last", () => {
    const home = tempDir()
    const root = tempDir("oi-kilo-order-")
    writeJson(path.join(home, ".config", "kilo", "kilo.json"), { indexing: { vectorStore: "qdrant" } })
    writeJson(path.join(root, "kilo.json"), { indexing: { vectorStore: "lancedb" } })
    writeJson(path.join(root, ".kilo", "kilo.jsonc"), { indexing: { vectorStore: "qdrant" } })

    assert.equal(readKiloConfig(root, home).indexing?.vectorStore, "qdrant")
  })

  test("project config is inherited from the workspace up to the checkout root", () => {
    const home = tempDir()
    const repo = tempDir("oi-kilo-repo-")
    const nested = path.join(repo, "packages", "app")
    mkdirSync(path.join(repo, ".git"))
    mkdirSync(nested, { recursive: true })
    writeJson(path.join(repo, "kilo.jsonc"), { indexing: { vectorStore: "lancedb", searchMaxResults: 70 } })
    writeJson(path.join(nested, ".kilo", "kilo.jsonc"), { indexing: { searchMaxResults: 90 } })

    const result = readKiloConfig(nested, home)
    assert.equal(result.indexing?.vectorStore, "lancedb")
    assert.equal(result.indexing?.searchMaxResults, 90, "the nearest project config wins")
  })

  test("a plain directory does not inherit a parent config", () => {
    const home = tempDir()
    const parent = tempDir("oi-kilo-plain-parent-")
    const child = path.join(parent, "child")
    mkdirSync(child, { recursive: true })
    writeJson(path.join(parent, "kilo.jsonc"), { indexing: { vectorStore: "qdrant" } })

    assert.equal(readKiloConfig(child, home).indexing, undefined)
  })

  test("KILO_CONFIG and KILO_CONFIG_CONTENT have the last word", () => {
    const home = tempDir()
    const root = tempDir("oi-kilo-env-")
    const custom = path.join(home, "custom.jsonc")
    writeJson(path.join(home, ".config", "kilo", "kilo.jsonc"), { indexing: { vectorStore: "qdrant" } })
    mkdirSync(path.dirname(custom), { recursive: true })
    writeFileSync(custom, '{\n  // custom\n  "indexing": { "searchMaxResults": 80, "vectorStore": "lancedb" }\n}\n')
    setEnv("KILO_CONFIG", custom)
    setEnv("KILO_CONFIG_CONTENT", JSON.stringify({ indexing: { searchMaxResults: 120 } }))

    const result = readKiloConfig(root, home)
    assert.equal(result.indexing?.vectorStore, "lancedb")
    assert.equal(result.indexing?.searchMaxResults, 120)
    assert.ok(result.files.includes("KILO_CONFIG_CONTENT"))
  })

  test("KILO_DISABLE_PROJECT_CONFIG ignores project files", () => {
    const home = tempDir()
    const root = tempDir("oi-kilo-disabled-")
    writeJson(path.join(home, ".config", "kilo", "kilo.jsonc"), { indexing: { vectorStore: "qdrant" } })
    writeJson(path.join(root, ".kilo", "kilo.jsonc"), { indexing: { vectorStore: "lancedb" } })
    setEnv("KILO_DISABLE_PROJECT_CONFIG", "1")

    assert.equal(readKiloConfig(root, home).indexing?.vectorStore, "qdrant")
  })

  test("JSONC comments and malformed files never throw", () => {
    const home = tempDir()
    const root = tempDir("oi-kilo-jsonc-")
    const global = path.join(home, ".config", "kilo", "kilo.jsonc")
    mkdirSync(path.dirname(global), { recursive: true })
    writeFileSync(global, '{ "indexing": { "lancedb": { "directory": "/custom" } } } // trailing\n')
    writeFileSync(path.join(root, "kilo.jsonc"), "{ broken")

    const result = readKiloConfig(root, home)
    assert.equal(result.indexing?.lancedb?.directory, "/custom")
  })

  test("global-only reads do not see project config", () => {
    const home = tempDir()
    const root = tempDir("oi-kilo-global-")
    writeJson(path.join(home, ".config", "kilo", "kilo.jsonc"), { indexing: { vectorStore: "qdrant" } })
    writeJson(path.join(root, ".kilo", "kilo.jsonc"), { indexing: { vectorStore: "lancedb" } })

    assert.equal(readKiloIndexingConfig(home)?.vectorStore, "qdrant")
  })
})
