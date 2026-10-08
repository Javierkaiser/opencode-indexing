import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import { createTools, type ToolDeps, type ToolDefinition } from "../src/tools.ts"
import type { IndexingSettings } from "../src/types.ts"

function settings(overrides: Partial<IndexingSettings> = {}): IndexingSettings {
  return {
    provider: "mistral",
    modelId: "codestral-embed-2505",
    dimension: 1536,
    vectorStore: "qdrant",
    qdrantUrl: "http://127.0.0.1:1", // unreachable: nothing here should reach the network
    lancedbDirectory: "unused",
    scoreThreshold: 0.35,
    searchMaxResults: 5,
    embeddingBatchSize: 60,
    maxFileSizeBytes: 1024 * 1024,
    fileExtensions: [],
    autoRefresh: true,
    importFromKilo: true,
    enabled: true,
    credentials: {},
    warnings: [],
    ...overrides,
  }
}

function toolNamed(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((tool) => tool.name === name)
  assert.ok(found, `missing tool ${name}`)
  return found
}

function deps(overrides: Partial<IndexingSettings> = {}): ToolDeps {
  return {
    kv: { get: async () => undefined, set: async () => {}, delete: async () => {} } as never,
    root: "C:\\workspace",
    getSettings: async () => settings(overrides),
  }
}

describe("indexing pause switch", () => {
  test("refuses every tool that would write the own index", async () => {
    for (const name of ["build", "refresh", "import"]) {
      const tool = toolNamed(createTools(deps({ enabled: false })), name)
      await assert.rejects(
        () => tool.execute({}, {}),
        (error: Error) => {
          assert.match(error.message, /paused/i)
          return true
        },
        `${name} must refuse while indexing is paused`,
      )
    }
  })

  test("the refusal names the ways to re-enable it", async () => {
    const tool = toolNamed(createTools(deps({ enabled: false })), "build")
    await assert.rejects(
      () => tool.execute({}, {}),
      (error: Error) => {
        assert.match(error.message, /footer indicator/)
        assert.match(error.message, /indexing-config set enabled true/)
        return true
      },
    )
  })

  test("search is still allowed while paused", async () => {
    // It may fail for unrelated reasons (no backend in a unit test), but it must
    // not fail with the "paused" refusal: reading Kilo's index stays possible.
    const tool = toolNamed(createTools(deps({ enabled: false })), "search")
    try {
      await tool.execute({ query: "anything" }, {})
    } catch (error) {
      assert.doesNotMatch((error as Error).message, /paused/i)
    }
  })

  test("search resolves while paused, reporting the backend failure instead of the pause", async () => {
    // The search tool collects backend errors into its output rather than
    // throwing, so the contract to check is "it answered" and "it did not blame
    // the pause". The unreachable Qdrant URL stands in for a real backend.
    const tool = toolNamed(createTools(deps({ enabled: false, autoRefresh: true })), "search")
    const result = await tool.execute({ query: "anything" }, {})
    assert.doesNotMatch(result.output, /paused/i)
  })
})
