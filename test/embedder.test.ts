import assert from "node:assert/strict"
import { after, before, beforeEach, test } from "node:test"

import { createEmbedder, resolveBatchLimits } from "../src/embedder.ts"
import { getModelMaxInputTokens } from "../src/registry.ts"
import { VALID_PROVIDERS } from "../src/config.ts"
import type { EmbedderProvider, IndexingSettings } from "../src/types.ts"

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
    kiloVectorStore: null,
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
  const estimatedTokens = Math.ceil(sent[0]!.length / 4)
  assert.ok(
    estimatedTokens <= 8192,
    `a chunk must fit the model's input ceiling, estimated ${estimatedTokens} tokens`,
  )
  assert.ok(estimatedTokens > 8192 * 0.9, "and the margin must not throw away a meaningful share of the chunk")
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
  assert.deepEqual(call.body, {
    // Ollama truncates by default and says nothing when it does; with a 512
    // token model that quietly indexes a prefix of every chunk.
    truncate: false,
    model: "mxbai-embed-large",
    input: ["one", "two"],
  })
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

test("gemini: wraps each input in its own Content so N inputs give N vectors", async () => {
  // gemini-embedding-001 embeds a plain string list one vector per string;
  // gemini-embedding-2 aggregates that same list into a single vector. Sending
  // the list unwrapped therefore returns 1 vector for N inputs and writes N-1
  // missing chunks into the index, with no error raised anywhere.
  respond = () => jsonResponse({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] })
  const embedder = createEmbedder(
    baseSettings({ provider: "gemini", modelId: "gemini-embedding-2", dimension: 3072, credentials: { geminiApiKey: "k" } }),
  )

  const vectors = await embedder.embed(["alpha", "beta"])

  assert.equal(vectors.length, 2, "one vector per input, never an aggregate")
  assert.deepEqual(vectors, [
    [0.1, 0.2],
    [0.3, 0.4],
  ])
  const call = calls[0]!
  assert.equal(
    call.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents",
  )
  assert.equal(call.headers.get("x-goog-api-key"), "k")
  const requests = call.body.requests as Array<{ content: { parts: Array<{ text: string }> } }>
  assert.equal(requests.length, 2)
  assert.deepEqual(
    requests.map((r) => r.content.parts[0]!.text),
    ["alpha", "beta"],
    "each request carries exactly one text, wrapped as a Content object",
  )
})

test("gemini: rejects a response that aggregates several inputs into one vector", async () => {
  respond = () => jsonResponse({ embeddings: [{ values: [0.1, 0.2] }] })
  const embedder = createEmbedder(
    baseSettings({ provider: "gemini", modelId: "gemini-embedding-2", dimension: 3072, credentials: { geminiApiKey: "k" } }),
  )

  await assert.rejects(() => embedder.embed(["alpha", "beta"]), /embedding count mismatch \(1 != 2\)/)
})

test("gemini: requires an API key", () => {
  assert.throws(() => createEmbedder(baseSettings({ provider: "gemini" })), /Gemini API key/i)
})

test("voyage: sends input_type and refuses silent truncation", async () => {
  respond = () => jsonResponse({ data: [{ embedding: [0.5], index: 0 }] })
  const embedder = createEmbedder(
    baseSettings({ provider: "voyage", modelId: "voyage-code-4", dimension: 1024, credentials: { voyageApiKey: "vk" } }),
  )

  await embedder.embed(["fn main() {}"])

  const call = calls[0]!
  assert.equal(call.url, "https://api.voyageai.com/v1/embeddings")
  assert.equal(call.headers.get("authorization"), "Bearer vk")
  // Voyage truncates by default; a truncated code chunk indexes as a valid but
  // wrong vector, so the adapter asks for an error instead.
  assert.equal(call.body.truncation, false)
  assert.equal(call.body.input_type, "document")
})

test("openrouter: posts to its own endpoint with the routed model id", async () => {
  respond = () => jsonResponse({ data: [{ embedding: [1, 2, 3], index: 0 }] })
  const embedder = createEmbedder(
    baseSettings({
      provider: "openrouter",
      modelId: "openai/text-embedding-3-small",
      dimension: 1536,
      credentials: { openRouterApiKey: "ork" },
    }),
  )

  await embedder.embed(["hello"])

  const call = calls[0]!
  assert.equal(call.url, "https://openrouter.ai/api/v1/embeddings")
  assert.equal(call.headers.get("authorization"), "Bearer ork")
  assert.equal(call.body.model, "openai/text-embedding-3-small")
})

