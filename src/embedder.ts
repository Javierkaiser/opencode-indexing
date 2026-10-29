/**
 * Embedding providers implemented with the global `fetch` (no SDKs).
 *
 * Four of the seven share one wire shape - `POST {base}/embeddings`, bearer
 * auth, `{ input, model }` in and `{ data: [{ embedding, index }] }` out - so
 * they run through a single parameterised adapter rather than four near-copies:
 * OpenAI, Mistral, Voyage and OpenRouter. Gemini and Ollama differ enough to
 * need their own: Gemini authenticates with a header, takes its own request
 * shape and returns vectors under a different key, and Ollama has no auth and
 * returns a bare positional array.
 *
 * Batching is bounded per provider. A single global item count was wrong the
 * moment more than one provider existed: OpenAI caps a request at 300,000
 * tokens regardless of item count, Gemini accepts a fixed number of items per
 * call, and Voyage has both ceilings. Bounds come from each provider's own
 * documentation and are combined with the user's `embeddingBatchSize`.
 *
 * Unlike Kilo - which drops oversized texts and thereby desynchronizes the
 * embedding count - items above the model's input ceiling are truncated, so
 * input/output alignment is always preserved.
 *
 * Retries: up to `MAX_ATTEMPTS` attempts per batch for HTTP 429/5xx and
 * network failures (including timeouts), with exponential backoff
 * `500ms * 2^attempt`. Other 4xx responses fail immediately.
 */

import type { StaticModel } from "mini-semantic-search"

import {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  getModelDimension,
  getModelMaxInputTokens,
  getModelProfile,
  getModelQueryPrefix,
} from "./registry.ts"
import type { Embedder, EmbedderProvider, IndexingSettings } from "./types.ts"
import { describeError } from "./errors.ts"

const REQUEST_TIMEOUT_MS = 60_000
const OLLAMA_TIMEOUT_MS = 120_000

const MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 500

/** ~4 characters per token, the same estimate the batch budget uses. */
const CHARS_PER_TOKEN = 4
/**
 * Fraction of the model's documented input ceiling we are willing to send.
 *
 * The characters-per-token figure is an estimate, so filling a chunk to exactly
 * the ceiling risks a rejection from any model whose tokenizer is slightly
 * denser than assumed. The cost of this margin is a few percent of a chunk; the
 * cost of getting it wrong is a whole indexing run failing on a long file.
 */
const INPUT_SAFETY = 0.95
/** Token budget for a request when neither the user nor the provider sets one. */
const FALLBACK_MAX_BATCH_TOKENS = 100_000
/** Item ceiling for a request when neither the user nor the provider sets one. */
const FALLBACK_MAX_BATCH_ITEMS = 64
/** Do not prepend a prefix when it would blow up an otherwise valid text. */
const MAX_PREFIXED_CHARS = 4 * 8_192
const ERROR_BODY_SNIPPET_CHARS = 500

/** Name of the request field that asks a provider for a specific output width. */
type DimensionParam = "dimensions" | "output_dimension" | "none"

interface ProviderSpec {
  /** Label used in retries and error messages. */
  label: string
  /** Endpoint, ignoring any per-provider variation resolved at call time. */
  url: string
  /** Header carrying the credential, or undefined for an unauthenticated local server. */
  authHeader?: string
  /** Requested response encoding, where asking for it is worth the bytes. */
  encodingFormat?: "base64"
  /** Defaults merged into every request body. */
  baseBody?: Record<string, unknown>
  /** Refuses over-long input instead of truncating it, where the API offers the choice. */
  refuseOversizedInput?: boolean
}

