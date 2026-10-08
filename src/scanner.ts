/**
 * Workspace scanner.
 *
 * Recursively walks a workspace and returns the indexable regular files:
 * symlinks are never followed, ignored directories/patterns are skipped, and
 * files can be restricted by an extension allowlist and a size limit.
 *
 * Ignore rules: the npm `ignore` package is used when it can be dynamically
 * imported at runtime; otherwise a small built-in matcher takes over. The
 * built-in matcher is deliberately best-effort and supports plain names
 * ("node_modules"), directory patterns ("build/"), simple globs
 * ("*.log", "**\/temp", "?", "[abc]") and leading "!" negation. It does not
 * implement every corner of the gitignore specification (escaped characters,
 * negative character classes edge cases, ...) but it never throws on malformed
 * input.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import * as path from "node:path"

import type { Dirent, Stats } from "node:fs"
import type { FileEntry, ScanOptions, ScanResult } from "./types.ts"

export const DEFAULT_IGNORED_DIRS: readonly string[] = [
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
]

export const DEFAULT_IGNORE_GLOBS: readonly string[] = [
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.lock",
  "package-lock.json",
  "*.log",
  "*.snap",
  "*.generated.*",
]

const DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024

/** Dot-directories that are still walked because they hold indexable config. */
const ALLOWED_DOT_DIRS: ReadonlySet<string> = new Set([
  ".github",
  ".vscode",
  ".gitlab",
  ".devcontainer",
])

const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set(
  DEFAULT_IGNORED_DIRS.map((name) => name.toLowerCase()),
)

/**
 * Binary/media extensions that are never indexed, even when no extension
 * allowlist is configured. This keeps images, archives, media and other
 * non-text assets out of the index without forcing callers to pass a list.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".avif",
  ".bmp",
  ".class",
  ".db",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".flac",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".ogg",
  ".otf",
  ".parquet",
  ".pdf",
  ".png",
  ".pyc",
  ".pyo",
  ".rar",
  ".so",
  ".sqlite",
  ".tar",
  ".tiff",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
])

/** Matcher abstraction shared by the real `ignore` package and the fallback. */
interface IgnoreChecker {
  /** `relPosix` is relative to the scan root and uses forward slashes. */
  ignores(relPosix: string, isDir: boolean): boolean
}

interface RawIgnorePattern {
  regex: RegExp
  negation: boolean
  dirOnly: boolean
}

function escapeRegExpCharacter(character: string): string {
  return /[.*+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character
}

/** Convert a gitignore-style glob (a single path segment chain) to regex source. */
function globToRegExpSource(glob: string): string {
  let source = ""
  let index = 0
  while (index < glob.length) {
    const character = glob[index]
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 2
        if (glob[index] === "/") {
          index += 1
          source += "(?:.*/)?"
        } else {
          source += ".*"
        }
        continue
      }
      source += "[^/]*"
    } else if (character === "?") {
      source += "[^/]"
    } else if (character === "[") {
      const end = glob.indexOf("]", index + 1)
      if (end === -1) {
        source += "\\["
      } else {
        let characterClass = glob.slice(index + 1, end)
        if (characterClass.startsWith("!")) {
          characterClass = `^${characterClass.slice(1)}`
        }
        source += `[${characterClass}]`
        index = end
      }
    } else {
      source += escapeRegExpCharacter(character)
    }
    index += 1
  }
  return source
}

function parseIgnorePattern(line: string): RawIgnorePattern | null {
  let pattern = line.trim()
  if (pattern.length === 0 || pattern.startsWith("#")) {
    return null
  }
  let negation = false
  if (pattern.startsWith("!")) {
    negation = true
    pattern = pattern.slice(1)
  }
  let dirOnly = false
  if (pattern.endsWith("/")) {
    dirOnly = true
    pattern = pattern.replace(/\/+$/, "")
  }
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1)
  }
  if (pattern.length === 0) {
    return null
  }
  // A pattern containing a slash is anchored to the scan root; otherwise it
  // matches the basename at any depth (standard gitignore semantics).
  const anchored = pattern.includes("/")
  const prefix = anchored ? "^" : "^(?:.*/)?"
  let regex: RegExp
  try {
    regex = new RegExp(`${prefix}${globToRegExpSource(pattern)}$`)
  } catch {
    // Malformed glob: ignore the pattern instead of crashing the scan.
    return null
  }
  return { regex, negation, dirOnly }
}

