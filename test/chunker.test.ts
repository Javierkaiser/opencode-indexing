import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import {
  MAX_BLOCK_CHARS,
  MAX_CHARS_TOLERANCE_FACTOR,
  MIN_BLOCK_CHARS,
  chunkFileContent,
  sha256Hex,
} from "../src/chunker.ts"

const EFFECTIVE_MAX = MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR // 1150
const FILE_HASH = "f".repeat(64)

function cryptoHash(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

test("small content (< MIN_BLOCK_CHARS) yields no chunks", () => {
  assert.deepEqual(chunkFileContent("a.ts", "const x = 1\n", FILE_HASH), [])
  assert.deepEqual(chunkFileContent("a.ts", "short", FILE_HASH), [])
  assert.deepEqual(chunkFileContent("a.ts", "", FILE_HASH), [])
})

test("single function-like block yields exactly one fallback_chunk", () => {
  const content = [
    "export function add(a: number, b: number): number {",
    "  const sum = a + b",
    "  if (sum > 100) {",
    "    return 100",
    "  }",
    "  return sum",
    "}",
    "// trailing comment pushing the block above the minimum threshold",
  ].join("\n")

  assert.ok(content.length >= MIN_BLOCK_CHARS && content.length < 900)

  const chunks = chunkFileContent("a.ts", content, FILE_HASH)
  assert.equal(chunks.length, 1)

  const chunk = chunks[0]
  assert.equal(chunk.filePath, "a.ts")
  assert.equal(chunk.content, content)
  assert.equal(chunk.startLine, 1)
  assert.equal(chunk.endLine, 8)
  assert.equal(chunk.type, "fallback_chunk")
  assert.equal(chunk.fileHash, FILE_HASH)
  assert.equal(
    chunk.segmentHash,
    cryptoHash(`a.ts-1-8-${content.length}-${content.slice(0, 100)}`),
  )
})

test("content needing a split produces consecutive chunks <= effective max", () => {
  const lines = Array.from({ length: 30 }, () => "x".repeat(99))
  const content = lines.join("\n")
  assert.ok(content.length > EFFECTIVE_MAX)

  const chunks = chunkFileContent("big.ts", content, FILE_HASH)

  assert.equal(chunks.length, 3)
  assert.deepEqual(
    chunks.map((c) => [c.startLine, c.endLine, c.content.length]),
    [
      [1, 11, 1099],
      [12, 22, 1099],
      [23, 30, 799],
    ],
  )

  for (const chunk of chunks) {
    assert.equal(chunk.type, "fallback_chunk")
    assert.equal(chunk.fileHash, FILE_HASH)
    assert.ok(chunk.content.length <= EFFECTIVE_MAX, `chunk ${chunk.startLine}-${chunk.endLine} exceeds max`)
    assert.ok(chunk.content.length >= MIN_BLOCK_CHARS, `chunk ${chunk.startLine}-${chunk.endLine} below min`)
  }

  // chunks are consecutive: no gaps, no overlaps
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i].startLine, chunks[i - 1].endLine + 1)
  }
  assert.equal(chunks[0].startLine, 1)
  assert.equal(chunks[chunks.length - 1].endLine, lines.length)
})

test("oversized single line is split into 1000/1000/500 segments", () => {
  const content = "a".repeat(2500)
  const chunks = chunkFileContent("huge.ts", content, FILE_HASH)

  assert.equal(chunks.length, 3)
  const expectedLengths = [1000, 1000, 500]

  chunks.forEach((chunk, index) => {
    const startCharIndex = index * MAX_BLOCK_CHARS
    assert.equal(chunk.type, "fallback_chunk_segment")
    assert.equal(chunk.startLine, 1)
    assert.equal(chunk.endLine, 1)
    assert.equal(chunk.content.length, expectedLengths[index])
    assert.equal(chunk.content, content.slice(startCharIndex, startCharIndex + expectedLengths[index]))
    assert.equal(chunk.fileHash, FILE_HASH)
    // startCharIndex is part of the hash input
    assert.equal(
      chunk.segmentHash,
      cryptoHash(
        `huge.ts-1-1-${startCharIndex}-${chunk.content.length}-${chunk.content.slice(0, 100)}`,
      ),
    )
  })

  // Hashes are unique even though the first two segments share the same text:
  // startCharIndex participates in the hash.
  assert.equal(new Set(chunks.map((c) => c.segmentHash)).size, chunks.length)

  // Determinism: calling twice yields identical output.
  assert.equal(JSON.stringify(chunkFileContent("huge.ts", content, FILE_HASH)), JSON.stringify(chunks))
})

test("segments are produced even when shorter than MIN_BLOCK_CHARS", () => {
  // 2001 chars -> 1000 + 1000 + 1 (the 1-char tail must still be emitted)
  const content = "w".repeat(2001)
  const chunks = chunkFileContent("tail.ts", content, FILE_HASH)

  assert.deepEqual(
    chunks.map((c) => c.content.length),
    [1000, 1000, 1],
  )
  for (const chunk of chunks) {
    assert.equal(chunk.type, "fallback_chunk_segment")
  }
})

test("oversized line mixed with normal trailing lines keeps line accounting", () => {
  const big = "q".repeat(1200)
  const lines = [big, "r".repeat(100), "s".repeat(100)]
  const content = lines.join("\n")
  const chunks = chunkFileContent("mixed.ts", content, FILE_HASH)

  assert.equal(chunks.length, 3)
  assert.deepEqual(
    chunks.map((c) => c.type),
    ["fallback_chunk_segment", "fallback_chunk_segment", "fallback_chunk"],
  )
  assert.deepEqual(
    chunks.map((c) => [c.startLine, c.endLine, c.content.length]),
    [
      [1, 1, 1000],
      [1, 1, 200],
      [2, 3, 201],
    ],
  )
  // The trailing normal chunk covers lines 2..3 (1-based) exactly.
  assert.equal(chunks[2].content, lines.slice(1, 3).join("\n"))
})

