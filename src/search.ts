import * as fs from "node:fs/promises"
import * as path from "node:path"

import { createEmbedder } from "./embedder.ts"
import { getKiloStoreInfo, resolveKiloCollection, searchKiloCollection } from "./kilo-store.ts"
import { createOwnStore, createSettingsQdrant } from "./store-factory.ts"
import { getModelScoreThreshold, profileKey, workspaceHash } from "./registry.ts"
import { withProfile } from "./config.ts"
import type { EmbedderProvider, IndexingSettings, KVStore, QueryHit, SearchHit } from "./types.ts"
import type { Qdrant } from "./qdrant.ts"

export interface SearchDeps {
  qdrant: Qdrant
  kv: KVStore
  root: string
  settings: IndexingSettings
}

export interface SearchMeta {
  root: string
  kilo: { collection: string | null; complete: boolean | null; points: number | null }
  own: { store: string; kind: "qdrant" | "lancedb"; complete: boolean | null; points: number | null }
  /** Distinct profiles used to embed the query. */
  profiles: string[]
}

export interface SearchOutcome {
  hits: SearchHit[]
  meta: SearchMeta
  errors: string[]
}

const KILO_CACHE_PREFIX = "kiloCollection/"

function validHit(hit: QueryHit): boolean {
  const payload = hit.payload
  if (!payload) return false
  return ["filePath", "fileHash", "codeChunk", "startLine", "endLine"].every((key) => key in payload)
}

function toSearchHit(hit: QueryHit, source: "kilo" | "own"): SearchHit | undefined {
  const payload = hit.payload
  if (!payload || !validHit(hit)) return undefined
  return {
    filePath: String(payload.filePath),
    score: hit.score,
    startLine: Number(payload.startLine),
    endLine: Number(payload.endLine),
    codeChunk: String(payload.codeChunk),
    fileHash: typeof payload.fileHash === "string" ? payload.fileHash : undefined,
    source,
  }
}

async function resolveKiloCached(qdrant: Qdrant, kv: KVStore, root: string): Promise<string | null> {
  const key = KILO_CACHE_PREFIX + workspaceHash(root).slice(0, 16)
  const cached = await kv.get(key)
  const cachedName = typeof cached === "string" ? cached : undefined
  const collection = await resolveKiloCollection(qdrant, root, cachedName)
  if (collection && collection !== cachedName) await kv.set(key, collection)
  if (!collection && cachedName) await kv.remove(key)
  return collection
}

interface ProfileRef {
  provider: EmbedderProvider
  modelId: string
  dimension: number
  queryPrefix?: string
}

/**
 * Search both indexes (Kilo baseline + our own) and merge:
 * own results win when they overlap on filePath+range (fresher hash),
 * then score ordering, then ghost-file filtering (top results only).
 */
