import { createQdrant, type Qdrant } from "./qdrant.ts"
import { createQdrantOwnStore } from "./store-qdrant.ts"
import { createLanceDbStore } from "./lancedb-store.ts"
import type { EmbeddingProfile, IndexingSettings } from "./types.ts"
import type { VectorStoreAdapter, VectorStoreKind } from "./vector-store.ts"

/**
 * Backend selection for the plugin's OWN index.
 *
 * - qdrant: HTTP collections named `oc-<hash16>` (default).
 * - lancedb: embedded `@lancedb/lancedb` database under the configured directory.
 */
export function createOwnStore(settings: IndexingSettings, root: string): VectorStoreAdapter {
  if (settings.vectorStore === "lancedb") {
    return createLanceDbStore({ root, directory: settings.lancedbDirectory })
  }
  const client = createQdrant({ url: settings.qdrantUrl, apiKey: settings.qdrantApiKey })
  return createQdrantOwnStore(client, root)
}

/** Qdrant client for the given settings (also used for Kilo reads). */
export function createSettingsQdrant(settings: IndexingSettings): Qdrant {
  return createQdrant({ url: settings.qdrantUrl, apiKey: settings.qdrantApiKey })
}

/**
 * Drop the own store and recreate it. Used when the embedding profile or
 * dimension changed, or on an explicit rebuild.
 */
export async function recreateOwnStore(
  store: VectorStoreAdapter,
  settings: IndexingSettings,
  dimension: number,
  profile: EmbeddingProfile,
): Promise<{ created: boolean }> {
  if (store.kind === "qdrant") {
    const client = createSettingsQdrant(settings)
    if (await client.collectionExists(store.name)) {
      await client.deleteCollection(store.name)
    }
  } else {
    const fs = await import("node:fs")
    fs.rmSync(store.name, { recursive: true, force: true })
  }
  return store.ensure(dimension, profile)
}

export function describeOwnStore(settings: IndexingSettings, root: string): { kind: VectorStoreKind; name: string } {
  const store = createOwnStore(settings, root)
  return { kind: store.kind, name: store.name }
}
