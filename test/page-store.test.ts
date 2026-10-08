import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PAGE_KEYMAP, SettingsPageStore } from "../tui/page-store.ts"

describe("SettingsPageStore", () => {
  test("starts on the first row", () => {
    const store = new SettingsPageStore(4)
    assert.equal(store.index, 0)
  })

  test("down and up wrap around both ends", () => {
    const store = new SettingsPageStore(3)
    store.dispatch("down")
    assert.equal(store.index, 1)
    store.dispatch("down")
    assert.equal(store.index, 2)
    store.dispatch("down")
    assert.equal(store.index, 0, "down past the last row wraps to the first")
    store.dispatch("up")
    assert.equal(store.index, 2, "up before the first row wraps to the last")
  })

  test("every row is reachable, including the trailing ones", () => {
    const store = new SettingsPageStore(8)
    const seen = new Set<number>()
    for (let step = 0; step < 8; step++) {
      seen.add(store.index)
      store.dispatch("down")
    }
    assert.equal(seen.size, 8, "all 8 rows must be reachable by moving down")
  })

  test("navigation notifies listeners and clears any pending command", () => {
    const store = new SettingsPageStore(3)
    let notifications = 0
    store.subscribe(() => notifications++)

    store.dispatch("run")
    assert.equal(notifications, 1)
    assert.equal(store.takeCommand(), "run")

    store.dispatch("down")
    assert.equal(notifications, 2)
    assert.equal(store.takeCommand(), null, "moving must not leave a stale command")
  })

  test("takeCommand hands the command over exactly once", () => {
    const store = new SettingsPageStore(3)
    store.dispatch("edit")
    assert.equal(store.takeCommand(), "edit")
    assert.equal(store.takeCommand(), null)
  })

  test("unsubscribe stops notifications", () => {
    const store = new SettingsPageStore(3)
    let notifications = 0
    const stop = store.subscribe(() => notifications++)
    store.dispatch("down")
    stop()
    store.dispatch("down")
    assert.equal(notifications, 1)
  })

  test("an empty list ignores every command", () => {
    const store = new SettingsPageStore(0)
    let notifications = 0
    store.subscribe(() => notifications++)
    store.dispatch("down")
    store.dispatch("run")
    store.dispatch("close")
    assert.equal(store.index, 0)
    assert.equal(notifications, 0)
    assert.equal(store.takeCommand(), null)
  })
})

describe("PAGE_KEYMAP", () => {
  test("binds the keys the page advertises", () => {
    const binds = Object.fromEntries(PAGE_KEYMAP.map((entry) => [entry.command, entry.bind]))
    assert.equal(binds.close, "escape")
    assert.equal(binds.run, "return")
    assert.equal(binds.edit, "e")
    assert.equal(binds.reload, "r")
    assert.equal(binds.up, "up")
    assert.equal(binds.down, "down")
  })

  test("ids are unique so the host keymap accepts them", () => {
    const ids = PAGE_KEYMAP.map((entry) => entry.id)
    assert.equal(new Set(ids).size, ids.length)
  })
})
