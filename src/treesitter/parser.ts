// Ported from Kilo Code (github.com/Kilo-Org/kilocode, MIT License). Copyright (c) 2026 Kilo Code.
//
// tree-sitter based chunking, ported from Kilo Code's
// `packages/kilo-indexing/src/tree-sitter/languageParser.ts` and
// `packages/kilo-indexing/src/indexing/processors/parser.ts`
// (`parseContent`, `_chunkTextByLines`, `_chunkLeafNodeByLines`,
// `processMarkdownSection`, `parseMarkdownContent`).
//
// Chunks use the exact same `segmentHash` inputs as Kilo:
//   AST node:            sha256(`${filePath}-${startLine}-${endLine}-${content.length}-${content.slice(0, 100)}`)
//   line chunks:         same, over the joined line range
//   oversized segments:  sha256(`${filePath}-${line}-${line}-${startCharIndex}-${length}-${preview}`)
//
// Parser/WASM loading is fully defensive: any missing optional package,
// missing grammar file, ABI mismatch or query compile error falls back to
// line-based chunking instead of throwing.

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import * as path from "node:path"

import type { Language, Node as SyntaxNode, Parser, Query, QueryCapture } from "web-tree-sitter"

import {
  MAX_BLOCK_CHARS,
  MAX_CHARS_TOLERANCE_FACTOR,
  MIN_BLOCK_CHARS,
  MIN_CHUNK_REMAINDER_CHARS,
  sha256Hex,
} from "../chunker.ts"
import type { Chunk } from "../types.ts"
import { parseMarkdown } from "./markdown.ts"
import * as querySources from "./queries.ts"

/** Options accepted by {@link parseFileFromDisk}. */
export interface TreeSitterChunkOptions {
  /** File content; when omitted the file is read from disk. */
  content?: string
  /** Pre-computed file hash; when omitted it is derived from the content. */
  fileHash?: string
}

/** Markdown never uses a tree-sitter grammar: Kilo parses it heuristically. */
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".markdown"])

/** All query source strings, keyed by their Kilo export name. */
type QueryKey =
  | "javascript"
  | "typescript"
  | "tsx"
  | "python"
  | "rust"
  | "go"
  | "cpp"
  | "c"
  | "c_sharp"
  | "ruby"
  | "java"
  | "php"
  | "html"
  | "swift"
  | "kotlin"
  | "css"
  | "ocaml"
  | "solidity"
  | "toml"
  | "vue"
  | "lua"
  | "systemrdl"
  | "tlaplus"
  | "zig"
  | "embedded_template"
  | "elisp"
  | "elixir"
  | "scala"

const QUERY_SOURCE: Readonly<Record<QueryKey, string>> = {
  javascript: querySources.javascriptQuery,
  typescript: querySources.typescriptQuery,
  tsx: querySources.tsxQuery,
  python: querySources.pythonQuery,
  rust: querySources.rustQuery,
  go: querySources.goQuery,
  cpp: querySources.cppQuery,
  c: querySources.cQuery,
  c_sharp: querySources.csharpQuery,
  ruby: querySources.rubyQuery,
  java: querySources.javaQuery,
  php: querySources.phpQuery,
  html: querySources.htmlQuery,
  swift: querySources.swiftQuery,
  kotlin: querySources.kotlinQuery,
  css: querySources.cssQuery,
  ocaml: querySources.ocamlQuery,
  solidity: querySources.solidityQuery,
  toml: querySources.tomlQuery,
  vue: querySources.vueQuery,
  lua: querySources.luaQuery,
  systemrdl: querySources.systemrdlQuery,
  tlaplus: querySources.tlaPlusQuery,
  zig: querySources.zigQuery,
  embedded_template: querySources.embeddedTemplateQuery,
  elisp: querySources.elispQuery,
  elixir: querySources.elixirQuery,
  scala: querySources.scalaQuery,
}

interface LanguageBinding {
  /** WASM file name suffix: `tree-sitter-<wasmName>.wasm`. */
  wasmName: string
  query: QueryKey
}

