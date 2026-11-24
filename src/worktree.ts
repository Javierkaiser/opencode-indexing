import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

/**
 * Git worktree discovery for the import engine.
 *
 * A repository checked out with `git worktree add` keeps a `.git` FILE instead
 * of a directory, holding `gitdir: <main>/.git/worktrees/<name>`. Kilo indexed
 * the main checkout, so the linked worktree's own directory usually has no
 * index at all while the main one has the whole repository's.
 *
 * Read-only and never throws: a workspace may be a plain directory, a broken
 * checkout, or a layout this does not recognize.
 */

/**
 * Kilo's baseline directory for `root`, or `undefined` when there is none.
 *
 * Kilo mirrors the active directory's position inside a linked worktree onto
 * the main checkout (`<main>/<relative>`), so opening a subdirectory is a
 * different Kilo index from opening the repository root. Walk up to the
 * checkout first and mirror the same relative path; returning just the main
 * root would look up the wrong database.
 */
export function mainWorktree(root: string): string | undefined {
  const absolute = path.resolve(root)
  const checkout = findCheckout(absolute)
  if (!checkout) return undefined

  const dotGit = path.join(checkout, ".git")
  let stat: fs.Stats
  try {
    stat = fs.statSync(dotGit)
  } catch {
    return undefined
  }
  // A directory means this IS the main checkout (or a plain repository), so
  // there is no separate baseline to import.
  if (stat.isDirectory()) return undefined
  if (!stat.isFile()) return undefined

  const gitdir = readGitdir(dotGit)
  let main = gitdir ? mainFromWorktreeGitdir(path.resolve(checkout, gitdir)) : undefined

  // A non-standard layout (or an unreadable `.git` file): let git answer. The
  // first porcelain entry is the main worktree. Read-only, and a missing git or
  // a failing command simply means "cannot tell".
  if (!main) main = mainFromGitWorktreeList(checkout)
  if (!main) return undefined
  if (samePath(main, checkout)) return undefined

  const relative = path.relative(checkout, absolute)
  if (relative === "") return main
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined
  return path.resolve(main, relative)
}

/** Nearest ancestor (or `root` itself) that holds a `.git` entry. */
function findCheckout(start: string): string | undefined {
  let current = start
  for (;;) {
    const dotGit = path.join(current, ".git")
    try {
      fs.statSync(dotGit)
      return current
    } catch {
      // Not here; a repository can still own a parent directory.
    }
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** First `gitdir: <path>` line of a `.git` file, verbatim. */
function readGitdir(file: string): string | undefined {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? ""
  const match = /^gitdir:\s*(.+?)\s*$/.exec(firstLine)
  const value = match?.[1]
  return value && value.length > 0 ? value : undefined
}

/** `<main>/.git/worktrees/<name>` -> `<main>`; anything else -> undefined. */
function mainFromWorktreeGitdir(gitdir: string): string | undefined {
  // Walk up with `path.dirname`, not by splitting and re-joining: splitting an
  // absolute POSIX path drops its leading slash, and resolving the joined
  // string would then look under the current directory.
  const worktrees = path.dirname(gitdir)
  if (path.basename(worktrees) !== "worktrees") return undefined
  const dotGit = path.dirname(worktrees)
  if (path.basename(dotGit) !== ".git") return undefined
  // Resolve to the host's separator: git writes `gitdir:` with forward slashes
  // on Windows, and Kilo hashes the workspace path verbatim to name its store.
  return path.resolve(path.dirname(dotGit))
}

function mainFromGitWorktreeList(root: string): string | undefined {
  const result = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    timeout: 2_000,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) return undefined
  const first = /^worktree (.+)$/m.exec(result.stdout ?? "")
  const value = first?.[1]?.trim()
  if (!value) return undefined
  const main = path.resolve(value)
  // The main worktree lists itself first; that is not a linked worktree.
  return samePath(main, root) ? undefined : main
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}
