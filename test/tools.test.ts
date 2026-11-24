import assert from "node:assert/strict"
import { beforeEach, describe, test } from "node:test"

import {
  AUTO_REFRESH_INTERVAL_MS,
  claimAutoRefreshSlot,
  invalidateAutoRefresh,
  releaseAutoRefreshSlot,
} from "../src/tools.ts"

/**
 * Auto-refresh scans the workspace before every search when enabled. The scan
 * is bounded but not free, so a burst of searches must share one check — and a
 * workspace whose index was just written must be checked immediately.
 */

const ROOT = "D:\\Projects\\demo"
const OTHER = "D:\\Projects\\other"

beforeEach(() => invalidateAutoRefresh())

describe("auto-refresh throttle", () => {
  test("two searches inside the interval share one check", () => {
    const start = 10_000
    assert.equal(claimAutoRefreshSlot(ROOT, start), true, "the first search checks")
    releaseAutoRefreshSlot(ROOT, start)
    assert.equal(claimAutoRefreshSlot(ROOT, start + AUTO_REFRESH_INTERVAL_MS - 1), false, "the second must not")
    assert.equal(claimAutoRefreshSlot(ROOT, start + AUTO_REFRESH_INTERVAL_MS), true, "after the interval it checks again")
  })

  test("workspaces are throttled independently", () => {
    assert.equal(claimAutoRefreshSlot(ROOT, 0), true)
    assert.equal(claimAutoRefreshSlot(OTHER, 0), true, "another workspace has its own slot")
    releaseAutoRefreshSlot(ROOT, 0)
    releaseAutoRefreshSlot(OTHER, 0)
    assert.equal(claimAutoRefreshSlot(ROOT, 1), false)
    assert.equal(claimAutoRefreshSlot(OTHER, 1), false)
  })

  test("invalidation makes the next check due immediately", () => {
    assert.equal(claimAutoRefreshSlot(ROOT, 0), true)
    assert.equal(claimAutoRefreshSlot(ROOT, 1), false)

    invalidateAutoRefresh(ROOT)
    assert.equal(claimAutoRefreshSlot(ROOT, 1), true, "the written workspace is checked now")
    assert.equal(claimAutoRefreshSlot(OTHER, 1), true, "and other workspaces were not affected")

    invalidateAutoRefresh()
    assert.equal(claimAutoRefreshSlot(ROOT, 2), true)
    assert.equal(claimAutoRefreshSlot(OTHER, 2), true)
  })

  test("a failed scan is not retried before the interval", () => {
    // `maybeAutoRefresh` claims the slot before scanning; a failure throws and
    // leaves the timestamp in place, so the next attempt waits for the TTL
    // instead of hammering a broken workspace on every search.
    assert.equal(claimAutoRefreshSlot(ROOT, 0), true)
    releaseAutoRefreshSlot(ROOT, 0)
    assert.equal(claimAutoRefreshSlot(ROOT, 4_999), false)
    assert.equal(claimAutoRefreshSlot(ROOT, 5_000), true)
  })

  test("a slow refresh cannot overlap itself", () => {
    // The scan/refresh runs longer than the TTL. A second search must still
    // skip: the in-flight slot, not the timestamp, is what prevents overlap.
    assert.equal(claimAutoRefreshSlot(ROOT, 0), true)
    assert.equal(claimAutoRefreshSlot(ROOT, AUTO_REFRESH_INTERVAL_MS * 2), false, "still in flight")
    releaseAutoRefreshSlot(ROOT, AUTO_REFRESH_INTERVAL_MS * 3)
    assert.equal(
      claimAutoRefreshSlot(ROOT, AUTO_REFRESH_INTERVAL_MS * 3 + 1),
      false,
      "the interval starts when the refresh finishes",
    )
    assert.equal(claimAutoRefreshSlot(ROOT, AUTO_REFRESH_INTERVAL_MS * 4 + 1), true, "and then it checks again")
  })
})
