import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  describeRow,
  forgetWorkspaceFlow,
  formatPoints,
  formatUpdatedAt,
  loadWorkspaces,
  type WorkspaceRow,
  type WorkspacesRpc,
} from "../tui/workspaces.ts"

const ROW: WorkspaceRow = {
  store: "oc-ca2cfc6b644e501b",
  root: "D:\\Proyectos\\opencode-indexing",
  points: 571,
  complete: true,
  profile: "mistral:codestral-embed-2505:1536",
  updatedAt: "2026-10-09T12:00:00.000Z",
  source: "registry",
}

function fakeRpc(rows: WorkspaceRow[], forget?: (store: string) => { summary: string; pointsDeleted: number | null }): {
  rpc: WorkspacesRpc
  forgotten: string[]
} {
  const forgotten: string[] = []
  const rpc = {
    "workspaces.list": async () => ({ workspaces: rows }),
    "workspace.forget": async (input: { store: string }) => {
      forgotten.push(input.store)
      return forget ? forget(input.store) : { summary: `Forgot ${input.store}`, pointsDeleted: 10 }
    },
  } as WorkspacesRpc
  return { rpc, forgotten }
}

describe("formatPoints", () => {
  test("keeps the row short", () => {
    assert.equal(formatPoints(0), "0 pts")
    assert.equal(formatPoints(999), "999 pts")
    assert.equal(formatPoints(1000), "1.0k pts")
    assert.equal(formatPoints(8573), "8.6k pts")
    assert.equal(formatPoints(2_500_000), "2.5M pts")
  })

  test("never prints a misleading number", () => {
    assert.equal(formatPoints(null), "unknown size")
    assert.equal(formatPoints(Number.NaN), "unknown size")
    assert.equal(formatPoints(-5), "unknown size")
  })
})

describe("formatUpdatedAt", () => {
  test("shows the day of the last recorded run", () => {
    assert.equal(formatUpdatedAt("2026-10-09T12:00:00.000Z"), "last run 2026-10-09")
  })

  test("says so when the date is missing or invalid", () => {
    assert.equal(formatUpdatedAt(null), "last run unknown")
    assert.equal(formatUpdatedAt("not-a-date"), "last run unknown")
  })
})

describe("describeRow", () => {
  test("names the directory when the registry knows it", () => {
    const text = describeRow(ROW)
    assert.ok(text.includes("D:\\Proyectos\\opencode-indexing"))
    assert.ok(text.includes("571 pts"))
    assert.ok(text.includes("last run 2026-10-09"))
    assert.ok(!text.includes("incomplete"))
  })

  test("falls back to the collection name when the directory is unknown", () => {
    const text = describeRow({ ...ROW, root: null, updatedAt: null, source: "collection" })
    assert.ok(text.includes("unknown workspace (oc-ca2cfc6b644e501b)"))
    assert.ok(text.includes("last run unknown"))
  })

  test("flags an incomplete run", () => {
    assert.ok(describeRow({ ...ROW, complete: false }).includes("incomplete"))
  })
})

describe("loadWorkspaces", () => {
  test("returns the rows and counts the unknown ones", async () => {
    const { rpc } = fakeRpc([ROW, { ...ROW, store: "oc-x", root: null, source: "collection" }])
    const view = await loadWorkspaces(rpc)
    assert.equal(view.rows.length, 2)
    assert.equal(view.unknownCount, 1)
  })

  test("degrades to an empty view instead of throwing", async () => {
    const rpc = {
      "workspaces.list": async () => {
        throw new Error("qdrant down")
      },
      "workspace.forget": async () => ({ summary: "", pointsDeleted: null }),
    } as WorkspacesRpc
    const view = await loadWorkspaces(rpc)
    assert.deepEqual(view.rows, [])
    assert.equal(view.unknownCount, 0)
  })
})

describe("forgetWorkspaceFlow", () => {
  test("deletes the chosen workspace after confirmation", async () => {
    const { rpc, forgotten } = fakeRpc([ROW])
    const summary = await forgetWorkspaceFlow(
      rpc,
      async () => ROW,
      async () => true,
    )
    assert.deepEqual(forgotten, [ROW.store])
    assert.equal(summary, `Forgot ${ROW.store}`)
  })

  test("does nothing when the list is empty", async () => {
    const { rpc, forgotten } = fakeRpc([])
    const summary = await forgetWorkspaceFlow(
      rpc,
      async () => undefined,
      async () => true,
    )
    assert.equal(summary, "No indexed workspaces to forget.")
    assert.deepEqual(forgotten, [])
  })

  test("does nothing when the user picks nothing", async () => {
    const { rpc, forgotten } = fakeRpc([ROW])
    const summary = await forgetWorkspaceFlow(
      rpc,
      async () => undefined,
      async () => true,
    )
    assert.equal(summary, "Cancelled.")
    assert.deepEqual(forgotten, [])
  })

  test("does nothing when the user declines the confirmation", async () => {
    const { rpc, forgotten } = fakeRpc([ROW])
    let confirmed = 0
    const summary = await forgetWorkspaceFlow(
      rpc,
      async () => ROW,
      async () => {
        confirmed++
        return false
      },
    )
    assert.equal(summary, "Cancelled.")
    assert.equal(confirmed, 1, "the confirmation must be asked before deleting")
    assert.deepEqual(forgotten, [], "a declined confirmation must not delete anything")
  })
})
