import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { createEmbedder } from "./embedder.ts"
import { searchLanceDbAt } from "./lancedb-store.ts"
import { discoverKiloSources, selectKiloSources, type KiloSourceInfo } from "./import.ts"
import { searchKiloCollection } from "./kilo-store.ts"
import { createKiloQdrant, createOwnStore } from "./store-factory.ts"
import type { Qdrant } from "./qdrant.ts"
import { modelScoreThresholdFor, normalizeExtensions, profileKey } from "./registry.ts"
import { withProfile } from "./config.ts"
import { kiloCredentials, readKiloConfig, type KiloConfigIndexing } from "./kilo-config.ts"
import { TtlCache } from "./ttl-cache.ts"
import type { EmbedderProvider, IndexingSettings, KVStore, QueryHit, SearchHit } from "./types.ts"
import type { VectorStoreAdapter, VectorStoreInfo } from "./vector-store.ts"
import { describeError } from "./errors.ts"

export interface SearchDeps {
  qdrant: Qdrant
  kv: KVStore
  root: string
  settings: IndexingSettings
  /**
   * The own-index store. Built from the settings when omitted.
   *
   * Injected so a caller that already holds one does not build a second
   * identical client, and so the search can be exercised without a server.
   */
  ownStore?: VectorStoreAdapter
  /** Qdrant client for Kilo's collections; defaults to `qdrant` or Kilo's config. */
  kiloQdrant?: Qdrant
  /** Effective Kilo config; read from disk when omitted. */
  kiloConfig?: KiloConfigIndexing
  homeDir?: string
}

export interface KiloSourceMeta {
  kind: "qdrant" | "lancedb"
  name: string
  role?: "baseline" | "delta"
  points: number | null
  complete: boolean | null
  profile: string | null
}

export interface SearchMeta {
  root: string
  /**
   * Kilo's index as far as this search is concerned.
   *
   * `searched` separates "not consulted" (`searchKilo: false`) from "consulted
   * and absent": both leave `collection` null, and reporting the second when the
   * first is true tells a user Kilo has no index when it was never looked at.
   */
  kilo: {
    searched: boolean
    collection: string | null
    complete: boolean | null
    points: number | null
    /** `collection` is the delta/baseline source that best explains the root. */
    sources?: KiloSourceMeta[]
  }
  own: { store: string; kind: "qdrant" | "lancedb"; complete: boolean | null; points: number | null }
  /** Distinct profiles used to embed the query. */
  profiles: string[]
}

export interface SearchOutcome {
  hits: SearchHit[]
  meta: SearchMeta
  errors: string[]
}

/**
 * How long search metadata may be reused.
 *
 * Points counts, the resolved Kilo sources and their profiles are metadata: a
 * few seconds of staleness can change which store is read, never which vectors
 * are compared. Every write path that changes them invalidates explicitly, so
 * this only bounds the paths that do not call us — a settings file edited by
 * hand, or another process indexing the same workspace.
 */
export const SEARCH_META_TTL_MS = 5_000

const ownInfoCache = new TtlCache<string, VectorStoreInfo | null>()
const kiloSourcesCache = new TtlCache<string, KiloDiscovery>()

interface KiloDiscovery {
  sources: KiloSourceInfo[]
  problems: string[]
}

/**
 * Cache key for one workspace and one store identity.
 *
 * The store identity is part of the key so a settings change that points at a
 * different backend or server can never be answered from the previous one's
 * metadata.
 */
function metadataKey(root: string, kind: string, ...identity: string[]): string {
  return [root, kind, ...identity].join("\u0000")
}

/** Forget cached search metadata; every workspace when `root` is omitted. */
export function invalidateSearchCaches(root?: string): void {
  if (root === undefined) {
    ownInfoCache.clear()
    kiloSourcesCache.clear()
    return
  }
  const prefix = `${root}\u0000`
  dropByPrefix(ownInfoCache, prefix)
  dropByPrefix(kiloSourcesCache, prefix)
}

function dropByPrefix<V>(cache: TtlCache<string, V>, prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

/**
 * Serve a cached value, or load and remember it for the metadata TTL.
 *
 * Failures are not cached: a transiently unreachable store must not make the
 * next searches answer from nothing for the rest of the window.
 */
async function cachedMetadata<V>(cache: TtlCache<string, V>, key: string, load: () => Promise<V>): Promise<V> {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const value = await load()
  cache.set(key, value, SEARCH_META_TTL_MS)
  return value
}

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

interface ProfileRef {
  provider: EmbedderProvider
  modelId: string
  dimension: number
  queryPrefix?: string
  /** True when the query vector is built from Kilo's own provider config. */
  kilo: boolean
}

function mergeCredentials(
  fromKilo: ReturnType<typeof kiloCredentials>,
  own: IndexingSettings["credentials"],
): IndexingSettings["credentials"] {
  const merged = { ...fromKilo }
  for (const [key, value] of Object.entries(own) as Array<[keyof IndexingSettings["credentials"], unknown]>) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value
  }
  return merged
}

