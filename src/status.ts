import * as fs from "node:fs/promises"
import * as path from "node:path"

import { getKiloStoreInfo, resolveKiloCollection } from "./kilo-store.ts"
import { discoverKiloSources, selectKiloSources, type KiloSourceInfo } from "./import.ts"
import { readKiloConfig, type KiloConfigIndexing } from "./kilo-config.ts"
import { createKiloQdrant, createOwnStore } from "./store-factory.ts"
import { diffFiles, loadManifest } from "./manifest.ts"
import { modelDimensionFor, profileKey, workspaceHash } from "./registry.ts"
import { scanWorkspace } from "./scanner.ts"
import type { IndexingSettings, KVStore } from "./types.ts"
import type { Qdrant } from "./qdrant.ts"
import type { VectorStoreAdapter } from "./vector-store.ts"
import { describeError } from "./errors.ts"

export interface StatusDeps {
  qdrant: Qdrant
  kv: KVStore
  root: string
  settings: IndexingSettings
  /** The own-index store. Built from the settings when omitted. */
  ownStore?: VectorStoreAdapter
  /** Effective Kilo config; read from disk when omitted. */
  kiloConfig?: KiloConfigIndexing
  homeDir?: string
}

export interface IndexStatus {
  root: string
  qdrant: { url: string; reachable: boolean }
  kilo: {
    collection: string | null
    exists: boolean
    points: number | null
    complete: boolean | null
    profile: string | null
  }
  /** All Kilo sources available for import (qdrant + lancedb). */
  kiloSources: KiloSourceInfo[]
  own: {
    store: string
    kind: "qdrant" | "lancedb"
    exists: boolean
    points: number | null
    complete: boolean | null
    profile: string | null
    lastRun: number | null
    manifestFiles: number | null
  }
  /** Workspace file freshness vs the manifest (own index). */
  freshness: {
    checked: boolean
    total: number
    added: number
    maybeStale: number
    deleted: number
  }
  recommendation: string
  warnings: string[]
}

const KILO_CACHE_PREFIX = "kiloCollection/"

/**
 * Why a Kilo source cannot be imported, and what actually fixes it.
 *
 * Only a profile mismatch is resolved by switching the model. An unsupported
 * provider or a newer index schema is not, so telling the user to switch sends
 * them in circles.
 */
function incompatibleSourceRecommendation(source: KiloSourceInfo): string {
  const rebuild = "Run indexing_build to index from scratch with your configured model"
  switch (source.reason) {
    case "provider":
      return (
        `Kilo index detected but it was built with the ${source.profile?.provider ?? "unknown"} embedding provider, ` +
        `which this plugin cannot call. ${rebuild}.`
      )
    case "schema":
      return (
        `Kilo index detected but it uses index schema ${source.schema ?? "unknown"}, which this plugin does not read. ` +
        `${rebuild}, or upgrade the plugin.`
      )
    default:
      return `Kilo index detected but its embedding profile differs. ${rebuild}, or switch to the matching model.`
  }
}

