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
 * The GUI build input: `src/gui.tsx` and any `src/gui/` module it imports.
 *
 * It is not loaded as TypeScript. `vite build` turns it into
 * `dist/gui-experimental.cjs` through the SDK preset, which keeps `solid-js`,
 * `@opencode/*` and Node built-ins external because the app provides them to
 * the bundle. Value imports of those modules here are therefore correct, and
 * the runtime-import scan below would otherwise flag every one of them; the
 * preset, not npm, is what validates them.
 */
const isGuiSource = (file: string): boolean =>
  file === join(root, "src", "gui.tsx") || file.startsWith(join(root, "src", "gui") + sep)

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
    if (isDeclaration(file) || isGuiSource(file)) continue
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
    // The GUI bundle keeps `solid-js` external and the app supplies the
    // instance; the TUI imports OpenTUI only through type declarations. None of
    // them may be installable: a second Solid on disk means two reactive
    // graphs, and signals created by the plugin never reach the host renderer
    // (upstream anomalyco/opencode#33884).
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
    }

    // `solid-js` is the one with a runtime contract: the GUI's bundle keeps it
    // external, so an optional peer documents the version the app provides.
    assert.equal(pkg.peerDependencies?.["solid-js"], ">=1.9.0")
    assert.equal(pkg.peerDependenciesMeta?.["solid-js"]?.optional, true)

    // OpenTUI is type-only now: the TUI carries no JSX, so a consumer does not
    // need to satisfy an OpenTUI peer. The devDependency is for `tsc` alone.
    for (const name of ["@opentui/core", "@opentui/solid"]) {
      assert.equal(pkg.peerDependencies?.[name], undefined, `${name} is type-only; a peer would claim a runtime contract`)
    }

    // @opencode/plugin is imported as types only, but its version is the host
    // contract the TUI relies on, so it stays an optional peer.
    assert.ok(pkg.peerDependencies?.["@opencode/plugin"], "@opencode/plugin must stay a peerDependency")
    assert.equal(pkg.peerDependenciesMeta?.["@opencode/plugin"]?.optional, true)

    // @opencode/theme is never imported by this package. The SDK pins it
    // exactly, so the devDependency tracks the SDK; consumers get it from the
    // host and should not be forced to satisfy an exact peer.
    assert.equal(pkg.peerDependencies?.["@opencode/theme"], undefined)
    assert.ok(pkg.devDependencies?.["@opencode/theme"], "@opencode/theme must stay a devDependency for the TUI types")
  })

  test("devDependencies satisfy the installed SDK's own peers", () => {
    // The check that would have caught the `>=2.0.0` and `>=0.5.17` floors:
    // the manifest looked self-consistent while advertising host versions the
    // SDK itself rejects.
    const installed = JSON.parse(
      readFileSync(join(root, "node_modules", "@opencode", "plugin", "package.json"), "utf8"),
    ) as { version: string; peerDependencies?: Record<string, string> }
    const floor = (range: string): string => {
      const match = range.match(/(\d+)\.(\d+)\.(\d+)/)
      return match ? `${match[1]}.${match[2]}.${match[3]}` : "0.0.0"
    }
    const atLeast = (value: string, minimum: string): boolean => {
      const left = value.split(".").map(Number)
      const right = minimum.split(".").map(Number)
      for (let index = 0; index < 3; index++) {
        if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0)
      }
      return true
    }

    assert.equal(
      pkg.devDependencies?.["@opencode/plugin"],
      installed.version,
      "the SDK must be pinned exactly so the typecheck runs against the same version as the host",
    )
    const themePeer = installed.peerDependencies?.["@opencode/theme"]
    if (themePeer) {
      assert.equal(pkg.devDependencies?.["@opencode/theme"], themePeer, "the theme peer is exact and must match the SDK")
    }
    for (const name of ["@opentui/core", "@opentui/solid", "solid-js"]) {
      const peer = installed.peerDependencies?.[name]
      if (!peer) continue
      const declared = pkg.devDependencies?.[name]
      assert.ok(declared, `${name} must be a devDependency for the typecheck`)
      assert.ok(
        atLeast(floor(declared), floor(peer)),
        `${name} devDependency ${declared} is below the SDK peer ${peer}`,
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