const PROVIDER_SPECS: Partial<Record<EmbedderProvider, ProviderSpec>> = {
  openai: {
    label: "openai",
    url: "https://api.openai.com/v1/embeddings",
    authHeader: "Authorization",
  },
  mistral: {
    label: "mistral",
    url: "https://api.mistral.ai/v1/embeddings",
    authHeader: "Authorization",
    encodingFormat: "base64",
  },
  voyage: {
    label: "voyage",
    url: "https://api.voyageai.com/v1/embeddings",
    authHeader: "Authorization",
    // Voyage documents that embeddings made with and without `input_type` are
    // interchangeable, so it can be left off without breaking a Kilo-imported
    // index. Setting it to "document" is the single largest quality lever the
    // provider offers for retrieval, so it is on for documents.
    baseBody: { input_type: "document", truncation: false },
  },
  openrouter: {
    label: "openrouter",
    url: "https://openrouter.ai/api/v1/embeddings",
    authHeader: "Authorization",
  },
  gemini: {
    label: "gemini",
    url: "",
    authHeader: "x-goog-api-key",
  },
  // The URL is whatever the user configured, resolved at call time. Asking for
  // base64 is the same gamble this adapter makes for Mistral; the response
  // parser accepts either form, so a server that ignores the field still works.
  "openai-compatible": {
    label: "openai-compatible",
    url: "",
    authHeader: "Authorization",
    encodingFormat: "base64",
  },
  ollama: {
    label: "ollama",
    url: "",
    // Truncating a code chunk without saying so produces a vector that looks
    // fine and retrieves the wrong thing forever, so the failure has to be loud.
    baseBody: { truncate: false },
  },
}

class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "HttpError"
    this.status = status
  }
}

class NetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NetworkError"
  }
}

function errorMessage(error: unknown): string {
  return describeError(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 429 || error.status >= 500
  return error instanceof NetworkError
}

/** Merge the caller headers with the JSON content type as a plain object. */
function jsonHeaders(init: RequestInit): Record<string, string> {
  const merged = new Headers(init.headers)
  if (!merged.has("Content-Type")) merged.set("Content-Type", "application/json")
  const headers: Record<string, string> = {}
  merged.forEach((value, key) => {
    headers[key] = value
  })
  return headers
}

/** Best-effort response body text for error snippets. */
async function readSnippet(response: Response): Promise<string> {
  try {
    if (typeof response.text === "function") return (await response.text()).slice(0, ERROR_BODY_SNIPPET_CHARS)
    if (typeof response.json === "function") return JSON.stringify(await response.json()).slice(0, ERROR_BODY_SNIPPET_CHARS)
  } catch {
    // Body already consumed or unreadable: fall through to an empty snippet.
  }
  return ""
}

/**
 * Single entry point for HTTP calls: merges JSON headers, applies a timeout via
 * `AbortSignal.timeout(timeoutMs)`, throws `HTTP <status>: <body-snippet>` on
 * non-2xx, and parses JSON bodies with a clear error on malformed content.
 */
async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: jsonHeaders(init),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new NetworkError(errorMessage(error))
  }

  if (!response.ok) {
    const snippet = await readSnippet(response)
    throw new HttpError(response.status, `HTTP ${response.status}: ${snippet}`)
  }

  try {
    if (typeof response.json === "function") return (await response.json()) as unknown
    return JSON.parse(await response.text()) as unknown
  } catch (error) {
    throw new Error(`HTTP ${response.status}: invalid JSON response: ${errorMessage(error)}`)
  }
}

/** Run `request` with retries, then wrap failures with the provider name. */
async function withRetries<T>(provider: string, request: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await request()
    } catch (error) {
      lastError = error
      if (!isRetryable(error) || attempt === MAX_ATTEMPTS - 1) break
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt)
    }
  }
  throw new Error(`${provider}: embedding request failed: ${errorMessage(lastError)}`)
}

/** Decode a base64 string of little-endian Float32 values (mistral format). */
function decodeBase64Float32(value: string): number[] {
  const buffer = Buffer.from(value, "base64")
  const floats = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4))
  return Array.from(floats, (entry) => Number(entry))
}

function parseVector(value: unknown): number[] {
  if (Array.isArray(value)) return value.map((entry) => Number(entry))
  if (typeof value === "string") return decodeBase64Float32(value)
  throw new Error("unexpected embedding format (expected number[] or base64 string)")
}

/**
 * Parse an OpenAI-shaped `{ data: [{ embedding, index }] }` payload.
 *
 * Results are placed by `index`, not by array position. OpenAI's own samples
 * fetch by `embedding.index`, and its documentation describes the field rather
 * than promising order, so trusting the position is trusting something the
 * vendor never did. A response with no `index` on any entry keeps its order,
 * which is the best that can be done for a gateway that omits it.
 */