test("every declared provider has an implementation", () => {
  // This used to assert the opposite for gemini: the provider was offered by
  // the dropdown, accepted by validation, and only failed once indexing started
  // and had already been billed for a probe.
  const implemented: Array<
    [EmbedderProvider, Partial<IndexingSettings>, Partial<IndexingSettings["credentials"]>]
  > = [
    ["local", { modelId: "potion-base-8M-128d", dimension: 128 }, {}],
    ["mistral", {}, { mistralApiKey: "k" }],
    ["openai", { modelId: "text-embedding-3-small", dimension: 1536 }, { openAiApiKey: "k" }],
    ["voyage", { modelId: "voyage-code-4", dimension: 1024 }, { voyageApiKey: "k" }],
    ["openrouter", { modelId: "openai/text-embedding-3-small", dimension: 1536 }, { openRouterApiKey: "k" }],
    ["gemini", { modelId: "gemini-embedding-2", dimension: 3072 }, { geminiApiKey: "k" }],
    ["ollama", { modelId: "nomic-embed-text", dimension: 768 }, {}],
    ["openai-compatible", { modelId: "custom", dimension: 768 }, { openAiCompatibleBaseUrl: "http://x/v1" }],
  ]
  for (const [provider, overrides, credentials] of implemented) {
    const embedder = createEmbedder(baseSettings({ provider, ...overrides, credentials }))
    assert.equal(embedder.provider, provider, `${provider} must build an embedder`)
  }
  // The type union and the catalog must not grow a provider nobody can embed.
  for (const provider of VALID_PROVIDERS) {
    assert.ok(
      implemented.some(([name]) => name === provider),
      `${provider} is selectable but has no adapter`,
    )
  }
})

test("local: embeds through the bundled static model without any request", async () => {
  const embedder = createEmbedder(
    baseSettings({ provider: "local", modelId: "potion-base-8M-128d", dimension: 128 }),
  )

  const vectors = await embedder.embed(["where files are discovered before indexing", "manifest store"])

  assert.equal(vectors.length, 2)
  assert.equal(vectors[0]?.length, 128, "the catalog dimension must match the model")
  assert.equal(vectors[1]?.length, 128)
  // The model normalizes and the store scores with cosine, so a vector that is
  // not unit length means the wrong model or a broken pooling step.
  const norm = Math.hypot(...(vectors[0] as number[]))
  assert.ok(Math.abs(norm - 1) < 1e-3, `expected unit length, got ${norm}`)
  assert.equal(calls.length, 0, "the local provider must not call fetch")
})

test("local: the same text embeds to the same vector", async () => {
  const embedder = createEmbedder(
    baseSettings({ provider: "local", modelId: "potion-base-8M-128d", dimension: 128 }),
  )
  const [first] = await embedder.embed(["workspace scanner"])
  const [second] = await embedder.embed(["workspace scanner"])
  assert.deepEqual(first, second)
})

test("ollama: refuses to truncate an over-long chunk instead of embedding a prefix", async () => {
  // `truncate` defaults to true, and mxbai-embed-large accepts 512 tokens, so
  // the default silently indexes the first 512 tokens of every function.
  respond = () => jsonResponse({ embeddings: [[0.1]] })
  const embedder = createEmbedder(
    baseSettings({ provider: "ollama", modelId: "mxbai-embed-large", dimension: 1024 }),
  )

  await embedder.embed(["x".repeat(40_000)])

  const call = calls[0]!
  assert.equal(call.body.truncate, false)
  assert.equal(call.url, "http://localhost:11434/api/embed")
})

test("results are placed by index, not by array position", async () => {
  // OpenAI documents an `index` field rather than promising response order, and
  // its own samples fetch by that field.
  respond = () => jsonResponse({
    data: [
      { embedding: [30], index: 2 },
      { embedding: [10], index: 0 },
      { embedding: [20], index: 1 },
    ],
  })
  const embedder = createEmbedder(baseSettings({ credentials: { mistralApiKey: "k" } }))

  const vectors = await embedder.embed(["a", "b", "c"])

  assert.deepEqual(vectors, [[10], [20], [30]])
})

