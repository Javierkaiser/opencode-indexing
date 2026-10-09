import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { isTimeoutError } from "../src/qdrant.ts"
import type { Qdrant } from "../src/qdrant.ts"
import type { QdrantFilter } from "../src/types.ts"
import { DELETE_CHUNK_SIZE, chunkPaths, deleteOwnByFilePaths } from "../src/own-store.ts"

// ---------------------------------------------------------------------------
// chunkPaths
// ---------------------------------------------------------------------------

describe("chunkPaths", () => {
  test("splits into consecutive batches of at most `size`", () => {
    assert.deepEqual(chunkPaths(["a", "b", "c", "d", "e"], 2), [["a", "b"], ["c", "d"], ["e"]])
  })

  test("preserves order and loses no entries", () => {
    const paths = Array.from({ length: 253 }, (_, i) => `src/f${i}.ts`)
    const batches = chunkPaths(paths, DELETE_CHUNK_SIZE)

    assert.equal(batches.length, 3)
    assert.deepEqual(batches.flat(), paths)
    assert.ok(batches.every((batch) => batch.length <= DELETE_CHUNK_SIZE))
  })

  test("returns a single batch when the input fits", () => {
    assert.deepEqual(chunkPaths(["a", "b"], 10), [["a", "b"]])
  })

  test("returns an empty array for empty input", () => {
    assert.deepEqual(chunkPaths([], 10), [])
  })

  test("rejects a non-positive or non-integer size", () => {
    assert.throws(() => chunkPaths(["a"], 0), RangeError)
    assert.throws(() => chunkPaths(["a"], -1), RangeError)
    assert.throws(() => chunkPaths(["a"], 1.5), RangeError)
  })
})

// ---------------------------------------------------------------------------
// isTimeoutError
// ---------------------------------------------------------------------------

describe("isTimeoutError", () => {
  test("detects AbortSignal.timeout and abort names", () => {
    assert.equal(isTimeoutError(Object.assign(new Error("boom"), { name: "TimeoutError" })), true)
    assert.equal(isTimeoutError(Object.assign(new Error("boom"), { name: "AbortError" })), true)
  })

  test("detects the wrapped timeout message", () => {
    assert.equal(
      isTimeoutError(new Error("Qdrant POST /collections/oc-x/points/delete failed: The operation timed out.")),
      true,
    )
  })

  test("ignores HTTP and unrelated errors", () => {
    assert.equal(isTimeoutError(new Error("Qdrant GET /collections failed: HTTP 500 boom")), false)
    assert.equal(isTimeoutError("timed out"), false)
    assert.equal(isTimeoutError(undefined), false)
  })
})

// ---------------------------------------------------------------------------
// deleteOwnByFilePaths batching / partial failure
// ---------------------------------------------------------------------------

interface DeleteCall {
  name: string
  filter: QdrantFilter | undefined
  wait?: boolean
}

/** Minimal fake implementing just the method `deleteOwnByFilePaths` consumes. */
function makeDeleteFake(failOnCall: (index: number) => Error | null = () => null): {
  calls: DeleteCall[]
  client: Qdrant
} {
  const calls: DeleteCall[] = []
  const client = {
    async deletePoints(name: string, filter: QdrantFilter | undefined, wait?: boolean): Promise<void> {
      const error = failOnCall(calls.length)
      calls.push({ name, filter, wait })
      if (error) throw error
    },
  } as unknown as Qdrant
  return { calls, client }
}

describe("deleteOwnByFilePaths batching", () => {
  test("issues one delete per batch and keeps the filter shape", async () => {
    const { calls, client } = makeDeleteFake()
    const paths = Array.from({ length: DELETE_CHUNK_SIZE + 1 }, (_, i) => `src/f${i}.ts`)

    await deleteOwnByFilePaths(client, "oc-x", "C:/ws", paths)

    assert.equal(calls.length, 2)
    assert.equal(calls[0]!.filter?.should?.length, DELETE_CHUNK_SIZE)
    assert.equal(calls[1]!.filter?.should?.length, 1)
    assert.deepEqual(calls[0]!.filter?.must_not, [{ key: "type", match: { value: "oc_metadata" } }])
    assert.deepEqual(calls[0]!.filter?.should?.[0], {
      must: [
        { key: "pathSegments.0", match: { value: "src" } },
        { key: "pathSegments.1", match: { value: "f0.ts" } },
      ],
    })
    assert.equal(calls[0]!.wait, true)
  })

  test("does nothing for an empty path list", async () => {
    const { calls, client } = makeDeleteFake()
    await deleteOwnByFilePaths(client, "oc-x", "C:/ws", [])
    assert.equal(calls.length, 0)
  })

  test("keeps successful batches and reports how many failed", async () => {
    const { calls, client } = makeDeleteFake((index) => (index === 1 ? new Error("timeout") : null))
    const paths = Array.from({ length: DELETE_CHUNK_SIZE * 2 + 1 }, (_, i) => `src/f${i}.ts`)

    await assert.rejects(
      () => deleteOwnByFilePaths(client, "oc-x", "C:/ws", paths),
      /deleteOwnByFilePaths: 1\/3 batches failed \(201 files\): timeout/,
    )
    // Every batch was attempted even though the middle one failed.
    assert.equal(calls.length, 3)
  })
})
