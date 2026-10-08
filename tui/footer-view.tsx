/** @jsxImportSource @opentui/solid */
/**
 * JSX for the prompt-footer index indicator.
 *
 * Passive on purpose: the host's `PromptFooterInput` exposes no interaction
 * surface (no focus, no click, unlike `PanelInput`), so a footer slot is
 * render-only. A click handler there is not delivered reliably, and the action
 * lives in the keymap instead — see `opencode.indexing.toggle` in `tui.ts`.
 *
 * Kept in a `.tsx` so `tui.ts` stays plain TypeScript and can load it lazily:
 * on a host without a JSX runtime the indicator is simply absent.
 */
import type { JSX } from "@opentui/solid"

import { footerText, footerView, type IndexingState } from "./footer.ts"
import type { PagePalette } from "./page-style.ts"

export interface FooterState {
  state: IndexingState
  points: number | null
}

export interface FooterProps extends FooterState {
  palette: PagePalette
}

/** Builds the footer element for a state snapshot. */
export function buildFooter(props: FooterProps): JSX.Element {
  const view = footerView(props.state)
  return <text fg={view.color(props.palette)}>{footerText(view, false)}</text>
}
