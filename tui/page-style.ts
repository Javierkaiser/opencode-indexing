/**
 * Visual tokens for the settings page.
 *
 * The host resolves its own theme (`context.theme`, typed by `@opencode/theme`)
 * and the page used to hardcode hex colors, which is why it looked foreign next
 * to the rest of the TUI and broke on light themes. Everything here maps theme
 * tokens to the handful of roles the page needs, with neutral fallbacks so the
 * page still renders on a host that does not expose a theme.
 *
 * Pure and free of renderer imports, so the mapping is unit-testable.
 */

import type { RGBA } from "@opentui/core"

/** Anything a renderable accepts as a color. */
export type PageColor = string | RGBA

/** Structural view of the parts of `ResolvedTheme` the page uses. */
export interface ThemeLike {
  text: {
    base: PageColor
    muted: PageColor
    action: Record<string, Record<string, PageColor> | undefined> | undefined
    feedback: Record<string, { base: PageColor; muted: PageColor } | undefined> | undefined
  }
  background: {
    base: PageColor
    raised?: { base?: PageColor; high?: PageColor; max?: PageColor }
    action?: Record<string, Record<string, PageColor> | undefined>
  }
  border: { base?: PageColor }
}

/** Colors used by the page, already resolved to something a renderable accepts. */
export interface PagePalette {
  /** Section headings. */
  title: PageColor
  /** Row labels in the configuration table. */
  label: PageColor
  /** Row values. */
  value: PageColor
  /** Descriptions, hints and secondary lines. */
  muted: PageColor
  /** Background of the selected row. */
  selectedBg: PageColor
  /** Text of the selected row. */
  selectedFg: PageColor
  /** Accent used for markers. */
  accent: PageColor
  success: PageColor
  error: PageColor
}

const FALLBACK = {
  title: "#FFFFFF",
  muted: "#888888",
  value: "#FFFFFF",
  label: "#CCCCCC",
  selectedBg: "#334455",
  selectedFg: "#FFFFFF",
  accent: "#7AA2F7",
  success: "#7ECF7E",
  error: "#F7768E",
} as const

/**
 * Returns the color unless it is missing or explicitly `"transparent"`.
 *
 * The theme schema allows `"transparent"` as a stateful color, and the default
 * theme uses it for the selected-row background of secondary actions. Treating
 * it as "present" is what made the selected row render with no highlight at all.
 */
function opaque(color: PageColor | undefined): PageColor | undefined {
  if (color === undefined || color === null) return undefined
  if (typeof color === "string" && color.trim().toLowerCase() === "transparent") return undefined
  return color
}

/**
 * Resolves the page palette from the host theme.
 *
 * `theme` may be undefined (host without theme support) or partial (custom theme
 * document that omits tokens), so every lookup falls back independently rather
 * than assuming a complete document.
 */
export function pagePalette(theme: ThemeLike | undefined | null): PagePalette {
  const text = theme?.text
  const background = theme?.background

  const action = (variant: string, state: string, fallback: PageColor): PageColor => {
    const entry = text?.action?.[variant]
    if (!entry) return fallback
    return opaque(entry[state]) ?? opaque(entry.base) ?? fallback
  }

  // The selected row is filled with the theme's accent, the way the host paints
  // the selection in its own dialogs, so the page and the dialogs agree.
  const selectedBg =
    opaque(background?.action?.primary?.selected) ??
    opaque(background?.action?.secondary?.selected) ??
    opaque(background?.raised?.high) ??
    FALLBACK.selectedBg

  const feedback = (kind: string, fallback: PageColor): PageColor => {
    const entry = text?.feedback?.[kind]
    return opaque(entry?.base) ?? fallback
  }

  return {
    title: opaque(text?.base) ?? FALLBACK.title,
    label: action("secondary", "base", FALLBACK.label),
    value: opaque(text?.base) ?? FALLBACK.value,
    muted: opaque(text?.muted) ?? FALLBACK.muted,
    selectedBg,
    selectedFg: action("primary", "selected", FALLBACK.selectedFg),
    accent: action("primary", "base", FALLBACK.accent),
    success: feedback("success", FALLBACK.success),
    error: feedback("error", FALLBACK.error),
  }
}

/** Width of the label column in the configuration table. */
export const LABEL_COLUMN = 18

/**
 * Selection affordance for the action rows.
 *
 * Background highlighting is not reliable: `expandTheme` falls a stateful
 * `$selected` back to `base`, and a theme that omits `background.action.*`
 * leaves the selected background transparent, which is why the selected row used
 * to look identical to the others. Text and marker contrast is always defined,
 * so selection is carried there instead.
 */
export const SELECTED_MARKER = "❯"
export const UNSELECTED_MARKER = " "
