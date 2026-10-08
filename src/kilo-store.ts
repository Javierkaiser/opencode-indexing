import path from "node:path"

import { workspaceHash } from "./registry.ts"
import type { Qdrant } from "./qdrant.ts"
import type { EmbeddingProfile, QdrantFieldCondition, QdrantFilter, QueryHit } from "./types.ts"

/**
 * Read-only access to Kilo Code's Qdrant index.
 *
 * Collection naming, metadata point id, payload keys and filter shapes mirror
 * Kilo Code (`packages/kilo-indexing`) so an existing index can be consumed
 * without being modified.
 */

export const KILO_METADATA_ID = "f946a536-9af4-4f1f-9f95-7d6efb4647d5"

/** Payload fields requested for every chunk query (same list Kilo uses). */
const KILO_PAYLOAD_INCLUDE: readonly string[] = [
  "filePath",
  "fileHash",
  "codeChunk",
  "startLine",
  "endLine",
  "pathSegments",
]

/** Payload fields a chunk must expose to be usable as a search hit (mirrors Kilo). */
const REQUIRED_CHUNK_FIELDS: readonly string[] = ["filePath", "fileHash", "codeChunk", "startLine", "endLine"]

const METADATA_TYPE = "metadata"
const DEFAULT_MIN_SCORE = 0.4
const DEFAULT_MAX_RESULTS = 50
const DEFAULT_HNSW_EF = 128

export interface KiloStoreInfo {
  collection: string
  pointsCount: number
  profile?: EmbeddingProfile
  complete?: boolean
  schema?: number
}

export interface KiloSearchOptions {
  vector: number[]
  pathPrefix?: string
  minScore?: number
  maxResults?: number
  hnswEf?: number
}

/**
 * Candidate collection names for a workspace root, most likely first.
 * Kilo hashes the raw workspace path string it was given, which may differ
 * from the path our plugin receives (separators, trailing slash), so every
 * plausible spelling is tried.
 */
export function kiloCollectionCandidates(root: string): string[] {
  const variants: string[] = [root, path.resolve(root)]
  if (process.platform === "win32") {
    variants.push(root.replaceAll("/", "\\"), path.resolve(root).replaceAll("/", "\\"))
  }
  for (const variant of [...variants]) {
    variants.push(stripTrailingSeparators(variant))
  }

  const names: string[] = []
  const seen = new Set<string>()
  for (const variant of variants) {
    if (variant.length === 0 || seen.has(variant)) continue
    seen.add(variant)
    names.push(`ws-${workspaceHash(variant).slice(0, 16)}`)
  }
  return [...new Set(names)]
}

/**
 * Resolve the Kilo collection for a workspace.
 *
 * `cached` (persisted by the caller) wins when it still exists; otherwise the
 * hash candidates are probed in order. Returns null when Kilo never indexed
 * this workspace.
 */
export async function resolveKiloCollection(client: Qdrant, root: string, cached?: string): Promise<string | null> {
  const collections = new Set(await client.listCollections())
  if (cached && collections.has(cached)) return cached
  for (const candidate of kiloCollectionCandidates(root)) {
    if (collections.has(candidate)) return candidate
  }
  return null
}

/** Read points_count plus the Kilo metadata payload of a collection. */
export async function getKiloStoreInfo(client: Qdrant, collection: string): Promise<KiloStoreInfo> {
  const info = await client.getCollection(collection)
  if (!info) throw new Error(`Kilo Code collection "${collection}" does not exist`)

  const points = await client.retrieve(collection, [KILO_METADATA_ID])
  const payload = points[0]?.payload ?? null

  const result: KiloStoreInfo = {
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

/** Query an existing Kilo collection. Missing collections yield an empty result. */
export async function searchKiloCollection(
  client: Qdrant,
  collection: string,
  opts: KiloSearchOptions,
): Promise<QueryHit[]> {
  try {
    const hits = await client.query(collection, {
      vector: opts.vector,
      filter: buildSearchFilter(opts.pathPrefix),
      scoreThreshold: opts.minScore ?? DEFAULT_MIN_SCORE,
      limit: opts.maxResults ?? DEFAULT_MAX_RESULTS,
      include: [...KILO_PAYLOAD_INCLUDE],
      hnswEf: opts.hnswEf ?? DEFAULT_HNSW_EF,
    })
    return hits.filter(isUsableChunkHit)
  } catch (error) {
    if (isMissingCollectionError(error)) return []
    throw error
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function stripTrailingSeparators(value: string): string {
  let out = value
  while (out.length > 1 && (out.endsWith("/") || out.endsWith("\\"))) {
    out = out.slice(0, -1)
  }
  return out
}

/** Normalize a workspace-relative prefix into `pathSegments` values. */
function normalizePathPrefix(prefix: string): string[] {
  let normalized = prefix.replaceAll("\\", "/")
  normalized = path.posix.normalize(normalized)
  if (normalized === "." || normalized === "./") return []
  if (normalized.startsWith("./")) normalized = normalized.slice(2)
  return normalized.split("/").filter((segment) => segment.length > 0)
}

function buildSearchFilter(pathPrefix: string | undefined): QdrantFilter {
  const filter: QdrantFilter = {
    must_not: [{ key: "type", match: { value: METADATA_TYPE } }],
  }
  const must = pathConditions(pathPrefix)
  if (must.length > 0) filter.must = must
  return filter
}

function pathConditions(pathPrefix: string | undefined): QdrantFieldCondition[] {
  if (!pathPrefix) return []
  return normalizePathPrefix(pathPrefix).map((segment, index) => ({
    key: `pathSegments.${index}`,
    match: { value: segment },
  }))
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

function isMissingCollectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  return lower.includes("404") || lower.includes("does not exist") || lower.includes("not found")
}