function parseDataEmbeddings(payload: unknown, expected: number): number[][] {
  const data = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) throw new Error("response is missing the data array")
  if (data.length !== expected) {
    throw new Error(`embedding count mismatch (${data.length} != ${expected})`)
  }

  const entries = data.map((entry, position) => ({
    position,
    index: toFiniteIndex((entry as { index?: unknown } | null)?.index),
    vector: parseVector((entry as { embedding?: unknown } | null)?.embedding),
  }))

  const indexed = entries.every((entry) => entry.index !== undefined)
  if (indexed) {
    const out: (number[] | undefined)[] = new Array(expected)
    for (const entry of entries) {
      const index = entry.index as number
      if (index < 0 || index >= expected || out[index] !== undefined) {
        throw new Error(`response returned an out-of-range or repeated embedding index (${index})`)
      }
      out[index] = entry.vector
    }
    if (out.some((vector) => vector === undefined)) {
      throw new Error("response is missing one or more embedding indices")
    }
    return out as number[][]
  }

  return entries.map((entry) => entry.vector)
}

function toFiniteIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** Parse Ollama's `{ embeddings: number[][] }` payload. */
function parseOllamaEmbeddings(payload: unknown, expected: number): number[][] {
  const embeddings = (payload as { embeddings?: unknown } | null)?.embeddings
  if (!Array.isArray(embeddings)) throw new Error("response is missing the embeddings array")
  const vectors = embeddings.map((entry, index) => {
    if (!Array.isArray(entry)) throw new Error(`embedding ${index} is not an array`)
    return entry.map((value) => Number(value))
  })
  if (vectors.length !== expected) {
    throw new Error(`embedding count mismatch (${vectors.length} != ${expected})`)
  }
  return vectors
}

/**
 * The shape Gemini's batch endpoint returns: `{ embeddings: [{ values }] }`.
 *
 * `values` rather than `embedding`, and documented as coming back in the same
 * order as the requests. There is no `index` to verify that against, so the
 * count check is the only guard there is.
 */
function parseGeminiEmbeddings(payload: unknown, expected: number): number[][] {
  const embeddings = (payload as { embeddings?: unknown } | null)?.embeddings
  if (!Array.isArray(embeddings)) throw new Error("response is missing the embeddings array")
  if (embeddings.length !== expected) {
    throw new Error(`embedding count mismatch (${embeddings.length} != ${expected})`)
  }
  return embeddings.map((entry, index) => {
    const values = (entry as { values?: unknown } | null)?.values
    if (!Array.isArray(values)) throw new Error(`embedding ${index} has no values array`)
    return values.map((value) => Number(value))
  })
}

/**
 * Apply the model query prefix to every text. Already-prefixed texts are left
 * untouched (Kilo applies the same prefix for indexing and querying). Texts
 * that would exceed the model limit only due to the prefix are kept as-is.
 */
function applyPrefix(texts: readonly string[], prefix: string | undefined): string[] {
  if (!prefix) return [...texts]
  return texts.map((text) => {
    if (text.startsWith(prefix)) return text
    const prefixed = prefix + text
    return prefixed.length > MAX_PREFIXED_CHARS ? text : prefixed
  })
}

/** Per-request ceilings, after combining the user's setting with the provider's. */
export interface BatchLimits {
  maxItems: number
  maxTokens: number
}

/**
 * Split texts into batches bounded by item count and estimated token budget.
 *
 * Both ceilings are per provider. OpenAI accepts at most 300,000 tokens in one
 * request however many items that is, so at 8,192 tokens per chunk a batch is
 * about 36 items - well under the configured `embeddingBatchSize` of 60, and
 * a fixed item count would have produced 400,000 tokens and a 400.
 */
