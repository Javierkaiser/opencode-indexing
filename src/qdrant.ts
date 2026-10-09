import type {
  QdrantFilter,
  QdrantPoint,
  QueryHit,
  QueryOptions,
} from "./types.ts"

export interface QdrantConfig {
  url: string
  apiKey?: string
  userAgent?: string
}

export interface CollectionConfig {
  vectors: {
    size: number
    distance: "Cosine" | "Euclid" | "Dot"
    on_disk?: boolean
  }
  hnsw_config?: {
    m?: number
    ef_construct?: number
    on_disk?: boolean
  }
}

export interface ScrollOptions {
  filter?: QdrantFilter
  limit: number
  withPayload?: boolean
  withVector?: boolean
  offset?: unknown
}

export interface Qdrant {
  listCollections(): Promise<string[]>
  getCollection(name: string): Promise<Record<string, any> | null>
  collectionExists(name: string): Promise<boolean>
  createCollection(name: string, config: CollectionConfig): Promise<void>
  deleteCollection(name: string): Promise<void>
  retrieve(
    name: string,
    ids: Array<string | number>,
  ): Promise<Array<{ id: string | number; payload: Record<string, unknown> | null }>>
  scroll(
    name: string,
    options: ScrollOptions,
  ): Promise<{
    points: Array<{ id: string | number; payload: Record<string, unknown> | null; vector?: number[] }>
    next?: unknown
  }>
  query(name: string, options: QueryOptions): Promise<QueryHit[]>
  upsert(name: string, points: QdrantPoint[], wait?: boolean): Promise<void>
  deletePoints(name: string, filter: QdrantFilter | undefined, wait?: boolean): Promise<void>
  createPayloadIndex(
    name: string,
    field: string,
    schema?: "keyword" | "integer" | "float" | "bool" | "text",
  ): Promise<void>
}

type PointRow = { id: string | number; payload: Record<string, unknown> | null; vector?: number[] }

interface RequestOptions {
  /** Override the shared request timeout for this call (milliseconds). */
  timeoutMs?: number
  /** Retry attempts after a timeout; only set on idempotent calls. */
  retriesOnTimeout?: number
}

const DEFAULT_URL = "http://localhost:6333"
const DEFAULT_USER_AGENT = "opencode-indexing/0.1.0"
const DEFAULT_INCLUDE = [
  "filePath",
  "fileHash",
  "codeChunk",
  "startLine",
  "endLine",
  "pathSegments",
]
const REQUEST_TIMEOUT_MS = 60_000
/**
 * Deletes are issued mid-build while Qdrant is already loaded, so they can
 * exceed the shared 60 s budget (a single-file delete already takes ~464 ms).
 * They therefore get a longer, dedicated timeout instead of raising the limit
 * for every request.
 */
const DELETE_TIMEOUT_MS = 180_000
/**
 * A delete is idempotent (re-applying the same filter matches nothing the
 * second time), so retrying once after a timeout is safe and turns a transient
 * stall into a success instead of a recorded warning.
 */
const DELETE_TIMEOUT_RETRIES = 1
const BODY_SNIPPET_MAX = 500

function truncateBody(text: string): string {
  return text.length > BODY_SNIPPET_MAX ? text.slice(0, BODY_SNIPPET_MAX) : text
}

class QdrantHttpError extends Error {
  readonly status: number

  constructor(method: string, path: string, status: number, bodyText: string) {
    super(`Qdrant ${method} ${path} failed: HTTP ${status} ${truncateBody(bodyText)}`)
    this.name = "QdrantHttpError"
    this.status = status
  }
}

class QdrantTimeoutError extends Error {
  constructor(method: string, path: string, reason: string) {
    super(`Qdrant ${method} ${path} failed: ${reason}`)
    this.name = "QdrantTimeoutError"
  }
}

/**
 * True when a fetch failure was caused by the request timeout aborting.
 * Accepts the raw abort reason as well as the error this module wraps it in.
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof QdrantTimeoutError) return true
  if (!(error instanceof Error)) return false
  if (error.name === "TimeoutError" || error.name === "AbortError") return true
  return /timed out|timeout/i.test(error.message)
}

/** Trim, default when empty, add protocol when missing, strip trailing slashes. */
function normalizeUrl(raw: string | undefined): string {
  let url = typeof raw === "string" ? raw.trim() : ""
  if (!url) url = DEFAULT_URL
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) url = `http://${url}`
  return url.replace(/\/+$/, "")
}

function pointRow(raw: any): PointRow {
  const row: PointRow = {
    id: raw?.id as string | number,
    payload: (raw?.payload ?? null) as Record<string, unknown> | null,
  }
  if (Array.isArray(raw?.vector)) {
    row.vector = raw.vector as number[]
  }
  return row
}

function pointRows(value: unknown): PointRow[] {
  if (!Array.isArray(value)) return []
  return value.map(pointRow)
}

