/** @jsxImportSource @opentui/solid */
/**
 * JSX wrapper for the prompt-footer index indicator.
 *
 * Two pieces:
 *  - `createFooterIndicator` owns the reactive state. The host re-renders a slot
 *    when the signals read inside its `render` change, so the displayed text has
 *    to come from a signal — a plain captured variable updates the data but never
 *    repaints, which is what made the indicator look frozen after a toggle.
 *  - `FooterIndicator` renders one snapshot, for tests and direct use.
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

export interface FooterIndicatorProps extends FooterState {
  /** Footer verbosity, from the host's slot input. */
  showDetails: boolean
  palette: PagePalette
  /** Called on click: start, pause or resume indexing. */
  onActivate: () => void
}

export function FooterIndicator(props: FooterIndicatorProps): JSX.Element {
  const view = footerView(props.state)
  return (
    <text
      fg={view.color(props.palette)}
      onMouseDown={(event: MouseEvent) => {
        // The footer belongs to the host: stop here so the click does not keep
        // bubbling into whatever the host binds on that row.
        event.stopPropagation()
        props.onActivate()
      }}
    >
      {footerText(view, props.showDetails, props.points)}
    </text>
  )
}

export interface FooterHandle {
  /** Hand this to `ui.slot().render`. Reactive: reads the state signal. */
  render: (input: { showDetails: boolean }) => JSX.Element
  /** Publishes a new state, which repaints the footer. */
  update: (next: FooterState) => void
  /** Current state, readable for assertions. */
  current: () => FooterState
}

/**
 * Creates the reactive footer bound to a palette and an action callback.
 *
 * The action is passed in rather than derived here so this module stays free of
 * RPC knowledge: what a click means is decided in `tui.ts`.
 */
export function createFooterIndicator(
  initial: FooterState,
  palette: PagePalette,
  onActivate: () => void,
): FooterHandle {
  const [state, setState] = createSignal<FooterState>(initial)
  return {
    render: (input) => (
      <FooterIndicator
        state={state().state}
        points={state().points}
        showDetails={input.showDetails}
        palette={palette}
        onActivate={onActivate}
      />
    ),
    update: (next) => setState(next),
    current: state,
  }
}
