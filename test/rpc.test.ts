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

  test("every workspace-scoped method accepts a directory", () => {
    // The server plugin is instantiated for the directory the service runs in,
    // so a method that takes no directory can only ever answer about that one.
    // `kilo.discover` and `settings.test` are the two that were missing it, and
    // both silently reported "no index here" for the workspace the user was in.
    for (const method of [
      "kilo.discover",
      "settings.test",
      "status.get",
      "index.build",
      "index.refresh",
      "index.import",
    ] as const) {
      const input = IndexingRpc.methods[method].input as unknown as {
        properties?: Record<string, { type?: string }>
        additionalProperties?: boolean
      }
      assert.equal(
        input.properties?.directory?.type,
        "string",
        `${method} must accept a directory, or it can only describe the service's own workspace`,
      )
      // The property is optional so a caller with nothing to say can send `{}`.
      assert.notEqual((input as { required?: string[] }).required?.includes("directory"), true)
    }
  })

  test("kilo.discover reports unreadable sources separately from missing ones", () => {
    const output = IndexingRpc.methods["kilo.discover"].output as unknown as {
      properties: { sources: unknown; problems: { type: string; items: { type: string } } }
      required: string[]
    }
    assert.equal(output.properties.problems.type, "array")
    assert.equal(output.properties.problems.items.type, "string")
    assert.deepEqual(output.required, ["sources"], "an empty list with problems is still a valid answer")
  })

  test("the global methods are not given a directory", () => {
    // These span every workspace, so naming one would be a lie about the scope.
    for (const method of ["settings.get", "settings.set", "workspaces.list", "workspace.forget"] as const) {
      const input = IndexingRpc.methods[method].input as unknown as { properties?: Record<string, unknown> }
      assert.equal(input.properties?.directory, undefined, `${method} must stay workspace-agnostic`)
    }
  })
})