function buildBatches(texts: string[], limits: BatchLimits, maxItemTokens: number): string[][] {
  const maxItemChars = Math.floor(maxItemTokens * CHARS_PER_TOKEN * INPUT_SAFETY)
  const batches: string[][] = []
  let current: string[] = []
  let currentTokens = 0

  for (const raw of texts) {
    // Truncating keeps the output aligned with the input, which dropping the
    // item would not.
    const text = raw.length <= maxItemChars ? raw : raw.slice(0, maxItemChars)
    const tokens = Math.ceil(text.length / CHARS_PER_TOKEN)
    if (
      current.length > 0 &&
      (current.length >= limits.maxItems || currentTokens + tokens > limits.maxTokens)
    ) {
      batches.push(current)
      current = []
      currentTokens = 0
    }
    current.push(text)
    currentTokens += tokens
  }

  if (current.length > 0) batches.push(current)
  return batches
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "")
}

/** Keep URLs that already point at an embeddings endpoint, else append it. */
function resolveEmbeddingsEndpoint(baseUrl: string): string {
  const base = stripTrailingSlashes(baseUrl)
  if (/\/embeddings(\?|$)/.test(base) || /\/embed(\?|$)/.test(base)) return base
  return `${base}/embeddings`
}

function requireCredential(value: string | undefined, description: string): string {
  const trimmed = value?.trim()
  if (!trimmed) throw new Error(`Missing ${description}`)
  return trimmed
}

type BatchRequest = (texts: string[]) => Promise<number[][]>

/**
 * One adapter for every provider that speaks the OpenAI wire shape.
 *
 * The endpoint, the auth header and a couple of optional body fields are the
 * only things that differ between OpenAI, Mistral, Voyage, OpenRouter and an
 * arbitrary OpenAI-compatible server, so they are what varies. Mistral's raw
 * HTTP body takes `input` (singular) even though every Mistral SDK and every
 * example in their documentation uses `inputs`; generating the body from those
 * examples sends the wrong field and produces an empty input.
 */
function createOpenAIShapedRequestImpl(
  spec: ProviderSpec,
  settings: IndexingSettings,
  options: { url: string; auth?: string },
): BatchRequest {
  const modelId = settings.modelId
  const headers: Record<string, string> = {}
  if (spec.authHeader && options.auth) headers[spec.authHeader] = `Bearer ${options.auth}`

  return async (texts) => {
    const body: Record<string, unknown> = {
      ...spec.baseBody,
      model: modelId,
      input: texts,
      ...(spec.encodingFormat ? { encoding_format: spec.encodingFormat } : {}),
    }
    const payload = await withRetries(spec.label, () =>
      fetchJson(options.url, { method: "POST", headers, body: JSON.stringify(body) }, REQUEST_TIMEOUT_MS),
    )
    return parseDataEmbeddings(payload, texts.length)
  }
}

function createMistralRequest(settings: IndexingSettings): BatchRequest {
  const spec = requireSpec("mistral")
  return createOpenAIShapedRequestImpl(spec, settings, {
    url: spec.url,
    auth: requireCredential(settings.credentials.mistralApiKey, "Mistral API key (credentials.mistralApiKey)"),
  })
}

function createOpenAiRequest(settings: IndexingSettings): BatchRequest {
  const spec = requireSpec("openai")
  return createOpenAIShapedRequestImpl(spec, settings, {
    url: spec.url,
    auth: requireCredential(settings.credentials.openAiApiKey, "OpenAI API key (credentials.openAiApiKey)"),
  })
}

function createVoyageRequest(settings: IndexingSettings): BatchRequest {
  const spec = requireSpec("voyage")
  return createOpenAIShapedRequestImpl(spec, settings, {
    url: spec.url,
    auth: requireCredential(settings.credentials.voyageApiKey, "Voyage API key (credentials.voyageApiKey)"),
  })
}

function createOpenRouterRequest(settings: IndexingSettings): BatchRequest {
  const spec = requireSpec("openrouter")
  return createOpenAIShapedRequestImpl(spec, settings, {
    url: spec.url,
    auth: requireCredential(settings.credentials.openRouterApiKey, "OpenRouter API key (credentials.openRouterApiKey)"),
  })
}

