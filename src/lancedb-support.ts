import { settingsFilePath } from "./settings.ts"

/**
 * Which platforms the LanceDB binding can actually run on.
 *
 * `@lancedb/lancedb` is a JavaScript wrapper that `require()`s one of seven
 * per-platform native binaries, each published as its own optional dependency.
 * There is no WASM build, so a platform outside that list cannot use LanceDB at
 * all, and installing it again will not change that.
 *
 * macOS on Intel is the one that bites: `lancedb-darwin-x64` is not published,
 * so LanceDB works on Apple Silicon only. The list is here so the plugin can say
 * so plainly instead of surfacing a module-resolution stack trace; the import
 * itself stays the authority on whether the binary loaded.
 */

export const LANCEDB_VERSION = "0.26.2"

/** `platform-arch`, the way a native package would be named. */
export function platformId(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`
}

const SUPPORTED = new Set([
  "win32-x64",
  "win32-arm64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
])

export interface LanceDbSupport {
  /** `platform-arch` of the current process. */
  id: string
  /** Whether a native binary is published for it. */
  supported: boolean
}

export function lanceDbSupport(
  platform: string = process.platform,
  arch: string = process.arch,
): LanceDbSupport {
  const id = platformId(platform, arch)
  return { id, supported: SUPPORTED.has(id) }
}

/**
 * Node appends the resolution chain to a MODULE_NOT_FOUND message, which buries
 * the one line that says what went wrong under seven lines of internal files.
 * The cause is still there; it is just what a reader acts on that is kept.
 */
function causeSummary(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  const atRequireStack = message.indexOf("Require stack:")
  return (atRequireStack === -1 ? message : message.slice(0, atRequireStack)).trim()
}

/**
 * The message shown when LanceDB cannot be loaded.
 *
 * The two cases need different advice, so they get different words: a platform
 * with no binary cannot be fixed by installing anything, while a supported
 * platform that failed to load usually means the optional dependency was
 * skipped.
 */
export function lanceDbUnavailableMessage(
  cause: unknown,
  support: LanceDbSupport = lanceDbSupport(),
): string {
  const { id, supported } = support
  if (!supported) {
    return (
      `LanceDB is the default store for the own index but has no native binary for ${id}. ` +
      `It cannot run on this platform and reinstalling will not change that. ` +
      `Set vectorStore=qdrant explicitly in ${settingsFilePath()} to use a Qdrant server instead.`
    )
  }
  return (
    `LanceDB could not be loaded for ${id}. It ships as an optional dependency: ` +
    `install @lancedb/lancedb@${LANCEDB_VERSION}, or set vectorStore=qdrant. ` +
    `Cause: ${causeSummary(cause)}`
  )
}
