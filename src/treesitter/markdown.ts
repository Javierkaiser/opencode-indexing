// Ported from Kilo Code (github.com/Kilo-Org/kilocode, MIT License). Copyright (c) 2026 Kilo Code.
//
// Markdown header/section extraction, ported from Kilo Code's
// `packages/kilo-indexing/src/tree-sitter/markdownParser.ts`.
//
// Kilo does NOT use a tree-sitter markdown grammar here: this parser is
// heuristic (regex based) and returns "mock captures" shaped like
// `QueryCapture` objects so the generic AST chunker can consume them. This
// port keeps that exact shape and all of its quirks:
//   - ATX headings (`# Title`) and setext headings (`Title` + `===`/`---`) are
//     supported; fenced code blocks are not filtered.
//   - Every heading yields two captures (a `name.definition.header.h<N>` and a
//     `definition.header.h<N>` capture) that share the same node object.
//   - The shared node's `endPosition.row` is extended so it covers the whole
//     section: up to the row before the next heading, or the last line.

/** Position shape used by the mock nodes (only `row` is meaningful here). */
export interface MarkdownPosition {
  row: number
}

/** Minimal node shape consumed by the markdown chunker. */
export interface MarkdownNode {
  startPosition: MarkdownPosition
  endPosition: MarkdownPosition
  text: string
  parent?: MarkdownNode
}

/**
 * Capture-like record returned by {@link parseMarkdown}. Mirrors the subset of
 * `QueryCapture` that the chunker uses (`node`, `name`, `patternIndex`).
 */
export interface MarkdownCapture {
  node: MarkdownNode
  name: string
  patternIndex: number
}

/**
 * Parse a markdown document and return heading/section captures.
 *
 * The returned array is flat and paired: for every heading, index `i` holds
 * the `name.definition.header.h<N>` capture and index `i + 1` the
 * `definition.header.h<N>` capture (both pointing at the same node).
 */
export function parseMarkdown(content: string): MarkdownCapture[] {
  if (!content || content.trim() === "") {
    return []
  }

  const lines = content.split("\n")
  const captures: MarkdownCapture[] = []

  const atxHeaderRegex = /^(#{1,6})\s+(.+)$/
  const setextH1Regex = /^={3,}\s*$/
  const setextH2Regex = /^-{3,}\s*$/
  const validSetextTextRegex = /^\s*[^#<>!\[\]`\t]+[^\n]$/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // ATX headers (# Header)
    const atxMatch = line.match(atxHeaderRegex)
    if (atxMatch) {
      const level = atxMatch[1].length
      const text = atxMatch[2].trim()

      const node: MarkdownNode = {
        startPosition: { row: i },
        endPosition: { row: i },
        text,
      }

      captures.push({
        node,
        name: `name.definition.header.h${level}`,
        patternIndex: 0,
      })

      captures.push({
        node,
        name: `definition.header.h${level}`,
        patternIndex: 0,
      })

      continue
    }

    // Setext headers (underlined)
    if (i > 0) {
      if (setextH1Regex.test(line) && validSetextTextRegex.test(lines[i - 1])) {
        const text = lines[i - 1].trim()

        const node: MarkdownNode = {
          startPosition: { row: i - 1 },
          endPosition: { row: i },
          text,
        }

        captures.push({
          node,
          name: "name.definition.header.h1",
          patternIndex: 0,
        })

        captures.push({
          node,
          name: "definition.header.h1",
          patternIndex: 0,
        })

        continue
      }

      if (setextH2Regex.test(line) && validSetextTextRegex.test(lines[i - 1])) {
        const text = lines[i - 1].trim()

        const node: MarkdownNode = {
          startPosition: { row: i - 1 },
          endPosition: { row: i },
          text,
        }

        captures.push({
          node,
          name: "name.definition.header.h2",
          patternIndex: 0,
        })

        captures.push({
          node,
          name: "definition.header.h2",
          patternIndex: 0,
        })

        continue
      }
    }
  }

  // Calculate section ranges
  captures.sort((a, b) => a.node.startPosition.row - b.node.startPosition.row)

  const headerCaptures: MarkdownCapture[][] = []
  for (let i = 0; i < captures.length; i += 2) {
    if (i + 1 < captures.length) {
      headerCaptures.push([captures[i], captures[i + 1]])
    } else {
      headerCaptures.push([captures[i]])
    }
  }

  // Update end positions for section ranges
  for (let i = 0; i < headerCaptures.length; i++) {
    const headerPair = headerCaptures[i]

    if (i < headerCaptures.length - 1) {
      const nextHeaderStartRow = headerCaptures[i + 1][0].node.startPosition.row
      headerPair.forEach((capture) => {
        capture.node.endPosition.row = nextHeaderStartRow - 1
      })
    } else {
      headerPair.forEach((capture) => {
        capture.node.endPosition.row = lines.length - 1
      })
    }
  }

  return headerCaptures.flat()
}