function createOpenAiCompatibleRequest(settings: IndexingSettings): BatchRequest {
  const spec = requireSpec("openai-compatible")
  const baseUrl = requireCredential(
    settings.credentials.openAiCompatibleBaseUrl,
    "OpenAI-compatible base URL (credentials.openAiCompatibleBaseUrl)",
  )
  // A generic endpoint may or may not honour `encoding_format`; asking is the
  // same gamble this adapter already makes for Mistral, and the response parser
  // accepts either form, so a server that ignores it still works.
  return createOpenAIShapedRequestImpl(
    spec,
    settings,
    { url: resolveEmbeddingsEndpoint(baseUrl), auth: settings.credentials.openAiCompatibleApiKey?.trim() },
  )
}

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"

/**
 * Gemini's batch endpoint, with every input wrapped in its own `Content`.
 *
 * The wrapping is not decoration. `gemini-embedding-001` embeds a list of
 * strings one vector per string, but `gemini-embedding-2` aggregates a plain
 * list into a single vector. Sending the list unwrapped therefore returns one
 * vector for N inputs and writes N-1 missing chunks into the index, with no
 * error anywhere. Wrapping makes both models behave the same way.
 */
function createGeminiRequest(settings: IndexingSettings): BatchRequest {
  const spec = requireSpec("gemini")
  const apiKey = requireCredential(settings.credentials.geminiApiKey, "Gemini API key (credentials.geminiApiKey)")
  const model = encodeURIComponent(settings.modelId)
  const url = `${GEMINI_API_BASE}/models/${model}:batchEmbedContents`
  const headers = { [spec.authHeader as string]: apiKey }

  return async (texts) => {
    const body = {
      requests: texts.map((text) => ({
        model: `models/${settings.modelId}`,
        content: { parts: [{ text }] },
      })),
    }
    const payload = await withRetries(spec.label, () =>
      fetchJson(url, { method: "POST", headers, body: JSON.stringify(body) }, REQUEST_TIMEOUT_MS),
    )
    return parseGeminiEmbeddings(payload, texts.length)
  }
}

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434"

/**
 * Ollama's `/api/embed`, which returns a bare positional array.
 *
 * There is no `index` field and no documented ordering guarantee, so
 * correspondence is positional and unverifiable. `truncate: false` makes an
 * over-long chunk fail loudly: with the default of `true`, `mxbai-embed-large`
 * would quietly embed the first 512 tokens of every function in the repository
 * and store the result as though it were the whole thing.
 */
function createOllamaRequest(settings: IndexingSettings): BatchRequest {
  const spec = requireSpec("ollama")
  const configured = settings.credentials.ollamaBaseUrl?.trim()
  const baseUrl = stripTrailingSlashes(configured && configured.length > 0 ? configured : DEFAULT_OLLAMA_BASE_URL)
  const endpoint = `${baseUrl}/api/embed`
  const modelId = settings.modelId

  return async (texts) => {
    const payload = await withRetries(spec.label, () =>
      fetchJson(
        endpoint,
        { method: "POST", body: JSON.stringify({ ...spec.baseBody, model: modelId, input: texts }) },
        OLLAMA_TIMEOUT_MS,
      ),
    )
    return parseOllamaEmbeddings(payload, texts.length)
  }
}

/**
 * The bundled static model, shared by every embedder in the process.
 *
 * `mini-semantic-search` packs potion-base-8M to 128 dimensions at 4 bits
 * (~2 MB) and implements Model2Vec inference plus a BERT tokenizer in plain
 * TypeScript: no native addon, no ONNX session and no background process, at
 * about 0.2 ms per chunk. A failed load clears the cache so a later attempt can
 * retry instead of pinning a rejected promise for the life of the process.
 */
let localModel: Promise<StaticModel> | undefined

function loadLocalModel(): Promise<StaticModel> {
  localModel ??= import("mini-semantic-search")
    .then((module) => module.StaticModel.load())
    .catch((error: unknown) => {
      localModel = undefined
      throw new Error(`local: could not load the bundled embedding model: ${errorMessage(error)}`)
    })
  return localModel
}

/**
 * Local embeddings through the packaged static model.
 *
 * There is no server and no request: the batch is embedded in this process.
 * Vectors come back unit length, which is what the store and the cosine score
 * assume, and the model's 128 dimensions are fixed by its catalog entry.
 */
