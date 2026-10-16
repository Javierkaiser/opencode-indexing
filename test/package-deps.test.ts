import * as assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, test } from "node:test"

/**
 * The published package's dependency declarations, read from the real file
 * rather than a copy, so this test fails when the manifest and reality drift.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  devDependencies?: Record<string, string>
  dependencies?: Record<string, string>
  files?: string[]
}

/**
 * Packages the shipped TUI code imports as values, and so must exist on disk.
 *
 * Derived from reading the published sources rather than from memory:
 *   tui/footer-view.tsx  -> solid-js (createSignal)
 *   tui/settings-page.tsx -> solid-js (For/Show/createResource), @opentui/core
 *   every .tsx            -> @opentui/solid, as the JSX runtime (tsconfig
 *                            jsxImportSource)
 * Nothing else outside node: builtins is imported by value.
 */
const RUNTIME_JSX_PACKAGES = ["solid-js", "@opentui/core", "@opentui/solid"] as const

describe("published dependencies", () => {
  test("the JSX runtime is installed, not left to the host", () => {
    // solid-js, @opentui/core and @opentui/solid were optional peerDependencies,
    // which means npm never installed them: the plugin's own import() of
    // footer-view.tsx then failed, the catch swallowed it, and the prompt
    // footer rendered nothing while every non-JSX feature kept working. The
    // command palette was the tell - it comes from tui.ts itself, which needs
    // no JSX at all.
    //
    // An optional peer is an assumption that something else provides the
    // package. OpenCode 2.0.30 stopped providing it, and the failure mode was
    // silence. optionalDependencies still tolerates a failed install, so this
    // keeps that tolerance without depending on anyone else.
    for (const name of RUNTIME_JSX_PACKAGES) {
      assert.ok(pkg.optionalDependencies?.[name], `${name} must be an optionalDependency so it gets installed`)
      assert.ok(
        !pkg.peerDependencies?.[name],
        `${name} must not also be a peerDependency: npm resolves the two differently`,
      )
      // Listing it in devDependencies as well is silently fatal: npm 12 lets
      // devDependencies win, `npm install --omit=dev` then skips the package
      // entirely, and the optionalDependency never reaches disk. Verified by
      // trial, not inferred - it looks correct in package.json.
      assert.ok(
        !pkg.devDependencies?.[name],
        `${name} must not be in devDependencies: npm drops it from the install even though it is an optionalDependency`,
      )
    }
  })

  test("the only peers left are types the host supplies at compile time", () => {
    // @opencode/plugin and @opencode/theme are imported as types only
    // (`import type { Plugin }`), so nothing is resolved at runtime and no
    // entry is needed on disk. Anything added here as a peer has to earn it:
    // either it is a type-only import, or it is an optionalDependency too.
    assert.deepEqual(Object.keys(pkg.peerDependencies ?? {}).sort(), ["@opencode/plugin", "@opencode/theme"])
    for (const [name, meta] of Object.entries(pkg.peerDependenciesMeta ?? {})) {
      assert.equal(meta.optional, true, `${name} must stay optional: the plugin runs without the TUI halves`)
    }
  })

  test("every value import in the published sources is satisfiable from the manifest", () => {
    // The check above is only worth anything if the list matches the code, so
    // walk the shipped sources and confirm nothing new appeared undeclared. A
    // new third-party value import fails here instead of becoming another
    // silent missing module at load time.
    const shipped: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(entry.name)) shipped.push(full)
      }
    }
    walk(join(root, "src"))
    walk(join(root, "tui"))
    shipped.push(join(root, "index.ts"), join(root, "tui.ts"))

    const builtins = /^node:/
    const known = new Set([...RUNTIME_JSX_PACKAGES, ...Object.keys(pkg.dependencies ?? {})])
    let checked = 0
    for (const file of shipped) {
      const text = readFileSync(file, "utf8")
      for (const match of text.matchAll(/^\s*import\s+(?!type\s)[^;]*?from\s+"([^"]+)"/gm)) {
        const specifier = match[1]!
        if (builtins.test(specifier)) continue
        // Relative and absolute paths are our own files, not packages.
        if (specifier.startsWith(".") || specifier.startsWith("/")) continue
        const bare = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!
        assert.ok(known.has(bare), `${file} imports ${specifier} as a value but the manifest does not install ${bare}`)
        checked++
      }
    }
    assert.ok(checked >= 3, `expected to check the JSX value imports; only found ${checked}`)
  })

  test("tsconfig.json ships, because the JSX transform is configured there", () => {
    // jsx: react-jsx + jsxImportSource: @opentui/solid is what makes a .tsx
    // file load at all. Without this file in the tarball the host falls back
    // to its own defaults and the JSX runtime is not the one the views import.
    assert.ok(pkg.files?.includes("tsconfig.json"), "tsconfig.json must be published for the JSX transform")
  })
})
