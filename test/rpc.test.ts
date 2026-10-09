import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import { IndexingRpc } from "../src/rpc.ts"

describe("IndexingRpc contract", () => {
  test("defines the settings/status/index methods with JSON schemas", () => {
    assert.equal(IndexingRpc.id, "opencode.indexing")
    const methods = Object.keys(IndexingRpc.methods)
    for (const method of [
      "settings.get",
      "settings.set",
      "settings.test",
      "kilo.discover",
      "status.get",
      "index.build",
      "index.refresh",
      "index.import",
      "workspaces.list",
      "workspace.forget",
    ]) {
      assert.ok(methods.includes(method), `missing method ${method}`)
    }
    assert.equal(IndexingRpc.events && Object.keys(IndexingRpc.events).length, 0)
  })

  test("method schemas are plain JSON-schema objects (portable)", () => {
    for (const [name, method] of Object.entries(IndexingRpc.methods)) {
      assert.equal(typeof method.input, "object", `${name} input must be an object schema`)
      assert.equal(typeof method.output, "object", `${name} output must be an object schema`)
      assert.ok(!Array.isArray(method.input), `${name} input must not be an array`)
    }
  })

  test("settings.set accepts an arbitrary patch object", () => {
    const input = IndexingRpc.methods["settings.set"].input as {
      properties: { patch: { type: string } }
    }
    assert.equal(input.properties.patch.type, "object")
  })

  test("settings.test targets enum", () => {
    const input = IndexingRpc.methods["settings.test"].input as unknown as {
      properties: { target: { enum: readonly string[] } }
    }
    assert.deepEqual([...input.properties.target.enum], ["qdrant", "lancedb", "provider", "kilo"])
  })

  test("workspace.forget requires a store name", () => {
    const input = IndexingRpc.methods["workspace.forget"].input as unknown as {
      properties: { store: { type: string } }
      required: string[]
    }
    assert.equal(input.properties.store.type, "string")
    assert.deepEqual(input.required, ["store"])
  })
})
