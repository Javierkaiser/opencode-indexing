import * as assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import { pluginVersion } from "../src/plugin-version.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }

/**
 * A throwaway copy of the module beside a manifest this test controls.
 *
 * `pluginVersion` resolves `../package.json` relative to its own file, so a
 * copy in a temp directory reads the temp manifest. That is the only way to
 * observe caching (rewrite the file, expect the old answer) and the fallback
 * (no manifest at all) without touching the real package.json. The module is
 * cached per URL, and every temp directory is a new URL.
 */
async function loadIsolated(contents: string | null): Promise<{ version: () => string; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), "oi-version-"))
  mkdirSync(join(directory, "src"))
  copyFileSync(join(root, "src", "plugin-version.ts"), join(directory, "src", "plugin-version.ts"))
  if (contents !== null) writeFileSync(join(directory, "package.json"), contents, "utf8")
  const loaded = (await import(pathToFileURL(join(directory, "src", "plugin-version.ts")).href)) as {
    pluginVersion: () => string
  }
  return { version: loaded.pluginVersion, directory }
}

describe("pluginVersion", () => {
  test("reports the version declared in the real package.json", () => {
    // Read from the file, not from memory: the test fails when the function
    // and the manifest that ships the plugin disagree.
    assert.equal(pluginVersion(), manifest.version)
  })

  test("returns the same value on every call", () => {
    assert.equal(pluginVersion(), pluginVersion())
  })

  test("caches the first read instead of re-reading the manifest", async () => {
    const { version, directory } = await loadIsolated(
      JSON.stringify({ name: "oi-test", version: "1.0.0", type: "module" }),
    )
    try {
      assert.equal(version(), "1.0.0")
      // `settings.get` calls this on every request; the answer must come from
      // the cache, not from a file that may have changed since startup.
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "oi-test", version: "2.0.0", type: "module" }))
      assert.equal(version(), "1.0.0")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('falls back to "unknown" when the manifest is missing', async () => {
    // No package.json beside the copied module: readFileSync throws ENOENT.
    const { version, directory } = await loadIsolated(null)
    try {
      assert.equal(version(), "unknown")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('falls back to "unknown" when the manifest has no usable version', async () => {
    const { version, directory } = await loadIsolated(JSON.stringify({ name: "oi-test", type: "module" }))
    try {
      assert.equal(version(), "unknown")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