test("small remainder after a split rebalances the split point (Kilo quirk)", () => {
  // Without the rebalance branch the split would happen at line 2:
  //   [570, 570] + [50, 50]  =>  chunks labeled [1,2] and [3,4]
  // Because the trailing remainder (101 chars) is < MIN_CHUNK_REMAINDER_CHARS
  // (200), the split point moves back to line 1. Note the Kilo quirk that
  // finalizeChunk keeps every accumulated line as content while labeling the
  // chunk with the rebalanced endLine, and the next chunk starts right after
  // the rebalanced split point, so contents overlap.
  const lines = ["a".repeat(570), "b".repeat(570), "c".repeat(50), "d".repeat(50)]
  const content = lines.join("\n")
  const chunks = chunkFileContent("rebalance.ts", content, FILE_HASH)

  assert.equal(chunks.length, 2)
  assert.deepEqual(
    chunks.map((c) => [c.startLine, c.endLine, c.content.length]),
    [
      [1, 1, 1141], // content is lines 1..2 joined, but endLine was rebalanced to 1
      [2, 4, 101], // starts at line 2 (after the rebalanced split), content is lines 3..4
    ],
  )
  assert.equal(chunks[0].content, lines.slice(0, 2).join("\n"))
  assert.equal(chunks[1].content, lines.slice(2, 4).join("\n"))

  const expectedHash0 = cryptoHash(`rebalance.ts-1-1-1141-${chunks[0].content.slice(0, 100)}`)
  const expectedHash1 = cryptoHash(`rebalance.ts-2-4-101-${chunks[1].content.slice(0, 100)}`)
  assert.equal(chunks[0].segmentHash, expectedHash0)
  assert.equal(chunks[1].segmentHash, expectedHash1)

  // No rebalance when the trailing remainder is comfortably large: split at
  // the natural boundary i-1.
  const noRebalance = chunkFileContent("plain.ts", ["a".repeat(600), "b".repeat(560), "c".repeat(30)].join("\n"), FILE_HASH)
  assert.deepEqual(
    noRebalance.map((c) => [c.startLine, c.endLine]),
    [
      [1, 1],
      [2, 3],
    ],
  )
})

test("reconstructing chunk content from original lines matches exactly", () => {
  const lines = [
    "import { foo } from './foo'",
    "x".repeat(300),
    "export const value = 1",
    "y".repeat(1400),
    "z".repeat(80),
    "export function tail() { return value }",
  ]
  const content = lines.join("\n")
  const chunks = chunkFileContent("recon.ts", content, FILE_HASH)

  assert.ok(chunks.length > 0)
  for (const chunk of chunks) {
    if (chunk.type === "fallback_chunk") {
      // Normal chunks are exact line ranges.
      assert.equal(chunk.content, lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"))
    } else {
      // Segments belong to one line and are slices of it.
      assert.equal(chunk.startLine, chunk.endLine)
      assert.ok(lines[chunk.startLine - 1].includes(chunk.content))
    }
  }

  // only the oversized line (line 4) has segments; their concatenation is the line
  const segmentChunks = chunks.filter((c) => c.type === "fallback_chunk_segment")
  assert.ok(segmentChunks.length >= 2)
  for (const segment of segmentChunks) {
    assert.equal(segment.startLine, 4)
    assert.equal(segment.endLine, 4)
  }
  assert.equal(segmentChunks.map((c) => c.content).join(""), lines[3])

  // Normal chunks partition their line ranges consecutively.
  const normal = chunks.filter((c) => c.type === "fallback_chunk")
  assert.deepEqual(
    normal.map((c) => [c.startLine, c.endLine]),
    [
      [1, 3],
      [5, 6],
    ],
  )
})

test("determinism: calling chunkFileContent twice yields identical arrays", () => {
  const content = Array.from({ length: 40 }, (_, i) => `line ${i} ${"d".repeat(60)}`).join("\n")
  const first = chunkFileContent("det.ts", content, FILE_HASH)
  const second = chunkFileContent("det.ts", content, FILE_HASH)

  assert.ok(first.length > 1)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})

test("dedupe: identical segment text still yields unique segmentHashes", () => {
  // Three identical oversized lines: every segment text repeats, but the line
  // number is part of the hash, so all hashes stay unique.
  const duplicateLine = "z".repeat(1200)
  const content = [duplicateLine, duplicateLine, duplicateLine].join("\n")
  const chunks = chunkFileContent("dup.ts", content, FILE_HASH)

  assert.equal(chunks.length, 6) // 2 segments per oversized line
  assert.equal(new Set(chunks.map((c) => c.segmentHash)).size, chunks.length)
  for (const chunk of chunks) {
    assert.equal(chunk.type, "fallback_chunk_segment")
  }
})

test("known hash vector (computed independently with node crypto)", () => {
  const filePath = "a.ts"
  const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n")
  const chunks = chunkFileContent(filePath, content, FILE_HASH)

  assert.equal(chunks.length, 1)
  const startLine = 1
  const endLine = 10
  const expected = cryptoHash(
    `${filePath}-${startLine}-${endLine}-${content.length}-${content.slice(0, 100)}`,
  )
  assert.equal(chunks[0].segmentHash, expected)
  assert.equal(chunks[0].content.length, content.length)
})

test("sha256Hex matches node crypto", () => {
  assert.equal(sha256Hex("hello world"), cryptoHash("hello world"))
  assert.equal(sha256Hex(""), cryptoHash(""))
})