/**
 * Extension (with dot) -> grammar + query mapping, mirrored from Kilo's
 * `loadRequiredLanguageParsers` switch.
 *
 * Divergence from Kilo: Kilo maps `.scala` to the Lua query ("COMPAT: Uses
 * Lua query until Scala is implemented"); since the official Scala query is
 * available in `queries/`, this module uses `scalaQuery` instead.
 */
const EXTENSION_LANGUAGE: ReadonlyMap<string, LanguageBinding> = new Map([
  [".js", { wasmName: "javascript", query: "javascript" }],
  [".jsx", { wasmName: "javascript", query: "javascript" }],
  [".json", { wasmName: "javascript", query: "javascript" }],
  [".ts", { wasmName: "typescript", query: "typescript" }],
  [".tsx", { wasmName: "tsx", query: "tsx" }],
  [".py", { wasmName: "python", query: "python" }],
  [".rs", { wasmName: "rust", query: "rust" }],
  [".go", { wasmName: "go", query: "go" }],
  [".cpp", { wasmName: "cpp", query: "cpp" }],
  [".hpp", { wasmName: "cpp", query: "cpp" }],
  [".c", { wasmName: "c", query: "c" }],
  [".h", { wasmName: "c", query: "c" }],
  [".cs", { wasmName: "c_sharp", query: "c_sharp" }],
  [".rb", { wasmName: "ruby", query: "ruby" }],
  [".java", { wasmName: "java", query: "java" }],
  [".php", { wasmName: "php", query: "php" }],
  [".html", { wasmName: "html", query: "html" }],
  [".htm", { wasmName: "html", query: "html" }],
  [".swift", { wasmName: "swift", query: "swift" }],
  [".kt", { wasmName: "kotlin", query: "kotlin" }],
  [".kts", { wasmName: "kotlin", query: "kotlin" }],
  [".css", { wasmName: "css", query: "css" }],
  [".ml", { wasmName: "ocaml", query: "ocaml" }],
  [".mli", { wasmName: "ocaml", query: "ocaml" }],
  [".sol", { wasmName: "solidity", query: "solidity" }],
  [".toml", { wasmName: "toml", query: "toml" }],
  [".vue", { wasmName: "vue", query: "vue" }],
  [".lua", { wasmName: "lua", query: "lua" }],
  [".rdl", { wasmName: "systemrdl", query: "systemrdl" }],
  [".tla", { wasmName: "tlaplus", query: "tlaplus" }],
  [".zig", { wasmName: "zig", query: "zig" }],
  [".ejs", { wasmName: "embedded_template", query: "embedded_template" }],
  [".erb", { wasmName: "embedded_template", query: "embedded_template" }],
  [".el", { wasmName: "elisp", query: "elisp" }],
  [".ex", { wasmName: "elixir", query: "elixir" }],
  [".exs", { wasmName: "elixir", query: "elixir" }],
  [".scala", { wasmName: "scala", query: "scala" }],
])

const requireFromHere = createRequire(import.meta.url)

/**
 * Directory holding the `tree-sitter-wasms` grammars.
 *
 * `KILO_TREE_SITTER_WASM_DIR` overrides the package location (same env var
 * Kilo Code honors). When the optional package cannot be resolved at all a
 * best-effort `node_modules` path is returned; callers must check for the
 * individual files before loading them.
 */
export function wasmDirectory(): string {
  const envDir = process.env.KILO_TREE_SITTER_WASM_DIR
  if (envDir !== undefined && envDir.trim().length > 0) {
    return envDir
  }
  try {
    const packageJsonPath = requireFromHere.resolve("tree-sitter-wasms/package.json")
    return path.join(path.dirname(packageJsonPath), "out")
  } catch {
    return path.resolve(process.cwd(), "node_modules", "tree-sitter-wasms", "out")
  }
}

/** Path of the web-tree-sitter runtime WASM, or undefined when unresolvable. */
function resolveRuntimeWasmPath(): string | undefined {
  const envDir = process.env.KILO_TREE_SITTER_WASM_DIR
  if (envDir !== undefined && envDir.trim().length > 0) {
    const candidate = path.join(envDir, "tree-sitter.wasm")
    if (existsSync(candidate)) {
      return candidate
    }
  }
  try {
    return requireFromHere.resolve("web-tree-sitter/tree-sitter.wasm")
  } catch {
    return undefined
  }
}

type WebTreeSitterModule = typeof import("web-tree-sitter")

