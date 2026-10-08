import * as os from "node:os"

import type { EmbedderProvider, IndexingSettings, ProviderCredentials } from "./types.ts"
import { defaultLanceDbDirectory, readSettingsFile, type SettingsFile } from "./settings.ts"
import { stripJsonComments } from "./jsonc.ts"
import {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_SEARCH_MIN_SCORE,
  getDefaultModelId,
  getModelDimension,
  getModelQueryPrefix,
  getModelScoreThreshold,
  normalizeExtensions,
} from "./registry.ts"

import * as fs from "node:fs"
import * as path from "node:path"

export { stripJsonComments }

export interface PluginOptionsInput {
  vectorStore?: "qdrant" | "lancedb"
  qdrantUrl?: string
  qdrantApiKey?: string
  lancedbDirectory?: string
  provider?: string
  model?: string
  dimension?: number
  searchMinScore?: number
  searchMaxResults?: number
  embeddingBatchSize?: number
  maxFileSizeBytes?: number
  fileExtensions?: string[]
  autoRefresh?: boolean
  /** Master switch: when false the own index is neither written nor refreshed. */
  enabled?: boolean
  importFromKilo?: boolean
  /** Disable reading Kilo's config file entirely. */
  ignoreKiloConfig?: boolean
  homeDir?: string
}

interface KiloConfigIndexing {
  enabled?: boolean
  provider?: string
  model?: string | null
  dimension?: number | null
  vectorStore?: string
  searchMinScore?: number
  searchMaxResults?: number
  embeddingBatchSize?: number
  fileExtensions?: string[]
  qdrant?: { url?: string; apiKey?: string }
  mistral?: { apiKey?: string }
  openai?: { apiKey?: string }
  ollama?: { baseUrl?: string }
  "openai-compatible"?: { baseUrl?: string; apiKey?: string }
  gemini?: { apiKey?: string }
  voyage?: { apiKey?: string }
  openrouter?: { apiKey?: string }
}

const VALID_PROVIDERS: readonly EmbedderProvider[] = [
  "mistral",
  "openai",
  "ollama",
  "openai-compatible",
  "gemini",
  "voyage",
  "openrouter",
]

function readJsoncFile(file: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8")
    return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function kiloConfigDir(homeDir?: string): string {
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg && xdg.trim()) return path.join(xdg, "kilo")
  return path.join(homeDir ?? os.homedir(), ".config", "kilo")
}

/** Read Kilo's indexing config (best-effort; never throws). */
export function readKiloIndexingConfig(homeDir?: string): KiloConfigIndexing | undefined {
  const dir = kiloConfigDir(homeDir)
  for (const file of ["kilo.jsonc", "kilo.json"]) {
    const parsed = readJsoncFile(path.join(dir, file))
    if (parsed && typeof parsed.indexing === "object" && parsed.indexing !== null) {
      return parsed.indexing as KiloConfigIndexing
    }
  }
  return undefined
}

function pickProvider(value: string | undefined): EmbedderProvider | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase() as EmbedderProvider
  return VALID_PROVIDERS.includes(normalized) ? normalized : undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function pickVectorStore(...values: Array<string | undefined>): "qdrant" | "lancedb" | undefined {
  for (const value of values) {
    const normalized = value?.trim().toLowerCase()
    if (normalized === "qdrant" || normalized === "lancedb") return normalized
  }
  return undefined
}

/**
 * Resolve effective settings.
 * Precedence: plugin options > indexing.json > env vars > kilo.jsonc > defaults.
 */
