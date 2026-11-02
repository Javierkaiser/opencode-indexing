import * as assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * Pins the Desktop entry points that break silently when they drift: the export
 * the app resolves, the Vite preset that builds it, and the contributions
 * `src/gui.tsx` makes. Reads the real files and imports no SDK, so it runs in
 * the plain `node --test` suite.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (relative: string): string => readFileSync(join(root, relative), "utf8")

describe("Desktop GUI entry", () => {
  test("./gui-experimental points at the CommonJS bundle the preset writes", () => {
    const pkg = JSON.parse(read("package.json")) as { exports?: Record<string, string>; files?: string[] }
    const entry = pkg.exports?.["./gui-experimental"]

    // The app loads only a .cjs or .js file for this export; a .ts entry is ignored.
    assert.equal(entry, "./dist/gui-experimental.cjs")
    assert.ok(entry?.endsWith(".cjs"))
    assert.ok(pkg.files?.includes("dist"), "the bundle's directory must be published")
  })

  test("vite.config.ts builds it with the SDK preset and its default output", () => {
    const config = read("vite.config.ts")

    assert.match(config, /from\s+"@opencode\/plugin\/gui\/vite"/)
    assert.match(config, /plugins:\s*\[\s*gui\(\)\s*\]/)
    // The export above names the preset's defaults; an override here would
    // write some other file and leave ./gui-experimental dangling.
    assert.doesNotMatch(config, /\b(outFile|entry)\s*:/)
  })

  test("src/gui.tsx default-exports Plugin.define with the window setup", () => {
    const file = read("src/gui.tsx")

    assert.match(file, /export\s+default\s+Plugin\.define\(\s*\{/)
    assert.match(file, /\bsetup\s*\(/)
    assert.match(file, /\bi18n\s*:\s*\{\s*en\s*:/)
  })

  test("registers the settings page, both commands and the composer pill", () => {
    const file = read("src/gui.tsx")

    assert.match(file, /ctx\.add\(\s*SettingsPage\s*,/)
    assert.match(file, /id:\s*"indexing"/)
    assert.match(file, /ctx\.add\(\s*Command\s*,/)
    assert.match(file, /"index\.build"/)
    assert.match(file, /"index\.refresh"/)
    assert.match(file, /ctx\.add\(\s*ComposerPill\s*,/)
  })
})