export async function getStatus(deps: StatusDeps, options?: { checkFreshness?: boolean }): Promise<IndexStatus> {
  const { qdrant, kv, root, settings } = deps
  const kiloConfig = deps.kiloConfig ?? readKiloConfig(root, deps.homeDir).indexing
  // Configuration warnings are produced once per resolution and were previously
  // never shown, so a store that cannot work on this platform looked simply
  // absent rather than misconfigured.
  const warnings: string[] = [...settings.warnings]
  let reachable = true
  try {
    await qdrant.listCollections()
  } catch (error) {
    reachable = false
    // Only worth reporting when Qdrant is actually part of this setup. With the
    // own index on LanceDB and no Qdrant-backed Kilo index, a dead Qdrant is
    // not a problem the user has, and saying so would train them to ignore it.
    const qdrantIsOurs =
      settings.vectorStore === "qdrant" ||
      settings.kiloVectorStore === "qdrant" ||
      kiloConfig?.vectorStore === "qdrant"
    if (qdrantIsOurs) {
      const kiloQdrantUrl = kiloConfig?.qdrant?.url?.trim() || settings.qdrantUrl
      warnings.push(
        settings.vectorStore === "qdrant"
          ? `Qdrant unreachable at ${settings.qdrantUrl}: ${describeError(error)}`
          : `Qdrant unreachable at ${kiloQdrantUrl}, so a Kilo index stored there cannot be read: ${describeError(error)}`,
      )
    }
  }

  const ownStore = deps.ownStore ?? createOwnStore(settings, root)
  const kiloQdrant = createKiloQdrant(settings, kiloConfig, qdrant)
  const cacheKey = KILO_CACHE_PREFIX + workspaceHash(root).slice(0, 16)
  const cachedKilo = await kv.get(cacheKey)
  const kiloCollection = reachable
    ? await resolveKiloCollection(kiloQdrant, root, typeof cachedKilo === "string" ? cachedKilo : undefined).catch(() => null)
    : null
  if (kiloCollection && kiloCollection !== cachedKilo) await kv.set(cacheKey, kiloCollection)

  const targetProfile =
    settings.dimension > 0
      ? { provider: settings.provider, modelId: settings.modelId, dimension: settings.dimension }
      : undefined
  // Discovery problems are collected here rather than thrown away, so `indexing_status`
  // can say "found but unreadable" instead of the much less useful "nothing there".
  const kiloProblems: string[] = []
  const [kiloInfo, ownInfo, manifest, kiloSources] = await Promise.all([
    kiloCollection ? getKiloStoreInfo(kiloQdrant, kiloCollection).catch(() => null) : null,
    ownStore.info().catch(() => null),
    loadManifest(kv, root),
    discoverKiloSources(root, {
      qdrant: kiloQdrant,
      homeDir: deps.homeDir,
      kiloConfig,
      targetProfile,
      onProblem: (message) => kiloProblems.push(message),
    }).catch(() => [] as KiloSourceInfo[]),
  ])
  const selectedKiloSources = selectKiloSources(kiloSources, kiloConfig?.vectorStore)

  const freshness = { checked: false, total: 0, added: 0, maybeStale: 0, deleted: 0 }
  if (options?.checkFreshness && reachable) {
    try {
      const scan = await scanWorkspace(root, {
        extensions: settings.fileExtensions,
        maxFileSizeBytes: settings.maxFileSizeBytes,
      })
      const diff = diffFiles(manifest, scan.files)
      freshness.checked = true
      freshness.total = scan.files.length
      freshness.added = diff.added.length
      freshness.maybeStale = diff.maybeStale.length
      freshness.deleted = diff.deleted.length
    } catch (error) {
      warnings.push(`freshness scan failed: ${describeError(error)}`)
    }
  }

  const compatibleSource = selectedKiloSources.find((source) => source.compatible)

  /**
   * The Kilo source that best explains this workspace.
   *
   * A linked worktree usually has no collection of its own while the main
   * checkout holds the repository's. Reading only the root's collection then
   * reported "Kilo: none" with a baseline source sitting right there, so the
   * discovered sources fill the gap: delta first, then baseline.
   */
  const effectiveKiloSource =
    selectedKiloSources.find((source) => source.role === "delta" && source.compatible) ??
    selectedKiloSources.find((source) => source.role === "baseline" && source.compatible) ??
    selectedKiloSources.find((source) => source.role === "delta") ??
    selectedKiloSources.find((source) => source.role === "baseline") ??
    selectedKiloSources[0]
  const kiloFromDiscovery = effectiveKiloSource !== undefined
  const kiloCollectionName = kiloCollection ?? effectiveKiloSource?.name ?? null
  const kiloPoints = kiloFromDiscovery ? (effectiveKiloSource.pointsCount ?? null) : (kiloInfo?.pointsCount ?? null)
  const kiloComplete = kiloFromDiscovery ? (effectiveKiloSource.complete ?? null) : (kiloInfo?.complete ?? null)
  const kiloProfile = kiloFromDiscovery
    ? effectiveKiloSource.profile
      ? profileKey(effectiveKiloSource.profile)
      : null
    : kiloInfo?.profile
      ? profileKey(kiloInfo.profile)
      : null
  const ownProfile = ownInfo?.profile
    ? `${ownInfo.profile.provider}:${ownInfo.profile.modelId}:${ownInfo.profile.dimension}`
    : null

  /**
   * A profile change destroys the own index and re-embeds everything.
   *
   * Saying so here is the point: the rebuild happens on the next build or
   * refresh, so a user who changes provider to save money can spend the whole
   * repository on embeddings before seeing any indication that it happened.
   * The count is reported because it is the only estimate of the cost.
   */
  const configuredProfile = {
    provider: settings.provider,
    modelId: settings.modelId,
    dimension: settings.dimension || modelDimensionFor(settings, settings.provider, settings.modelId) || 0,
  }
  const storedProfile = ownInfo?.profile
  const profileChanged =
    storedProfile !== undefined &&
    (storedProfile.provider !== configuredProfile.provider ||
      storedProfile.modelId !== configuredProfile.modelId ||
      (configuredProfile.dimension > 0 && storedProfile.dimension !== configuredProfile.dimension))
  if (profileChanged && (ownInfo?.pointsCount ?? 0) > 0) {
    warnings.push(
      `The own index holds ${ownInfo?.pointsCount} points built with ${profileKey(storedProfile)} but the configured ` +
        `model is ${profileKey(configuredProfile)}. The next build or refresh will delete them and re-embed the whole ` +
        `workspace. Set the model back to reuse them, or re-import from Kilo if a matching source exists.`,
    )
  }

  let recommendation: string
  /**
   * Advice when Kilo is excluded from the search.
   *
   * `searchKilo: false` makes the own index the whole corpus, so anything that
   * points at Kilo — "search works now", "switch to the matching model" — sends
   * the user to a source the search will never read.
   */
  const ownIndexRecommendation = (): string => {
    if (!ownInfo?.exists) {
      return "Kilo search is disabled (searchKilo = false), so results come from the own index only. Run indexing_build to create it."
    }
    if (ownInfo.complete === false) return "Own index reported a previous incomplete run. Run indexing_refresh to finish it."
    if (freshness.checked && freshness.added + freshness.maybeStale + freshness.deleted > 0) {
      return `Workspace has ${freshness.added} new, ${freshness.maybeStale} possibly changed and ${freshness.deleted} deleted files vs own index. Run indexing_refresh.`
    }
    return "The own index looks healthy. Use indexing_search for semantic queries."
  }
  const kiloInSearch = settings.searchKilo !== false
  if (profileChanged) {
    recommendation =
      `The embedding model changed since the own index was built (${profileKey(storedProfile!)} -> ` +
      `${profileKey(configuredProfile)}). Run indexing_build to rebuild it, which re-embeds every file.`
  } else if (!reachable && settings.vectorStore === "qdrant") {
    recommendation = "Start Qdrant (e.g. `docker run -p 6333:6333 qdrant/qdrant` or Podman equivalent), then re-run indexing_status."
  } else if (!kiloInSearch) {
    recommendation = ownIndexRecommendation()
  } else if (!kiloCollectionName && !ownInfo?.exists && selectedKiloSources.length === 0) {
    recommendation = "No index found. Run indexing_build to create an independent index (works without Kilo Code)."
  } else if (selectedKiloSources.length > 0 && !ownInfo?.exists && compatibleSource) {
    recommendation = `Kilo index detected (${compatibleSource.kind}: ${compatibleSource.name}). Run indexing_build to import it without re-embedding.`
  } else if (selectedKiloSources.some((source) => !source.compatible) && !ownInfo?.exists) {
    const blocked = selectedKiloSources.find((source) => !source.compatible)!
    recommendation = incompatibleSourceRecommendation(blocked)
  } else if (kiloCollectionName && kiloComplete === false && !ownInfo?.exists) {
    recommendation =
      "Kilo index exists but its last indexing run did not complete. Run indexing_build (import) or indexing_refresh once built."
  } else if (freshness.checked && freshness.added + freshness.maybeStale + freshness.deleted > 0) {
    recommendation = `Workspace has ${freshness.added} new, ${freshness.maybeStale} possibly changed and ${freshness.deleted} deleted files vs own index. Run indexing_refresh.`
  } else if (!ownInfo?.exists && kiloCollectionName) {
    recommendation = "Kilo index available. Search works now; run indexing_build/refresh as files change to keep results fresh."
  } else if (ownInfo?.exists && ownInfo.complete === false) {
    recommendation = "Own index reported a previous incomplete run. Run indexing_refresh to finish it."
  } else {
    recommendation = "Indexes look healthy. Use indexing_search for semantic queries."
  }

  return {
    root,
    qdrant: { url: settings.qdrantUrl, reachable },
    kilo: {
      collection: kiloCollectionName,
      exists: kiloFromDiscovery ? true : kiloCollection !== null && kiloInfo !== null,
      points: kiloPoints,
      complete: kiloComplete,
      profile: kiloProfile,
    },
    kiloSources,
    own: {
      store: ownStore.name,
      kind: ownStore.kind,
      exists: ownInfo?.exists ?? false,
      points: ownInfo?.pointsCount ?? null,
      complete: ownInfo?.complete ?? null,
      profile: ownProfile,
      lastRun: manifest?.lastRun ?? null,
      manifestFiles: manifest ? Object.keys(manifest.files).length : null,
    },
    freshness,
    recommendation,
    // Discovery problems ride along as warnings because that is the list
    // `indexing_status` already renders, so they surface without a field of
    // their own. It is the only consumer: the footer reads point counts and
    // `ownStoreReachable`, and never looks at warnings.
    warnings: [...warnings, ...kiloProblems],
  }
}
