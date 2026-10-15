import * as assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, test } from "node:test"

/**
 * `@lancedb/lancedb` is an optional dependency, and the two import-tool tests
 * below need it: they select LanceDB as the own store because it is the one
 * backend whose `info()` succeeds without a server, so the tool reaches
 * discovery. Without the native module `store.ensure()` throws first and the
 * assertions never run, so those tests skip instead of failing the run.
 */
const lanceUnavailable = await import("@lancedb/lancedb")
  .then(() => false as const)
  .catch(() => "optional @lancedb/lancedb is not installed")

import { createTools, type ToolContext, type ToolDeps, type ToolDefinition } from "../src/tools.ts"
import type { IndexingSettings } from "../src/types.ts"

/**
 * The tools used to be pinned to the plugin instance's own directory.
 *
 * The server plugin is instantiated for the directory the service runs in, so a
 * chat session opened in another project reported — and indexed — the service's
 * codebase while naming the user's. Nothing about that looked like a bug from
 * the tool's point of view: it was asked about a directory and it answered
 * faithfully about it.
 */
const SERVICE_ROOT = "C:\\service-install-dir"
const SESSION_ROOT = "D:\\Proyectos\\kine"

function settings(overrides: Partial<IndexingSettings> = {}): IndexingSettings {
  return {
    provider: "mistral",
    modelId: "codestral-embed-2505",
    dimension: 1536,
    vectorStore: "qdrant",
    kiloVectorStore: null,
    qdrantUrl: "http://127.0.0.1:1", // unreachable: nothing here should reach the network
    lancedbDirectory: "unused",
    scoreThreshold: 0.35,
    searchMaxResults: 5,
    embeddingBatchSize: 60,
    maxFileSizeBytes: 1024 * 1024,
    fileExtensions: [],
    autoRefresh: false,
    importFromKilo: true,
    enabled: true,
    credentials: {},
    warnings: [],
    ...overrides,
  }
}

function deps(overrides: Partial<IndexingSettings> = {}): ToolDeps {
  return {
    kv: { get: async () => undefined, set: async () => {}, delete: async () => {} } as never,
    root: SERVICE_ROOT,
    getSettings: async () => settings(overrides),
  }
}

function toolNamed(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((tool) => tool.name === name)
  assert.ok(found, `missing tool ${name}`)
  return found
}

/** Runs a tool against a context that names `directory`, and returns its output. */
async function run(tool: ToolDefinition, context: ToolContext): Promise<string> {
  const result = await tool.execute({}, context)
  return result.output
}

describe("tool workspace resolution", () => {
  test("a tool reports the session's directory, not the instance's", async () => {
    const status = toolNamed(createTools(deps()), "status")
    const output = await run(status, { directory: SESSION_ROOT })

    assert.match(
      output,
      new RegExp(`Workspace: ${SESSION_ROOT.replaceAll("\\", "\\\\")}`),
      "the tool must describe the workspace it actually read",
    )
  })

  test("falls back to the instance directory when the host reports none", async () => {
    // Older hosts do not send `directory`. Indexing nothing would be worse than
    // answering about the instance directory, so the fallback has to stay.
    const status = toolNamed(createTools(deps()), "status")
    const output = await run(status, {})

    assert.ok(output.includes(`Workspace: ${SERVICE_ROOT}`), output)
  })

  test("a blank directory is treated as none", async () => {
    const status = toolNamed(createTools(deps()), "status")
    const output = await run(status, { directory: "   " })

    assert.ok(output.includes(`Workspace: ${SERVICE_ROOT}`), output)
  })

  test("search answers about the session's directory too", async () => {
    // Search is the tool most likely to look correct while being wrong: results
    // from the wrong codebase still read as plausible.
    const search = toolNamed(createTools(deps()), "search")
    const result = await search.execute({ query: "anything" }, { directory: SESSION_ROOT })

    const root = (result.metadata as { root?: string }).root
    assert.equal(root, SESSION_ROOT)
  })

  test(
    "the import tool names the session's directory when it finds nothing",
    { skip: lanceUnavailable },
    async () => {
      // This is the path the whole bug showed up on: a user in one project asking
      // to import an index and being told, wrongly, that their project had none.
      //
      // LanceDB as the own store, because that is the one backend whose `info()`
      // succeeds without a server — so the tool actually reaches discovery.
      const directory = mkdtempSync(path.join(os.tmpdir(), "oi-tools-lancedb-"))
      try {
        const importer = toolNamed(createTools(deps({ vectorStore: "lancedb", lancedbDirectory: directory })), "import")
        await assert.rejects(
          () => importer.execute({}, { directory: SESSION_ROOT }),
          (error: Error) => {
            assert.ok(
              error.message.includes(SESSION_ROOT),
              `the failure must name the workspace it looked in, got: ${error.message}`,
            )
            assert.ok(
              !error.message.includes(SERVICE_ROOT),
              `the service directory must not appear, got: ${error.message}`,
            )
            return true
          },
        )
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  test(
    "an unreachable backend is reported as unreachable, not as an absent index",
    { skip: lanceUnavailable },
    async () => {
      // "No index here" and "could not look" need different fixes, and only one of
      // them is fixed by indexing.
      const directory = mkdtempSync(path.join(os.tmpdir(), "oi-tools-lancedb-"))
      try {
        const importer = toolNamed(createTools(deps({ vectorStore: "lancedb", lancedbDirectory: directory })), "import")
        await assert.rejects(
          () => importer.execute({}, { directory: SESSION_ROOT }),
          (error: Error) => {
            assert.match(error.message, /Could not reach the Qdrant server/, error.message)
            return true
          },
        )
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})