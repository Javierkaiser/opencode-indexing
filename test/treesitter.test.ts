import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { chunkFileContent } from "../src/chunker.ts"
import {
  isTreeSitterExtension,
  parseFileFromDisk,
  parseFileTreeSitter,
  resetParserForTests,
  wasmDirectory,
} from "../src/treesitter/parser.ts"
import type { Chunk } from "../src/types.ts"

const FILE_HASH = "f".repeat(64)

function cryptoHash(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

/** Kilo's AST/line chunk hash formula. */
function expectedSegmentHash(chunk: { filePath: string; startLine: number; endLine: number; content: string }): string {
  return cryptoHash(
    `${chunk.filePath}-${chunk.startLine}-${chunk.endLine}-${chunk.content.length}-${chunk.content.slice(0, 100)}`,
  )
}

const TS_SOURCE = [
  "export function add(a: number, b: number): number {",
  "  return a + b",
  "}",
  "",
  'export const greeting = "hello world, this is a fairly long string constant"',
  "",
  "export class Calculator {",
  "  value = 0",
  "",
  "  increment(): void {",
  "    this.value += 1",
  "  }",
  "}",
].join("\n")

const CSHARP_SOURCE = [
  "using System;",
  "",
  "public class Calculator",
  "{",
  "    public int Add(int a, int b)",
  "    {",
  "        return a + b;",
  "    }",
  "",
  "    public int Subtract(int a, int b)",
  "    {",
  "        return a - b;",
  "    }",
  "}",
].join("\n")

const PHP_SOURCE = [
  "<?php",
  "",
  "function calculateTotal(float $a, float $b): float",
  "{",
  "    return $a + $b;",
  "}",
].join("\n")

const MARKDOWN_SOURCE = [
  "# Title",
  "",
  "This is an introductory paragraph that is definitely longer than fifty characters in total.",
  "",
  "## Section",
  "",
  "Another paragraph below the second heading, also comfortably above the fifty character minimum.",
].join("\n")

/** Set by the TypeScript test; re-checked after a parser reset. */
let tsChunksFromFirstRun: Chunk[] | undefined

test("isTreeSitterExtension accepts supported extensions with and without a leading dot", () => {
  const supported = [
    ".js",
    ".jsx",
    ".json",
    ".ts",
    ".tsx",
    ".py",
    ".rs",
    ".go",
    ".cpp",
    ".hpp",
    ".c",
    ".h",
    ".cs",
    ".rb",
    ".java",
    ".php",
    ".html",
    ".htm",
    ".swift",
    ".kt",
    ".kts",
    ".css",
    ".ml",
    ".mli",
    ".sol",
    ".toml",
    ".vue",
    ".lua",
    ".rdl",
    ".tla",
    ".zig",
    ".ejs",
    ".erb",
    ".el",
    ".ex",
    ".exs",
    ".scala",
    ".md",
    ".markdown",
  ]
  for (const ext of supported) {
    assert.equal(isTreeSitterExtension(ext), true, `expected ${ext} to be supported`)
    assert.equal(isTreeSitterExtension(ext.slice(1)), true, `expected ${ext.slice(1)} (no dot) to be supported`)
    assert.equal(isTreeSitterExtension(ext.toUpperCase()), true, `expected ${ext.toUpperCase()} to be supported`)
  }

  // Scanner formats with no query wiring or intentionally disabled AST chunking.
  const unsupported = [
    ".txt",
    ".yaml",
    ".yml",
    ".sql",
    ".dart",
    ".elm",
    ".rst",
    ".vb",
    ".r",
    ".m",
    ".mm",
    ".ql",
    ".res",
    ".resi",
    ".bash",
    ".sh",
    ".zsh",
    ".gradle",
    ".unknown",
    "tsx.ts",
    "",
  ]
  for (const ext of unsupported) {
    assert.equal(isTreeSitterExtension(ext), false, `expected ${JSON.stringify(ext)} to be unsupported`)
  }
})

test("wasmDirectory resolves tree-sitter-wasms/out and honors KILO_TREE_SITTER_WASM_DIR", () => {
  const previous = process.env.KILO_TREE_SITTER_WASM_DIR
  try {
    delete process.env.KILO_TREE_SITTER_WASM_DIR
    const resolved = wasmDirectory()
    assert.ok(resolved.length > 0)
    assert.equal(path.basename(resolved), "out")
    assert.match(resolved.replaceAll("\\", "/"), /tree-sitter-wasms\/out$/)

    process.env.KILO_TREE_SITTER_WASM_DIR = path.join(os.tmpdir(), "custom-tree-sitter-wasms")
    assert.equal(wasmDirectory(), path.join(os.tmpdir(), "custom-tree-sitter-wasms"))
  } finally {
    if (previous === undefined) {
      delete process.env.KILO_TREE_SITTER_WASM_DIR
    } else {
      process.env.KILO_TREE_SITTER_WASM_DIR = previous
    }
  }
})

test("typescript AST chunking yields function/class blocks, deterministic and hash-parity", async () => {
  const first = await parseFileTreeSitter("src/demo.ts", TS_SOURCE, FILE_HASH)
  const second = await parseFileTreeSitter("src/demo.ts", TS_SOURCE, FILE_HASH)

  // Deterministic across runs (same cached parser, same file path).
  assert.deepEqual(first, second)
  assert.ok(first.length > 0)
  tsChunksFromFirstRun = first

  const types = first.map((chunk) => chunk.type)
  assert.ok(types.includes("function_declaration"), `expected function_declaration, got ${types.join(",")}`)
  assert.ok(types.includes("class_declaration"), `expected class_declaration, got ${types.join(",")}`)

  const fn = first.find((chunk) => chunk.type === "function_declaration")
  assert.ok(fn, "function_declaration chunk missing")
  assert.ok(fn.content.includes("function add"), "function chunk should contain its source")
  assert.equal(fn.startLine, 1)
  assert.equal(fn.endLine, 3)

  const cls = first.find((chunk) => chunk.type === "class_declaration")
  assert.ok(cls, "class_declaration chunk missing")
  assert.equal(cls.startLine, 7)
  assert.equal(cls.endLine, TS_SOURCE.split("\n").length)
  assert.ok(cls.content.includes("class Calculator"))

  for (const chunk of first) {
    assert.equal(chunk.filePath, "src/demo.ts")
    assert.equal(chunk.fileHash, FILE_HASH)
    if (!chunk.type.endsWith("_segment")) {
      assert.ok(chunk.content.length >= 50, `${chunk.type} chunk below the 50-char minimum`)
    }
    // Task requirement 7: Kilo's segment hash formula holds for every chunk.
    assert.equal(chunk.segmentHash, expectedSegmentHash(chunk))
  }
})

test("csharp AST chunking yields a class plus both method declarations", async () => {
  const chunks = await parseFileTreeSitter("Calc.cs", CSHARP_SOURCE, FILE_HASH)
  const types = chunks.map((chunk) => chunk.type)

  assert.ok(types.includes("class_declaration"), `expected class_declaration, got ${types.join(",")}`)
  assert.ok(
    types.filter((type) => type === "method_declaration").length >= 2,
    `expected >= 2 method_declaration chunks, got ${types.join(",")}`,
  )
  assert.ok(chunks.some((chunk) => chunk.content.includes("Add")))
  assert.ok(chunks.some((chunk) => chunk.content.includes("Subtract")))
  for (const chunk of chunks) {
    assert.equal(chunk.segmentHash, expectedSegmentHash(chunk))
  }
})

test("php AST chunking yields a function_definition chunk", async () => {
  const chunks = await parseFileTreeSitter("calc.php", PHP_SOURCE, FILE_HASH)
  assert.ok(chunks.length >= 1)
  const fn = chunks.find((chunk) => chunk.type === "function_definition")
  assert.ok(fn, `expected function_definition, got ${chunks.map((chunk) => chunk.type).join(",")}`)
  assert.ok(fn.content.includes("calculateTotal"))
  assert.equal(fn.startLine, 3)
  assert.equal(fn.endLine, 6)
  assert.equal(fn.segmentHash, expectedSegmentHash(fn))
})

test("markdown sections produce markdown_header_h1 and markdown_header_h2 chunks", async () => {
  const chunks = await parseFileTreeSitter("docs/README.md", MARKDOWN_SOURCE, FILE_HASH)

  const h1 = chunks.find((chunk) => chunk.type === "markdown_header_h1")
  const h2 = chunks.find((chunk) => chunk.type === "markdown_header_h2")
  assert.ok(h1, `expected markdown_header_h1, got ${chunks.map((chunk) => chunk.type).join(",")}`)
  assert.ok(h2, `expected markdown_header_h2, got ${chunks.map((chunk) => chunk.type).join(",")}`)
  assert.ok(h1.content.startsWith("# Title"))
  assert.ok(h1.content.includes("introductory paragraph"))
  assert.equal(h1.startLine, 1)
  assert.ok(h2.content.startsWith("## Section"))
  assert.equal(h2.startLine, 5)

  // The section parser (ported from Kilo) runs before tree-sitter: no grammar
  // is needed for markdown, so no fallback chunks appear.
  assert.ok(chunks.every((chunk) => chunk.type.startsWith("markdown_")))
  for (const chunk of chunks) {
    assert.equal(chunk.segmentHash, expectedSegmentHash(chunk))
  }

  // Markdown without any header becomes a single markdown_content chunk.
  const plain = await parseFileTreeSitter("docs/plain.md", "Just a paragraph that is long enough to be indexed.", FILE_HASH)
  assert.deepEqual(
    plain.map((chunk) => [chunk.type, chunk.startLine, chunk.endLine]),
    [["markdown_content", 1, 1]],
  )
})

test("oversized single-line AST nodes are split into 1000/1000/... segments", async () => {
  const longComment = "// " + "x".repeat(1200) // 1203 chars, single leaf `comment` node
  const content = ["export function withComment(): void {", `  ${longComment}`, "}"].join("\n")

  const chunks = await parseFileTreeSitter("seg.ts", content, FILE_HASH)
  const segments = chunks.filter((chunk) => chunk.type.endsWith("_segment"))

  assert.ok(segments.length >= 2, `expected segments, got ${chunks.map((chunk) => chunk.type).join(",")}`)
  assert.ok(chunks.every((chunk) => chunk.type === "comment_segment"))
  assert.deepEqual(
    segments.map((chunk) => chunk.content.length),
    [1000, 203],
  )
  assert.equal(segments.map((chunk) => chunk.content).join(""), longComment)

  // Segments keep the node's line and use startCharIndex in the hash.
  let startCharIndex = 0
  for (const segment of segments) {
    assert.equal(segment.startLine, 2)
    assert.equal(segment.endLine, 2)
    const expected = cryptoHash(
      `seg.ts-2-2-${startCharIndex}-${segment.content.length}-${segment.content.slice(0, 100)}`,
    )
    assert.equal(segment.segmentHash, expected)
    startCharIndex += 1000
  }
})

test("fallback paths: unsupported extensions, tiny files, and unavailable WASM", async () => {
  // Unsupported extensions produce no chunks (the scanner filters them out).
  assert.deepEqual(await parseFileTreeSitter("notes.txt", "hello world ".repeat(20), FILE_HASH), [])
  assert.deepEqual(await parseFileTreeSitter("app.dart", "void main() { print('hello world, this is long enough'); }", FILE_HASH), [])

  // Supported extension but too little content for a chunk.
  assert.deepEqual(await parseFileTreeSitter("tiny.ts", "export const x = 1", FILE_HASH), [])

  // Missing file: never throws.
  assert.deepEqual(await parseFileFromDisk(path.join(os.tmpdir(), "missing-file-oc-indexing.ts")), [])

  // Simulate a missing grammar by pointing the WASM directory at an empty
  // folder: parser issues must degrade to exact line-chunking parity.
  const previous = process.env.KILO_TREE_SITTER_WASM_DIR
  const emptyDir = await mkdtemp(path.join(os.tmpdir(), "oc-indexing-no-wasm-"))
  try {
    process.env.KILO_TREE_SITTER_WASM_DIR = emptyDir
    await resetParserForTests()

    const goSource = [
      "package main",
      "",
      "func main() {",
      '  println("this fallback test content is longer than fifty characters")',
      "}",
    ].join("\n")
    const chunks = await parseFileTreeSitter("main.go", goSource, FILE_HASH)

    assert.ok(chunks.length > 0)
    assert.ok(chunks.every((chunk) => chunk.type.startsWith("fallback_chunk")))
    assert.deepEqual(chunks, chunkFileContent("main.go", goSource, FILE_HASH))
  } finally {
    if (previous === undefined) {
      delete process.env.KILO_TREE_SITTER_WASM_DIR
    } else {
      process.env.KILO_TREE_SITTER_WASM_DIR = previous
    }
    await rm(emptyDir, { recursive: true, force: true })
    await resetParserForTests()
  }
})

test("parseFileFromDisk reads content, derives the file hash and reloads after reset", async () => {
  // A reset clears cached parsers; the next parse must reload and agree with
  // the pre-reset output.
  if (tsChunksFromFirstRun !== undefined) {
    const reloaded = await parseFileTreeSitter("src/demo.ts", TS_SOURCE, FILE_HASH)
    assert.deepEqual(reloaded, tsChunksFromFirstRun)
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "oc-indexing-ts-"))
  const file = path.join(dir, "sample.ts")
  try {
    await writeFile(file, TS_SOURCE, "utf8")
    const chunks = await parseFileFromDisk(file)
    assert.ok(chunks.length > 0)
    const expectedHash = cryptoHash(TS_SOURCE)
    for (const chunk of chunks) {
      assert.equal(chunk.fileHash, expectedHash)
      assert.equal(chunk.segmentHash, expectedSegmentHash(chunk))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
