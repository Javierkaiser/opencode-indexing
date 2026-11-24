import * as assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, describe, test } from "node:test"

import { mainWorktree } from "../src/worktree.ts"

/**
 * A linked git worktree keeps a `.git` file pointing into the main checkout.
 * Discovery reads that pointer to find the index Kilo actually built, so the
 * parsing has to be right without a git binary being involved.
 */

const dirs: string[] = []

function tempDir(prefix = "oi-worktree-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe("mainWorktree", () => {
  test("a .git directory means this is the main worktree", () => {
    const root = tempDir()
    mkdirSync(path.join(root, ".git"))
    assert.equal(mainWorktree(root), undefined)
  })

  test("a plain directory is not a worktree", () => {
    const root = tempDir()
    assert.equal(mainWorktree(root), undefined)
    assert.equal(mainWorktree(path.join(root, "missing")), undefined)
  })

  test("a standard gitdir file resolves to the main worktree", () => {
    const main = tempDir("oi-main-")
    const worktree = tempDir("oi-linked-")
    mkdirSync(path.join(main, ".git", "worktrees", "feature"), { recursive: true })
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`)

    assert.equal(path.resolve(mainWorktree(worktree) ?? ""), path.resolve(main))
  })

  test("a subdirectory of a linked worktree mirrors its position in the main checkout", () => {
    // Kilo indexes the active directory, not always the repository root: the
    // baseline for `<linked>/sub/deep` is `<main>/sub/deep`, not `<main>`.
    const main = tempDir("oi-main-nested-")
    const worktree = tempDir("oi-linked-nested-")
    mkdirSync(path.join(main, ".git", "worktrees", "feature"), { recursive: true })
    const nested = path.join(worktree, "sub", "deep")
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`)

    assert.equal(mainWorktree(nested), path.join(main, "sub", "deep"))
  })

  test("a subdirectory of the main worktree has no baseline", () => {
    const main = tempDir("oi-main-sub-")
    mkdirSync(path.join(main, ".git"))
    mkdirSync(path.join(main, "sub"), { recursive: true })
    assert.equal(mainWorktree(path.join(main, "sub")), undefined)
  })

  test("a relative gitdir is resolved from the worktree, not the cwd", () => {
    const parent = tempDir("oi-relative-")
    const main = path.join(parent, "repo")
    const worktree = path.join(parent, "repo-feature")
    mkdirSync(path.join(main, ".git", "worktrees", "feature"), { recursive: true })
    mkdirSync(worktree, { recursive: true })
    writeFileSync(path.join(worktree, ".git"), "gitdir: ../repo/.git/worktrees/feature\n")

    assert.equal(mainWorktree(worktree), main)
  })

  test("an unreadable .git file is not a worktree", () => {
    // The git fallback would run here, so keep it inside this directory: with a
    // parent repository it could otherwise answer about the wrong checkout.
    const root = tempDir()
    writeFileSync(path.join(root, ".git"), "this is not a gitdir line\n")
    const previous = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = root
    try {
      assert.equal(mainWorktree(root), undefined)
    } finally {
      if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = previous
    }
  })

  test("a submodule-style gitdir is not a worktree", () => {
    const root = tempDir()
    mkdirSync(path.join(root, "modules", "dep"), { recursive: true })
    writeFileSync(path.join(root, ".git"), `gitdir: ${path.join(root, "modules", "dep")}\n`)
    const previous = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = root
    try {
      assert.equal(mainWorktree(root), undefined)
    } finally {
      if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = previous
    }
  })
})
