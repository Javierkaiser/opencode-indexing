import * as assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, test } from "node:test"

/**
 * The published package's dependency declarations and imports, read from the
 * real files rather than copies, so this test fails when the manifest and the
 * code drift apart.
 *
 * The rule this file exists for: the TUI half of the plugin must not install
 * or import its own `solid-js` / `@opentui/*`. Installed from npm the plugin
 * lives under `node_modules`, where the host's JSX transform does not reach it
 * and a bare import resolves to the plugin's own copy. Two Solid instances
 * mean two reactive graphs, so signals created by the plugin never reach the
 * host renderer and the UI freezes (upstream anomalyco/opencode#33884). The
 * runtime is reached through `tui/host-runtime.ts`, which imports the host's
 * singletons by virtual `opentui:runtime-module:*` IDs.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  devDependencies?: Record<string, string>
}

/**
 * Packages the host supplies at runtime. The plugin declares them as optional
 * peers (so npm does not install a second copy) and keeps them in
 * devDependencies for the typecheck, which is why importing them by value from
 * the published sources must fail.
 */
const HOST_RUNTIME_PACKAGES = ["solid-js", "@opentui/core", "@opentui/solid"] as const

/** Prefix of the host's virtual module IDs: resolved by the host, typed in `tui/virtual-modules.d.ts`. */
const VIRTUAL_PREFIX = "opentui:runtime-module:"

const FACADE = join(root, "tui", "host-runtime.ts")
const TYPE_MAP = join(root, "tui", "virtual-modules.d.ts")

/** Every source file the tarball ships: `files` lists `src`, `tui`, `index.ts` and `tui.ts`. */
const shippedFiles = (): string[] => {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) files.push(full)
    }
  }
  walk(join(root, "src"))
  walk(join(root, "tui"))
  files.push(join(root, "index.ts"), join(root, "tui.ts"))
  return files.sort()
}

/** The TUI half: everything under `tui/` plus `tui.ts`, the files the host transform used to see. */
const tuiSources = (): string[] =>
  shippedFiles().filter((file) => file.startsWith(join(root, "tui") + sep) || file === join(root, "tui.ts"))

/**
 * Declaration files are erased before anything executes. `tui/virtual-modules.d.ts`
 * is exactly such a file: its `export * from "solid-js"` re-exports types only,
 * so it is out of scope for the runtime-import scan below.
 */
const isDeclaration = (file: string): boolean => file.endsWith(".d.ts")

/** `@scope/pkg/sub` -> `@scope/pkg`; `pkg/sub` -> `pkg`. */
const packageOf = (specifier: string): string => {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
}

/**
 * Value imports in the shipped runtime files.
 *
 * All three forms resolve at runtime, so all three are checked: static
 * `import … from`, side-effect `import "…"`, and `import("…")` (dynamic).
 * Type-only statements are erased by the compiler and skipped.
 *
 * The static matcher spells out the real clause shapes (`{ … }`, `* as ns`,
 * `*`, a default identifier, and the default + named combination) instead of
 * lazily scanning to the next `from`, so a comment or a later statement
 * containing the word `from` cannot be mistaken for an import. The clause is
 * captured to tell an all-`type` brace list (`import { type X } from`, erased
 * like `import type`) from a statement that keeps a runtime binding.
 */
const STATIC_IMPORT =
  /(?:^|\n)[ \t]*(?:import|export)\s+(?!type\b)(?:\{([^}]*)\}|\*\s+as\s+[\w$]+|\*|[\w$]+)(?:\s*,\s*(?:\{([^}]*)\}|\*\s+as\s+[\w$]+|[\w$]+))?\s*from\s+"([^"]+)"/g

/** True when every specifier inside a `{ … }` clause carries the inline `type` modifier. */
const allInlineTypes = (clause: string): boolean => {
  const specifiers = clause
    .split(",")
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier !== "")
  return specifiers.length > 0 && specifiers.every((specifier) => specifier.startsWith("type "))
}