export function resolveSettings(options: PluginOptionsInput): IndexingSettings {
  const warnings: string[] = []
  const file: SettingsFile | undefined = options.ignoreKiloConfig ? undefined : readSettingsFile(options.homeDir)
  const kilo = options.ignoreKiloConfig ? undefined : readKiloIndexingConfig(options.homeDir)
  const apiKeys = file?.apiKeys

  const provider =
    pickProvider(options.provider) ??
    pickProvider(file?.provider) ??
    pickProvider(process.env.KILO_INDEX_PROVIDER) ??
    pickProvider(kilo?.provider) ??
    ("mistral" as EmbedderProvider)
  if (options.provider && !pickProvider(options.provider)) {
    warnings.push(`Unknown provider "${options.provider}" in plugin options; using "${provider}"`)
  }

  const modelId =
    nonEmpty(options.model) ??
    nonEmpty(file?.model) ??
    nonEmpty(process.env.KILO_INDEX_MODEL) ??
    nonEmpty(kilo?.model) ??
    getDefaultModelId(provider) ??
    ""
  if (!modelId) warnings.push(`No embedding model configured for provider "${provider}"`)

  const dimension =
    (typeof options.dimension === "number" && options.dimension > 0 ? options.dimension : undefined) ??
    (typeof file?.dimension === "number" && file.dimension > 0 ? file.dimension : undefined) ??
    (typeof kilo?.dimension === "number" && kilo.dimension > 0 ? kilo.dimension : undefined) ??
    getModelDimension(provider, modelId)
  if (!dimension) {
    warnings.push(`Unknown embedding dimension for ${provider}/${modelId}; it will be detected on first use`)
  }

  const credentials: ProviderCredentials = {
    mistralApiKey:
      nonEmpty(apiKeys?.mistral) ??
      nonEmpty(process.env.KILO_INDEX_MISTRAL_KEY) ??
      nonEmpty(kilo?.mistral?.apiKey),
    openAiApiKey:
      nonEmpty(apiKeys?.openai) ?? nonEmpty(process.env.KILO_INDEX_OPENAI_KEY) ?? nonEmpty(kilo?.openai?.apiKey),
    ollamaBaseUrl:
      nonEmpty(apiKeys?.ollama?.baseUrl) ??
      nonEmpty(process.env.KILO_INDEX_OLLAMA_URL) ??
      nonEmpty(kilo?.ollama?.baseUrl),
    openAiCompatibleBaseUrl:
      nonEmpty(apiKeys?.["openai-compatible"]?.baseUrl) ??
      nonEmpty(process.env.KILO_INDEX_OPENAI_COMPATIBLE_URL) ??
      nonEmpty(kilo?.["openai-compatible"]?.baseUrl),
    openAiCompatibleApiKey:
      nonEmpty(apiKeys?.["openai-compatible"]?.apiKey) ??
      nonEmpty(process.env.KILO_INDEX_OPENAI_COMPATIBLE_KEY) ??
      nonEmpty(kilo?.["openai-compatible"]?.apiKey),
    geminiApiKey:
      nonEmpty(apiKeys?.gemini) ?? nonEmpty(process.env.KILO_INDEX_GEMINI_KEY) ?? nonEmpty(kilo?.gemini?.apiKey),
    voyageApiKey:
      nonEmpty(apiKeys?.voyage) ?? nonEmpty(process.env.KILO_INDEX_VOYAGE_KEY) ?? nonEmpty(kilo?.voyage?.apiKey),
    openRouterApiKey:
      nonEmpty(apiKeys?.openrouter) ??
      nonEmpty(process.env.KILO_INDEX_OPENROUTER_KEY) ??
      nonEmpty(kilo?.openrouter?.apiKey),
  }

  const vectorStore =
    pickVectorStore(options.vectorStore, file?.vectorStore, process.env.KILO_INDEX_VECTOR_STORE, kilo?.vectorStore) ??
    "qdrant"

  const qdrantUrl =
    nonEmpty(options.qdrantUrl) ??
    nonEmpty(file?.qdrant?.url) ??
    nonEmpty(process.env.KILO_INDEX_QDRANT_URL) ??
    nonEmpty(kilo?.qdrant?.url) ??
    "http://localhost:6333"
  const qdrantApiKey =
    nonEmpty(options.qdrantApiKey) ??
    nonEmpty(file?.qdrant?.apiKey) ??
    nonEmpty(process.env.KILO_INDEX_QDRANT_API_KEY) ??
    nonEmpty(kilo?.qdrant?.apiKey)

  const lancedbDirectory =
    nonEmpty(options.lancedbDirectory) ??
    nonEmpty(file?.lancedb?.directory) ??
    nonEmpty(process.env.KILO_INDEX_LANCEDB_DIR) ??
    defaultLanceDbDirectory(options.homeDir)

  const kiloMinScore = typeof kilo?.searchMinScore === "number" ? kilo.searchMinScore : undefined
  const fileMinScore = typeof file?.searchMinScore === "number" ? file.searchMinScore : undefined
  const scoreThreshold =
    (typeof options.searchMinScore === "number" ? options.searchMinScore : undefined) ??
    fileMinScore ??
    kiloMinScore ??
    getModelScoreThreshold(provider, modelId) ??
    DEFAULT_SEARCH_MIN_SCORE

  const searchMaxResults =
    (typeof options.searchMaxResults === "number" && options.searchMaxResults > 0
      ? Math.floor(options.searchMaxResults)
      : undefined) ??
    (typeof file?.searchMaxResults === "number" && file.searchMaxResults > 0
      ? Math.floor(file.searchMaxResults)
      : undefined) ??
    (typeof kilo?.searchMaxResults === "number" && kilo.searchMaxResults > 0
      ? Math.floor(kilo.searchMaxResults)
      : undefined) ??
    DEFAULT_MAX_SEARCH_RESULTS

  const embeddingBatchSize =
    (typeof options.embeddingBatchSize === "number" && options.embeddingBatchSize > 0
      ? Math.floor(options.embeddingBatchSize)
      : undefined) ??
    (typeof file?.embeddingBatchSize === "number" && file.embeddingBatchSize > 0
      ? Math.floor(file.embeddingBatchSize)
      : undefined) ??
    (typeof kilo?.embeddingBatchSize === "number" && kilo.embeddingBatchSize > 0
      ? Math.floor(kilo.embeddingBatchSize)
      : undefined) ??
    DEFAULT_EMBEDDING_BATCH_SIZE

  const maxFileSizeBytes =
    (typeof options.maxFileSizeBytes === "number" && options.maxFileSizeBytes > 0
      ? Math.floor(options.maxFileSizeBytes)
      : undefined) ??
    (typeof file?.maxFileSizeBytes === "number" && file.maxFileSizeBytes > 0
      ? Math.floor(file.maxFileSizeBytes)
      : undefined) ??
    DEFAULT_MAX_FILE_SIZE_BYTES

  const fileExtensions = normalizeExtensions(
    options.fileExtensions ?? file?.fileExtensions ?? kilo?.fileExtensions,
  )

  const autoRefresh = options.autoRefresh ?? file?.autoRefresh === true
  const importFromKilo = options.importFromKilo ?? file?.importFromKilo !== false
  // Master switch for the own index. Off means: search still reads Kilo's index,
  // but nothing is written and nothing is auto-refreshed. Toggled from the TUI
  // footer indicator or `/indexing-config set enabled false`.
  const enabled = options.enabled ?? file?.enabled !== false

  return {
    provider,
    modelId,
    dimension: dimension ?? 0,
    vectorStore,
    qdrantUrl,
    qdrantApiKey,
    lancedbDirectory,
    scoreThreshold,
    queryPrefix: getModelQueryPrefix(provider, modelId),
    searchMinScore:
      (typeof options.searchMinScore === "number" ? options.searchMinScore : undefined) ??
      fileMinScore ??
      kiloMinScore,
    searchMaxResults,
    embeddingBatchSize,
    maxFileSizeBytes,
    fileExtensions,
    autoRefresh,
    importFromKilo,
    enabled,
    credentials,
    warnings,
  }
}

/** Clone settings swapping the embedding profile (used to query stores with other profiles). */
export function withProfile(
  settings: IndexingSettings,
  profile: { provider: EmbedderProvider; modelId: string; dimension: number },
): IndexingSettings {
  return {
    ...settings,
    provider: profile.provider,
    modelId: profile.modelId,
    dimension: profile.dimension,
    scoreThreshold: getModelScoreThreshold(profile.provider, profile.modelId) ?? settings.scoreThreshold,
    queryPrefix: getModelQueryPrefix(profile.provider, profile.modelId),
  }
}
