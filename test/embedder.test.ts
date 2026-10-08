import assert from "node:assert/strict"
import { after, before, beforeEach, test } from "node:test"

import { createEmbedder } from "../src/embedder.ts"
import type { IndexingSettings } from "../src/types.ts"

interface FetchCall {
  url: string
  headers: Headers
  body: Record<string, unknown>
  init: RequestInit
}

const realFetch = globalThis.fetch
const calls: FetchCall[] = []

let respond: (call: FetchCall, index: number) => Response | Promise<Response> = () => {
  throw new Error("no fetch handler configured for this test")
}

before(() => {
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    const rawBody = typeof init?.body === "string" ? init.body : undefined
    const call: FetchCall = {
      url,
      headers,
      body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
      init: init ?? {},
    }
    calls.push(call)
    return respond(call, calls.length - 1)
  }
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
})

beforeEach(() => {
  calls.length = 0
  respond = () => {
    throw new Error("no fetch handler configured for this test")
  }
})

function baseSettings(overrides: Partial<IndexingSettings> = {}): IndexingSettings {
  return {
    provider: "mistral",
    modelId: "codestral-embed-2505",
    dimension: 1536,
    vectorStore: "qdrant",
    qdrantUrl: "http://localhost:6333",
    lancedbDirectory: "C:\\Users\\test\\.local\\state\\opencode-indexing\\lancedb",
    scoreThreshold: 0.35,
    searchMaxResults: 20,
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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** Little-endian Float32 bytes as base64, the format mistral returns. */
function base64Float32(values: number[]): string {
  const floats = new Float32Array(values)
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString("base64")
}

/** Respond with one numeric embedding per input string. */
function echoInputs(call: FetchCall): Response {
  const input = call.body.input as string[]
  return jsonResponse({ data: input.map((_, index) => ({ embedding: [index] })) })
}

test("mistral: builds the request and decodes base64 float32 embeddings", async () => {
  respond = () => jsonResponse({ data: [{ embedding: base64Float32([1.5, 2.5, 3.5]) }] })
  const embedder = createEmbedder(baseSettings({ credentials: { mistralApiKey: "test-mistral-key" } }))

  const vectors = await embedder.embed(["hello"])

  assert.deepEqual(vectors, [[1.5, 2.5, 3.5]])
  assert.equal(calls.length, 1)
  const call = calls[0]!
  assert.equal(call.url, "https://api.mistral.ai/v1/embeddings")
  assert.equal(call.init.method, "POST")
  assert.equal(call.headers.get("content-type"), "application/json")
  assert.equal(call.headers.get("authorization"), "Bearer test-mistral-key")
  assert.deepEqual(call.body, {
    model: "codestral-embed-2505",
    input: ["hello"],
    encoding_format: "base64",
  })
})

test("mistral: non-2xx throws with the status and body snippet, without retrying", async () => {
  respond = () => new Response("bad api key", { status: 401 })
  const embedder = createEmbedder(baseSettings({ credentials: { mistralApiKey: "wrong" } }))

  await assert.rejects(
    embedder.embed(["hello"]),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /mistral/i)
      assert.match(error.message, /HTTP 401/)
      assert.match(error.message, /bad api key/)
      return true
    },
  )
  assert.equal(calls.length, 1)
})

test("mistral: missing api key throws a clear error", () => {
  assert.throws(
    () => createEmbedder(baseSettings({ credentials: {} })),
    /Mistral API key/i,
  )
})

test("openai: sends a plain body, parses numeric arrays, validates credentials", async () => {
  assert.throws(
    () => createEmbedder(baseSettings({ provider: "openai", credentials: {} })),
    /OpenAI API key/i,
  )

  respond = echoInputs
  const embedder = createEmbedder(
    baseSettings({
      provider: "openai",
      modelId: "text-embedding-3-small",
      credentials: { openAiApiKey: "sk-test" },
    }),
  )

  const vectors = await embedder.embed(["a", "b"])

  assert.deepEqual(vectors, [[0], [1]])
  const call = calls[0]!
  assert.equal(call.url, "https://api.openai.com/v1/embeddings")
  assert.equal(call.headers.get("authorization"), "Bearer sk-test")
  assert.deepEqual(call.body, { model: "text-embedding-3-small", input: ["a", "b"] })
  assert.equal("encoding_format" in call.body, false)
})

test("batching: splits into batch-size chunks and preserves order", async () => {
  respond = (call) => {
    const input = call.body.input as string[]
    return jsonResponse({
      data: input.map((text) => ({ embedding: [Number(text.slice("text-".length))] })),
    })
  }
  const texts = Array.from({ length: 130 }, (_, index) => `text-${index}`)
  const embedder = createEmbedder(baseSettings({ embeddingBatchSize: 60, credentials: { mistralApiKey: "k" } }))

  const vectors = await embedder.embed(texts)

  assert.equal(calls.length, 3)
  assert.deepEqual(
    calls.map((call) => (call.body.input as string[]).length),
    [60, 60, 10],
  )
  assert.equal(vectors.length, 130)
  for (let index = 0; index < texts.length; index += 1) {
    assert.deepEqual(vectors[index], [index])
  }
})

