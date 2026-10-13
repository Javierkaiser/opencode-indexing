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
import {
  DETAILS,
  GLYPHS,
  LABELS,
  formatPoints,
  indexState,
  type IndexingState,
  type StatusInput,
} from "../src/index-state.ts"

// The state vocabulary is shared with the chat-side status line, so a state
// never reads one way in the TUI and another in a chat client. Re-exported here
// because the TUI's public surface has always owned it.
export {
  GLYPHS,
  LABELS,
  formatPoints,
  indexState as footerState,
  type IndexingState,
  type StatusInput,
} from "../src/index-state.ts"

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

export type FooterAction = "start" | "pause" | "resume" | "restatus"

/** The slice of an open tab the workspace resolution needs. */
export interface WorkspaceTab {
  readonly sessionID: string
  readonly active: boolean
}

/** The slice of a session the workspace resolution needs. */
export interface WorkspaceSession {
  readonly id: string
  readonly location?: { readonly directory?: string } | undefined
}

export interface WorkspaceSources {
  /** Whether the host opens session tabs at all. */
  readonly tabsEnabled: () => boolean
  /** The open tabs, in host order. */
  readonly tabs: () => readonly WorkspaceTab[]
  /** Every session the client knows about. */
  readonly sessions: () => readonly WorkspaceSession[]
  /** Directory the plugin instance was started in. Only a last resort. */
  readonly instanceDirectory: () => string | undefined
}

/**
 * Directory of the ACTIVE tab's session.
 *
 * `context.location.directory` is where the server SERVICE was started, not
 * where the user is working: an RPC told about it reads and writes the index of
 * the service's own root instead of the project on screen. The active tab is
 * the signal that follows the user, so it wins whenever the host has tabs and
 * can name the session. Everything else — tabs switched off, no tab focused,
 * session unknown or without a directory — falls back to the instance
 * directory, which is the best answer available on such a host.
 */
export function activeWorkspace(sources: WorkspaceSources): string | undefined {
  if (sources.tabsEnabled()) {
    const active = sources.tabs().find((tab) => tab.active)
    const session = active && sources.sessions().find((entry) => entry.id === active.sessionID)
    const directory = session?.location?.directory
    if (directory) return directory
  }
  return sources.instanceDirectory()
}

export function footerAction(state: IndexingState): FooterAction {
  switch (state) {
    case "paused":
      return "resume"
    case "ready":
      return "pause"
    case "loading":
    case "working":
    case "error":
      return "restatus"
    default:
      // empty, stale, unavailable: there is something to index, so start it.
      return "start"
  }
}

/**
 * Colours per state.
 *
 * The wording is not repeated here on purpose: the glyph, label and detail all
 * come from `src/index-state.ts`, which the chat-side status line also reads.
 */
const COLORS: Record<IndexingState, (palette: PagePalette) => PageColor> = {
  loading: (palette) => palette.muted,
  working: (palette) => palette.accent,
  paused: (palette) => palette.muted,
  ready: (palette) => palette.success,
  stale: (palette) => palette.accent,
  empty: (palette) => palette.muted,
  unavailable: (palette) => palette.error,
  error: (palette) => palette.error,
}

/** Builds the footer view for a state, including its theme color. */
export function footerView(state: IndexingState): FooterView {
  return {
    state,
    glyph: GLYPHS[state],
    label: LABELS[state],
    detail: DETAILS[state],
    color: COLORS[state],
  }
}

/**
 * The text rendered in the footer.
 *
 * The footer itself always uses the compact form (`showDetails: false`): it is a
 * status line, and the longer explanation belongs in `/indexing`. The detailed
 * form is kept for callers that have room for it.
 */
export function footerText(view: FooterView, showDetails: boolean, points?: number | null): string {
  const parts = [`${view.glyph} ${view.label}`]
  if (showDetails && points !== undefined && points !== null && points > 0) {
    parts.push(formatPoints(points))
  }
  if (showDetails && view.detail) parts.push(view.detail)
  return parts.join("  ")
}
