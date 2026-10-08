/** @jsxImportSource @opentui/solid */
/**
 * JSX wrapper for the prompt-footer index indicator.
 *
 * Lives in a `.tsx` because the slot content must return a JSX element, while
 * `tui.ts` is plain TypeScript. The wording and colors come from `footer.ts`,
 * which is pure and tested; this file only renders what it is handed.
 */
import type { JSX } from "@opentui/solid"

import { footerText, footerView, type IndexingState } from "./footer.ts"
import type { PagePalette } from "./page-style.ts"

export interface FooterIndicatorProps {
  state: IndexingState
  points: number | null
  /** Footer verbosity, from the host's slot input. */
  showDetails: boolean
  palette: PagePalette
}

export function FooterIndicator(props: FooterIndicatorProps): JSX.Element {
  const view = footerView(props.state)
  return (
    <text fg={view.color(props.palette)}>
      {footerText(view, props.showDetails, props.points)}
    </text>
  )
}