let webTreeSitterPromise: Promise<WebTreeSitterModule | null> | null = null

function loadWebTreeSitter(): Promise<WebTreeSitterModule | null> {
  webTreeSitterPromise ??= (async () => {
    try {
      return (await import("web-tree-sitter")) as WebTreeSitterModule
    } catch {
      try {
        return requireFromHere("web-tree-sitter") as WebTreeSitterModule
      } catch {
        return null
      }
    }
  })()
  return webTreeSitterPromise
}

interface LoadedLanguage {
  parser: Parser
  query: Query
}

const loadedLanguages = new Map<string, LoadedLanguage>()
const pendingLanguages = new Map<string, Promise<LoadedLanguage | null>>()
const failedLanguages = new Set<string>()

let parserInitPromise: Promise<boolean> | null = null
let parserInitialized = false

function ensureParserRuntime(): Promise<boolean> {
  parserInitPromise ??= (async () => {
    const module = await loadWebTreeSitter()
    if (!module) {
      return false
    }
    try {
      const runtimeWasmPath = resolveRuntimeWasmPath()
      if (runtimeWasmPath) {
        await module.Parser.init({ locateFile: () => runtimeWasmPath })
      } else {
        await module.Parser.init()
      }
      parserInitialized = true
      return true
    } catch {
      return false
    }
  })()
  return parserInitPromise
}

/**
 * Load (once) the grammar + compiled query for a file extension.
 * Returns null when the grammar/query cannot be made available, in which case
 * the caller falls back to line chunking.
 */
function getLanguageForExtension(ext: string): Promise<LoadedLanguage | null> {
  const cached = loadedLanguages.get(ext)
  if (cached !== undefined) {
    return Promise.resolve(cached)
  }
  if (failedLanguages.has(ext)) {
    return Promise.resolve(null)
  }
  const pending = pendingLanguages.get(ext)
  if (pending !== undefined) {
    return pending
  }

  const loading = (async (): Promise<LoadedLanguage | null> => {
    const binding = EXTENSION_LANGUAGE.get(ext)
    if (!binding) {
      failedLanguages.add(ext)
      return null
    }
    if (!(await ensureParserRuntime())) {
      failedLanguages.add(ext)
      return null
    }
    const module = await loadWebTreeSitter()
    if (!module) {
      failedLanguages.add(ext)
      return null
    }
    try {
      const wasmPath = path.join(wasmDirectory(), `tree-sitter-${binding.wasmName}.wasm`)
      if (!existsSync(wasmPath)) {
        failedLanguages.add(ext)
        return null
      }
      const language: Language = await module.Language.load(wasmPath)
      const query = new module.Query(language, QUERY_SOURCE[binding.query])
      const parser = new module.Parser()
      parser.setLanguage(language)
      const loaded: LoadedLanguage = { parser, query }
      loadedLanguages.set(ext, loaded)
      return loaded
    } catch {
      failedLanguages.add(ext)
      return null
    } finally {
      pendingLanguages.delete(ext)
    }
  })()

  pendingLanguages.set(ext, loading)
  return loading
}

/**
 * True when the extension (with or without leading dot) is handled by the
 * tree-sitter path or by the markdown section parser.
 */
