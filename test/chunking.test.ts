import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import { chunkFile } from "../src/chunking.ts"
import { chunkFileContent } from "../src/chunker.ts"

describe("chunking dispatcher", () => {
  test("fallback-only extensions use the line chunker (yaml)", async () => {
    const content = Array.from({ length: 30 }, (_, i) => `key${i}: value number ${i}`).join("\n")
    const hash = "hash-yaml"
    const viaDispatcher = await chunkFile("config.yaml", content, hash)
    const viaFallback = chunkFileContent("config.yaml", content, hash)
    assert.deepEqual(viaDispatcher, viaFallback)
  })

  test("unsupported extensions use the line chunker", async () => {
    const content = "plain text content ".repeat(10)
    const viaDispatcher = await chunkFile("notes.txt", content, "h")
    assert.ok(viaDispatcher.length > 0)
    assert.equal(viaDispatcher[0]!.type, "fallback_chunk")
  })

  test("empty content yields no chunks", async () => {
    assert.deepEqual(await chunkFile("a.ts", "", "h"), [])
  })

  test("small content below MIN_BLOCK_CHARS yields no chunks", async () => {
    assert.deepEqual(await chunkFile("a.ts", "const x = 1", "h"), [])
  })

  test("typescript content produces chunks (tree-sitter or fallback)", async () => {
    const content = [
      "export function greet(name: string): string {",
      "  const message = `hello ${name}`",
      "  return message",
      "}",
      "",
      "export class Service {",
      "  run(): void {",
      "    console.log('running the service with enough characters to be chunked')",
      "  }",
      "}",
    ].join("\n")
    const chunks = await chunkFile("service.ts", content, "h")
    assert.ok(chunks.length >= 1, "expected at least one chunk")
    for (const chunk of chunks) {
      assert.equal(chunk.filePath, "service.ts")
      assert.equal(chunk.fileHash, "h")
      assert.ok(chunk.startLine >= 1)
      assert.ok(chunk.endLine >= chunk.startLine)
      assert.ok(chunk.segmentHash.length === 64)
    }
  })

  test("deterministic for the same input", async () => {
    const content = "export const value = 'a long enough line to produce a chunk in the dispatcher tests'\n".repeat(5)
    const first = await chunkFile("x.ts", content, "h")
    const second = await chunkFile("x.ts", content, "h")
    assert.deepEqual(first, second)
  })
})