/**
 * Best-effort fallback used when the optional `ignore` package is unavailable.
 * Patterns are evaluated in order and the last match wins; an ignored ancestor
 * directory makes every descendant ignored (git never re-includes a file whose
 * parent directory is excluded).
 */
class FallbackIgnoreMatcher implements IgnoreChecker {
  readonly #patterns: RawIgnorePattern[]

  constructor(patterns: readonly string[]) {
    this.#patterns = []
    for (const line of patterns) {
      const parsed = parseIgnorePattern(line)
      if (parsed !== null) {
        this.#patterns.push(parsed)
      }
    }
  }

  #matches(relPosix: string, isDir: boolean): boolean {
    let ignored = false
    for (const pattern of this.#patterns) {
      if (pattern.dirOnly && !isDir) {
        continue
      }
      if (pattern.regex.test(relPosix)) {
        ignored = !pattern.negation
      }
    }
    return ignored
  }

  ignores(relPosix: string, isDir: boolean): boolean {
    const segments = relPosix.split("/")
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const candidate = segments.slice(0, depth).join("/")
      const candidateIsDir = depth < segments.length || isDir
      if (this.#matches(candidate, candidateIsDir)) {
        return true
      }
    }
    return false
  }
}

interface IgnorePackageInstance {
  ignores(relPosix: string): boolean
}

interface IgnorePackageFactory {
  (): {
    add(patterns: readonly string[]): IgnorePackageInstance
  }
}

function createPackageChecker(
  factory: IgnorePackageFactory,
  patterns: readonly string[],
): IgnoreChecker | null {
  try {
    const instance = factory().add([...patterns])
    return {
      ignores(relPosix: string, isDir: boolean): boolean {
        try {
          // Directory checks pass a trailing slash so "dir/" patterns match.
          if (isDir && instance.ignores(`${relPosix}/`)) {
            return true
          }
        } catch {
          // Fall through to the plain path below.
        }
        try {
          return instance.ignores(relPosix)
        } catch {
          return false
        }
      },
    }
  } catch {
    return null
  }
}

async function tryLoadIgnorePackage(): Promise<IgnorePackageFactory | null> {
  try {
    // A non-literal specifier keeps this optional dependency out of the
    // TypeScript module-resolution graph (it may not be installed at all).
    const specifier: string = "ignore"
    const loaded: unknown = await import(specifier)
    const candidates: unknown[] = [
      (loaded as { default?: unknown } | null)?.default,
      (loaded as { ignore?: unknown } | null)?.ignore,
      loaded,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === "function") {
        return candidate as IgnorePackageFactory
      }
    }
    return null
  } catch {
    return null
  }
}

async function collectIgnorePatterns(root: string, options: ScanOptions): Promise<string[]> {
  const patterns: string[] = [...DEFAULT_IGNORE_GLOBS]
  for (const fileName of [".gitignore", ".kilocodeignore"]) {
    try {
      const content = await readFile(path.join(root, fileName), "utf8")
      for (const line of content.split(/\r?\n/)) {
        patterns.push(line)
      }
    } catch {
      // Missing or unreadable ignore files are fine.
    }
  }
  if (options.ignoreGlobs !== undefined) {
    patterns.push(...options.ignoreGlobs)
  }
  return patterns
}

async function createIgnoreChecker(root: string, options: ScanOptions): Promise<IgnoreChecker> {
  const patterns = await collectIgnorePatterns(root, options)
  const factory = await tryLoadIgnorePackage()
  if (factory !== null) {
    const checker = createPackageChecker(factory, patterns)
    if (checker !== null) {
      return checker
    }
  }
  return new FallbackIgnoreMatcher(patterns)
}

function toPosixPath(relPathNative: string): string {
  return path.sep === "/" ? relPathNative : relPathNative.replaceAll(path.sep, "/")
}

