import * as fs from "node:fs/promises"
import * as path from "node:path"

import { getKiloStoreInfo, resolveKiloCollection } from "./kilo-store.ts"
import { discoverKiloSources, type KiloSourceInfo } from "./import.ts"
import { createOwnStore, createSettingsQdrant } from "./store-factory.ts"
import { diffFiles, loadManifest } from "./manifest.ts"
import { workspaceHash } from "./registry.ts"
import { scanWorkspace } from "./scanner.ts"
import type { IndexingSettings, KVStore } from "./types.ts"
import type { Qdrant } from "./qdrant.ts"

export interface StatusDeps {
  qdrant: Qdrant
  kv: KVStore
  root: string
  settings: IndexingSettings
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

export async function getStatus(deps: StatusDeps, options?: { checkFreshness?: boolean }): Promise<IndexStatus> {
  const { qdrant, kv, root, settings } = deps
  const warnings: string[] = []
  let reachable = true
  try {
    await qdrant.listCollections()
  } catch (error) {
    reachable = false
    warnings.push(`Qdrant unreachable at ${settings.qdrantUrl}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const ownStore = createOwnStore(settings, root)
  const cacheKey = KILO_CACHE_PREFIX + workspaceHash(root).slice(0, 16)
  const cachedKilo = await kv.get(cacheKey)
  const kiloCollection = reachable
    ? await resolveKiloCollection(qdrant, root, typeof cachedKilo === "string" ? cachedKilo : undefined).catch(() => null)
    : null
  if (kiloCollection && kiloCollection !== cachedKilo) await kv.set(cacheKey, kiloCollection)

  const targetProfile =
    settings.dimension > 0
      ? { provider: settings.provider, modelId: settings.modelId, dimension: settings.dimension }
      : undefined
  const [kiloInfo, ownInfo, manifest, kiloSources] = await Promise.all([
    kiloCollection ? getKiloStoreInfo(qdrant, kiloCollection).catch(() => null) : null,
    ownStore.info().catch(() => null),
    loadManifest(kv, root),
    discoverKiloSources(root, { qdrant, homeDir: undefined, targetProfile }).catch(() => [] as KiloSourceInfo[]),
  ])

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
      warnings.push(`freshness scan failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const kiloProfile = kiloInfo?.profile
    ? `${kiloInfo.profile.provider}:${kiloInfo.profile.modelId}:${kiloInfo.profile.dimension}`
    : null
  const ownProfile = ownInfo?.profile
    ? `${ownInfo.profile.provider}:${ownInfo.profile.modelId}:${ownInfo.profile.dimension}`
    : null

  const compatibleSource = kiloSources.find((source) => source.compatible)
  let recommendation: string
  if (!reachable && settings.vectorStore === "qdrant") {
    recommendation = "Start Qdrant (e.g. `docker run -p 6333:6333 qdrant/qdrant` or Podman equivalent), then re-run indexing_status."
  } else if (!kiloCollection && !ownInfo?.exists && kiloSources.length === 0) {
    recommendation = "No index found. Run indexing_build to create an independent index (works without Kilo Code)."
  } else if (kiloSources.length > 0 && !ownInfo?.exists && compatibleSource) {
    recommendation = `Kilo index detected (${compatibleSource.kind}: ${compatibleSource.name}). Run indexing_build to import it without re-embedding.`
  } else if (kiloSources.some((source) => !source.compatible) && !ownInfo?.exists) {
    recommendation =
      "Kilo index detected but its embedding profile differs. Run indexing_build to index from scratch with your configured model, or switch to the matching model."
  } else if (kiloCollection && kiloInfo && kiloInfo.complete === false && !ownInfo?.exists) {
    recommendation =
      "Kilo index exists but its last indexing run did not complete. Run indexing_build (import) or indexing_refresh once built."
  } else if (freshness.checked && freshness.added + freshness.maybeStale + freshness.deleted > 0) {
    recommendation = `Workspace has ${freshness.added} new, ${freshness.maybeStale} possibly changed and ${freshness.deleted} deleted files vs own index. Run indexing_refresh.`
  } else if (!ownInfo?.exists && kiloCollection) {
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
      collection: kiloCollection,
      exists: kiloCollection !== null && kiloInfo !== null,
      points: kiloInfo?.pointsCount ?? null,
      complete: kiloInfo?.complete ?? null,
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
    warnings,
  }
}
