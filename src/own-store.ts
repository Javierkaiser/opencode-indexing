import path from "node:path"

import { workspaceHash } from "./registry.ts"
import type { Qdrant } from "./qdrant.ts"
import type { EmbeddingProfile, QdrantFieldCondition, QdrantFilter, QdrantPoint, QueryHit } from "./types.ts"

/**
 * The plugin's own Qdrant index.
 *
 * Collections use the `oc-` prefix so they never collide with Kilo's `ws-`
 * collections, and the payload layout mirrors Kilo's (`pathSegments`, `type`
 * metadata point, ...) to keep behavior comparable.
 */

export const OWN_METADATA_ID = "9f2a7c1e-4b3d-4f6a-8e5c-2d1b7a9c3e6f"
export const OWN_SCHEMA = 1

const METADATA_TYPE = "oc_metadata"
const DEFAULT_MIN_SCORE = 0.4
const DEFAULT_MAX_RESULTS = 50
const DEFAULT_HNSW_EF = 128

/** Payload fields requested for every chunk query (same list as Kilo). */
const OWN_PAYLOAD_INCLUDE: readonly string[] = [
  "filePath",
  "fileHash",
  "codeChunk",
  "startLine",
  "endLine",
  "pathSegments",
]

/** Payload fields a chunk must expose to be usable as a search hit (mirrors Kilo). */
const REQUIRED_CHUNK_FIELDS: readonly string[] = ["filePath", "fileHash", "codeChunk", "startLine", "endLine"]

/** How many leading path segments get a dedicated payload index. */
const INDEXED_PATH_SEGMENT_COUNT = 5

export interface OwnStoreInfo {
  collection: string
  pointsCount: number
  profile?: EmbeddingProfile
  complete?: boolean
  schema?: number
}

export interface OwnSearchOptions {
  vector: number[]
  pathPrefix?: string
  minScore?: number
  maxResults?: number
  hnswEf?: number
}

/** Collections of the plugin's own index use this prefix (Kilo's use `ws-`). */
export const OWN_COLLECTION_PREFIX = "oc-"

/** Name of the plugin's collection for a workspace root. */
export function ownCollectionName(root: string): string {
  return `${OWN_COLLECTION_PREFIX}${workspaceHash(root).slice(0, 16)}`
}

/**
 * Create the collection (vector config + payload indexes) when missing.
 * An existing collection is kept as-is; a vector size mismatch throws instead
 * of being recreated silently.
 */
export async function ensureOwnCollection(
  client: Qdrant,
  name: string,
  size: number,
): Promise<{ created: boolean }> {
  const existing = await client.getCollection(name)
  if (existing) {
    const actualSize = readVectorSize(existing)
    if (actualSize !== undefined && actualSize !== size) {
      throw new Error(
        `Own collection "${name}" uses vector size ${actualSize}, but the current embedding model produces ${size}. ` +
          `Delete the collection or switch back to a ${actualSize}-dimension model.`,
      )
    }
    return { created: false }
  }

  await client.createCollection(name, {
    vectors: { size, distance: "Cosine", on_disk: true },
    hnsw_config: { m: 64, ef_construct: 512, on_disk: true },
  })
  await createOwnPayloadIndexes(client, name)
  return { created: true }
}

/** Read points_count plus the metadata payload (null when the collection is missing). */
export async function getOwnStoreInfo(client: Qdrant, collection: string): Promise<OwnStoreInfo | null> {
  const info = await client.getCollection(collection)
  if (!info) return null

  const points = await client.retrieve(collection, [OWN_METADATA_ID])
  const payload = points[0]?.payload ?? null

  const result: OwnStoreInfo = {
    collection,
    pointsCount: readPointsCount(info),
  }
  if (payload) {
    const profile = parseProfile(payload)
    if (profile) result.profile = profile
    result.complete = payload.indexing_complete === true
    const schema = toFiniteNumber(payload.index_schema)
    if (schema !== undefined) result.schema = schema
  }
  return result
}

/** Upsert chunk points, enriching every payload with Kilo-style `pathSegments`. */
export async function upsertChunkPoints(client: Qdrant, collection: string, points: QdrantPoint[]): Promise<void> {
  if (points.length === 0) return
  const enriched = points.map((point) => ({
    ...point,
    payload: {
      ...point.payload,
      pathSegments: buildPathSegments(point.payload.filePath),
    },
  }))
  await client.upsert(collection, enriched)
}

/** Delete every chunk belonging to the given workspace-relative files. */
export async function deleteOwnByFilePaths(
  client: Qdrant,
  collection: string,
  root: string,
  relPaths: string[],
): Promise<void> {
  void root // reserved for callers that pass absolute paths; relPaths are already workspace-relative
  const should = relPaths.map((relPath) => ({ must: pathConditions(relPath) }))
  if (should.length === 0) return
  await client.deletePoints(
    collection,
    {
      should,
      must_not: [{ key: "type", match: { value: METADATA_TYPE } }],
    },
    true,
  )
}

