import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import { lanceDbSupport, lanceDbUnavailableMessage, platformId } from "../src/lancedb-support.ts"

describe("lanceDbSupport", () => {
  test("the platforms the binding ships a binary for", () => {
    // These are the seven optionalDependencies published for @lancedb/lancedb.
    for (const [platform, arch] of [
      ["win32", "x64"],
      ["win32", "arm64"],
      ["darwin", "arm64"],
      ["linux", "x64"],
      ["linux", "arm64"],
    ] as const) {
      assert.equal(lanceDbSupport(platform, arch).supported, true, `${platformId(platform, arch)} should be supported`)
    }
  })

  test("macOS on Intel has no binary, so LanceDB cannot run there", () => {
    // lancedb-darwin-x64 is not published. The wrapper tries darwin-universal
    // first, which is not published either, and there is no WASM build, so this
    // platform is simply out of reach. Saying so up front is the whole point:
    // the alternative is a MODULE_NOT_FOUND with a seven-line require stack.
    const support = lanceDbSupport("darwin", "x64")
    assert.equal(support.supported, false)
    assert.equal(support.id, "darwin-x64")
  })

  test("an unknown platform is reported as unsupported, not assumed to work", () => {
    assert.equal(lanceDbSupport("sunos", "x64").supported, false)
  })
})

describe("lanceDbUnavailableMessage", () => {
  test("a platform without a binary is told the fix is not to install anything", () => {
    // The platform is passed in so this branch is reachable from a machine that
    // does have a binary; it is the one that matters and the CI runner is not it.
    const message = lanceDbUnavailableMessage(
      new Error("Cannot find module '@lancedb/lancedb-darwin-x64'"),
      lanceDbSupport("darwin", "x64"),
    )
    assert.match(message, /no native binary for darwin-x64/)
    assert.match(message, /vectorStore=qdrant/)
    assert.match(message, /indexing\.json/, "it must name the file the user has to edit")
    assert.doesNotMatch(message, /no está disponible/, "the message has to be in the language of the repository")
  })

  test("a supported platform that failed to load is told to install the optional dependency", () => {
    const message = lanceDbUnavailableMessage(new Error("boom"))
    assert.match(message, /could not be loaded/)
    assert.match(message, /@lancedb\/lancedb@/)
    assert.match(message, /boom/, "the original cause still has to be visible")
  })

  test("the module resolution chain is not part of the message", () => {
    // Node appends the require chain to MODULE_NOT_FOUND. It is seven lines of
    // internal files that bury the single line anyone can act on.
    const cause = new Error(
      "Cannot find module '@lancedb/lancedb-win32-x64-msvc'\nRequire stack:\n- a/dist/native.js\n- b/dist/query.js\n- c/dist/index.js",
    )
    const message = lanceDbUnavailableMessage(cause)
    assert.doesNotMatch(message, /Require stack/)
    assert.doesNotMatch(message, /dist\/native\.js/)
    assert.match(message, /Cannot find module/)
  })
})
