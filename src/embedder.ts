/**
 * Embedding providers implemented with the global `fetch` (no SDKs).
 *
 * Mirrors Kilo Code's request/response shapes:
 * - mistral / openai-compatible request `encoding_format: "base64"` and accept
 *   either base64-encoded Float32 vectors or plain number arrays.
 * - openai requests plain float arrays (a base64 string is tolerated anyway,
 *   some gateways return it).
 * - ollama uses the newer `/api/embed` batch endpoint.
 *
 * Batching: texts are split into requests of at most `embeddingBatchSize`
 * items and at most `MAX_BATCH_TOKENS` estimated tokens (ceil(chars / 4)).
 * Unlike Kilo (which drops oversized texts and thereby desynchronizes the
 * embedding count), items estimated above `MAX_ITEM_TOKENS` are truncated to
 * `MAX_ITEM_CHARS` characters, so input/output alignment is always preserved.
 *
 * Retries: up to `MAX_ATTEMPTS` attempts per batch for HTTP 429/5xx and
 * network failures (including timeouts), with exponential backoff
 * `500ms * 2^attempt`. Other 4xx responses fail immediately.
 */

import { DEFAULT_EMBEDDING_BATCH_SIZE, getModelDimension, getModelQueryPrefix } from "./registry.ts"
import type { Embedder, IndexingSettings } from "./types.ts"

const MISTRAL_EMBEDDINGS_URL = "https://api.mistral.ai/v1/embeddings"
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings"
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434"

const REQUEST_TIMEOUT_MS = 60_000
const OLLAMA_TIMEOUT_MS = 120_000

const MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 500

/** Model token limit (all catalog models). */
const MAX_ITEM_TOKENS = 8191
/** ~4 chars/token with a safety margin below MAX_ITEM_TOKENS. */
const MAX_ITEM_CHARS = 32_000
/** Token budget for a single request. */
const MAX_BATCH_TOKENS = 100_000
/** Do not prepend a prefix when it would blow up an otherwise valid text. */
const MAX_PREFIXED_CHARS = 4 * MAX_ITEM_TOKENS
const ERROR_BODY_SNIPPET_CHARS = 500

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
  return error instanceof Error ? error.message : String(error)
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

/** Parse an OpenAI/mistral-style `{ data: [{ embedding }] }` payload. */
function parseDataEmbeddings(payload: unknown, expected: number): number[][] {
  const data = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) throw new Error("response is missing the data array")
  const embeddings = data.map((entry) => parseVector((entry as { embedding?: unknown } | null)?.embedding))
  if (embeddings.length !== expected) {
    throw new Error(`embedding count mismatch (${embeddings.length} != ${expected})`)
  }
  return embeddings
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

function fitToTokenLimit(text: string): string {
  if (Math.ceil(text.length / 4) <= MAX_ITEM_TOKENS) return text
  return text.slice(0, MAX_ITEM_CHARS)
}

/** Split texts into batches bounded by item count and estimated token budget. */
function buildBatches(texts: string[], batchSize: number): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let currentTokens = 0

  for (const raw of texts) {
    const text = fitToTokenLimit(raw)
    const tokens = Math.ceil(text.length / 4)
    if (current.length > 0 && (current.length >= batchSize || currentTokens + tokens > MAX_BATCH_TOKENS)) {
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

function createMistralRequest(settings: IndexingSettings): BatchRequest {
  const apiKey = requireCredential(settings.credentials.mistralApiKey, "Mistral API key (credentials.mistralApiKey)")
  const modelId = settings.modelId
  return async (texts) => {
    const payload = await withRetries("mistral", () =>
      fetchJson(
        MISTRAL_EMBEDDINGS_URL,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: modelId, input: texts, encoding_format: "base64" }),
        },
        REQUEST_TIMEOUT_MS,
      ),
    )
    return parseDataEmbeddings(payload, texts.length)
  }
}

function createOpenAiRequest(settings: IndexingSettings): BatchRequest {
  const apiKey = requireCredential(settings.credentials.openAiApiKey, "OpenAI API key (credentials.openAiApiKey)")
  const modelId = settings.modelId
  return async (texts) => {
    const payload = await withRetries("openai", () =>
      fetchJson(
        OPENAI_EMBEDDINGS_URL,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: modelId, input: texts }),
        },
        REQUEST_TIMEOUT_MS,
      ),
    )
    return parseDataEmbeddings(payload, texts.length)
  }
}

function createOpenAiCompatibleRequest(settings: IndexingSettings): BatchRequest {
  const baseUrl = requireCredential(
    settings.credentials.openAiCompatibleBaseUrl,
    "OpenAI-compatible base URL (credentials.openAiCompatibleBaseUrl)",
  )
  const endpoint = resolveEmbeddingsEndpoint(baseUrl)
  const apiKey = settings.credentials.openAiCompatibleApiKey?.trim()
  const modelId = settings.modelId
  return async (texts) => {
    const headers: Record<string, string> = {}
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`
    const payload = await withRetries("openai-compatible", () =>
      fetchJson(
        endpoint,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ model: modelId, input: texts, encoding_format: "base64" }),
        },
        REQUEST_TIMEOUT_MS,
      ),
    )
    return parseDataEmbeddings(payload, texts.length)
  }
}

function createOllamaRequest(settings: IndexingSettings): BatchRequest {
  const configured = settings.credentials.ollamaBaseUrl?.trim()
  const baseUrl = stripTrailingSlashes(configured && configured.length > 0 ? configured : DEFAULT_OLLAMA_BASE_URL)
  const endpoint = `${baseUrl}/api/embed`
  const modelId = settings.modelId
  return async (texts) => {
    const payload = await withRetries("ollama", () =>
      fetchJson(
        endpoint,
        { method: "POST", body: JSON.stringify({ model: modelId, input: texts }) },
        OLLAMA_TIMEOUT_MS,
      ),
    )
    return parseOllamaEmbeddings(payload, texts.length)
  }
}

function createEmbedderImpl(settings: IndexingSettings, request: BatchRequest, prefix: string | undefined): Embedder {
  const provider = settings.provider
  const modelId = settings.modelId
  const dimension = settings.dimension || getModelDimension(provider, modelId) || 0
  const batchSize =
    Number.isFinite(settings.embeddingBatchSize) && settings.embeddingBatchSize > 0
      ? Math.floor(settings.embeddingBatchSize)
      : DEFAULT_EMBEDDING_BATCH_SIZE

  return {
    provider,
    modelId,
    dimension,
    async embed(texts) {
      const prepared = applyPrefix(texts, prefix)
      const batches = buildBatches(prepared, batchSize)
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
  switch (provider) {
    case "mistral":
      return createEmbedderImpl(settings, createMistralRequest(settings), undefined)
    case "openai":
      return createEmbedderImpl(settings, createOpenAiRequest(settings), undefined)
    case "openai-compatible":
      return createEmbedderImpl(
        settings,
        createOpenAiCompatibleRequest(settings),
        getModelQueryPrefix(provider, settings.modelId) ?? settings.queryPrefix,
      )
    case "ollama":
      return createEmbedderImpl(
        settings,
        createOllamaRequest(settings),
        getModelQueryPrefix(provider, settings.modelId) ?? settings.queryPrefix,
      )
    default:
      throw new Error(`Unsupported embedder provider: ${provider}`)
  }
}
