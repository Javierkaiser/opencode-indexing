import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  EDIT_ROW,
  PAGE_ACTIONS,
  PAGE_ROWS,
  actionRowText,
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
  configuredProviders: ["mistral"],
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

  test("carries the version of the server answering the call", async () => {
    const { rpc } = fakeRpc({
      "settings.get": async () => ({ settings: SETTINGS, version: "0.3.5" }),
    })
    const data = await loadSettingsPageData(rpc)
    assert.equal(data.version, "0.3.5")
  })

  test("reports an unknown version when the response does not carry one", async () => {
    // Older servers answered `settings.get` without a version; the page must
    // still render a value instead of blanking the row.
    const { rpc } = fakeRpc({
      "settings.get": async () => ({ settings: SETTINGS }),
    })
    const data = await loadSettingsPageData(rpc)
    assert.equal(data.version, "unknown")
  })

  test("a hung RPC degrades after the timeout instead of hanging the page", async () => {
    const never = (): Promise<never> => new Promise<never>(() => {})
    const { rpc } = fakeRpc({
      "settings.get": never,
      "kilo.discover": never,
      "status.get": never,
      "workspaces.list": never,
    })
    const data = await loadSettingsPageData(rpc, { timeoutMs: 20 })
    assert.equal(data.settings, UNKNOWN_SETTINGS)
    assert.equal(data.version, "unknown")
    assert.deepEqual(data.sources, [])
    assert.equal(data.status.summary, "(status unavailable)")
    assert.deepEqual(data.workspaces, { rows: [], unknownCount: 0 })
  })

  test("a hung settings.get alone still renders the rest of the page", async () => {
    const never = (): Promise<never> => new Promise<never>(() => {})
    const { rpc } = fakeRpc({ "settings.get": never })
    const data = await loadSettingsPageData(rpc, { timeoutMs: 20 })
    assert.equal(data.settings, UNKNOWN_SETTINGS)
    assert.equal(data.sources.length, 1, "the calls that answered must still be used")
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
    assert.ok(get("Credentials").includes("mistral"))
    assert.ok(!get("Credentials").includes("openai"))
  })

  test("credentials row lists every configured provider, not just two", () => {
    // The row used to be built from two hardcoded booleans, so a Gemini key
    // showed as "none configured" while the provider was fully usable.
    const rows = configRows({
      ...SETTINGS,
      configuredProviders: ["mistral", "gemini", "voyage", "openrouter", "ollama"],
    })
    const value = rows.find((row) => row.label === "Credentials")?.value ?? ""
    for (const provider of ["mistral", "gemini", "voyage", "openrouter", "ollama"]) {
      assert.ok(value.includes(provider), `${provider} must appear in the credentials row`)
    }
  })

  test("no credentials configured says so", () => {
    const rows = configRows({ ...SETTINGS, configuredProviders: [] })
    assert.equal(rows.find((row) => row.label === "Credentials")?.value, "none configured")
  })

  test("renders lancedb backend path", () => {
    const rows = configRows({ ...SETTINGS, vectorStore: "lancedb" })
    assert.ok(rows.find((row) => row.label === "Vector store")?.value.includes("LanceDB"))
  })

  test("shows the plugin version next to the settings file", () => {
    const rows = configRows(SETTINGS, "0.3.5")
    const labels = rows.map((row) => row.label)
    assert.equal(rows.find((row) => row.label === "Plugin version")?.value, "0.3.5")
    // Both rows answer "where does this come from?", so they travel together.
    assert.equal(labels[labels.indexOf("Settings file") + 1], "Plugin version")
  })

  test("says unknown when no version was reported", () => {
    assert.equal(configRows(SETTINGS).find((row) => row.label === "Plugin version")?.value, "unknown")
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

  test("a failed run keeps its reason on the page", async () => {
    // The page shows one line per action, so the reason has to ride along with
    // the summary or the user is left with "Indexing failed" and nothing else.
    const { rpc } = fakeRpc({
      "index.build": async () => ({
        summary: "Indexing failed",
        error: "Qdrant GET /collections/oc-abc failed: Unable to connect",
      }),
    })
    const result = await actionById("build")!.run(rpc)
    assert.match(result, /Unable to connect/)
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

describe("actionRowText", () => {
  test("shows only the title when the row is not selected", () => {
    const row = PAGE_ROWS[0]
    assert.equal(actionRowText(row, false), row.title)
    assert.ok(!actionRowText(row, false).includes(row.description))
  })

  test("appends the description to the same string when selected", () => {
    const row = PAGE_ROWS[0]
    const text = actionRowText(row, true)
    assert.ok(text.startsWith(row.title))
    assert.ok(text.includes(row.description))
    // One string, not two elements: mounting it separately made the host draw it
    // over the title.
    assert.equal(text.split("\n").length, 1)
  })

  test("covers every row without losing a description", () => {
    for (const row of PAGE_ROWS) {
      assert.ok(actionRowText(row, true).includes(row.description), `row ${row.row} lost its description`)
    }
  })
})
