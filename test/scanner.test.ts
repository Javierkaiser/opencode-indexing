import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, describe, it } from "node:test"

import {
  DEFAULT_IGNORE_GLOBS,
  DEFAULT_IGNORED_DIRS,
  scanWorkspace,
} from "../src/scanner.ts"

/**
 * The scanner prefers the optional npm `ignore` package and falls back to a
 * built-in minimal matcher. Detect which one is active at runtime; the tests
 * below only rely on behavior both matchers share (gitignore negation inside
 * non-excluded directories, no re-inclusion below an excluded directory).
 */
const ignoreSpecifier: string = "ignore"
let hasIgnorePackage = false
try {
  await import(ignoreSpecifier)
  hasIgnorePackage = true
} catch {
  hasIgnorePackage = false
}

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "scan-test-"))
  tempRoots.push(root)
  return root
}

function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    mkdirSync(path.dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
}

/**
 * Standard tree:
 *   a.ts, sub/b.ts, z.ts, big.ts (>1MB), empty.ts (0 bytes)
 *   node_modules/x/c.ts, .git/config
 *   img.png, readme.md, ignored.log, .github/workflows/ci.yml
 *   .gitignore containing "*.log"
 */
function createWorkspace(): string {
  const root = makeTempRoot()
  writeFiles(root, {
    ".gitignore": "*.log\n",
    "a.ts": "export const a = 1\n",
    "sub/b.ts": "export const b = 2\n",
    "z.ts": "export const z = 9\n",
    "node_modules/x/c.ts": "export const c = 3\n",
    ".git/config": "[core]\n",
    "img.png": "not really a png",
    "big.ts": Buffer.alloc(1024 * 1024 + 1, 97),
    "readme.md": "# readme\n",
    ".github/workflows/ci.yml": "name: ci\n",
    "empty.ts": "",
    "ignored.log": "log line\n",
  })
  return root
}

