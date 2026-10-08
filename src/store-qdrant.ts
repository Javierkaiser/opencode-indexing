import {
  deleteOwnByFilePaths,
  ensureOwnCollection,
  getOwnStoreInfo,
  markOwnComplete,
  ownCollectionName,
  searchOwnCollection,
  upsertChunkPoints,
} from "./own-store.ts"
import type { Qdrant } from "./qdrant.ts"
import type { EmbeddingProfile, QdrantPoint, QueryHit } from "./types.ts"
import type { ExportBatch, StoreSearchOptions, VectorStoreAdapter, VectorStoreInfo } from "./vector-store.ts"

/**
 * VectorStoreAdapter over the plugin's own Qdrant collections (`oc-` prefix).
 * Thin wrapper around the existing own-store helpers.
 */
export function createQdrantOwnStore(client: Qdrant, root: string): VectorStoreAdapter {
  const collection = ownCollectionName(root)

  return {
    kind: "qdrant",
    name: collection,

    async exists(): Promise<boolean> {
      return client.collectionExists(collection)
    },

    async info(): Promise<VectorStoreInfo> {
      const info = await getOwnStoreInfo(client, collection)
      if (!info) {
        return { kind: "qdrant", name: collection, exists: false, pointsCount: null, complete: null }
      }
      return {
        kind: "qdrant",
        name: collection,
        exists: true,
        pointsCount: info.pointsCount,
        profile: info.profile,
        complete: info.complete ?? null,
        schema: info.schema ?? null,
      }
    },

    async ensure(dimension: number, _profile: EmbeddingProfile): Promise<{ created: boolean }> {
      return ensureOwnCollection(client, collection, dimension)
    },

    async upsert(points: QdrantPoint[]): Promise<void> {
      await upsertChunkPoints(client, collection, points)
    },

    async deleteByFilePaths(relPaths: string[]): Promise<void> {
      await deleteOwnByFilePaths(client, collection, root, relPaths)
    },

    async deleteAll(): Promise<void> {
      await client.deletePoints(collection, undefined, true)
    },

    async search(options: StoreSearchOptions): Promise<QueryHit[]> {
      return searchOwnCollection(client, collection, options)
    },

    async exportBatch(options: { limit: number; cursor?: unknown }): Promise<ExportBatch> {
      const page = await client.scroll(collection, {
        filter: {
          must_not: [{ key: "type", match: { value: "oc_metadata" } }],
        },
        limit: options.limit,
        withPayload: true,
        withVector: true,
        offset: options.cursor,
      })
      const points: QdrantPoint[] = []
      for (const point of page.points) {
        if (!point.vector || point.payload == null) continue
        const payload = point.payload
        if (!isChunkPayload(payload)) continue
        points.push({
          id: typeof point.id === "string" ? point.id : String(point.id),
          vector: point.vector,
          payload,
        })
      }
      return { points, next: page.next }
    },

    async markComplete(profile: EmbeddingProfile, complete: boolean, dimension: number): Promise<void> {
      await markOwnComplete(client, collection, profile, complete, dimension)
    },
  }
}

export function isChunkPayload(payload: Record<string, unknown>): boolean {
  return ["filePath", "fileHash", "codeChunk", "startLine", "endLine"].every((key) => key in payload)
}
