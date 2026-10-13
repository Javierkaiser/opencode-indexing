/**
 * Index-state vocabulary shared by every surface that reports index status.
 *
 * The prompt footer and the chat-side status line use the same glyphs and the
 * same labels, so a state never reads one way in the TUI and another in a chat
 * client. Pure on purpose: no TUI imports, no reactivity, unit-testable.
 */

export type IndexingState =
  /** Status not fetched yet. */
  | "loading"
  /** An index run is in flight. */
  | "working"
  /** Indexing paused by the user (`enabled: false`). */
  | "paused"
  /** Own index exists and is complete. */
  | "ready"
  /** Own index exists but is incomplete, so it needs a refresh. */
  | "stale"
  /** Nothing indexed for this workspace. */
  | "empty"
  /** No Kilo index either, so searches would find nothing. */
  | "unavailable"
  /** The status call failed. */
  | "error"

export interface StatusInput {
  /** `enabled` flag from the resolved settings. */
  enabled: boolean
  /** Points in the own index; null/undefined when it does not exist. */
  ownPoints?: number | null
  /** Whether the own index finished indexing. */
  ownComplete?: boolean | null
  /** Whether a readable Kilo index exists. */
  hasKilo: boolean
  /** Points in the Kilo index, when known; only used by the chat-side line. */
  kiloPoints?: number | null
  /** Workspace the status is about; only used by the chat-side line. */
  root?: string
}

export const GLYPHS: Record<IndexingState, string> = {
  loading: "◌",
  working: "◍",
  paused: "⏸",
  ready: "●",
  stale: "◐",
  empty: "○",
  unavailable: "✕",
  error: "!",
}

export const LABELS: Record<IndexingState, string> = {
  loading: "…",
  working: "indexing…",
  paused: "paused",
  ready: "indexed",
  stale: "index stale",
  empty: "not indexed",
  unavailable: "no index",
  error: "index error",
}

export const DETAILS: Record<IndexingState, string> = {
  loading: "reading index status",
  working: "an index run is in progress",
  paused: "click to resume indexing",
  ready: "index up to date",
  stale: "index needs a refresh",
  empty: "no own index yet",
  unavailable: "no index available for this workspace",
  error: "could not read index status",
}

/** 12345 → "12.3k"; keeps a status line one short token. */
export function formatPoints(points: number): string {
  if (!Number.isFinite(points) || points < 0) return "?"
  if (points < 1000) return String(Math.floor(points))
  if (points < 1_000_000) return `${(points / 1000).toFixed(1)}k`
  return `${(points / 1_000_000).toFixed(1)}M`
}

/** Maps a status payload to an index state. */
export function indexState(input: StatusInput): IndexingState {
  if (!input.enabled) return "paused"
  if (input.ownPoints !== undefined && input.ownPoints !== null) {
    return input.ownComplete === true ? "ready" : "stale"
  }
  return input.hasKilo ? "empty" : "unavailable"
}

/**
 * One-line status appended to tool output.
 *
 * Chat clients have no footer slot, and the Desktop app has no status area at
 * all, so this rides along with the results of the tool people run constantly
 * instead. It costs no extra message and adds no noise: a reader who ignores it
 * sees exactly the output they saw before.
 *
 * The workspace root is part of the line because the server plugin runs in the
 * service's directory, not the session's: saying which workspace was searched
 * is what stops the report from being read as "the directory the server is in".
 */
export function indexStatusLine(input: StatusInput): string {
  const state = indexState(input)
  const parts = [`Index: ${GLYPHS[state]} ${LABELS[state]}`]
  if (input.ownPoints !== undefined && input.ownPoints !== null) {
    parts.push(`own ${formatPoints(input.ownPoints)} pts`)
  } else if (input.kiloPoints !== undefined && input.kiloPoints !== null) {
    parts.push(`kilo ${formatPoints(input.kiloPoints)} pts`)
  }
  if (input.root) parts.push(input.root)
  return parts.join(" · ")
}