import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Scope assessment for a workspace root.
 *
 * Indexing is deliberately warn-but-allow: a user may really want to index a
 * parent directory, several vendored repos or even (arguably) their home. What
 * they must not get is a silent multi-hour, credit-eating run they did not
 * choose, so the assessment only reports — it never blocks.
 */

export interface ScopeAssessment {
  level: "ok" | "warn"
  /** Empty when `level` is `ok`. */
  reason: string
}

/** Bounds the container scan: one level deep, at most this many entries. */
const MAX_SCAN_ENTRIES = 200
/** Direct subdirectories that must be git repos for "container" to fire. */
const CONTAINER_REPO_THRESHOLD = 3
/** Never looked at while scanning for nested repositories. */
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules"])

/** Assess whether `root` looks like a single project. Never throws. */
export function assessScope(root: string, homeDir?: string): ScopeAssessment {
  const target = resolvePath(root)
  if (!target) return ok()

  // The user's home itself, or a directory above it: every project on the
  // machine would be swept in. A project INSIDE the home is perfectly normal.
  const home = resolvePath(homeDir ?? homeDirectory())
  if (home && isSelfOrAncestor(target, home)) {
    return warn(
      normalize(target) === normalize(home)
        ? "your home directory — every project on this machine would be indexed"
        : "a parent of your home directory — every project on this machine would be indexed",
    )
  }

  if (isVolumeRoot(target)) return warn("a drive root — every project on that drive would be indexed")

  const repos = countGitRepositories(target)
  if (repos >= CONTAINER_REPO_THRESHOLD) {
    return warn(
      `a container — ${repos} of its direct subdirectories are git repositories, so all of them would be indexed`,
    )
  }

  return ok()
}

function ok(): ScopeAssessment {
  return { level: "ok", reason: "" }
}

function warn(reason: string): ScopeAssessment {
  return { level: "warn", reason }
}

function resolvePath(target: string | undefined): string | undefined {
  if (typeof target !== "string" || !target.trim()) return undefined
  try {
    return path.resolve(target.trim())
  } catch {
    return undefined
  }
}

/** `os.homedir()` is allowed to fail; the assessment must still answer. */
function homeDirectory(): string | undefined {
  try {
    return os.homedir()
  } catch {
    return undefined
  }
}

/** Case-insensitive on Windows, where `C:\Users` and `c:\users` are one path. */
function normalize(target: string): string {
  const resolved = path.resolve(target)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** True when `candidate` is `descendant` itself or one of its ancestors. */
function isSelfOrAncestor(candidate: string, descendant: string): boolean {
  const base = normalize(candidate)
  const dir = normalize(descendant)
  if (dir === base) return true
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`
  return dir.startsWith(prefix)
}

function isVolumeRoot(target: string): boolean {
  try {
    const root = path.parse(target).root
    return root.length > 0 && normalize(root) === normalize(target)
  } catch {
    return false
  }
}

/** How many direct subdirectories of `root` are git repositories (capped scan). */
function countGitRepositories(root: string): number {
  try {
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .slice(0, MAX_SCAN_ENTRIES)
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    let repos = 0
    for (const entry of entries) {
      if (repos >= CONTAINER_REPO_THRESHOLD) break
      if (entry.name.startsWith(".")) continue
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue
      if (fs.existsSync(path.join(root, entry.name, ".git"))) repos++
    }
    return repos
  } catch {
    // Unreadable directory: no evidence of a container, so no warning.
    return 0
  }
}
