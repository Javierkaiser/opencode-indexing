import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { TtlCache } from "../src/ttl-cache.ts"

/**
 * The cache is what makes repeated searches skip metadata round trips, so its
 * two failure modes matter: serving an expired value (wrong index reported) and
 * dropping a live one (a round trip on every search).
 */

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

describe("TtlCache", () => {
  test("serves a value until its ttl expires, then forgets it", () => {
    const time = clock()
    const cache = new TtlCache<string, number>({ now: time.now })

    cache.set("own", 42, 5_000)
    time.advance(4_999)
    assert.equal(cache.get("own"), 42)

    time.advance(1)
    assert.equal(cache.get("own"), undefined)
    assert.deepEqual(cache.keys(), [], "an expired entry is gone, not merely invisible")
  })

  test("a missing key is undefined", () => {
    const cache = new TtlCache<string, number>()
    assert.equal(cache.get("absent"), undefined)
  })

  test("overwriting replaces the value and restarts the ttl", () => {
    const time = clock()
    const cache = new TtlCache<string, string>({ now: time.now })

    cache.set("kilo", "ws-old", 1_000)
    time.advance(800)
    cache.set("kilo", "ws-new", 1_000)

    time.advance(400)
    assert.equal(cache.get("kilo"), "ws-new", "the first ttl must not expire the second value")
    time.advance(600)
    assert.equal(cache.get("kilo"), undefined)
  })

  test("delete removes one entry and clear removes all", () => {
    const time = clock()
    const cache = new TtlCache<string, string>({ now: time.now })
    cache.set("a", "1", 10_000)
    cache.set("b", "2", 10_000)

    assert.equal(cache.delete("a"), true)
    assert.equal(cache.get("a"), undefined)
    assert.equal(cache.get("b"), "2")
    assert.equal(cache.delete("a"), false)

    assert.deepEqual(cache.keys(), ["b"])
    cache.clear()
    assert.equal(cache.get("b"), undefined)
    assert.deepEqual(cache.keys(), [])
  })
})
