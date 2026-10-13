import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, test } from "node:test"

import { createTools } from "../src/tools.ts"

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)))

/**
 * The installer grants one permission per tool.
 *
 * A tool the plugin registers but the installer never grants is blocked by the
 * host, and nothing in the type-check or the unit tests notices — it only shows
 * up in a fresh install, as a tool that silently never runs.
 */
describe("installer tool permissions", () => {
  const source = fs.readFileSync(path.join(repoRoot, "install.mjs"), "utf8")
  const granted = (() => {
    const match = source.match(/const TOOLS = \[([^\]]*)\]/)
    assert.ok(match, "TOOLS list not found in install.mjs")
    return [...match![1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1])
  })()

  test("every registered tool is granted", () => {
    const names = createTools({
      kv: {} as never,
      root: repoRoot,
      getSettings: () => ({}) as never,
    }).map((tool) => tool.name)

    // `config` is registered in index.ts rather than src/tools.ts, because it
    // renders through the report helper defined there.
    const expected = [...names, "config"].map((name) => `indexing_${name}`).sort()

    assert.deepEqual(granted.slice().sort(), expected)
  })

  test("the list has no duplicates", () => {
    assert.equal(new Set(granted).size, granted.length)
  })
})
