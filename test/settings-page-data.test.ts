import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  EDIT_ROW,
  PAGE_ACTIONS,
  PAGE_ROWS,
  RELOAD_ROW,
  UNKNOWN_SETTINGS,
  actionById,
  configRows,
  describeSource,
  loadSettingsPageData,
  type SettingsPageRpc,
  type SettingsView,
} from "../tui/settings-page-data.ts"

const SETTINGS: SettingsView = {
  vectorStore: "qdrant",
  qdrantUrl: "http://localhost:6333",
  qdrantApiKey: "",
  lancedbDirectory: "C:\\state\\lancedb",
  provider: "mistral",
  model: "codestral-embed-2505",
  dimension: 1536,
  importFromKilo: true,
  enabled: true,
  autoRefresh: false,
  searchMaxResults: 50,
  hasMistralKey: true,
  hasOpenAiKey: false,
  settingsFile: "C:\\config\\indexing.json",
}

function fakeRpc(overrides: Partial<Record<keyof SettingsPageRpc, unknown>> = {}): { rpc: SettingsPageRpc; calls: string[] } {
  const calls: string[] = []
  const rpc = {
    "settings.get": async () => {
      calls.push("settings.get")
      return { settings: SETTINGS }
    },
    "settings.set": async () => {
      calls.push("settings.set")
      return { settings: SETTINGS }
    },
    "settings.test": async (input: { target: string }) => {
      calls.push(`settings.test:${input.target}`)
      return { ok: true, message: "reachable" }
    },
    "kilo.discover": async () => {
      calls.push("kilo.discover")
      return {
        sources: [
          { kind: "qdrant", name: "ws-abc", pointsCount: 10, complete: true, profile: "mistral:model:1536", compatible: true },
        ],
      }
    },
    "status.get": async () => {
      calls.push("status.get")
      return { summary: "2,000 points", recommendation: "all good" }
    },
    "index.build": async () => {
      calls.push("index.build")
      return { summary: "built" }
    },
    "index.refresh": async () => {
      calls.push("index.refresh")
      return { summary: "refreshed" }
    },
    "index.import": async (input: { source?: string }) => {
      calls.push(`index.import:${input.source ?? ""}`)
      return { summary: "imported" }
    },
    ...overrides,
  } as unknown as SettingsPageRpc
  return { rpc, calls }
}

describe("loadSettingsPageData", () => {
  test("gathers settings, sources and status concurrently", async () => {
    const { rpc } = fakeRpc()
    const data = await loadSettingsPageData(rpc)
    assert.equal(data.settings.provider, "mistral")
    assert.equal(data.sources.length, 1)
    assert.equal(data.status.summary, "2,000 points")
  })

  test("degrades when sources or status fail", async () => {
    const { rpc } = fakeRpc({
      "kilo.discover": async () => {
        throw new Error("qdrant down")
      },
      "status.get": async () => {
        throw new Error("boom")
      },
    })
    const data = await loadSettingsPageData(rpc)
    assert.deepEqual(data.sources, [])
    assert.equal(data.status.summary, "(status unavailable)")
  })

  test("renders instead of hanging when settings.get fails", async () => {
    const { rpc } = fakeRpc({
      "settings.get": async () => {
        throw new Error("server plugin not ready")
      },
    })
    // Before the fix this rejected, and the page sat on "Loading…" forever.
    const data = await loadSettingsPageData(rpc)
    assert.equal(data.settings, UNKNOWN_SETTINGS)
    assert.equal(configRows(data.settings)[0]?.value.includes("(unavailable)"), true)
  })

  test("never rejects, whatever fails", async () => {
    const boom = async (): Promise<never> => {
      throw new Error("boom")
    }
    const data = await loadSettingsPageData({
      "settings.get": boom,
      "settings.set": boom,
      "settings.test": boom,
      "kilo.discover": boom,
      "status.get": boom,
      "index.build": boom,
      "index.refresh": boom,
      "index.import": boom,
    } as unknown as SettingsPageRpc)
    assert.equal(data.settings.settingsFile, "(unavailable)")
    assert.deepEqual(data.sources, [])
  })
})

