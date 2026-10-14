import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import { describeError } from "../src/errors.ts"

describe("describeError", () => {
  test("keeps an Error message", () => {
    assert.equal(describeError(new Error("boom")), "boom")
  })

  test("extracts the message from the RPC error shape", () => {
    // This is the shape that produced "[object Object]" for the user.
    const rpcError = { _tag: "RpcError", type: "rpc.invalid_input", message: "Expected object" }
    assert.equal(describeError(rpcError), "Expected object")
    assert.notEqual(describeError(rpcError), "[object Object]")
  })

  test("falls back to the RPC type when there is no message", () => {
    assert.equal(describeError({ _tag: "RpcError", type: "rpc.method_not_found" }), "rpc.method_not_found")
  })

  test("uses a thrown string as-is", () => {
    assert.equal(describeError("qdrant refused the connection"), "qdrant refused the connection")
  })

  test("descends into a nested error", () => {
    assert.equal(describeError({ error: { message: "the real reason" } }), "the real reason")
  })

  test("descends into a cause", () => {
    const error = new Error("wrapper", { cause: new Error("underlying") })
    assert.equal(describeError(error), "wrapper")
  })

  test("always returns something non-empty", () => {
    for (const value of [null, undefined, {}, [], { message: "" }, { message: 5 }, new Error("")]) {
      const described = describeError(value)
      assert.ok(described.length > 0, `empty for ${JSON.stringify(value) ?? String(value)}`)
      assert.notEqual(described, "[object Object]")
    }
  })

  test("keeps a Qdrant failure readable", () => {
    // A real HTTP error, with the detail that matters attached to the message.
    const error = { _tag: "QdrantHttpError", message: 'Qdrant PUT /collections/oc-x/points?wait=true failed: HTTP 404 {"status":{"error":"Not found"}}' }
    const described = describeError(error)
    assert.match(described, /HTTP 404/)
    assert.match(described, /collection/i)
  })

  test("truncates rather than dumping an unbounded object", () => {
    const serialized = describeError({ a: "x".repeat(2000) })
    assert.ok(serialized.length <= 400, `got ${serialized.length} chars`)
  })
})