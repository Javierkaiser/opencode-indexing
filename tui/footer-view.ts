/**
 * Prompt-footer index indicator.
 *
 * Passive on purpose: the host's `PromptFooterInput` exposes no interaction
 * surface (no focus, no click, unlike `PanelInput`), so a footer slot is
 * render-only. The action lives in the keymap instead — see
 * `opencode.indexing.toggle` in `tui.ts`.
 *
 * Deliberately JSX-free and plain TypeScript: installed from npm the plugin
 * lives under `node_modules`, where the host's JSX transform does not run, so
 * JSX (and bare `solid-js`/`@opentui/solid` imports) would bind to the
 * plugin's own copies — a second reactive graph whose signals never reach the
 * host renderer (upstream anomalyco/opencode#33884). `jsx` and `createSignal`
 * come from `./host-runtime.ts`, which resolves the host's singletons.
 *
 * The slot is registered ONCE and repaints from a signal. Re-registering on
 * every state change added a second claim and the indicator rendered twice.
 */
import { createSignal, jsx, type JSX } from "./host-runtime.ts"

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
  return jsx("text", {
    // Static for this render: the color comes from the state snapshot.
    fg: view.color(props.palette),
    // A getter keeps the text lazy, like the insert the JSX transform emitted.
    get children() {
      return footerText(view, false)
    },
  })
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