export async function searchCode(deps: SearchDeps, query: string, pathPrefix?: string, overrideLimit?: number): Promise<SearchOutcome> {
  const { qdrant, kv, root, settings } = deps
  const errors: string[] = []
  const limit = Math.max(1, Math.min(overrideLimit ?? settings.searchMaxResults, 200))

  const ownStore = createOwnStore(settings, root)
  const qdrantClient = settings.vectorStore === "qdrant" ? qdrant : createSettingsQdrant(settings)
  const [ownInfo, kiloCollection] = await Promise.all([
    ownStore.info().catch(() => null),
    resolveKiloCached(qdrantClient, kv, root).catch((error) => {
      errors.push(`kilo resolve: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }),
  ])
  const kiloInfo = kiloCollection ? await getKiloStoreInfo(qdrantClient, kiloCollection).catch(() => null) : null

  const profiles = new Map<string, ProfileRef>()
  if (ownInfo?.profile) profiles.set(profileKey(ownInfo.profile), { ...ownInfo.profile })
  if (kiloInfo?.profile) profiles.set(profileKey(kiloInfo.profile), { ...kiloInfo.profile })
  const baseProfile: ProfileRef = {
    provider: settings.provider,
    modelId: settings.modelId,
    dimension: settings.dimension,
  }
  if (!profiles.has(profileKey(baseProfile))) profiles.set(profileKey(baseProfile), baseProfile)

  const vectors = new Map<string, number[]>()
  for (const [key, profile] of profiles) {
    try {
      const embedder = createEmbedder(withProfile(settings, profile))
      const [vector] = await embedder.embed([query], { asQuery: true })
      if (!vector) throw new Error("empty embedding")
      vectors.set(key, vector)
    } catch (error) {
      errors.push(`embed ${key}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const minScore = settings.searchMinScore

  const kiloHits = (async (): Promise<SearchHit[]> => {
    if (!kiloCollection || !kiloInfo?.profile) return []
    const vector = vectors.get(profileKey(kiloInfo.profile))
    if (!vector) return []
    const threshold = minScore ?? getModelScoreThreshold(kiloInfo.profile.provider, kiloInfo.profile.modelId) ?? settings.scoreThreshold
    const hits = await searchKiloCollection(qdrantClient, kiloCollection, {
      vector,
      pathPrefix,
      minScore: threshold,
      maxResults: limit,
      hnswEf: 128,
    })
    return hits.map((hit) => toSearchHit(hit, "kilo")).filter((hit): hit is SearchHit => hit !== undefined)
  })().catch((error) => {
    errors.push(`kilo search: ${error instanceof Error ? error.message : String(error)}`)
    return [] as SearchHit[]
  })

  const ownHits = (async (): Promise<SearchHit[]> => {
    if (!ownInfo?.exists || !ownInfo.profile || (ownInfo.pointsCount ?? 0) === 0) return []
    const vector = vectors.get(profileKey(ownInfo.profile))
    if (!vector) return []
    const threshold = minScore ?? getModelScoreThreshold(ownInfo.profile.provider, ownInfo.profile.modelId) ?? settings.scoreThreshold
    const hits = await ownStore.search({
      vector,
      pathPrefix,
      minScore: threshold,
      maxResults: limit,
      hnswEf: 128,
    })
    return hits.map((hit) => toSearchHit(hit, "own")).filter((hit): hit is SearchHit => hit !== undefined)
  })().catch((error) => {
    errors.push(`own search: ${error instanceof Error ? error.message : String(error)}`)
    return [] as SearchHit[]
  })

  const [kiloResults, ownResults] = await Promise.all([kiloHits, ownHits])

  const merged = new Map<string, SearchHit>()
  const keyOf = (hit: SearchHit) => `${hit.filePath}\u0000${hit.startLine}\u0000${hit.endLine}`
  for (const hit of kiloResults) merged.set(keyOf(hit), hit)
  for (const hit of ownResults) merged.set(keyOf(hit), hit) // own always overrides on overlap

  let hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit)

  // Ghost filtering: only when Kilo may contain files our own index already knows were deleted.
  if (kiloCollection && ownInfo?.exists) {
    hits = await filterGhosts(root, hits, 60)
  }

  return {
    hits,
    meta: {
      root,
      kilo: { collection: kiloCollection, complete: kiloInfo?.complete ?? null, points: kiloInfo?.pointsCount ?? null },
      own: {
        store: ownStore.name,
        kind: ownStore.kind,
        complete: ownInfo?.complete ?? null,
        points: ownInfo?.pointsCount ?? null,
      },
      profiles: [...profiles.keys()],
    },
    errors,
  }
}

/** Drop hits whose file no longer exists (bounded parallel existence checks). */
async function filterGhosts(root: string, hits: SearchHit[], cap: number): Promise<SearchHit[]> {
  const checks = hits.slice(0, cap)
  const rest = hits.slice(cap)
  const results = await Promise.all(
    checks.map(async (hit) => {
      try {
        await fs.access(path.join(root, hit.filePath))
        return hit
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        return code === "ENOENT" ? undefined : hit
      }
    }),
  )
  return [...results.filter((hit): hit is SearchHit => hit !== undefined), ...rest]
}
