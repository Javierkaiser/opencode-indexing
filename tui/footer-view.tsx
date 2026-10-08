/** @jsxImportSource @opentui/solid */
/**
 * JSX wrapper for the prompt-footer index indicator.
 *
 * The slot content builds the `<text>` directly instead of delegating to a child
 * component: with a nested component the click stopped reaching the handler, and
 * the direct form is the one verified to work in the TUI.
 *
 * State lives in a Solid signal so the host re-renders the slot when it changes
 * — a plain variable would update the data but never repaint.
 *
 * The mouse handler is passed as a renderable *option* (`onMouseDown`), not as
 * `on:mousedown`: the reconciler turns the latter into emitter subscriptions, but
 * OpenTUI dispatches mouse events by calling the property handlers directly.
 */
import type { JSX } from "@opentui/solid"
import type { MouseEvent } from "@opentui/core"
import { createSignal } from "solid-js"

import { footerText, footerView, type IndexingState } from "./footer.ts"
import type { PagePalette } from "./page-style.ts"

export interface FooterState {
  state: IndexingState
  points: number | null
}

export interface FooterHandle {
  /** Hand this to `ui.slot().render`. Reads the state signal, so it repaints. */
  render: () => JSX.Element
  /** Publishes a new state. */
  update: (next: FooterState) => void
  /** Current state, readable for assertions. */
  current: () => FooterState
}

/**
 * Creates the reactive footer.
 *
 * Always renders the compact form (glyph + state): the footer is a status line,
 * and the detail lives in `/indexing`. `onActivate` is the click action, passed
 * in so this module stays free of RPC knowledge.
 */
export function createFooterIndicator(
  initial: FooterState,
  palette: PagePalette,
  onActivate: () => void,
): FooterHandle {
  const [state, setState] = createSignal<FooterState>(initial)
  return {
    render: () => {
      const snapshot = state()
      const view = footerView(snapshot.state)
      return (
        <text
          fg={view.color(palette)}
          onMouseDown={(event: MouseEvent) => {
            // The footer belongs to the host: stop here so the click does not keep
            // bubbling into whatever the host binds on that row.
            event.stopPropagation()
            onActivate()
          }}
        >
          {footerText(view, false)}
        </text>
      )
    },
    update: (next) => setState(next),
    current: state,
  }
}