/** Query our own collection. Missing collections yield an empty result. */
export async function searchOwnCollection(
  client: Qdrant,
  collection: string,
  opts: OwnSearchOptions,
): Promise<QueryHit[]> {
  try {
    const hits = await client.query(collection, {
      vector: opts.vector,
      filter: buildSearchFilter(opts.pathPrefix),
      scoreThreshold: opts.minScore ?? DEFAULT_MIN_SCORE,
      limit: opts.maxResults ?? DEFAULT_MAX_RESULTS,
      include: [...OWN_PAYLOAD_INCLUDE],
      hnswEf: opts.hnswEf ?? DEFAULT_HNSW_EF,
    })
    return hits.filter(isUsableChunkHit)
  } catch (error) {
    if (isMissingCollectionError(error)) return []
    throw error
  }
}

/**
 * Write the single metadata point that records the embedding profile and
 * indexing state of the collection.
 */
export async function markOwnComplete(
  client: Qdrant,
  collection: string,
  profile: EmbeddingProfile,
  complete: boolean,
  dimension: number,
): Promise<void> {
  const point: QdrantPoint = {
    id: OWN_METADATA_ID,
    vector: new Array<number>(dimension).fill(0),
    payload: {
      type: METADATA_TYPE,
      writer: "opencode",
      index_schema: OWN_SCHEMA,
      indexing_complete: complete,
      embedding_provider: profile.provider,
      embedding_model_id: profile.modelId,
      embedding_dimension: profile.dimension,
      updated_at: Date.now(),
    },
  }
  await client.upsert(collection, [point])
}

/** Ensure the payload indexes used by filters/searches exist. */
export async function createOwnPayloadIndexes(client: Qdrant, collection: string): Promise<void> {
  await client.createPayloadIndex(collection, "type", "keyword")
  for (let i = 0; i < INDEXED_PATH_SEGMENT_COUNT; i++) {
    await client.createPayloadIndex(collection, `pathSegments.${i}`, "keyword")
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** `"src\\sub\\file.ts"` -> `{ "0": "src", "1": "sub", "2": "file.ts" }` (Kilo-compatible). */
function buildPathSegments(filePath: unknown): Record<string, string> {
  if (typeof filePath !== "string") return {}
  const segments: Record<string, string> = {}
  filePath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
    .forEach((segment, index) => {
      segments[String(index)] = segment
    })
  return segments
}

/** Normalize a workspace-relative prefix into `pathSegments` values. */
function normalizePathPrefix(prefix: string): string[] {
  let normalized = prefix.replaceAll("\\", "/")
  normalized = path.posix.normalize(normalized)
  if (normalized === "." || normalized === "./") return []
  if (normalized.startsWith("./")) normalized = normalized.slice(2)
  return normalized.split("/").filter((segment) => segment.length > 0)
}

function pathConditions(pathPrefix: string): QdrantFieldCondition[] {
  return normalizePathPrefix(pathPrefix).map((segment, index) => ({
    key: `pathSegments.${index}`,
    match: { value: segment },
  }))
}

function buildSearchFilter(pathPrefix: string | undefined): QdrantFilter {
  const filter: QdrantFilter = {
    must_not: [{ key: "type", match: { value: METADATA_TYPE } }],
  }
  if (pathPrefix) {
    const must = pathConditions(pathPrefix)
    if (must.length > 0) filter.must = must
  }
  return filter
}

function isUsableChunkHit(hit: QueryHit): boolean {
  const payload = hit.payload
  if (!payload) return false
  for (const field of REQUIRED_CHUNK_FIELDS) {
    const value = payload[field]
    if (value === undefined || value === null) return false
    if (typeof value === "string" && value.length === 0) return false
  }
  return true
}

function parseProfile(payload: Record<string, unknown>): EmbeddingProfile | undefined {
  const provider = typeof payload.embedding_provider === "string" ? payload.embedding_provider.trim() : ""
  const modelId = typeof payload.embedding_model_id === "string" ? payload.embedding_model_id.trim() : ""
  const dimension = toFiniteNumber(payload.embedding_dimension)
  if (provider.length === 0 || modelId.length === 0 || dimension === undefined || dimension <= 0) {
    return undefined
  }
  return {
    provider: provider as EmbeddingProfile["provider"],
    modelId,
    dimension,
  }
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function readPointsCount(info: Record<string, any>): number {
  const parsed = toFiniteNumber(info.points_count ?? info.pointsCount)
  return parsed !== undefined && parsed >= 0 ? parsed : 0
}

/** Best-effort read of the configured vector size (unnamed or named vectors). */
function readVectorSize(info: Record<string, any>): number | undefined {
  const vectors = info?.config?.params?.vectors
  if (typeof vectors === "number") return vectors
  if (vectors && typeof vectors === "object") {
    const direct = toFiniteNumber(vectors.size)
    if (direct !== undefined) return direct
    for (const key of Object.keys(vectors)) {
      const entry = (vectors as Record<string, unknown>)[key]
      if (entry && typeof entry === "object") {
        const named = toFiniteNumber((entry as Record<string, unknown>).size)
        if (named !== undefined) return named
      }
    }
  }
  return undefined
}

function isMissingCollectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  return lower.includes("404") || lower.includes("does not exist") || lower.includes("not found")
}