export function createQdrant(config: QdrantConfig): Qdrant {
  const base = normalizeUrl(config.url)
  const apiKey = config.apiKey?.trim() ? config.apiKey.trim() : undefined
  const userAgent = config.userAgent?.trim() ? config.userAgent.trim() : DEFAULT_USER_AGENT

  async function request(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<any> {
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
    const retries = options.retriesOnTimeout ?? 0
    for (let attempt = 0; ; attempt++) {
      try {
        return await requestOnce(method, path, body, timeoutMs)
      } catch (error) {
        if (attempt >= retries || !isTimeoutError(error)) throw error
      }
    }
  }

  async function requestOnce(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<any> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": userAgent,
    }
    if (apiKey) headers["api-key"] = apiKey
    if (body !== undefined) headers["content-type"] = "application/json"

    let response: Response
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (isTimeoutError(error)) throw new QdrantTimeoutError(method, path, reason)
      throw new Error(`Qdrant ${method} ${path} failed: ${reason}`)
    }

    const text = await response.text()
    if (!response.ok) {
      throw new QdrantHttpError(method, path, response.status, text)
    }
    if (!text.trim()) return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(
        `Qdrant ${method} ${path} failed: invalid JSON in response body: ${truncateBody(text)}`,
      )
    }
  }

  function collectionPath(name: string): string {
    return `/collections/${encodeURIComponent(name)}`
  }

  function pointsPath(name: string): string {
    return `${collectionPath(name)}/points`
  }

  async function listCollections(): Promise<string[]> {
    const data = await request("GET", "/collections")
    const collections: unknown = data?.result?.collections
    if (!Array.isArray(collections)) return []
    return collections
      .map((entry: any) => entry?.name)
      .filter((name: unknown): name is string => typeof name === "string")
  }

  async function getCollection(name: string): Promise<Record<string, any> | null> {
    try {
      const data = await request("GET", collectionPath(name))
      return (data?.result ?? null) as Record<string, any> | null
    } catch (error) {
      if (error instanceof QdrantHttpError && error.status === 404) return null
      throw error
    }
  }

  async function collectionExists(name: string): Promise<boolean> {
    return (await getCollection(name)) !== null
  }

  async function createCollection(name: string, config: CollectionConfig): Promise<void> {
    await request("PUT", collectionPath(name), config)
  }

  async function deleteCollection(name: string): Promise<void> {
    await request("DELETE", collectionPath(name))
  }

  async function retrieve(
    name: string,
    ids: Array<string | number>,
  ): Promise<PointRow[]> {
    const data = await request("POST", pointsPath(name), {
      ids,
      with_payload: true,
      with_vector: false,
    })
    return pointRows(data?.result)
  }

  async function scroll(
    name: string,
    options: ScrollOptions,
  ): Promise<{ points: PointRow[]; next?: unknown }> {
    const body: Record<string, unknown> = {
      limit: options.limit,
      with_payload: options.withPayload ?? true,
      with_vector: options.withVector ?? false,
    }
    if (options.filter !== undefined) body.filter = options.filter
    if (options.offset !== undefined) body.offset = options.offset

    const data = await request("POST", `${pointsPath(name)}/scroll`, body)
    const result = data?.result ?? {}
    const out: { points: PointRow[]; next?: unknown } = {
      points: pointRows(result.points),
    }
    if (result.next_page_offset !== undefined && result.next_page_offset !== null) {
      out.next = result.next_page_offset
    }
    return out
  }

  async function query(name: string, options: QueryOptions): Promise<QueryHit[]> {
    const include = options.include === undefined ? DEFAULT_INCLUDE : options.include
    const body: Record<string, unknown> = {
      query: options.vector,
      params: { hnsw_ef: options.hnswEf ?? 128, exact: false },
      with_payload: include.length === 0 ? false : { include },
    }
    if (options.filter !== undefined) body.filter = options.filter
    if (options.scoreThreshold !== undefined) body.score_threshold = options.scoreThreshold
    if (options.limit !== undefined) body.limit = options.limit

    const data = await request("POST", `${pointsPath(name)}/query`, body)
    // Qdrant 1.19 returns { result: { points: [...] } }; accept { result: [...] } too.
    const points: unknown = Array.isArray(data?.result) ? data.result : data?.result?.points
    if (!Array.isArray(points)) return []
    return points.map((raw: any) => ({
      id: raw?.id as string | number,
      score: typeof raw?.score === "number" ? raw.score : 0,
      payload: (raw?.payload ?? null) as Record<string, unknown> | null,
    }))
  }

  async function upsert(name: string, points: QdrantPoint[], wait = true): Promise<void> {
    await request("PUT", `${pointsPath(name)}?wait=${wait}`, { points })
  }

  async function deletePoints(
    name: string,
    filter: QdrantFilter | undefined,
    wait = true,
  ): Promise<void> {
    // For an unscoped delete Qdrant expects a filter; an empty `must` matches all.
    const body = filter === undefined ? { filter: { must: [] } } : { filter }
    await request("POST", `${pointsPath(name)}/delete?wait=${wait}`, body, {
      timeoutMs: DELETE_TIMEOUT_MS,
      retriesOnTimeout: DELETE_TIMEOUT_RETRIES,
    })
  }

  async function createPayloadIndex(
    name: string,
    field: string,
    schema: "keyword" | "integer" | "float" | "bool" | "text" = "keyword",
  ): Promise<void> {
    try {
      await request("PUT", `${collectionPath(name)}/index`, {
        field_name: field,
        field_schema: schema,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/already exists/i.test(message)) return
      throw error
    }
  }

  return {
    listCollections,
    getCollection,
    collectionExists,
    createCollection,
    deleteCollection,
    retrieve,
    scroll,
    query,
    upsert,
    deletePoints,
    createPayloadIndex,
  }
}