export function isTreeSitterExtension(ext: string): boolean {
  const normalized = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`
  return EXTENSION_LANGUAGE.has(normalized) || MARKDOWN_EXTENSIONS.has(normalized)
}

/** Release cached parsers/queries (tests only). */
export async function resetParserForTests(): Promise<void> {
  for (const loaded of loadedLanguages.values()) {
    try {
      loaded.parser.delete()
    } catch {
      // Best effort: the parser may already have been freed.
    }
    try {
      loaded.query.delete()
    } catch {
      // Best effort: the query may already have been freed.
    }
  }
  loadedLanguages.clear()
  pendingLanguages.clear()
  failedLanguages.clear()
  if (!parserInitialized) {
    // Allow a retry after a failed initialization (e.g. a bad env override).
    parserInitPromise = null
  }
}

/**
 * Parse a file into chunks (AST-aware, with markdown support and line
 * fallback). Never throws for parser issues; falls back to line chunking.
 */
export async function parseFileTreeSitter(filePath: string, content: string, fileHash: string): Promise<Chunk[]> {
  const ext = path.extname(filePath).toLowerCase()
  if (!isTreeSitterExtension(ext)) {
    return []
  }
  if (content.length === 0) {
    return []
  }

  const seenSegmentHashes = new Set<string>()

  // Markdown files are handled by the heuristic section parser (no grammar).
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return parseMarkdownContent(filePath, content, fileHash, seenSegmentHashes)
  }

  const loaded = await getLanguageForExtension(ext)
  if (!loaded) {
    return fallbackChunks(filePath, content, fileHash, seenSegmentHashes)
  }

  try {
    const tree = loaded.parser.parse(content)
    const captures: QueryCapture[] = tree ? loaded.query.captures(tree.rootNode) : []

    if (captures.length === 0) {
      // Mirror Kilo: empty captures fall back to line chunking for large files.
      if (content.length >= MIN_BLOCK_CHARS) {
        return fallbackChunks(filePath, content, fileHash, seenSegmentHashes)
      }
      return []
    }

    return processCaptures(captures, filePath, fileHash, seenSegmentHashes)
  } catch {
    return fallbackChunks(filePath, content, fileHash, seenSegmentHashes)
  }
}

/** Convenience: reads the file from disk if content is not provided. */
export async function parseFileFromDisk(filePath: string, options?: TreeSitterChunkOptions): Promise<Chunk[]> {
  let content = options?.content
  if (content === undefined) {
    try {
      content = await readFile(filePath, "utf8")
    } catch {
      return []
    }
  }
  const fileHash = options?.fileHash !== undefined ? options.fileHash : sha256Hex(content)
  return parseFileTreeSitter(filePath, content, fileHash)
}

// ---------------------------------------------------------------------------
// AST capture processing (ported from Kilo's `CodeParser.parseContent`)
// ---------------------------------------------------------------------------

function processCaptures(
  captures: QueryCapture[],
  filePath: string,
  fileHash: string,
  seenSegmentHashes: Set<string>,
): Chunk[] {
  const results: Chunk[] = []
  const queue: SyntaxNode[] = captures.map((capture) => capture.node)

  while (queue.length > 0) {
    const currentNode = queue.shift() as SyntaxNode
    const nodeText = currentNode.text
    if (nodeText.length < MIN_BLOCK_CHARS) {
      // Nodes smaller than minBlockChars are ignored.
      continue
    }

    if (nodeText.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR) {
      const children = currentNode.children.filter((child): child is SyntaxNode => child !== null)
      if (children.length > 0) {
        // Too large for one chunk: process its children instead.
        queue.push(...children)
      } else {
        // Leaf node: chunk its text by lines (oversized lines become segments).
        results.push(...chunkLeafNodeByLines(currentNode, filePath, fileHash, seenSegmentHashes))
      }
      continue
    }

    const startLine = currentNode.startPosition.row + 1
    const endLine = currentNode.endPosition.row + 1
    const contentPreview = nodeText.slice(0, 100)
    const segmentHash = sha256Hex(`${filePath}-${startLine}-${endLine}-${nodeText.length}-${contentPreview}`)

    if (!seenSegmentHashes.has(segmentHash)) {
      seenSegmentHashes.add(segmentHash)
      results.push({
        filePath,
        content: nodeText,
        startLine,
        endLine,
        type: currentNode.type,
        segmentHash,
        fileHash,
      })
    }
  }

  return results
}

/** Chunk a single (oversized, childless) AST node by its lines. */
function chunkLeafNodeByLines(
  node: SyntaxNode,
  filePath: string,
  fileHash: string,
  seenSegmentHashes: Set<string>,
): Chunk[] {
  const lines = node.text.split("\n")
  const baseStartLine = node.startPosition.row + 1
  return chunkTextByLines(lines, filePath, fileHash, node.type, seenSegmentHashes, baseStartLine)
}

/** Whole-file fallback chunking (Kilo: `_performFallbackChunking`). */
function fallbackChunks(filePath: string, content: string, fileHash: string, seenSegmentHashes: Set<string>): Chunk[] {
  if (content.length === 0) {
    return []
  }
  const lines = content.split("\n")
  return chunkTextByLines(lines, filePath, fileHash, "fallback_chunk", seenSegmentHashes)
}

/**
 * Common helper to chunk text by lines, avoiding tiny remainders. Exact port
 * of Kilo's `_chunkTextByLines` (also the base of `chunkFileContent` in
 * `../chunker.ts`), additionally parameterized by chunk type and the 1-based
 * start line of the first line in `lines`.
 */
function chunkTextByLines(
  lines: string[],
  filePath: string,
  fileHash: string,
  chunkType: string,
  seenSegmentHashes: Set<string>,
  baseStartLine = 1,
): Chunk[] {
  const chunks: Chunk[] = []
  let currentChunkLines: string[] = []
  let currentChunkLength = 0
  let chunkStartLineIndex = 0 // 0-based index within the `lines` array
  const effectiveMaxChars = MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR

  const finalizeChunk = (endLineIndex: number) => {
    if (currentChunkLength >= MIN_BLOCK_CHARS && currentChunkLines.length > 0) {
      const chunkContent = currentChunkLines.join("\n")
      const startLine = baseStartLine + chunkStartLineIndex
      const endLine = baseStartLine + endLineIndex
      const contentPreview = chunkContent.slice(0, 100)
      const segmentHash = sha256Hex(`${filePath}-${startLine}-${endLine}-${chunkContent.length}-${contentPreview}`)

      if (!seenSegmentHashes.has(segmentHash)) {
        seenSegmentHashes.add(segmentHash)
        chunks.push({ filePath, content: chunkContent, startLine, endLine, type: chunkType, segmentHash, fileHash })
      }
    }
    currentChunkLines = []
    currentChunkLength = 0
    chunkStartLineIndex = endLineIndex + 1
  }

  const createSegmentBlock = (segment: string, originalLineNumber: number, startCharIndex: number) => {
    const segmentPreview = segment.slice(0, 100)
    const segmentHash = sha256Hex(
      `${filePath}-${originalLineNumber}-${originalLineNumber}-${startCharIndex}-${segment.length}-${segmentPreview}`,
    )

    if (!seenSegmentHashes.has(segmentHash)) {
      seenSegmentHashes.add(segmentHash)
      chunks.push({
        filePath,
        content: segment,
        startLine: originalLineNumber,
        endLine: originalLineNumber,
        type: `${chunkType}_segment`,
        segmentHash,
        fileHash,
      })
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineLength = line.length + (i < lines.length - 1 ? 1 : 0) // +1 for newline, except last line
    const originalLineNumber = baseStartLine + i

    // Handle oversized lines (longer than effectiveMaxChars)
    if (lineLength > effectiveMaxChars) {
      // Finalize any existing normal chunk before processing the oversized line
      if (currentChunkLines.length > 0) {
        finalizeChunk(i - 1)
      }

      // Split the oversized line into segments
      let remainingLineContent = line
      let currentSegmentStartChar = 0
      while (remainingLineContent.length > 0) {
        const segment = remainingLineContent.substring(0, MAX_BLOCK_CHARS)
        remainingLineContent = remainingLineContent.substring(MAX_BLOCK_CHARS)
        createSegmentBlock(segment, originalLineNumber, currentSegmentStartChar)
        currentSegmentStartChar += MAX_BLOCK_CHARS
      }
      // Update chunkStartLineIndex to continue processing from the next line
      chunkStartLineIndex = i + 1
      continue
    }

    // Handle normally sized lines
    if (currentChunkLength > 0 && currentChunkLength + lineLength > effectiveMaxChars) {
      // Re-balancing logic
      let splitIndex = i - 1
      let remainderLength = 0
      for (let j = i; j < lines.length; j++) {
        remainderLength += lines[j].length + (j < lines.length - 1 ? 1 : 0)
      }

      if (
        currentChunkLength >= MIN_BLOCK_CHARS &&
        remainderLength < MIN_CHUNK_REMAINDER_CHARS &&
        currentChunkLines.length > 1
      ) {
        for (let k = i - 2; k >= chunkStartLineIndex; k--) {
          const potentialChunkLines = lines.slice(chunkStartLineIndex, k + 1)
          const potentialChunkLength = potentialChunkLines.join("\n").length + 1
          const potentialNextChunkLines = lines.slice(k + 1)
          const potentialNextChunkLength = potentialNextChunkLines.join("\n").length + 1

          if (potentialChunkLength >= MIN_BLOCK_CHARS && potentialNextChunkLength >= MIN_CHUNK_REMAINDER_CHARS) {
            splitIndex = k
            break
          }
        }
      }

      finalizeChunk(splitIndex)

      if (i >= chunkStartLineIndex) {
        currentChunkLines.push(line)
        currentChunkLength += lineLength
      } else {
        i = chunkStartLineIndex - 1
        continue
      }
    } else {
      currentChunkLines.push(line)
      currentChunkLength += lineLength
    }
  }

  // Process the last remaining chunk
  if (currentChunkLines.length > 0) {
    finalizeChunk(lines.length - 1)
  }

  return chunks
}

// ---------------------------------------------------------------------------
// Markdown chunking (ported from Kilo's `parseMarkdownContent` /
// `processMarkdownSection`)
// ---------------------------------------------------------------------------

function parseMarkdownContent(
  filePath: string,
  content: string,
  fileHash: string,
  seenSegmentHashes: Set<string>,
): Chunk[] {
  const lines = content.split("\n")
  const markdownCaptures = parseMarkdown(content)

  if (markdownCaptures.length === 0) {
    // No headers found: process the entire content as one markdown section.
    return processMarkdownSection(lines, filePath, fileHash, "markdown_content", seenSegmentHashes, 1)
  }

  const results: Chunk[] = []
  let lastProcessedLine = 0

  // Process content before the first header.
  const firstHeaderLine = markdownCaptures[0].node.startPosition.row
  if (firstHeaderLine > 0) {
    const preHeaderLines = lines.slice(0, firstHeaderLine)
    results.push(...processMarkdownSection(preHeaderLines, filePath, fileHash, "markdown_content", seenSegmentHashes, 1))
  }

  // Process markdown captures (header name + section definition pairs).
  for (let i = 0; i < markdownCaptures.length; i += 2) {
    const nameCapture = markdownCaptures[i]
    if (i + 1 >= markdownCaptures.length) break
    const definitionCapture = markdownCaptures[i + 1]
    if (!definitionCapture) continue

    const startLine = definitionCapture.node.startPosition.row + 1
    const endLine = definitionCapture.node.endPosition.row + 1
    const sectionLines = lines.slice(startLine - 1, endLine)

    // Extract header level for type classification.
    const headerMatch = nameCapture.name.match(/\.h(\d)$/)
    const headerLevel = headerMatch ? parseInt(headerMatch[1]) : 1

    results.push(
      ...processMarkdownSection(
        sectionLines,
        filePath,
        fileHash,
        `markdown_header_h${headerLevel}`,
        seenSegmentHashes,
        startLine,
      ),
    )

    lastProcessedLine = endLine
  }

  // Process any remaining content after the last header section.
  if (lastProcessedLine < lines.length) {
    const remainingLines = lines.slice(lastProcessedLine)
    results.push(
      ...processMarkdownSection(
        remainingLines,
        filePath,
        fileHash,
        "markdown_content",
        seenSegmentHashes,
        lastProcessedLine + 1,
      ),
    )
  }

  return results
}

function processMarkdownSection(
  lines: string[],
  filePath: string,
  fileHash: string,
  type: string,
  seenSegmentHashes: Set<string>,
  startLine: number,
): Chunk[] {
  const content = lines.join("\n")

  if (content.trim().length < MIN_BLOCK_CHARS) {
    return []
  }

  // Chunk when the section is large or contains an oversized single line.
  const needsChunking =
    content.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR ||
    lines.some((line) => line.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR)

  if (needsChunking) {
    return chunkTextByLines(lines, filePath, fileHash, type, seenSegmentHashes, startLine)
  }

  const endLine = startLine + lines.length - 1
  const contentPreview = content.slice(0, 100)
  const segmentHash = sha256Hex(`${filePath}-${startLine}-${endLine}-${content.length}-${contentPreview}`)

  if (!seenSegmentHashes.has(segmentHash)) {
    seenSegmentHashes.add(segmentHash)
    return [{ filePath, content, startLine, endLine, type, segmentHash, fileHash }]
  }

  return []
}
