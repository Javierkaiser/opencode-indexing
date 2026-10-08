/**
 * State and wording for the prompt-footer index indicator.
 *
 * Pure on purpose: the TUI plugin renders it from a cached `status.get`, and the
 * mapping from status fields to a short label is the part worth testing.
 *
 * Design notes: the footer is a single tight line, so the label is one glyph
 * plus at most a few characters. Detail lives in `/indexing`; this only answers
 * "is this workspace being indexed right now?".
 */

import type { PageColor, PagePalette } from "./page-style.ts"

export type IndexingState =
  /** Status not fetched yet. */
  | "loading"
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
}

export interface FooterView {
  state: IndexingState
  /** Single glyph prefix. */
  glyph: string
  /** Short label, without the glyph. */
  label: string
  /** Longer label used when the footer shows details. */
  detail: string
  color: (palette: PagePalette) => PageColor
}

const GLYPHS: Record<IndexingState, string> = {
  loading: "◌",
  paused: "⏸",
  ready: "●",
  stale: "◐",
  empty: "○",
  unavailable: "✕",
  error: "!",
}

/** 12345 → "12.3k"; keeps the footer one short token. */
export function formatPoints(points: number): string {
  if (!Number.isFinite(points) || points < 0) return "?"
  if (points < 1000) return String(Math.floor(points))
  if (points < 1_000_000) return `${(points / 1000).toFixed(1)}k`
  return `${(points / 1_000_000).toFixed(1)}M`
}

/** Maps a status payload to the footer state. */
export function footerState(input: StatusInput): IndexingState {
  if (!input.enabled) return "paused"
  if (input.ownPoints !== undefined && input.ownPoints !== null) {
    return input.ownComplete === true ? "ready" : "stale"
  }
  return input.hasKilo ? "empty" : "unavailable"
}

/** Builds the footer view for a state, including its theme color. */
export function footerView(state: IndexingState): FooterView {
  const glyph = GLYPHS[state]
  switch (state) {
    case "paused":
      return {
        state,
        glyph,
        label: "paused",
        detail: "click to resume indexing",
        color: (palette) => palette.muted,
      }
    case "ready":
      return {
        state,
        glyph,
        label: "indexed",
        detail: "index up to date; click to pause",
        color: (palette) => palette.success,
      }
    case "stale":
      return {
        state,
        glyph,
        label: "index stale",
        detail: "needs a refresh; click to pause",
        color: (palette) => palette.accent,
      }
    case "empty":
      return {
        state,
        glyph,
        label: "not indexed",
        detail: "no own index yet; click to pause",
        color: (palette) => palette.muted,
      }
    case "unavailable":
      return {
        state,
        glyph,
        label: "no index",
        detail: "no index available for this workspace",
        color: (palette) => palette.error,
      }
    case "error":
      return {
        state,
        glyph,
        label: "index error",
        detail: "could not read index status",
        color: (palette) => palette.error,
      }
    default:
      return {
        state,
        glyph,
        label: "…",
        detail: "reading index status",
        color: (palette) => palette.muted,
      }
  }
}

/** The text rendered in the footer, glyph included. */
export function footerText(view: FooterView, showDetails: boolean, points?: number | null): string {
  const parts = [`${view.glyph} ${view.label}`]
  if (showDetails && points !== undefined && points !== null && points > 0) {
    parts.push(formatPoints(points))
  }
  if (showDetails && view.detail) parts.push(view.detail)
  return parts.join("  ")
}
