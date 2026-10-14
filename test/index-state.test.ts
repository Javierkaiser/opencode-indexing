import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import { GLYPHS, LABELS, indexState, indexStatusLine, formatPoints } from "../src/index-state.ts"
import { footerView } from "../tui/footer.ts"

describe("indexStatusLine", () => {
  const root = "D:\\workspace\\demo"

  test("a complete own index reads as ready, with its size and workspace", () => {
    const line = indexStatusLine({ enabled: true, ownPoints: 571, ownComplete: true, hasKilo: false, root })
    assert.equal(line, `Index: ● indexed · own 571 pts · ${root}`)
  })

  test("an incomplete own index reads as stale", () => {
    const line = indexStatusLine({ enabled: true, ownPoints: 120, ownComplete: false, hasKilo: false, root })
    assert.match(line, /^Index: ◐ index stale/)
  })

  test("paused wins over a complete index", () => {
    // Pausing must not be hidden by a healthy index: it means writes are refused.
    const line = indexStatusLine({ enabled: false, ownPoints: 571, ownComplete: true, hasKilo: true, root })
    assert.match(line, /^Index: ⏸ paused/)
  })

  test("falls back to the Kilo index when there is no own index yet", () => {
    const line = indexStatusLine({ enabled: true, hasKilo: true, kiloPoints: 31_261, root })
    assert.equal(line, `Index: ○ not indexed · kilo 31.3k pts · ${root}`)
  })

  test("reports no index at all when neither source exists", () => {
    const line = indexStatusLine({ enabled: true, hasKilo: false, root })
    assert.equal(line, `Index: ✕ no index · ${root}`)
  })

  test("omits the root when the caller does not know it", () => {
    const line = indexStatusLine({ enabled: true, ownPoints: 42, ownComplete: true, hasKilo: false })
    assert.equal(line, "Index: ● indexed · own 42 pts")
  })

  test("shows the workspace, because the server runs in its own directory", () => {
    // The server plugin is instantiated for the service directory, so without
    // the root the line reads as if it described the wrong folder.
    const line = indexStatusLine({ enabled: true, ownPoints: 1, ownComplete: true, hasKilo: false, root })
    assert.ok(line.includes(root))
  })
})

describe("indexState", () => {
  test("an unreachable store is not the same as an empty one", () => {
    // A stopped Qdrant once reported "no index", which reads as "nothing is
    // indexed" when the truth is "we could not look".
    assert.equal(indexState({ enabled: true, ownPoints: null, hasKilo: false, ownStoreReachable: false }), "error")
    assert.notEqual(
      indexState({ enabled: true, ownPoints: null, hasKilo: false, ownStoreReachable: false }),
      "unavailable",
    )
  })

  test("a reachable store with nothing in it still reports empty", () => {
    assert.equal(indexState({ enabled: true, ownPoints: null, hasKilo: false, ownStoreReachable: true }), "unavailable")
  })

  test("an unreachable store wins over a paused setting", () => {
    // "Re-read" is the action for an unreadable store; "resume" would fail again.
    assert.equal(
      indexState({ enabled: false, ownPoints: null, hasKilo: false, ownStoreReachable: false }),
      "error",
    )
  })

  test("LanceDB does not depend on Qdrant being up", () => {
    assert.equal(
      indexState({ enabled: true, ownPoints: 42, ownComplete: true, hasKilo: false, ownStoreReachable: false }),
      "error",
      "reachability is about the store that was actually read",
    )
  })
})

describe("shared vocabulary", () => {
  const states = ["loading", "working", "paused", "ready", "stale", "empty", "unavailable", "error"] as const

  test("every state has a glyph and a label", () => {
    for (const state of states) {
      assert.ok(GLYPHS[state], `missing glyph for ${state}`)
      assert.ok(LABELS[state], `missing label for ${state}`)
    }
  })

  test("the footer renders exactly the shared wording", () => {
    // The footer used to carry its own copy of these strings. If it drifts from
    // the chat line, the same state reads two different ways to a user.
    for (const state of states) {
      const view = footerView(state)
      assert.equal(view.glyph, GLYPHS[state])
      assert.equal(view.label, LABELS[state])
    }
  })

  test("indexState and the line agree on the state", () => {
    const line = indexStatusLine({ enabled: true, ownPoints: 5, ownComplete: false, hasKilo: false })
    assert.ok(line.includes(LABELS[indexState({ enabled: true, ownPoints: 5, ownComplete: false, hasKilo: false })]))
  })

  test("formatPoints keeps the line short", () => {
    assert.equal(formatPoints(999), "999")
    assert.equal(formatPoints(12_345), "12.3k")
    assert.equal(formatPoints(2_500_000), "2.5M")
    assert.equal(formatPoints(Number.NaN), "?")
  })
})