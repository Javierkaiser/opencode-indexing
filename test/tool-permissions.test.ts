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

    // `config` and `config_set` are registered in index.ts rather than
    // src/tools.ts, because they render and write through the helpers there.
    const expected = [...names, "config", "config_set"].map((name) => `indexing_${name}`).sort()

    assert.deepEqual(granted.slice().sort(), expected)
  })

  test("the settings-writing tool is granted as ask, not allow", () => {
    // `allow` would let a model rewrite the configuration without the user
    // ever seeing the change.
    const block = source.match(/const ASK_BEFORE_RUN = new Set\(\[([^\]]*)\]\)/)
    assert.ok(block, "ASK_BEFORE_RUN set not found in install.mjs")
    const asked = [...block![1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1])

    assert.deepEqual(asked, ["indexing_config_set"])
  })

  test("the installer does not write the ignored V1 shape", () => {
    // V2 reads `permissions` as a rule list. A `permission` action map is the
    // V1 shape: V2 ignores it, so writing one grants nothing while looking
    // like it did. The tools would then only run because of the built-in
    // wildcard allow, and a rule meant to block or ask them would do nothing.
    //
    // Deleting our own stale entries from that map is fine; assigning into it
    // is the bug, so the check looks for an assignment, not the name.
    assert.ok(!/cfg\.permission\[[^\]]+\]\s*=[^=]/.test(source), "still assigns into cfg.permission")
    assert.match(source, /delete cfg\.permission\[tool\]/, "stale V1 entries should be removed")
    assert.match(source, /cfg\.permissions\.push\(/)
  })

  test("the list has no duplicates", () => {
    assert.equal(new Set(granted).size, granted.length)
  })
})