/** Build an embedder for a Kilo profile, borrowing Kilo's key when needed. */
function settingsForProfile(
  settings: IndexingSettings,
  profile: ProfileRef,
  kiloConfig: KiloConfigIndexing | undefined,
): IndexingSettings {
  const base = withProfile(settings, profile)
  if (!profile.kilo) return base
  return { ...base, credentials: mergeCredentials(kiloCredentials(kiloConfig), settings.credentials) }
}

async function resolveKiloSources(deps: SearchDeps, config: KiloConfigIndexing | undefined): Promise<KiloDiscovery> {
  const { root, settings } = deps
  const client = deps.kiloQdrant ?? createKiloQdrant(deps.settings, config, deps.qdrant)
  const key = metadataKey(
    root,
    "kilo-sources",
    settings.qdrantUrl,
    settings.qdrantApiKey ?? "",
    config?.qdrant?.url ?? "",
    config?.qdrant?.apiKey ?? "",
    config?.vectorStore ?? "",
    config?.lancedb?.directory ?? "",
    deps.homeDir ?? "",
  )
  return cachedMetadata(kiloSourcesCache, key, async () => {
    const problems: string[] = []
    const all = await discoverKiloSources(root, {
      qdrant: client,
      homeDir: deps.homeDir,
      kiloConfig: config,
      // No target profile: live search embeds each source with its own stored
      // profile, so a profile that differs from the own index is not a refusal.
      onProblem: (message) => problems.push(message),
    })
    return { sources: selectKiloSources(all, config?.vectorStore), problems }
  })
}

function relativeToRoot(root: string, filePath: string): string | undefined {
  const relative = path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  return path.normalize(relative)
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex")
}

/**
 * Why a baseline hit can be shown: the file it describes must still be the file
 * Kilo indexed in the main checkout. Kilo's own worktree overlay makes the same
 * check, otherwise a stale baseline chunk answers for a file changed here.
 */
async function baselineHitValid(
  root: string,
  hit: QueryHit,
  checks: Map<string, Promise<boolean>>,
): Promise<boolean> {
  const filePath = hit.payload?.filePath
  const expected = hit.payload?.fileHash
  if (typeof filePath !== "string" || typeof expected !== "string") return false
  const relative = relativeToRoot(root, filePath)
  if (!relative) return false

  let pending = checks.get(relative)
  if (!pending) {
    pending = fs
      .readFile(path.join(root, relative))
      .then((content) => sha256Buffer(content) === expected)
      .catch(() => false)
    checks.set(relative, pending)
  }
  return pending
}

async function expandHits(
  limit: number,
  search: (requested: number) => Promise<QueryHit[]>,
  accept: (hit: QueryHit) => boolean | Promise<boolean>,
): Promise<QueryHit[]> {
  const ceiling = Math.max(limit, Math.min(limit * 16, 1000))
  let requested = limit
  for (;;) {
    const hits = await search(requested)
    const accepted: QueryHit[] = []
    for (const hit of hits) if (await accept(hit)) accepted.push(hit)
    if (accepted.length >= limit || hits.length < requested || requested >= ceiling) return accepted
    requested = Math.min(requested * 2, ceiling)
  }
}

/**
 * Search both indexes (Kilo's live index plus our own) and merge:
 * own results win when they overlap on filePath+range (fresher hash),
 * then score ordering, then ghost-file filtering (top results only).
 *
 * Kilo's live source can be Qdrant or LanceDB, and a linked worktree is a
 * baseline (main checkout) plus a delta (this checkout). Both are read the way
 * Kilo reads them, including the baseline hash check.
 */
