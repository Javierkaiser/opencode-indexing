import type { EmbeddingProfile, QdrantPoint, QueryHit } from "./types.ts"

/**
 * Vector store abstraction: the plugin can back its own index with either
 * Qdrant (HTTP, default) or LanceDB (embedded, native module).
 *
 * Both adapters index the same chunk shape and metadata, so indexes can be
 * imported from one store into the other without re-embedding.
 */

export type VectorStoreKind = "qdrant" | "lancedb"

export interface VectorStoreInfo {
  kind: VectorStoreKind
  /** Human readable location (qdrant collection name or lancedb path). */
  name: string
  exists: boolean
  pointsCount: number | null
  profile?: EmbeddingProfile
  complete?: boolean | null
  schema?: number | null
}

export interface StoreSearchOptions {
  vector: number[]
  pathPrefix?: string
  minScore?: number
  maxResults?: number
  hnswEf?: number
}

export interface ExportBatch {
  points: QdrantPoint[]
  /** Opaque cursor to resume; undefined when done. */
  next?: unknown
}

export interface VectorStoreAdapter {
  readonly kind: VectorStoreKind
  readonly name: string

  exists(): Promise<boolean>
  info(): Promise<VectorStoreInfo>

  /** Create the store if missing. Existing stores are validated, never silently recreated. */
  ensure(dimension: number, profile: EmbeddingProfile): Promise<{ created: boolean }>

  upsert(points: QdrantPoint[]): Promise<void>
  /** Delete every chunk point belonging to the given workspace-relative files. */
  deleteByFilePaths(relPaths: string[]): Promise<void>
  /** Delete all points (or drop the whole collection/table). */
  deleteAll(): Promise<void>

  search(options: StoreSearchOptions): Promise<QueryHit[]>

  /**
   * Iterate every chunk point with vectors, excluding metadata points.
   * Used by the import engine; must be resumable via an opaque cursor.
   */
  exportBatch(options: { limit: number; cursor?: unknown }): Promise<ExportBatch>

  markComplete(profile: EmbeddingProfile, complete: boolean, dimension: number): Promise<void>
}