interface ScanState {
  readonly files: FileEntry[]
  readonly checker: IgnoreChecker
  readonly extensions: ReadonlySet<string> | null
  readonly maxFileSizeBytes: number
  readonly maxFiles: number
  skippedTooLarge: number
  skippedIgnored: number
  truncated: boolean
  done: boolean
}

function shouldSkipDirectory(name: string, relNative: string, checker: IgnoreChecker): boolean {
  const lowerName = name.toLowerCase()
  if (IGNORED_DIR_NAMES.has(lowerName)) {
    return true
  }
  if (name.startsWith(".") && !ALLOWED_DOT_DIRS.has(lowerName)) {
    return true
  }
  return checker.ignores(toPosixPath(relNative), true)
}

async function collectFile(
  directoryAbs: string,
  name: string,
  relNative: string,
  state: ScanState,
): Promise<void> {
  const absPath = path.resolve(directoryAbs, name)
  let stats: Stats
  try {
    stats = await stat(absPath)
  } catch {
    return
  }
  if (!stats.isFile() || stats.size === 0) {
    return
  }
  if (state.checker.ignores(toPosixPath(relNative), false)) {
    state.skippedIgnored += 1
    return
  }
  const extension = path.extname(name).toLowerCase()
  if (state.extensions !== null) {
    if (!state.extensions.has(extension)) {
      return
    }
  } else if (BINARY_EXTENSIONS.has(extension)) {
    return
  }
  if (stats.size > state.maxFileSizeBytes) {
    state.skippedTooLarge += 1
    return
  }
  state.files.push({
    absPath,
    relPath: relNative,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  })
  if (state.maxFiles > 0 && state.files.length >= state.maxFiles) {
    state.truncated = true
    state.done = true
  }
}

async function walkDirectory(
  directoryAbs: string,
  directoryRel: string,
  state: ScanState,
): Promise<void> {
  if (state.done) {
    return
  }
  let entries: Dirent[]
  try {
    entries = await readdir(directoryAbs, { withFileTypes: true })
  } catch {
    // ENOENT / EACCES / ENOTDIR: skip silently.
    return
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    if (state.done) {
      return
    }
    const relNative = directoryRel.length === 0 ? entry.name : path.join(directoryRel, entry.name)
    if (entry.isSymbolicLink()) {
      continue
    }
    let isDirectory = entry.isDirectory()
    let isFile = entry.isFile()
    if (!isDirectory && !isFile) {
      // Some filesystems report UV_DIRENT_UNKNOWN; fall back to stat().
      try {
        const stats = await stat(path.resolve(directoryAbs, entry.name))
        isDirectory = stats.isDirectory()
        isFile = stats.isFile()
      } catch {
        continue
      }
    }
    if (isDirectory) {
      if (shouldSkipDirectory(entry.name, relNative, state.checker)) {
        state.skippedIgnored += 1
        continue
      }
      await walkDirectory(path.resolve(directoryAbs, entry.name), relNative, state)
      continue
    }
    if (isFile) {
      await collectFile(directoryAbs, entry.name, relNative, state)
    }
  }
}

function compareRelPaths(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

export async function scanWorkspace(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const absoluteRoot = path.resolve(root)
  const checker = await createIgnoreChecker(absoluteRoot, options)
  const extensionList = options.extensions
  const extensions =
    extensionList !== undefined && extensionList.length > 0
      ? new Set(extensionList.map((extension) => extension.toLowerCase()))
      : null
  const state: ScanState = {
    files: [],
    checker,
    extensions,
    maxFileSizeBytes: options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
    maxFiles: options.maxFiles !== undefined && options.maxFiles > 0 ? options.maxFiles : 0,
    skippedTooLarge: 0,
    skippedIgnored: 0,
    truncated: false,
    done: false,
  }
  await walkDirectory(absoluteRoot, "", state)
  state.files.sort((left, right) => compareRelPaths(left.relPath, right.relPath))
  return {
    files: state.files,
    skippedTooLarge: state.skippedTooLarge,
    skippedIgnored: state.skippedIgnored,
    truncated: state.truncated,
  }
}
