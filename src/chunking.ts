import { chunkFileContent } from "./chunker.ts"
import type { Chunk } from "./types.ts"

/**
 * Chunking dispatcher.
 *
 * Prefers tree-sitter AST chunking (parity with Kilo Code) and falls back to
 * the line-based chunker when the parser/WASM is unavailable or the language
 * has no grammar. The fallback is also used for formats Kilo marks as
 * fallback-only (yaml, sql, sh, ...), matching Kilo's behavior.
 *
 * The treesitter module is imported lazily so the plugin keeps working when
 * the optional WASM packages are not installed.
 */

type TreeSitterModule = {
  parseFileTreeSitter: (filePath: string, content: string, fileHash: string) => Promise<Chunk[]>
  isTreeSitterExtension: (ext: string) => boolean
}

let treesitter: TreeSitterModule | null | undefined

async function loadTreeSitter(): Promise<TreeSitterModule | null> {
  if (treesitter !== undefined) return treesitter
  try {
    const mod = (await import("./treesitter/parser.ts")) as TreeSitterModule
    treesitter = mod
  } catch {
    treesitter = null
  }
  return treesitter
}

/** Extensions where Kilo intentionally uses line fallback instead of AST chunking. */
const FALLBACK_EXTENSIONS = new Set([
  ".bash",
  ".bazel",
  ".bzl",
  ".build",
  ".gradle",
  ".ninja",
  ".sh",
  ".zsh",
  ".dart",
  ".elm",
  ".m",
  ".mm",
  ".ql",
  ".r",
  ".res",
  ".resi",
  ".sql",
  ".vb",
  ".yaml",
  ".yml",
  ".rst",
  ".scala",
  ".swift",
])

export async function chunkFile(filePath: string, content: string, fileHash: string): Promise<Chunk[]> {
  const lower = filePath.toLowerCase()
  const dot = lower.lastIndexOf(".")
  const ext = dot >= 0 ? lower.slice(dot) : ""

  const module = await loadTreeSitter()
  if (module && ext && !FALLBACK_EXTENSIONS.has(ext) && module.isTreeSitterExtension(ext)) {
    try {
      const chunks = await module.parseFileTreeSitter(filePath, content, fileHash)
      if (chunks.length > 0) return chunks
      // Empty AST result for a non-empty file: use the line fallback rather
      // than returning nothing (Kilo does the same when captures are empty).
      if (content.length > 0 && content.trim().length >= 50) {
        return chunkFileContent(filePath, content, fileHash)
      }
      return chunks
    } catch {
      // Parser failure: fall through to the line chunker.
    }
  }
  return chunkFileContent(filePath, content, fileHash)
}