describe("scanner", () => {
  after(() => {
    for (const root of tempRoots) {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // Best-effort cleanup.
      }
    }
  })

  it("exports the documented default ignore lists", () => {
    assert.deepEqual(DEFAULT_IGNORED_DIRS, [
      ".git",
      "node_modules",
      "vendor",
      "dist",
      "build",
      "out",
      "target",
      "bin",
      "obj",
      ".next",
      ".nuxt",
      ".cache",
      "coverage",
      "__pycache__",
      ".venv",
      "venv",
      ".idea",
      ".vs",
      ".gradle",
      ".terraform",
      ".turbo",
      ".parcel-cache",
    ])
    assert.deepEqual(DEFAULT_IGNORE_GLOBS, [
      "*.min.js",
      "*.min.css",
      "*.map",
      "*.lock",
      "package-lock.json",
      "*.log",
      "*.snap",
      "*.generated.*",
    ])
  })

  it("filters by extension and skips ignored directories", async () => {
    const root = createWorkspace()
    const result = await scanWorkspace(root, { extensions: [".ts", ".md", ".yml"] })
    const expected = [
      path.join(".github", "workflows", "ci.yml"),
      "a.ts",
      "readme.md",
      path.join("sub", "b.ts"),
      "z.ts",
    ]
    assert.deepEqual(result.files.map((file) => file.relPath), expected)
    assert.equal(result.skippedTooLarge, 1)
    // .git dir + node_modules dir + ignored.log
    assert.equal(result.skippedIgnored, 3)
    assert.equal(result.truncated, false)
  })

  it("without extensions keeps text/config files but excludes media and default globs", async () => {
    const root = createWorkspace()
    const result = await scanWorkspace(root)
    const rel = result.files.map((file) => file.relPath)
    assert.ok(rel.includes("a.ts"))
    assert.ok(rel.includes(path.join("sub", "b.ts")))
    assert.ok(rel.includes("readme.md"))
    assert.ok(rel.includes(path.join(".github", "workflows", "ci.yml")))
    assert.ok(rel.includes(".gitignore"))
    assert.ok(!rel.includes("img.png"))
    assert.ok(!rel.includes("ignored.log"))
    assert.ok(!rel.includes("big.ts"))
    assert.ok(!rel.includes("empty.ts"))
    assert.ok(!rel.some((entry) => entry.includes("node_modules")))
    assert.ok(!rel.some((entry) => entry === path.join(".git", "config")))
    assert.equal(result.skippedTooLarge, 1)
  })

  it("uses native separators, resolves absolute paths and sorts deterministically", async () => {
    const root = createWorkspace()
    const result = await scanWorkspace(root, { extensions: [".ts"] })
    const rel = result.files.map((file) => file.relPath)
    const sorted = [...rel].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    assert.deepEqual(rel, sorted)
    if (path.sep === "\\") {
      assert.ok(rel.includes("sub\\b.ts"))
      assert.ok(rel.every((entry) => !entry.includes("/")))
    } else {
      assert.ok(rel.includes("sub/b.ts"))
    }
    for (const file of result.files) {
      assert.equal(file.absPath, path.resolve(root, file.relPath))
      assert.ok(file.size > 0)
      assert.ok(file.mtimeMs > 0)
    }
  })

  it("stops at maxFiles and reports truncation", async () => {
    const root = createWorkspace()
    const result = await scanWorkspace(root, { extensions: [".ts"], maxFiles: 2 })
    assert.equal(result.truncated, true)
    assert.deepEqual(result.files.map((file) => file.relPath), [
      "a.ts",
      path.join("sub", "b.ts"),
    ])
    // The walk stopped before reaching z.ts.
    assert.ok(!result.files.some((file) => file.relPath === "z.ts"))
  })

  it("returns an empty result for a missing root", async () => {
    const missing = path.join(
      os.tmpdir(),
      `scan-test-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    const result = await scanWorkspace(missing)
    assert.deepEqual(result, {
      files: [],
      skippedTooLarge: 0,
      skippedIgnored: 0,
      truncated: false,
    })
  })

  it("honors .gitignore patterns", async () => {
    const root = makeTempRoot()
    writeFiles(root, {
      ".gitignore": "sub/\n*.log\n",
      "keep.ts": "keep\n",
      "sub/inside.ts": "inside\n",
      "debug.log": "debug\n",
    })
    const result = await scanWorkspace(root)
    assert.deepEqual(result.files.map((file) => file.relPath), [".gitignore", "keep.ts"])
    // sub dir + debug.log
    assert.equal(result.skippedIgnored, 2)
    assert.equal(result.skippedTooLarge, 0)
    assert.equal(result.truncated, false)
  })

  it("honors .kilocodeignore patterns", async () => {
    const root = makeTempRoot()
    writeFiles(root, {
      ".kilocodeignore": "secret.ts\n",
      "main.ts": "main\n",
      "secret.ts": "secret\n",
    })
    const result = await scanWorkspace(root)
    assert.deepEqual(result.files.map((file) => file.relPath), [".kilocodeignore", "main.ts"])
    assert.equal(result.skippedIgnored, 1)
  })

  it("supports negation but never re-includes files below an ignored directory", async (context) => {
    context.diagnostic(
      hasIgnorePackage
        ? "matcher: npm `ignore` package"
        : "matcher: built-in fallback",
    )

    const negated = makeTempRoot()
    writeFiles(negated, {
      ".gitignore": "*.log\n!important.log\n",
      "code.ts": "code\n",
      "important.log": "keep me\n",
      "other.log": "drop me\n",
    })
    const negatedResult = await scanWorkspace(negated)
    assert.deepEqual(negatedResult.files.map((file) => file.relPath), [
      ".gitignore",
      "code.ts",
      "important.log",
    ])
    assert.equal(negatedResult.skippedIgnored, 1)

    const nested = makeTempRoot()
    writeFiles(nested, {
      ".gitignore": "sub/\n!sub/keep.ts\n",
      "top.ts": "top\n",
      "sub/keep.ts": "nested\n",
    })
    const nestedResult = await scanWorkspace(nested)
    assert.deepEqual(nestedResult.files.map((file) => file.relPath), [".gitignore", "top.ts"])
    assert.equal(nestedResult.skippedIgnored, 1)
  })

  it("does not follow symlinked files or directories", async () => {
    const root = createWorkspace()
    let fileLinkCreated = false
    let dirLinkCreated = false
    try {
      symlinkSync(path.join(root, "a.ts"), path.join(root, "link.ts"), "file")
      fileLinkCreated = true
    } catch {
      // Symlink creation can require privileges (Windows without Developer Mode).
    }
    try {
      const dirLinkType = process.platform === "win32" ? "junction" : "dir"
      symlinkSync(path.join(root, "sub"), path.join(root, "linkdir"), dirLinkType)
      dirLinkCreated = true
    } catch {
      // Same as above.
    }
    if (!fileLinkCreated && !dirLinkCreated) {
      return
    }
    const result = await scanWorkspace(root)
    const rel = result.files.map((file) => file.relPath)
    if (fileLinkCreated) {
      assert.ok(!rel.includes("link.ts"))
    }
    if (dirLinkCreated) {
      assert.ok(!rel.some((entry) => entry.startsWith(`linkdir${path.sep}`)))
    }
  })
})
