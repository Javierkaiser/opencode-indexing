import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import { mapConcurrent } from "../src/concurrency.ts"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("mapConcurrent", () => {
  test("never runs more than `limit` callbacks at once", async () => {
    const items = Array.from({ length: 12 }, (_, index) => index)
    let active = 0
    let maxActive = 0

    const results = await mapConcurrent(items, 3, async (item) => {
      active++
      maxActive = Math.max(maxActive, active)
      await delay(5)
      active--
      return item * 2
    })

    assert.equal(maxActive, 3, "all three slots were used")
    assert.ok(maxActive <= 3)
    assert.deepEqual(results, items.map((item) => item * 2))
  })

  test("preserves input order when callbacks finish out of order", async () => {
    const items = ["a", "b", "c", "d"]
    const results = await mapConcurrent(items, 4, async (item) => {
      // Later items finish first.
      await delay((items.length - items.indexOf(item)) * 2)
      return item.toUpperCase()
    })
    assert.deepEqual(results, ["A", "B", "C", "D"])
  })

  test("limit 1 runs sequentially", async () => {
    let active = 0
    let maxActive = 0
    const order: number[] = []

    await mapConcurrent([1, 2, 3, 4], 1, async (item) => {
      active++
      maxActive = Math.max(maxActive, active)
      await delay(1)
      order.push(item)
      active--
      return item
    })

    assert.equal(maxActive, 1)
    assert.deepEqual(order, [1, 2, 3, 4])
  })

  test("clamps a non-positive limit to one worker", async () => {
    let maxActive = 0
    let active = 0
    await mapConcurrent([1, 2, 3], 0, async (item) => {
      active++
      maxActive = Math.max(maxActive, active)
      await delay(1)
      active--
      return item
    })
    assert.equal(maxActive, 1)
  })

  test("empty input resolves to an empty array without calling fn", async () => {
    let calls = 0
    const results = await mapConcurrent([], 4, async () => {
      calls++
      return 1
    })
    assert.deepEqual(results, [])
    assert.equal(calls, 0)
  })

  test("a thrown error rejects the promise and stops new work", async () => {
    let started = 0
    const error = new Error("boom")
    await assert.rejects(
      mapConcurrent(Array.from({ length: 20 }, (_, index) => index), 2, async (item) => {
        started++
        await delay(1)
        if (item === 1) throw error
        return item
      }),
      (thrown) => thrown === error,
    )
    assert.ok(started < 20, `no further items started after the failure; started=${started}`)
  })

  test("propagates a synchronous throw as a rejection", async () => {
    await assert.rejects(
      mapConcurrent([1], 1, () => {
        throw new Error("sync boom")
      }),
      /sync boom/,
    )
  })
})
