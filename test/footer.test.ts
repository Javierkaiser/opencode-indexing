import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  activeWorkspace,
  footerAction,
  footerState,
  footerText,
  footerView,
  formatPoints,
  type IndexingState,
  type WorkspaceSources,
} from "../tui/footer.ts"
import { pagePalette, type PagePalette } from "../tui/page-style.ts"

const PALETTE: PagePalette = pagePalette(undefined)

describe("formatPoints", () => {
  test("keeps the footer short", () => {
    assert.equal(formatPoints(0), "0")
    assert.equal(formatPoints(999), "999")
    assert.equal(formatPoints(1_000), "1.0k")
    assert.equal(formatPoints(81_360), "81.4k")
    assert.equal(formatPoints(2_500_000), "2.5M")
  })

  test("never prints NaN for nonsense", () => {
    assert.equal(formatPoints(Number.NaN), "?")
    assert.equal(formatPoints(-1), "?")
  })
})

describe("footerState", () => {
  test("paused wins over everything else", () => {
    assert.equal(
      footerState({ enabled: false, ownPoints: 100, ownComplete: true, hasKilo: true }),
      "paused",
    )
    assert.equal(footerState({ enabled: false, ownPoints: null, ownComplete: null, hasKilo: false }), "paused")
  })

  test("a complete own index is ready", () => {
    assert.equal(footerState({ enabled: true, ownPoints: 81_360, ownComplete: true, hasKilo: false }), "ready")
  })

  test("an incomplete own index is stale", () => {
    assert.equal(footerState({ enabled: true, ownPoints: 81_360, ownComplete: false, hasKilo: false }), "stale")
    assert.equal(footerState({ enabled: true, ownPoints: 5, ownComplete: null, hasKilo: false }), "stale")
  })

  test("nothing indexed falls back to whether Kilo can be read", () => {
    assert.equal(footerState({ enabled: true, ownPoints: null, ownComplete: null, hasKilo: true }), "empty")
    assert.equal(footerState({ enabled: true, ownPoints: null, ownComplete: null, hasKilo: false }), "unavailable")
  })
})

describe("footerAction", () => {
  test("paused resumes, ready pauses", () => {
    assert.equal(footerAction("paused"), "resume")
    assert.equal(footerAction("ready"), "pause")
  })

  test("anything indexable starts indexing", () => {
    for (const state of ["empty", "stale", "unavailable"] as const) {
      assert.equal(footerAction(state), "start", `${state} should start indexing`)
    }
  })

  test("transient states only re-read the status", () => {
    assert.equal(footerAction("loading"), "restatus")
    assert.equal(footerAction("error"), "restatus")
  })

  test("a run in flight is not restartable", () => {
    // Without this, selecting the command twice would start two concurrent runs.
    assert.equal(footerAction("working"), "restatus")
    assert.match(footerText(footerView("working"), false), /indexing/)
  })
})

describe("footerView", () => {
  test("gives every state a distinct glyph and a non-empty label", () => {
    const states: IndexingState[] = ["loading", "paused", "ready", "stale", "empty", "unavailable", "error"]
    const glyphs = new Set<string>()
    for (const state of states) {
      const view = footerView(state)
      assert.ok(view.glyph.length > 0, `${state} needs a glyph`)
      assert.ok(view.label.length > 0, `${state} needs a label`)
      assert.ok(view.detail.length > 0, `${state} needs a detail line`)
      glyphs.add(view.glyph)
    }
    assert.equal(glyphs.size, states.length, "glyphs must be distinguishable at a glance")
  })

  test("colors come from the palette rather than being hardcoded", () => {
    assert.equal(footerView("ready").color(PALETTE), PALETTE.success)
    assert.equal(footerView("stale").color(PALETTE), PALETTE.accent)
    assert.equal(footerView("error").color(PALETTE), PALETTE.error)
    assert.equal(footerView("paused").color(PALETTE), PALETTE.muted)
  })
})

describe("activeWorkspace", () => {
  /** Host where one tab is focused and every session names its directory. */
  const sources = (overrides: Partial<WorkspaceSources> = {}): WorkspaceSources => ({
    tabsEnabled: () => true,
    tabs: () => [
      { sessionID: "ses-home", active: false },
      { sessionID: "ses-work", active: true },
    ],
    sessions: () => [
      { id: "ses-home", location: { directory: "C:\\Users\\clust" } },
      { id: "ses-work", location: { directory: "D:\\Proyectos\\opencode-indexing" } },
    ],
    instanceDirectory: () => "C:\\Users\\clust",
    ...overrides,
  })

  test("resolves the ACTIVE tab's session directory", () => {
    assert.equal(
      activeWorkspace(sources()),
      "D:\\Proyectos\\opencode-indexing",
      "the tab the user is looking at wins over the instance directory",
    )
  })

  test("ignores the tabs that are not focused", () => {
    assert.equal(activeWorkspace(sources({ tabs: () => [{ sessionID: "ses-home", active: false }] })), "C:\\Users\\clust")
    assert.equal(
      activeWorkspace(
        sources({
          tabs: () => [
            { sessionID: "ses-home", active: true },
            { sessionID: "ses-work", active: false },
          ],
        }),
      ),
      "C:\\Users\\clust",
    )
  })

  test("falls back to the instance directory when tabs are disabled", () => {
    let sessionReads = 0
    assert.equal(
      activeWorkspace(
        sources({
          tabsEnabled: () => false,
          sessions: () => {
            sessionReads++
            return []
          },
        }),
      ),
      "C:\\Users\\clust",
    )
    assert.equal(sessionReads, 0, "with tabs off the session list is not even consulted")
  })

  test("falls back when the host names no directory for the active tab", () => {
    assert.equal(activeWorkspace(sources({ tabs: () => [] })), "C:\\Users\\clust", "no focused tab")
    assert.equal(
      activeWorkspace(sources({ sessions: () => [{ id: "ses-home", location: { directory: "C:\\Users\\clust" } }] })),
      "C:\\Users\\clust",
      "the active tab's session is not loaded yet",
    )
    assert.equal(
      activeWorkspace(sources({ sessions: () => [{ id: "ses-work" }] })),
      "C:\\Users\\clust",
      "the session carries no location",
    )
  })
})

describe("footerText", () => {
  test("compact form is glyph plus label", () => {
    assert.equal(footerText(footerView("ready"), false, 81_360), "● indexed")
  })

  test("detailed form adds the point count and the explanation", () => {
    const text = footerText(footerView("ready"), true, 81_360)
    assert.ok(text.startsWith("● indexed"))
    assert.ok(text.includes("81.4k"))
    assert.ok(text.includes("index up to date"))
  })

  test("omits the point count when there is nothing indexed", () => {
    assert.match(footerText(footerView("empty"), true, null), /not indexed {2}no own index yet$/)
  })

  test("omits a zero count rather than showing 0", () => {
    assert.match(footerText(footerView("stale"), true, 0), /index stale {2}index needs a refresh$/)
  })
})