function createLocalRequest(): BatchRequest {
  return async (texts) => {
    const model = await loadLocalModel()
    return texts.map((text) => Array.from(model.embed(text)))
  }
}

function requireSpec(provider: EmbedderProvider): ProviderSpec {
  const spec = PROVIDER_SPECS[provider]
  if (!spec) throw new Error(`Unsupported embedder provider: ${provider}`)
  return spec
}

/**
 * Combine the user's `embeddingBatchSize` with the provider's own ceilings.
 *
 * `embeddingBatchSize` is an item ceiling, so it is compared against the
 * provider's item ceiling. The token ceiling is not derived from the item
 * count: the two are independent limits, and deriving one from the other
 * silently caps throughput at whatever arithmetic happens to produce.
 */
export function resolveBatchLimits(settings: IndexingSettings): BatchLimits {
  const profile = getModelProfile(settings.provider, settings.modelId)
  const configured =
    Number.isFinite(settings.embeddingBatchSize) && settings.embeddingBatchSize > 0
      ? Math.floor(settings.embeddingBatchSize)
      : DEFAULT_EMBEDDING_BATCH_SIZE
  return {
    maxItems: Math.max(1, Math.min(configured, profile?.maxBatchItems ?? FALLBACK_MAX_BATCH_ITEMS)),
    maxTokens: Math.max(1, profile?.maxBatchTokens ?? FALLBACK_MAX_BATCH_TOKENS),
  }
}

function createEmbedderImpl(settings: IndexingSettings, request: BatchRequest, prefix: string | undefined): Embedder {
  const provider = settings.provider
  const modelId = settings.modelId
  const dimension = settings.dimension || getModelDimension(provider, modelId) || 0
  const limits = resolveBatchLimits(settings)
  const maxItemTokens = getModelMaxInputTokens(provider, modelId)

  return {
    provider,
    modelId,
    dimension,
    async embed(texts) {
      const prepared = applyPrefix(texts, prefix)
      const batches = buildBatches(prepared, limits, maxItemTokens)
      const vectors: number[][] = []
      for (const batch of batches) {
        const embedded = await request(batch)
        if (embedded.length !== batch.length) {
          throw new Error(`${provider}: embedding count mismatch (${embedded.length} != ${batch.length})`)
        }
        vectors.push(...embedded)
      }
      if (vectors.length !== texts.length) {
        throw new Error(`${provider}: embedding count mismatch (${vectors.length} != ${texts.length})`)
      }
      return vectors
    },
  }
}

/**
 * Create the embedder for the configured provider.
 *
 * Credential/base-URL validation happens eagerly, so a misconfigured embedder
 * fails at creation time with a clear message (callers already create it inside
 * try/catch when probing profiles).
 */
export function createEmbedder(settings: IndexingSettings): Embedder {
  const provider = settings.provider
  // The prefix comes from the catalog for models that declare one (nomic and
  // friends); otherwise the resolved setting, which only an explicit override
  // sets. Mistral and OpenAI declare none.
  const prefix = getModelQueryPrefix(provider, settings.modelId) ?? settings.queryPrefix
  switch (provider) {
    case "local":
      return createEmbedderImpl(settings, createLocalRequest(), prefix)
    case "mistral":
      return createEmbedderImpl(settings, createMistralRequest(settings), undefined)
    case "openai":
      return createEmbedderImpl(settings, createOpenAiRequest(settings), undefined)
    case "voyage":
      return createEmbedderImpl(settings, createVoyageRequest(settings), undefined)
    case "openrouter":
      return createEmbedderImpl(settings, createOpenRouterRequest(settings), undefined)
    case "gemini":
      return createEmbedderImpl(settings, createGeminiRequest(settings), undefined)
    case "openai-compatible":
      return createEmbedderImpl(settings, createOpenAiCompatibleRequest(settings), prefix)
    case "ollama":
      return createEmbedderImpl(settings, createOllamaRequest(settings), prefix)
    default:
      throw new Error(`Unsupported embedder provider: ${provider as string}`)
  }
}
