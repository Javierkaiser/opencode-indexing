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

  test("the settings page never asks for a freshness scan", () => {
    // Settings has no session, so the directory is undefined and the server
    // falls back to its own. `checkFreshness: true` then scans that directory:
    // on a service running from a home directory that is the whole machine, and
    // the scan outlives the RPC transport timeout. The page rendered nothing.
    const file = read("src/gui.tsx")

    assert.doesNotMatch(file, /checkFreshness:\s*true/)
    assert.match(file, /checkFreshness:\s*false/)
  })

  test("a failed read resolves with the reason instead of rejecting", () => {
    // A rejected resource leaves the page with nothing to render, and a blank
    // page is how this bug stayed hidden. The fetcher has to catch and return.
    const file = read("src/gui.tsx")

    assert.match(file, /catch\s*\(error\)/)
    assert.match(file, /return\s*\{\s*error:\s*describeError\(error\)\s*\}/)
    assert.match(file, /"error"\s+in\s+result/)
  })

  test("the page takes the setup context as a prop, not from usePlugin", () => {
    // `usePlugin` throws outside the host's provider. The page is rendered by
    // the settings window, and the SDK only documents that provider for routes,
    // dialogs and slots. Passing the setup context through a prop removes the
    // assumption instead of betting on it.
    const file = read("src/gui.tsx")

    assert.doesNotMatch(file, /usePlugin/)
    assert.match(file, /<IndexingSettings\s+ctx=\{ctx\}/)
  })

  test("the page is built from the host's components, not raw controls", () => {
    // A settings page that draws its own buttons reads as a different app. The
    // SDK exposes the host's controls through ctx.ui and no theme tokens, so
    // the layout is ours but every interactive piece must be the host's.
    const file = read("src/gui.tsx")

    assert.match(file, /ctx\.ui\.Button/)
    assert.match(file, /ctx\.ui\.IconButton/)
    assert.match(file, /ctx\.ui\.Switch/)
    assert.match(file, /ctx\.ui\.Loader/)
    assert.match(file, /ctx\.ui\.Icon/)
    assert.match(file, /ctx\.ui\.Tooltip/)
    assert.doesNotMatch(file, /<button\b/)
  })

  test("the booleans persist through settings.apply and adopt the server's answer", () => {
    // The switch must show what the server stored, not what was asked for: a
    // clamped or rejected value would otherwise look accepted until a reload.
    const file = read("src/gui.tsx")

    assert.match(file, /"settings\.apply"/)
    assert.match(file, /applyKey\("enabled"/)
    assert.match(file, /applyKey\("importfromkilo"/)
    assert.match(file, /applyKey\("autorefresh"/)
    assert.match(file, /applyKey\("codegraph"/)
    assert.match(file, /mutate\(/)
  })

  test("provider, model and store are chosen from the server's catalog", () => {
    // `src/registry.ts` imports node:crypto, so the GUI cannot import the
    // catalog: it asks for it. A hardcoded list here would drift from the
    // server and offer models with no adapter.
    const file = read("src/gui.tsx")

    assert.match(file, /"catalog\.get"/)
    assert.match(file, /ctx\.dialogs\.select/)
    assert.match(file, /chooseProvider/)
    assert.match(file, /chooseModel/)
    assert.match(file, /chooseStore/)
  })

  test("credentials are typed in a secret prompt and written through their own method", () => {
    // The chat tool refuses secrets; a settings surface is the user typing
    // their own key. A distinct RPC keeps that exception visible instead of
    // hiding it in a raw `settings.set` patch.
    const file = read("src/gui.tsx")

    assert.match(file, /"settings\.credential"/)
    assert.match(file, /secret:\s*true/)
    assert.doesNotMatch(file, /apiKeys/)
  })

  test("the local preset sets the model, the store and the toggles together", () => {
    const file = read("src/gui.tsx")

    assert.match(file, /provider:\s*"local"/)
    assert.match(file, /vectorStore:\s*"lancedb"/)
    assert.match(file, /importFromKilo:\s*true/)
    assert.match(file, /autoRefresh:\s*true/)
    assert.match(file, /settings\.test"\]\(\{\s*target:\s*"lancedb"/s)
  })

  test("no colour is hardcoded, so the page follows the app's theme", () => {
    // The app defines its theme as CSS variables: `:root` for light,
    // `@media (prefers-color-scheme: dark)` for the system scheme, and
    // `[data-color-scheme=dark]` for the Settings > Appearance override. A
    // plugin page inside the document inherits all three, so a hex value is
    // the one thing that would stop following them.
    const file = read("src/gui.tsx")

    assert.match(file, /var\(--v2-/)
    assert.doesNotMatch(file, /#[0-9a-f]{3,8}\b/i)
    assert.doesNotMatch(file, /\brgba?\(/i)
  })

  test("the page uses the host's measurements and theme variables", () => {
    // These are the app's own values, read from its settings CSS: a 720px
    // column, 48px above the title, and `--v2-*` variables for every colour.
    // A hardcoded grey is wrong in one of the two themes.
    const file = read("src/gui.tsx")

    assert.match(file, /"padding-top": "48px"/)
    assert.match(file, /"max-width": "720px"/)
    assert.match(file, /--v2-/)
    assert.match(file, /"padding-block": "20px"/)
  })
})
