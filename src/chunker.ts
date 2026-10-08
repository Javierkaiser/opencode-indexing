import { createHash } from "node:crypto"

import type { Chunk } from "./types.ts"

/**
 * Line-based fallback chunking, replicated from Kilo Code
 * (`packages/kilo-indexing/src/indexing/processors/parser.ts`,
 * `_performFallbackChunking` + `_chunkTextByLines`) so that chunks stored in
 * our own `oc-` prefixed Qdrant collections have an identical shape to the
 * ones Kilo produces for the same file content.
 *
 * Tree-sitter is intentionally not used here: this module only implements the
 * fallback path.
 */

export const MAX_BLOCK_CHARS = 1000
export const MIN_BLOCK_CHARS = 50
export const MIN_CHUNK_REMAINDER_CHARS = 200
export const MAX_CHARS_TOLERANCE_FACTOR = 1.15

/** sha256 hex helper also exported for reuse/tests. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

/**
 * Common helper function to chunk text by lines, avoiding tiny remainders.
 *
 * Mirrors Kilo's `_chunkTextByLines` exactly, including the
 * `i = chunkStartLineIndex - 1` re-scan behavior and the hash inputs.
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

/** chunkFileContent replicates Kilo's _performFallbackChunking+_chunkTextByLines. */
export function chunkFileContent(filePath: string, content: string, fileHash: string): Chunk[] {
  if (content.length === 0) return []
  const lines = content.split("\n")
  return chunkTextByLines(lines, filePath, fileHash, "fallback_chunk", new Set<string>())
}
