import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import { LABEL_COLUMN, pagePalette, type ThemeLike } from "../tui/page-style.ts"

/** Minimal theme with every token the page reads. */
const THEME = {
  text: {
    base: "text-base",
    muted: "text-muted",
    action: {
      primary: { base: "primary-base", selected: "primary-selected" },
      secondary: { base: "secondary-base", selected: "secondary-selected" },
    },
    feedback: {
      success: { base: "success-base", muted: "success-muted" },
      error: { base: "error-base", muted: "error-muted" },
      info: { base: "info-base", muted: "info-muted" },
    },
  },
  background: {
    base: "bg-base",
    raised: { base: "raised-base", high: "raised-high", max: "raised-max" },
    action: { secondary: { base: "action-bg-base", selected: "action-bg-selected" } },
  },
  border: { base: "border-base" },
} as unknown as ThemeLike

describe("pagePalette", () => {
  test("maps every role to the host theme token", () => {
    const palette = pagePalette(THEME)
    assert.equal(palette.title, "text-base")
    assert.equal(palette.value, "text-base")
    assert.equal(palette.muted, "text-muted")
    assert.equal(palette.label, "secondary-base")
    assert.equal(palette.selectedFg, "primary-selected")
    assert.equal(palette.selectedBg, "action-bg-selected")
    assert.equal(palette.accent, "primary-base")
    assert.equal(palette.success, "success-base")
    assert.equal(palette.error, "error-base")
  })

  test("every palette role is defined and nothing unused lingers", () => {
    const palette = pagePalette(THEME)
    for (const [role, color] of Object.entries(palette)) {
      assert.notEqual(color, undefined, `${role} must resolve`)
    }
    // Guards against the palette growing roles the view never reads.
    assert.deepEqual(Object.keys(palette).sort(), [
      "accent",
      "error",
      "label",
      "muted",
      "selectedBg",
      "selectedFg",
      "success",
      "title",
      "value",
    ])
  })

  test("falls back to neutral colors without a theme", () => {
    const palette = pagePalette(undefined)
    assert.equal(palette.title, "#FFFFFF")
    assert.equal(palette.muted, "#888888")
    assert.equal(palette.selectedBg, "#334455")
  })

  test("survives a partial custom theme document", () => {
    const partial = {
      text: { base: "only-base" },
      background: {},
      border: {},
    } as unknown as ThemeLike
    const palette = pagePalette(partial)
    assert.equal(palette.title, "only-base")
    assert.equal(palette.label, "#CCCCCC", "missing secondary falls back")
    assert.equal(palette.selectedBg, "#334455")
  })

  test("tolerates a null theme and missing action maps", () => {
    const palette = pagePalette({
      text: { base: "b", muted: "m", action: undefined, feedback: undefined },
      background: { base: "bg", action: undefined },
      border: {},
    } as unknown as ThemeLike)
    assert.equal(palette.title, "b")
    assert.equal(palette.muted, "m")
    assert.equal(palette.accent, "#7AA2F7")
  })

  test("uses the raised surface when there is no selected action background", () => {
    const noSelected = {
      ...THEME,
      background: { base: "bg-base", raised: { high: "raised-high" } },
    } as unknown as ThemeLike
    assert.equal(pagePalette(noSelected).selectedBg, "raised-high")
  })

  test("prefers the primary action fill so the selection matches the host dialogs", () => {
    const withPrimary = {
      ...THEME,
      background: {
        base: "bg-base",
        action: {
          primary: { base: "primary-bg-base", selected: "accent-orange" },
          secondary: { base: "secondary-bg-base", selected: "transparent" },
        },
      },
    } as unknown as ThemeLike
    assert.equal(pagePalette(withPrimary).selectedBg, "accent-orange")
  })

  test('treats an explicit "transparent" as missing, not as a colour', () => {
    const transparent = {
      text: {
        base: "text-base",
        muted: "text-muted",
        action: { secondary: { base: "sec-base", selected: "transparent" } },
        feedback: { success: { base: "transparent", muted: "x" } },
      },
      background: { base: "bg", action: { secondary: { base: "bg-base", selected: "transparent" } } },
      border: { base: "transparent" },
    } as unknown as ThemeLike

    const palette = pagePalette(transparent)
    assert.equal(palette.selectedBg, "#334455", "a transparent fill must fall through to a visible colour")
    assert.equal(palette.success, "#7ECF7E")
  })

  test('a transparent selected foreground still yields readable selection text', () => {
    const transparentFg = {
      text: {
        base: "text-base",
        muted: "text-muted",
        action: { primary: { base: "primary-base", selected: "TRANSPARENT " } },
        feedback: {},
      },
      background: { base: "bg", action: {} },
      border: {},
    } as unknown as ThemeLike
    assert.equal(pagePalette(transparentFg).selectedFg, "primary-base")
  })
})

describe("LABEL_COLUMN", () => {
  test("fits the longest configuration label", () => {
    assert.ok(LABEL_COLUMN >= "Import from Kilo".length)
  })
})
