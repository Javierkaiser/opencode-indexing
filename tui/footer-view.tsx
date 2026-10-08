/** @jsxImportSource @opentui/solid */
/**
 * JSX wrapper for the prompt-footer index indicator.
 *
 * Lives in a `.tsx` because the slot content must return a JSX element, while
 * `tui.ts` is plain TypeScript. The wording and colors come from `footer.ts`,
 * which is pure and tested; this file only renders what it is handed.
 *
 * The indicator is clickable. The mouse handlers are passed as renderable
 * *options* (`onMouseDown`), not as `on:mousedown`: the reconciler turns the
 * latter into emitter subscriptions, but OpenTUI dispatches mouse events by
 * calling the property handlers directly, so only the option form ever fires.
 */
import type { JSX } from "@opentui/solid"
import type { MouseEvent } from "@opentui/core"

import { footerText, footerView, type IndexingState } from "./footer.ts"
import type { PagePalette } from "./page-style.ts"

export interface FooterIndicatorProps {
  state: IndexingState
  points: number | null
  /** Footer verbosity, from the host's slot input. */
  showDetails: boolean
  palette: PagePalette
  /** Called when the indicator is clicked: toggles indexing for this workspace. */
  onToggle: () => void
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
        props.onToggle()
      }}
    >
      {footerText(view, props.showDetails, props.points)}
    </text>
  )
}