test("a response with no index keeps its order", async () => {
  respond = () => jsonResponse({ data: [{ embedding: [10] }, { embedding: [20] }] })
  const embedder = createEmbedder(baseSettings({ credentials: { mistralApiKey: "k" } }))

  assert.deepEqual(await embedder.embed(["a", "b"]), [[10], [20]])
})

test("a repeated index is an error, not a silently shifted result", async () => {
  respond = () => jsonResponse({
    data: [
      { embedding: [10], index: 0 },
      { embedding: [20], index: 0 },
    ],
  })
  const embedder = createEmbedder(baseSettings({ credentials: { mistralApiKey: "k" } }))

  await assert.rejects(() => embedder.embed(["a", "b"]), /out-of-range or repeated embedding index/)
})

test("batch size is capped by the provider, not only by the user setting", async () => {
  // OpenAI accepts at most 300,000 tokens per request however many items that
  // is. A fixed item count would have sent 500 x 2,000 tokens and been refused;
  // the token ceiling has to cut the batch too.
  const settings = baseSettings({
    provider: "openai",
    modelId: "text-embedding-3-small",
    dimension: 1536,
    embeddingBatchSize: 500,
    credentials: { openAiApiKey: "k" },
  })
  const limits = resolveBatchLimits(settings)
  assert.equal(limits.maxItems, 500, "the user's item ceiling is honoured when the provider allows it")
  assert.equal(limits.maxTokens, 300_000, "and the provider's token ceiling applies too")

  respond = (call) => {
    const input = call.body.input as string[]
    return jsonResponse({
      data: input.map((_, index) => ({ embedding: [index], index })),
    })
  }
  const embedder = createEmbedder(settings)
  // 100 chunks of 2,000 estimated tokens is 200,000 tokens total: one request
  // would exceed nothing, so this asserts the ordinary path stays in one batch
  // and the per-item input ceiling is what actually splits oversized work.
  const texts = Array.from({ length: 100 }, (_, i) => `${i}${"x".repeat(8000)}`)
  const vectors = await embedder.embed(texts)
  assert.equal(vectors.length, 100)
  assert.equal(calls.length, 1, "200,000 tokens fits under the 300,000 ceiling")

  // Now exceed it: 400 chunks of 8,000 characters is about 800,000 tokens.
  calls.length = 0
  const many = Array.from({ length: 400 }, (_, i) => `${i}${"x".repeat(8000)}`)
  await embedder.embed(many)
  assert.ok(calls.length >= 3, `expected the token ceiling to split the batch, got ${calls.length} request(s)`)
  for (const call of calls) {
    const estimatedTokens = (call.body.input as string[]).reduce(
      (total, text) => total + Math.ceil(text.length / 4),
      0,
    )
    assert.ok(estimatedTokens <= 300_000, `a request carried ${estimatedTokens} tokens`)
  }
})

test("a model with a small input ceiling is truncated to fit, not dropped", async () => {
  // Alignment is the reason for truncating rather than skipping: dropping the
  // item would leave fewer vectors than inputs and desynchronize the whole file.
  respond = (call) => {
    const input = call.body.input as string[]
    return jsonResponse({ embeddings: input.map((text) => [text.length]) })
  }
  const embedder = createEmbedder(baseSettings({ provider: "ollama", modelId: "mxbai-embed-large", dimension: 1024 }))

  const long = "y".repeat(40_000)
  const vectors = await embedder.embed([long])

  assert.equal(vectors.length, 1, "the chunk is still embedded, just shortened")
  const sent = calls[0]!.body.input as string[]
  const estimatedTokens = Math.ceil(sent[0]!.length / 4)
  assert.ok(
    estimatedTokens <= 512,
    `mxbai-embed-large takes 512 tokens; the chunk was estimated at ${estimatedTokens}`,
  )
  assert.ok(sent[0]!.length < 40_000, "and was actually shortened")
})

test("an unknown model is sized conservatively, not optimistically", () => {
  // Guessing high sends a 32,000-character chunk to a model that may accept 512,
  // which comes back truncated with nothing to indicate it happened.
  const limits = resolveBatchLimits(baseSettings({ provider: "ollama", modelId: "never-heard-of-it" }))
  assert.ok(limits.maxItems > 0)
  assert.equal(getModelMaxInputTokens("ollama", "never-heard-of-it"), 512)
  assert.equal(getModelMaxInputTokens("voyage", "voyage-code-4"), 32_000)
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