describe("configRows", () => {
  test("renders qdrant backend and key presence", () => {
    const rows = configRows(SETTINGS)
    const get = (label: string) => rows.find((row) => row.label === label)?.value ?? ""
    assert.ok(get("Vector store").includes("Qdrant"))
    assert.ok(get("Vector store").includes("localhost:6333"))
    assert.ok(get("Embeddings").includes("mistral/codestral-embed-2505"))
    assert.equal(get("Import from Kilo").startsWith("ON"), true)
    assert.equal(get("Auto-refresh"), "OFF")
    assert.ok(get("API keys").includes("mistral"))
    assert.ok(!get("API keys").includes("openai"))
  })

  test("renders lancedb backend path", () => {
    const rows = configRows({ ...SETTINGS, vectorStore: "lancedb" })
    assert.ok(rows.find((row) => row.label === "Vector store")?.value.includes("LanceDB"))
  })
})

describe("describeSource", () => {
  test("formats points, state and compatibility", () => {
    const text = describeSource({
      kind: "lancedb",
      name: "db",
      pointsCount: 8548,
      complete: true,
      profile: "mistral:codestral-embed-2505:1536",
      compatible: true,
    })
    assert.ok(text.includes("8548 pts"))
    assert.ok(text.includes("complete"))
    assert.ok(!text.includes("INCOMPATIBLE"))

    const incompatible = describeSource({ kind: "qdrant", name: "ws-x", pointsCount: null, complete: false, profile: null, compatible: false })
    assert.ok(incompatible.includes("INCOMPATIBLE"))
    assert.ok(incompatible.includes("incomplete"))
  })
})

describe("PAGE_ACTIONS", () => {
  test("covers status/test/build/refresh/import", () => {
    const ids = PAGE_ACTIONS.map((action) => action.id)
    for (const expected of ["status", "test", "build", "build-scratch", "refresh", "import"]) {
      assert.ok(ids.includes(expected), `missing action ${expected}`)
    }
    assert.equal(actionById("nope"), undefined)
  })

  test("status action reports freshness through RPC", async () => {
    const { rpc, calls } = fakeRpc()
    const result = await actionById("status")!.run(rpc)
    assert.ok(calls.includes("status.get"))
    assert.ok(result.includes("2,000 points"))
    assert.ok(result.includes("all good"))
  })

  test("import action passes the selected source", async () => {
    const { rpc, calls } = fakeRpc()
    const result = await actionById("import")!.run(rpc, "ws-abc")
    assert.ok(calls.includes("index.import:ws-abc"))
    assert.equal(result, "imported")
  })

  test("test action collects per-target results", async () => {
    const { rpc } = fakeRpc()
    const result = await actionById("test")!.run(rpc)
    assert.ok(result.includes("qdrant: OK"))
    assert.ok(result.includes("lancedb: OK"))
    assert.ok(result.includes("provider: OK"))
  })
})

describe("PAGE_ROWS", () => {
  test("lists every action plus the two fixed rows, in order", () => {
    assert.equal(PAGE_ROWS.length, PAGE_ACTIONS.length + 2)
    assert.deepEqual(
      PAGE_ROWS.slice(0, PAGE_ACTIONS.length).map((row) => row.title),
      PAGE_ACTIONS.map((action) => action.title),
    )
    assert.equal(PAGE_ROWS[EDIT_ROW].title, "Edit settings…")
    assert.equal(PAGE_ROWS[RELOAD_ROW].title, "Reload status")
  })

  test("row indexes are contiguous and match the store size", () => {
    assert.deepEqual(
      PAGE_ROWS.map((row) => row.row),
      PAGE_ROWS.map((_row, position) => position),
    )
    // The store is sized from PAGE_ROWS.length in tui.ts; these two assertions are
    // what fail if a fixed row is added without reconciling the constants.
    assert.equal(PAGE_ROWS.length, RELOAD_ROW + 1)
    assert.equal(RELOAD_ROW, PAGE_ROWS.length - 1)
    assert.equal(EDIT_ROW, PAGE_ROWS.length - 2)
  })

  test("every row carries a title and a description for progressive disclosure", () => {
    for (const row of PAGE_ROWS) {
      assert.ok(row.title.length > 0, `row ${row.row} needs a title`)
      assert.ok(row.description.length > 0, `row ${row.row} needs a description`)
    }
  })

  test("row titles never repeat, so the selection is unambiguous", () => {
    const titles = PAGE_ROWS.map((row) => row.title)
    assert.equal(new Set(titles).size, titles.length)
  })
})
