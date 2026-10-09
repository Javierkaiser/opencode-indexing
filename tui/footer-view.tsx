/** @jsxImportSource @opentui/solid */
/**
 * JSX for the prompt-footer index indicator.
 *
 * Passive on purpose: the host's `PromptFooterInput` exposes no interaction
 * surface (no focus, no click, unlike `PanelInput`), so a footer slot is
 * render-only. The action lives in the keymap instead — see
 * `opencode.indexing.toggle` in `tui.ts`.
 *
 * The slot is registered ONCE and repaints from a signal. Re-registering on
 * every state change added a second claim and the indicator rendered twice.
 *
 * Kept in a `.tsx` so `tui.ts` stays plain TypeScript and can load it lazily:
 * on a host without a JSX runtime the indicator is simply absent.
 */
import type { JSX } from "@opentui/solid"
import { createSignal } from "solid-js"

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

export interface FooterHandle {
  /** Hand this to `ui.slot().render`. Reads the signal, so it repaints. */
  render: () => JSX.Element
  /** Publishes a new state, which repaints the footer. */
  update: (next: FooterState) => void
  /** Current state, readable for assertions and for the action decision. */
  current: () => FooterState
}

/**
 * Creates the reactive footer.
 *
 * The signal is what makes `update` repaint: the host runs `render` inside a
 * computation, so a value read there is tracked.
 */
export function createFooterIndicator(initial: FooterState, palette: PagePalette): FooterHandle {
  const [state, setState] = createSignal<FooterState>(initial)
  return {
    render: () => buildFooter({ ...state(), palette }),
    update: (next) => setState(next),
    current: state,
  }
}
