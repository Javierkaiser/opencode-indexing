/**
 * Shared types for opencode-indexing.
 * All modules align with this file. Keep it dependency-free.
 */

export type EmbedderProvider =
  | "mistral"
  | "openai"
  | "ollama"
  | "openai-compatible"
  | "gemini"
  | "voyage"
  | "openrouter"

export interface EmbeddingProfile {
  provider: EmbedderProvider
  modelId: string
  dimension: number
}

export interface ModelProfile {
  dimension: number
  scoreThreshold?: number
  queryPrefix?: string
}

export interface ProviderCredentials {
  mistralApiKey?: string
  openAiApiKey?: string
  ollamaBaseUrl?: string
  openAiCompatibleBaseUrl?: string
  openAiCompatibleApiKey?: string
  geminiApiKey?: string
  voyageApiKey?: string
  openRouterApiKey?: string
}

/** Fully resolved settings used at runtime. */
export interface IndexingSettings extends EmbeddingProfile {
  /** Backend for the plugin's OWN index. */
  vectorStore: "qdrant" | "lancedb"
  qdrantUrl: string
  qdrantApiKey?: string
  /** Base directory for the plugin's own LanceDB stores. */
  lancedbDirectory: string
  scoreThreshold: number
  queryPrefix?: string
  searchMinScore?: number
  searchMaxResults: number
  embeddingBatchSize: number
  maxFileSizeBytes: number
  fileExtensions: string[]
  autoRefresh: boolean
  /** Import vectors from Kilo Code's existing index instead of re-embedding. */
  importFromKilo: boolean
  /** Master switch: when false nothing is written to nor refreshed in the own index. */
  enabled: boolean
  credentials: ProviderCredentials
  /** Warnings produced while resolving configuration. */
  warnings: string[]
}

export interface FileEntry {
  absPath: string
  /** Workspace-relative path with native separators (Windows: backslash). */
  relPath: string
  size: number
  mtimeMs: number
}

export interface ScanOptions {
  /** Extensions with dot, lowercase. Empty/undefined = all files. */
  extensions?: readonly string[]
  maxFileSizeBytes?: number
  /** Extra gitignore-style patterns. */
  ignoreGlobs?: readonly string[]
  maxFiles?: number
}

export interface ScanResult {
  files: FileEntry[]
  skippedTooLarge: number
  skippedIgnored: number
  truncated: boolean
}

export interface Chunk {
  /** Workspace-relative, native separators (same as FileEntry.relPath). */
  filePath: string
  content: string
  /** 1-based inclusive. */
  startLine: number
  endLine: number
  type: string
  segmentHash: string
  fileHash: string
}

export interface QdrantPoint {
  id: string
  vector: number[]
  payload: Record<string, unknown>
}

export interface QdrantFieldCondition {
  key: string
  match: { value: unknown }
}

export interface QdrantFilter {
  must?: QdrantFieldCondition[]
  must_not?: QdrantFieldCondition[]
  should?: Array<{ must: QdrantFieldCondition[] }>
}

export interface QueryOptions {
  vector: number[]
  filter?: QdrantFilter
  scoreThreshold?: number
  limit?: number
  include?: string[]
  hnswEf?: number
}

export interface QueryHit {
  id: string | number
  score: number
  payload: Record<string, unknown> | null
}

export interface SearchHit {
  filePath: string
  score: number
  startLine: number
  endLine: number
  codeChunk: string
  fileHash?: string
  source: "kilo" | "own"
}

export interface StoreInfo {
  name: string
  exists: boolean
  pointsCount?: number
  profile?: EmbeddingProfile
  schema?: number
  complete?: boolean
}

export interface Embedder {
  readonly provider: EmbedderProvider
  readonly modelId: string
  readonly dimension: number
  /**
   * Embed a list of texts. `asQuery` is informational: prefix behavior is
   * applied consistently with the provider/model catalog either way.
   */
  embed(texts: string[], options?: { asQuery?: boolean }): Promise<number[][]>
}

export interface KVStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: {
    prefix: string
    after?: string
    limit?: number
  }): Promise<{ entries: Array<{ key: string; value: unknown }>; next?: string }>
}

export interface ManifestFileRecord {
  hash: string
  size: number
  mtimeMs: number
  indexedAt: number
}

export interface Manifest {
  version: 1
  root: string
  collection: string
  profile: EmbeddingProfile
  /** relPath -> record */
  files: Record<string, ManifestFileRecord>
  lastRun?: number
  complete?: boolean
}

export interface IndexReport {
  mode: "refresh" | "build"
  scanned: number
  newFiles: number
  changedFiles: number
  deletedFiles: number
  unchangedFiles: number
  chunksUpserted: number
  batches: number
  durationMs: number
  errors: string[]
  /** Non-fatal notes (e.g. truncated scans skipped deletion detection). */
  notes?: string[]
  /** Set when the build seeded from a Kilo Code index instead of embedding. */
  imported?: {
    source: string
    kind: "qdrant" | "lancedb"
    chunks: number
  }
}
