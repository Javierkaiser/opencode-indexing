import * as assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, beforeEach, describe, test } from "node:test"

import {
  configDir,
  defaultLanceDbDirectory,
  kiloLanceDbDirectory,
  maskSecret,
  readSettingsFile,
  settingsFilePath,
  writeSettingsFile,
} from "../src/settings.ts"
import { resolveSettings } from "../src/config.ts"

const homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "oi-settings-"))
  homes.push(home)
  mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
  mkdirSync(path.join(home, ".config", "kilo"), { recursive: true })
  return home
}

after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

// XDG_CONFIG_HOME / XDG_STATE_HOME take precedence over the `homeDir` option in
// the config layer, and GitHub's Linux/macOS runners set them. Clear both so the
// temp-home tests never read or write the real configuration directory.
beforeEach(() => {
  delete process.env.XDG_CONFIG_HOME
  delete process.env.XDG_STATE_HOME
})

describe("settings file", () => {
  test("paths honor XDG when set", () => {
    const old = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = "C:\\xdg"
    try {
      assert.equal(configDir(), path.join("C:\\xdg", "opencode"))
      assert.equal(settingsFilePath(), path.join("C:\\xdg", "opencode", "indexing.json"))
    } finally {
      if (old === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = old
    }
  })

  test("writeSettingsFile merges patches and persists atomically", () => {
    const home = makeHome()
    const first = writeSettingsFile({ vectorStore: "lancedb", qdrant: { url: "http://remote:6333" } }, home)
    assert.equal(first.vectorStore, "lancedb")

    const second = writeSettingsFile({ apiKeys: { mistral: "key-123" }, importFromKilo: false }, home)
    assert.equal(second.vectorStore, "lancedb", "previous keys preserved")
    assert.equal(second.qdrant?.url, "http://remote:6333")
    assert.equal(second.apiKeys?.mistral, "key-123")
    assert.equal(second.importFromKilo, false)

    // Deep merge for nested objects: qdrant apiKey added without losing url.
    const third = writeSettingsFile({ qdrant: { apiKey: "qk" } }, home)
    assert.equal(third.qdrant?.url, "http://remote:6333")
    assert.equal(third.qdrant?.apiKey, "qk")

    const raw = readFileSync(settingsFilePath(home), "utf8")
    assert.ok(raw.includes('"vectorStore": "lancedb"'))
    const parsed = readSettingsFile(home)
    assert.equal(parsed?.apiKeys?.mistral, "key-123")
  })

  test("readSettingsFile tolerates JSONC comments", () => {
    const home = makeHome()
    writeFileSync(
      settingsFilePath(home),
      `{
        // backend choice
        "vectorStore": "qdrant",
        "importFromKilo": true,
      }`,
    )
    const parsed = readSettingsFile(home)
    assert.equal(parsed?.vectorStore, "qdrant")
  })

  test("maskSecret hides all but the edges", () => {
    assert.equal(maskSecret(undefined), undefined)
    assert.equal(maskSecret("short"), "••••")
    // Fixture, not a credential: keep secrets out of the repository.
    assert.equal(maskSecret("abcdefghijklmnopqrstuvwxyz012345"), "abcd…2345")
  })

  test("lance directories default under state home", () => {
    const dir = defaultLanceDbDirectory("C:\\Users\\test")
    assert.ok(dir.includes("opencode-indexing"))
    assert.ok(dir.endsWith(path.join("lancedb")))
    const kilo = kiloLanceDbDirectory("C:\\Users\\test")
    assert.ok(kilo.includes(path.join("kilo", "indexing", "lancedb")))
  })
})

describe("resolveSettings with indexing.json", () => {
  test("indexing.json overrides kilo.jsonc but not plugin options", () => {
    const home = makeHome()
    writeFileSync(
      path.join(home, ".config", "kilo", "kilo.jsonc"),
      JSON.stringify({
        indexing: {
          provider: "mistral",
          mistral: { apiKey: "from-kilo" },
          qdrant: { url: "http://kilo:6333" },
        },
      }),
    )
    writeSettingsFile(
      {
        vectorStore: "lancedb",
        provider: "openai",
        model: "text-embedding-3-small",
        qdrant: { url: "http://mine:6333" },
        apiKeys: { mistral: "from-mine" },
        importFromKilo: false,
      },
      home,
    )

    const settings = resolveSettings({ homeDir: home })
    assert.equal(settings.vectorStore, "lancedb")
    assert.equal(settings.provider, "openai", "indexing.json wins over kilo.jsonc")
    assert.equal(settings.modelId, "text-embedding-3-small")
    assert.equal(settings.qdrantUrl, "http://mine:6333")
    assert.equal(settings.credentials.mistralApiKey, "from-mine")
    assert.equal(settings.importFromKilo, false)

    // Plugin options beat everything.
    const overridden = resolveSettings({ homeDir: home, qdrantUrl: "http://option:6333", importFromKilo: true })
    assert.equal(overridden.qdrantUrl, "http://option:6333")
    assert.equal(overridden.importFromKilo, true)
  })

  test("falls back to kilo.jsonc keys when indexing.json omits them", () => {
    const home = makeHome()
    writeFileSync(
      path.join(home, ".config", "kilo", "kilo.jsonc"),
      JSON.stringify({ indexing: { enabled: true, provider: "mistral", mistral: { apiKey: "kilo-key" } } }),
    )
    writeSettingsFile({ vectorStore: "qdrant" }, home)

    const settings = resolveSettings({ homeDir: home, ignoreKiloConfig: false })
    assert.equal(settings.provider, "mistral")
    assert.equal(settings.credentials.mistralApiKey, "kilo-key")
    assert.equal(settings.importFromKilo, true, "default is import on")
  })

  test("unknown provider falls back with a warning", () => {
    const home = makeHome()
    const settings = resolveSettings({ homeDir: home, provider: "nope" })
    assert.equal(settings.provider, "mistral")
    assert.ok(settings.warnings.some((warning) => warning.includes("nope")))
  })
})