const valueImports = (): Array<{ file: string; specifier: string }> => {
  const found: Array<{ file: string; specifier: string }> = []
  const simpleForms = [
    // Side-effect form: no `from`, no bindings.
    /(?:^|\n)[ \t]*import\s+"([^"]+)"/g,
    // Dynamic literal: resolved at load time, exactly like a static import.
    /\bimport\s*\(\s*"([^"]+)"\s*\)/g,
  ]
  for (const file of shippedFiles()) {
    if (isDeclaration(file)) continue
    const text = readFileSync(file, "utf8")
    for (const match of text.matchAll(STATIC_IMPORT)) {
      const braces = [match[1], match[2]].filter((part): part is string => part !== undefined)
      if (braces.length > 0 && braces.every(allInlineTypes)) continue
      found.push({ file, specifier: match[3]! })
    }
    for (const pattern of simpleForms) {
      for (const match of text.matchAll(pattern)) {
        found.push({ file, specifier: match[1]! })
      }
    }
  }
  return found
}

describe("published dependencies", () => {
  test("no published runtime file imports a third-party package of its own", () => {
    // The allowed set is derived from the manifest, not remembered: dependencies
    // plus optionalDependencies are the only packages npm puts on disk. Every
    // other bare specifier must be a virtual ID; `node:` builtins and relative
    // paths are ours. A new third-party value import fails here instead of
    // becoming another silent missing module at load time.
    const installed = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ])
    let external = 0
    let virtual = 0
    for (const { file, specifier } of valueImports()) {
      if (specifier.startsWith("node:")) continue
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue
      if (specifier.startsWith(VIRTUAL_PREFIX)) {
        virtual++
        continue
      }
      const bare = packageOf(specifier)
      assert.ok(
        !(HOST_RUNTIME_PACKAGES as readonly string[]).includes(bare),
        `${relative(root, file)} imports "${specifier}" as a value. ${bare} is the host's runtime: ` +
          "installed from npm the plugin would load its own copy, and two copies of Solid mean two " +
          "reactive graphs — signals created by the plugin never reach the host renderer and the UI " +
          "freezes (upstream anomalyco/opencode#33884). Import it through tui/host-runtime.ts instead.",
      )
      assert.ok(
        installed.has(bare),
        `${relative(root, file)} imports "${specifier}" as a value but the manifest does not install ` +
          `${bare}: declare it as a dependency/optionalDependency, or reach the host through tui/host-runtime.ts`,
      )
      external++
    }
    // Non-vacuity. The facade's virtual imports must have been seen, otherwise
    // the scan is broken; so must at least one manifest-installed package
    // imported by value (the optional @lancedb/lancedb / web-tree-sitter),
    // which is what keeps the optionalDependencies honest.
    assert.ok(virtual >= 1, `expected to check the facade's ${VIRTUAL_PREFIX}… imports; found ${virtual}`)
    assert.ok(external >= 1, `expected to check at least one installed package imported by value; found ${external}`)
  })

  test("the host runtime is reached only through tui/host-runtime.ts", () => {
    // The facade is the one runtime file that names the virtual IDs, and the
    // type map declares them for the typechecker. A virtual ID anywhere else
    // means a host build that renames the scheme has more than one file to
    // update, or that a file is bypassing the facade.
    for (const file of shippedFiles()) {
      if (file === FACADE || file === TYPE_MAP) continue
      assert.ok(
        !readFileSync(file, "utf8").includes(VIRTUAL_PREFIX),
        `${relative(root, file)} names a ${VIRTUAL_PREFIX}… specifier; these must stay in tui/host-runtime.ts`,
      )
    }

    const declared = new Set(
      [...readFileSync(FACADE, "utf8").matchAll(/"(opentui:runtime-module:[^"]+)"/g)].map((match) => match[1]!),
    )
    assert.ok(declared.size >= 1, "tui/host-runtime.ts must re-export at least one host runtime module")

    const mapped = new Set(
      [...readFileSync(TYPE_MAP, "utf8").matchAll(/declare\s+module\s+"(opentui:runtime-module:[^"]+)"/g)].map(
        (match) => match[1]!,
      ),
    )
    for (const id of declared) {
      assert.ok(
        mapped.has(id),
        `tui/host-runtime.ts uses ${id} but tui/virtual-modules.d.ts does not declare it, so the typecheck cannot resolve it`,
      )
    }
    // The reverse is tolerated: the host may expose modules the plugin does not
    // use yet, and an unused `declare module` costs nothing at runtime.
  })

  test("the manifest does not install the host runtime", () => {
    // They were dependencies once. That failed twice: as optional peers npm
    // never installed them (the plugin's own import() then failed and the catch
    // swallowed it, so the footer rendered nothing), and as dependencies
    // @opentui's `engines.node >= 26.4.0` made npm skip them in silence on
    // Node 22 - the version this package claims to support.
    //
    // The TUI is JSX-free now and takes its runtime from the host, so there is
    // nothing left to install: devDependencies carry the types for `tsc`, and
    // optional peers document the host versions the virtual modules resolve
    // against without npm putting a second Solid on disk. A required peer would
    // make npm 7+ auto-install its own copy - the same two-Solid bug through
    // another door - so every peer must stay optional.
    for (const name of HOST_RUNTIME_PACKAGES) {
      assert.equal(pkg.dependencies?.[name], undefined, `${name} must not be a dependency: npm would install a second copy`)
      assert.equal(
        pkg.optionalDependencies?.[name],
        undefined,
        `${name} must not be an optionalDependency: npm skips those in silence when the engine does not match`,
      )
      assert.ok(
        pkg.devDependencies?.[name],
        `${name} must stay in devDependencies: the typecheck needs the host's types, and they are erased at runtime`,
      )
      assert.ok(
        pkg.peerDependencies?.[name],
        `${name} must be declared as an optional peerDependency: it documents the host version the runtime expects`,
      )
      assert.equal(
        pkg.peerDependenciesMeta?.[name]?.optional,
        true,
        `${name} must be an OPTIONAL peer: a required peer makes npm install its own copy under the plugin`,
      )
    }

    // @opencode/plugin and @opencode/theme are imported as types only
    // (`import type { Plugin }`), so nothing is resolved at runtime and no
    // entry is needed on disk. They stay optional peers for the same reason.
    for (const name of ["@opencode/plugin", "@opencode/theme"]) {
      assert.ok(pkg.peerDependencies?.[name], `${name} must stay a peerDependency: the host supplies it at compile time`)
      assert.equal(
        pkg.peerDependenciesMeta?.[name]?.optional,
        true,
        `${name} must stay optional: the plugin runs without the TUI halves`,
      )
    }
  })

  test("published TUI sources carry no JSX syntax", () => {
    // Heuristic, not a parser. The host's JSX transform does not run on code
    // under node_modules, so a stray JSX tag in these files would compile
    // against the plugin's own @opentui/solid (or not compile at all) instead
    // of the host's runtime - see the header and anomalyco/opencode#33884.
    // The tree is built with the jsx()/jsxs() calls re-exported by
    // tui/host-runtime.ts, which this test leaves alone.
    //
    // A full-line comment is skipped for the tag patterns: tui/host-runtime.ts
    // mentions `<>…</>` in prose, and prose is not syntax. The jsxImportSource
    // check still runs on every line, because a pragma lives in a comment.
    // Strings could in theory trip a pattern; none do, and a false positive
    // here is a line worth looking at anyway.
    const tagPatterns: Array<{ pattern: RegExp; what: string }> = [
      { pattern: /<\/[A-Za-z>]/, what: "a closing JSX tag" },
      { pattern: /\/>/, what: "a self-closing JSX tag" },
      { pattern: /<[A-Za-z][\w.:-]*\s+[\w-]+\s*[=/>]/, what: "a JSX opening tag with attributes" },
    ]
    for (const file of tuiSources()) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const where = `${relative(root, file)}:${index + 1}`
          assert.ok(
            !/@jsxImportSource/.test(line),
            `${where} configures a JSX import source; the published TUI must not rely on a JSX transform`,
          )
          const trimmed = line.trim()
          if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return
          for (const { pattern, what } of tagPatterns) {
            assert.ok(!pattern.test(line), `${where} looks like ${what}: ${trimmed}`)
          }
        })
    }
  })
})