test("batching: truncates oversized texts instead of dropping them", async () => {
  respond = (call) => {
    const input = call.body.input as string[]
    return jsonResponse({ data: input.map(() => ({ embedding: [7] })) })
  }
  const embedder = createEmbedder(baseSettings({ credentials: { mistralApiKey: "k" } }))

  await embedder.embed(["x".repeat(100_000)])

  const sent = calls[0]!.body.input as string[]
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.length, 32_000)
})

test("retry: a 429 is retried once and then succeeds", async () => {
  respond = (_call, index) =>
    index === 0 ? new Response("rate limited", { status: 429 }) : jsonResponse({ data: [{ embedding: [42] }] })
  const embedder = createEmbedder(baseSettings({ credentials: { mistralApiKey: "k" } }))

  const vectors = await embedder.embed(["retry me"])

  assert.deepEqual(vectors, [[42]])
  assert.equal(calls.length, 2)
})

test("openai-compatible: appends /embeddings and omits Authorization without a key", async () => {
  respond = echoInputs
  const embedder = createEmbedder(
    baseSettings({
      provider: "openai-compatible",
      modelId: "local-model",
      credentials: { openAiCompatibleBaseUrl: "http://localhost:8080/v1" },
    }),
  )

  await embedder.embed(["a"])

  const call = calls[0]!
  assert.equal(call.url, "http://localhost:8080/v1/embeddings")
  assert.equal(call.headers.get("content-type"), "application/json")
  assert.equal(call.headers.get("authorization"), null)
  assert.deepEqual(call.body, { model: "local-model", input: ["a"], encoding_format: "base64" })
})

test("openai-compatible: respects a full embeddings URL and sends the key when present", async () => {
  respond = echoInputs
  const embedder = createEmbedder(
    baseSettings({
      provider: "openai-compatible",
      modelId: "remote-model",
      credentials: {
        openAiCompatibleBaseUrl: "http://x/embeddings",
        openAiCompatibleApiKey: "compat-secret",
      },
    }),
  )

  await embedder.embed(["a"])

  const call = calls[0]!
  assert.equal(call.url, "http://x/embeddings")
  assert.equal(call.headers.get("authorization"), "Bearer compat-secret")
})

test("openai-compatible: missing base url throws a clear error", () => {
  assert.throws(
    () => createEmbedder(baseSettings({ provider: "openai-compatible", credentials: {} })),
    /base URL/i,
  )
})

test("ollama: posts to /api/embed and parses the embeddings array", async () => {
  respond = (call) => {
    const input = call.body.input as string[]
    return jsonResponse({ embeddings: input.map((_, index) => [index, index + 1]) })
  }
  const embedder = createEmbedder(
    baseSettings({ provider: "ollama", modelId: "mxbai-embed-large", credentials: {} }),
  )

  const vectors = await embedder.embed(["one", "two"])

  assert.deepEqual(vectors, [
    [0, 1],
    [1, 2],
  ])
  const call = calls[0]!
  assert.equal(call.url, "http://localhost:11434/api/embed")
  assert.equal(call.headers.get("authorization"), null)
  assert.deepEqual(call.body, { model: "mxbai-embed-large", input: ["one", "two"] })
})

test("ollama: prefixes query text for nomic-embed-text without double-prefixing", async () => {
  respond = (call) => {
    const input = call.body.input as string[]
    return jsonResponse({ embeddings: input.map(() => [1]) })
  }
  const embedder = createEmbedder(
    baseSettings({ provider: "ollama", modelId: "nomic-embed-text", credentials: {} }),
  )

  await embedder.embed(["hello", "search_query: already prefixed"])

  assert.deepEqual(calls[0]!.body.input, ["search_query: hello", "search_query: already prefixed"])
})

test("unknown provider throws", () => {
  assert.throws(
    () => createEmbedder(baseSettings({ provider: "gemini" })),
    /Unsupported embedder provider: gemini/,
  )
})

test(
  "mistral live embedding (opt-in via MISTRAL_LIVE=1 and MISTRAL_API_KEY)",
  { skip: process.env.MISTRAL_LIVE !== "1" || !process.env.MISTRAL_API_KEY },
  async () => {
    const savedFetch = globalThis.fetch
    globalThis.fetch = realFetch
    try {
      const embedder = createEmbedder(
        baseSettings({ credentials: { mistralApiKey: process.env.MISTRAL_API_KEY } }),
      )
      const vectors = await embedder.embed(["hello"])
      assert.equal(vectors.length, 1)
      assert.equal(vectors[0]!.length, 1536)
    } finally {
      globalThis.fetch = savedFetch
    }
  },
)