export async function searchCode(deps: SearchDeps, query: string, pathPrefix?: string, overrideLimit?: number): Promise<SearchOutcome> {
  const { root, settings } = deps
  const errors: string[] = []
  const limit = Math.max(1, Math.min(overrideLimit ?? settings.searchMaxResults, 200))

  const ownStore = deps.ownStore ?? createOwnStore(settings, root)
  const searchKilo = settings.searchKilo !== false
  const kiloConfig = searchKilo ? (deps.kiloConfig ?? readKiloConfig(root, deps.homeDir).indexing) : undefined

  const ownKey = metadataKey(
    root,
    "own",
    settings.vectorStore,
    settings.qdrantUrl,
    settings.lancedbDirectory,
    ownStore.kind,
    ownStore.name,
  )
  const [ownInfo, kilo] = await Promise.all([
    cachedMetadata(ownInfoCache, ownKey, () => ownStore.info()).catch(() => null),
    searchKilo
      ? resolveKiloSources(deps, kiloConfig).catch((error) => {
          errors.push(`kilo resolve: ${describeError(error)}`)
          return { sources: [] as KiloSourceInfo[], problems: [] } satisfies KiloDiscovery
        })
      : Promise.resolve({ sources: [] as KiloSourceInfo[], problems: [] } satisfies KiloDiscovery),
  ])

  const sources = kilo.sources
  if (sources.length === 0 && kilo.problems.length > 0) {
    for (const problem of kilo.problems) errors.push(`kilo: ${problem}`)
  }

  const profiles = new Map<string, ProfileRef>()
  if (ownInfo?.profile) profiles.set(profileKey(ownInfo.profile), { ...ownInfo.profile, kilo: false })
  for (const source of sources) {
    if ((source.pointsCount ?? 0) <= 0 || !source.profile) continue
    const key = profileKey(source.profile)
    if (!profiles.has(key)) profiles.set(key, { ...source.profile, kilo: true })
  }
  const baseProfile: ProfileRef = {
    provider: settings.provider,
    modelId: settings.modelId,
    dimension: settings.dimension,
    kilo: false,
  }
  if (!profiles.has(profileKey(baseProfile))) profiles.set(profileKey(baseProfile), baseProfile)

  const vectors = new Map<string, number[]>()
  const embedFailures = new Map<string, string>()
  // One task per profile: the indexes are independent, so a second provider
  // round trip must not wait for the first to finish.
  await Promise.all(
    [...profiles].map(async ([key, profile]) => {
      try {
        const embedder = createEmbedder(settingsForProfile(settings, profile, kiloConfig))
        const [vector] = await embedder.embed([query], { asQuery: true })
        if (!vector) throw new Error("empty embedding")
        vectors.set(key, vector)
      } catch (error) {
        embedFailures.set(key, describeError(error))
      }
    }),
  )

  /**
   * Refuse to answer from part of the corpus.
   *
   * A stored index whose profile cannot be embedded is unreachable, and
   * returning only the half that worked looks exactly like a complete answer
   * whose other half ranked lower. The caller asked what matches, not what
   * matches in whichever part happened to be readable, so this is an error.
   * An index with no points needs no query vector and is not a problem.
   */
  const unreachableOwn = (profile: ProfileRef | undefined, points: number | null | undefined): void => {
    if (!profile || (points ?? 0) <= 0) return
    const key = profileKey(profile)
    if (vectors.has(key)) return
    const cause = embedFailures.get(key)
    throw new Error(
      `Cannot search the own index: it holds ${points} points built with ${key}, and that profile could not be embedded` +
        `${cause ? ` (${cause})` : ""}. Searching only the other index would return an incomplete result set as if it were complete.`,
    )
  }
  unreachableOwn(ownInfo?.profile ? { ...ownInfo.profile, kilo: false } : undefined, ownInfo?.pointsCount)

  for (const source of sources) {
    if ((source.pointsCount ?? 0) <= 0) continue
    if (!source.profile) {
      throw new Error(
        `Cannot search Kilo's index (${source.kind} ${source.name}): it reports ${source.pointsCount} points but no embedding profile.`,
      )
    }
    const key = profileKey(source.profile)
    if (vectors.has(key)) continue
    const cause = embedFailures.get(key)
    throw new Error(
      `Cannot search Kilo's index (${source.kind} ${source.name}${source.role ? `, ${source.role}` : ""}): ` +
        `it holds ${source.pointsCount} points built with ${key}, and that profile could not be embedded` +
        `${cause ? ` (${cause})` : ""}. Searching only the other index would return an incomplete result set as if it were complete.`,
    )
  }

  const minScore = settings.searchMinScore
  // Kilo's project may index an extension set different from the own scan.
  // Filtering Kilo hits by the own list would hide valid Kilo results.
  const kiloExtensions =
    Array.isArray(kiloConfig?.fileExtensions) && kiloConfig.fileExtensions.length > 0
      ? kiloConfig.fileExtensions
      : settings.fileExtensions
  const extensions = new Set(normalizeExtensions(kiloExtensions))
  const allowed = (hit: QueryHit): boolean => {
    const filePath = hit.payload?.filePath
    if (typeof filePath !== "string") return false
    if (extensions.size === 0) return true
    return extensions.has(path.extname(filePath).toLowerCase())
  }
  const thresholdFor = (profile: { provider: EmbedderProvider; modelId: string }): number =>
    minScore ?? modelScoreThresholdFor(settings, profile.provider, profile.modelId) ?? settings.scoreThreshold

  const searchSource = async (source: KiloSourceInfo, requested: number): Promise<QueryHit[]> => {
    if (!source.profile) return []
    const vector = vectors.get(profileKey(source.profile))
    if (!vector) return []
    const threshold = thresholdFor(source.profile)
    const client = deps.kiloQdrant ?? createKiloQdrant(settings, kiloConfig, deps.qdrant)
    try {
      if (source.kind === "qdrant") {
        return await searchKiloCollection(client, source.name, {
          vector,
          pathPrefix,
          minScore: threshold,
          maxResults: requested,
          hnswEf: 128,
        })
      }
      return await searchLanceDbAt(source.name, {
        vector,
        pathPrefix,
        minScore: threshold,
        maxResults: requested,
        expectedProfile: source.profile,
      })
    } catch (error) {
      if ((source.pointsCount ?? 0) > 0) {
        throw new Error(
          `Cannot read Kilo's index (${source.kind} ${source.name}${source.role ? `, ${source.role}` : ""}): ${describeError(error)}`,
        )
      }
      return []
    }
  }

  const kiloHits = (async (): Promise<SearchHit[]> => {
    if (!searchKilo || sources.length === 0) return []

    const delta = sources.find((source) => source.role === "delta")
    const baseline = sources.find((source) => source.role === "baseline")
    if (!delta && !baseline) {
      const only = sources[0]!
      const hits = await expandHits(limit, (requested) => searchSource(only, requested), allowed)
      return hits.map((hit) => toSearchHit(hit, "kilo")).filter((hit): hit is SearchHit => hit !== undefined)
    }

    const checks = new Map<string, Promise<boolean>>()
    const [baselineHits, deltaHits] = await Promise.all([
      baseline
        ? expandHits(
            limit,
            (requested) => searchSource(baseline, requested),
            async (hit) => allowed(hit) && (await baselineHitValid(root, hit, checks)),
          )
        : Promise.resolve([]),
      delta
        ? expandHits(limit, (requested) => searchSource(delta, requested), allowed)
        : Promise.resolve([]),
    ])

    const keyOf = (hit: QueryHit): string =>
      [
        String(hit.payload?.filePath ?? ""),
        String(hit.payload?.startLine ?? ""),
        String(hit.payload?.endLine ?? ""),
        String(hit.payload?.codeChunk ?? ""),
      ].join("\u0000")
    const merged = new Map<string, QueryHit>()
    for (const hit of baselineHits) merged.set(keyOf(hit), hit)
    for (const hit of deltaHits) merged.set(keyOf(hit), hit) // delta is this checkout, baseline is the main one
    return [...merged.values()]
      .sort((left, right) => right.score - left.score)
      .map((hit) => toSearchHit(hit, "kilo"))
      .filter((hit): hit is SearchHit => hit !== undefined)
  })()

  const ownHits = (async (): Promise<SearchHit[]> => {
    if (!ownInfo?.exists || !ownInfo.profile || (ownInfo.pointsCount ?? 0) === 0) return []
    const vector = vectors.get(profileKey(ownInfo.profile))
    if (!vector) return []
    const threshold = thresholdFor(ownInfo.profile)
    const hits = await ownStore.search({
      vector,
      pathPrefix,
      minScore: threshold,
      maxResults: limit,
      hnswEf: 128,
    })
    return hits.map((hit) => toSearchHit(hit, "own")).filter((hit): hit is SearchHit => hit !== undefined)
  })().catch((error) => {
    if ((ownInfo?.pointsCount ?? 0) > 0) {
      throw new Error(`Cannot read the own index (${ownStore.name}): ${describeError(error)}`)
    }
    errors.push(`own search: ${describeError(error)}`)
    return [] as SearchHit[]
  })

  const [kiloResults, ownResults] = await Promise.all([kiloHits, ownHits])

  const merged = new Map<string, SearchHit>()
  const keyOf = (hit: SearchHit) => `${hit.filePath}\u0000${hit.startLine}\u0000${hit.endLine}`
  for (const hit of kiloResults) merged.set(keyOf(hit), hit)
  for (const hit of ownResults) merged.set(keyOf(hit), hit) // own always overrides on overlap

  let hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit)

  // Ghost filtering: only when Kilo may contain files our own index already knows were deleted.
  if (sources.length > 0 && ownInfo?.exists) {
    hits = await filterGhosts(root, hits, 60)
  }

  const effective = sources.find((source) => source.role === "delta") ?? sources.find((source) => source.role === "baseline") ?? sources[0]

  return {
    hits,
    meta: {
      root,
      kilo: {
        searched: searchKilo,
        collection: effective?.name ?? null,
        complete: effective?.complete ?? null,
        points: effective?.pointsCount ?? null,
        sources: sources.map((source) => ({
          kind: source.kind,
          name: source.name,
          ...(source.role ? { role: source.role } : {}),
          points: source.pointsCount,
          complete: source.complete ?? null,
          profile: source.profile ? profileKey(source.profile) : null,
        })),
      },
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
