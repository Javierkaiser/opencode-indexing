import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, test } from "node:test"

import { createQdrant } from "../src/qdrant.ts"
import type { QdrantFilter } from "../src/types.ts"

interface CapturedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

const originalFetch = globalThis.fetch
let calls: CapturedCall[] = []

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Replace global fetch with a synchronous mock and record every request. */
function installFetch(handler: (call: CapturedCall) => Response): void {
  calls = []
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const rawBody = typeof init?.body === "string" ? init.body : undefined
    const call: CapturedCall = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: rawBody === undefined ? undefined : (JSON.parse(rawBody) as unknown),
    }
    calls.push(call)
    return Promise.resolve(handler(call))
  }) as typeof fetch
}

beforeEach(() => {
  installFetch(() => jsonResponse({}))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  calls = []
})

describe("createQdrant", () => {
  test("listCollections parses collection names", async () => {
    installFetch(() =>
      jsonResponse({
        result: { collections: [{ name: "ws-aaa" }, { name: "ws-bbb" }] },
      }),
    )
    const qdrant = createQdrant({ url: "http://localhost:6333" })

    const names = await qdrant.listCollections()

    assert.deepEqual(names, ["ws-aaa", "ws-bbb"])
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, "http://localhost:6333/collections")
    assert.equal(calls[0]!.method, "GET")
    assert.equal(calls[0]!.headers["user-agent"], "opencode-indexing/0.1.0")
  })

  test("query builds the given URL/body and maps result.points to QueryHit[]", async () => {
    installFetch(() =>
      jsonResponse({
        result: {
          points: [
            { id: "11111111-1111-5111-8111-111111111111", score: 0.87, payload: { filePath: "src/a.ts" } },
            { id: 42, score: 0.5, payload: null },
          ],
        },
      }),
    )
    const qdrant = createQdrant({ url: "http://localhost:6333" })
    const filter: QdrantFilter = {
      must: [{ key: "filePath", match: { value: "src/a.ts" } }],
    }

    const hits = await qdrant.query("ws-aaa", {
      vector: [0.1, 0.2, 0.3],
      filter,
      scoreThreshold: 0.35,
      limit: 10,
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, "http://localhost:6333/collections/ws-aaa/points/query")
    assert.equal(calls[0]!.method, "POST")
    assert.deepEqual(calls[0]!.body, {
      query: [0.1, 0.2, 0.3],
      filter,
      score_threshold: 0.35,
      limit: 10,
      params: { hnsw_ef: 128, exact: false },
      with_payload: {
        include: ["filePath", "fileHash", "codeChunk", "startLine", "endLine", "pathSegments"],
      },
    })
    assert.deepEqual(hits, [
      { id: "11111111-1111-5111-8111-111111111111", score: 0.87, payload: { filePath: "src/a.ts" } },
      { id: 42, score: 0.5, payload: null },
    ])
  })

  test("query omits optional keys, honors hnswEf, and accepts a bare result array", async () => {
    installFetch(() =>
      jsonResponse({ result: [{ id: "p1", score: 1, payload: { filePath: "b.ts" } }] }),
    )
    const qdrant = createQdrant({ url: "http://localhost:6333" })

    const hits = await qdrant.query("ws-aaa", {
      vector: [1, 2],
      hnswEf: 256,
      include: [],
    })

    assert.deepEqual(calls[0]!.body, {
      query: [1, 2],
      params: { hnsw_ef: 256, exact: false },
      with_payload: false,
    })
    assert.deepEqual(hits, [{ id: "p1", score: 1, payload: { filePath: "b.ts" } }])
  })

  test("getCollection returns null on 404 and throws on other errors", async () => {
    installFetch(() => jsonResponse({ status: { error: "Not found" } }, 404))
    const qdrant = createQdrant({ url: "http://localhost:6333" })
    assert.equal(await qdrant.getCollection("missing"), null)
    assert.equal(await qdrant.collectionExists("missing"), false)

    installFetch(() => jsonResponse({ status: { error: "boom" } }, 500))
    await assert.rejects(
      () => qdrant.getCollection("ws-aaa"),
      /Qdrant GET \/collections\/ws-aaa failed: HTTP 500/,
    )
  })

  test("createPayloadIndex swallows already-exists errors but rethrows others", async () => {
    installFetch(() => jsonResponse({ status: { error: "Index already exists" } }, 400))
    const qdrant = createQdrant({ url: "http://localhost:6333" })

    await qdrant.createPayloadIndex("ws-aaa", "filePath")
    assert.equal(calls[0]!.url, "http://localhost:6333/collections/ws-aaa/index")
    assert.deepEqual(calls[0]!.body, { field_name: "filePath", field_schema: "keyword" })

    installFetch(() => jsonResponse({ status: { error: "ALREADY EXISTS" } }, 400))
    await qdrant.createPayloadIndex("ws-aaa", "filePath", "integer")
    assert.deepEqual(calls[0]!.body, { field_name: "filePath", field_schema: "integer" })

    installFetch(() => jsonResponse({ status: { error: "Bad request" } }, 400))
    await assert.rejects(
      () => qdrant.createPayloadIndex("ws-aaa", "filePath"),
      /Qdrant PUT \/collections\/ws-aaa\/index failed: HTTP 400/,
    )
  })

  test("normalizes base URLs (default, missing protocol, trailing slashes, path prefix)", async () => {
    const cases: Array<[string, string]> = [
      ["", "http://localhost:6333/collections"],
      ["http://localhost:6333/", "http://localhost:6333/collections"],
      ["localhost:6333///", "http://localhost:6333/collections"],
      ["http://localhost:6333/qdrant/", "http://localhost:6333/qdrant/collections"],
    ]

    for (const [input, expected] of cases) {
      installFetch(() => jsonResponse({ result: { collections: [] } }))
      const qdrant = createQdrant({ url: input })
      await qdrant.listCollections()
      assert.equal(calls[0]!.url, expected, `url ${JSON.stringify(input)}`)
    }
  })

  test("sends api-key only when configured and allows user-agent override", async () => {
    installFetch(() => jsonResponse({ result: { collections: [] } }))
    const qdrant = createQdrant({
      url: "http://localhost:6333",
      apiKey: "secret",
      userAgent: "custom-agent/9.9",
    })
    await qdrant.listCollections()

    assert.equal(calls[0]!.headers["api-key"], "secret")
    assert.equal(calls[0]!.headers["user-agent"], "custom-agent/9.9")
  })

  test("upsert sends points with wait=true by default", async () => {
    installFetch(() => jsonResponse({ result: { status: "completed" } }))
    const qdrant = createQdrant({ url: "http://localhost:6333" })
    const points = [
      { id: "p1", vector: [0.1, 0.2], payload: { filePath: "src/a.ts" } },
      { id: "p2", vector: [0.3, 0.4], payload: { filePath: "src/b.ts" } },
    ]

    await qdrant.upsert("ws-aaa", points)
    assert.equal(calls[0]!.url, "http://localhost:6333/collections/ws-aaa/points?wait=true")
    assert.equal(calls[0]!.method, "PUT")
    assert.deepEqual(calls[0]!.body, { points })

    await qdrant.upsert("ws-aaa", points, false)
    assert.equal(calls[1]!.url, "http://localhost:6333/collections/ws-aaa/points?wait=false")
  })

  test("deletePoints with an undefined filter clears via an empty must clause", async () => {
    installFetch(() => jsonResponse({ result: { status: "completed" } }))
    const qdrant = createQdrant({ url: "http://localhost:6333" })
    const filter: QdrantFilter = { must: [{ key: "filePath", match: { value: "a.ts" } }] }

    await qdrant.deletePoints("ws-aaa", undefined)
    assert.equal(calls[0]!.url, "http://localhost:6333/collections/ws-aaa/points/delete?wait=true")
    assert.deepEqual(calls[0]!.body, { filter: { must: [] } })

    await qdrant.deletePoints("ws-aaa", filter, false)
    assert.deepEqual(calls[1]!.body, { filter })
    assert.equal(calls[1]!.url, "http://localhost:6333/collections/ws-aaa/points/delete?wait=false")
  })

  test("scroll maps points and next_page_offset", async () => {
    installFetch(() =>
      jsonResponse({
        result: {
          points: [{ id: "p1", payload: { filePath: "a.ts" } }],
          next_page_offset: "p2",
        },
      }),
    )
    const qdrant = createQdrant({ url: "http://localhost:6333" })

    const page = await qdrant.scroll("ws-aaa", { limit: 50 })
    assert.deepEqual(page.points, [{ id: "p1", payload: { filePath: "a.ts" } }])
    assert.equal(page.next, "p2")
    assert.deepEqual(calls[0]!.body, { limit: 50, with_payload: true, with_vector: false })
  })

  test("retrieve posts ids with with_payload true and with_vector false", async () => {
    installFetch(() =>
      jsonResponse({
        result: [{ id: "p1", payload: { filePath: "a.ts" } }],
      }),
    )
    const qdrant = createQdrant({ url: "http://localhost:6333" })

    const points = await qdrant.retrieve("ws-aaa", ["p1", 7])
    assert.deepEqual(points, [{ id: "p1", payload: { filePath: "a.ts" } }])
    assert.equal(calls[0]!.url, "http://localhost:6333/collections/ws-aaa/points")
    assert.deepEqual(calls[0]!.body, { ids: ["p1", 7], with_payload: true, with_vector: false })
  })
})

test("live Qdrant check (QDRANT_LIVE=1)", async (t) => {
  if (process.env.QDRANT_LIVE !== "1") {
    t.skip("set QDRANT_LIVE=1 to run against http://localhost:6333")
    return
  }
  const qdrant = createQdrant({ url: "http://localhost:6333" })
  const names = await qdrant.listCollections()
  assert.ok(
    names.some((name) => name.startsWith("ws-")),
    `expected a ws-* collection, got: ${names.join(", ")}`,
  )
})
