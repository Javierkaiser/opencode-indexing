import type { EmbedderProvider, IndexingSettings, ProviderCredentials } from "./types.ts"
import { defaultLanceDbDirectory, readSettingsFile, settingsFilePath, type SettingsFile } from "./settings.ts"
import { lanceDbSupport } from "./lancedb-support.ts"
import { stripJsonComments } from "./jsonc.ts"
import { readKiloIndexingConfig } from "./kilo-config.ts"
import { localModelSpec } from "./local/models.ts"
import {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_SEARCH_MIN_SCORE,
  getDefaultModelId,
  getModelProfile,
  modelDimensionFor,
  modelQueryPrefixFor,
  modelScoreThresholdFor,
  normalizeExtensions,
} from "./registry.ts"

export { stripJsonComments }
export { readKiloIndexingConfig }

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
  /** Search Kilo's index alongside the own one. Defaults to on. */
  searchKilo?: boolean
  /** Also launch the codegraph CLI on build. Absent means on; see IndexingSettings. */
  codegraph?: boolean
  /** Disable reading Kilo's config file entirely. */
  ignoreKiloConfig?: boolean
  homeDir?: string
}

export const VALID_PROVIDERS: readonly EmbedderProvider[] = [
  "local",
  "mistral",
  "openai",
  "ollama",
  "openai-compatible",
  "gemini",
  "voyage",
  "openrouter",
]

function pickProvider(value: string | undefined): EmbedderProvider | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase() as EmbedderProvider
  return VALID_PROVIDERS.includes(normalized) ? normalized : undefined
}

/** Boolean environment flag; anything that is not a recognized word is ignored. */
function envFlag(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return undefined
  if (["1", "true", "yes", "on"].includes(raw)) return true
  if (["0", "false", "no", "off"].includes(raw)) return false
  return undefined
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

  // Credentials are resolved before the provider because the default depends on
  // them: a machine with no cloud key at all should still index, so it falls
  // back to the bundled local model instead of a provider it cannot call.
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

  /** Whether any cloud embedding provider could be called without more setup. */
  const hasCloudKey = Boolean(
    credentials.mistralApiKey ||
      credentials.openAiApiKey ||
      credentials.geminiApiKey ||
      credentials.voyageApiKey ||
      credentials.openRouterApiKey,
  )

  const explicitProvider =
    pickProvider(options.provider) ??
    pickProvider(file?.provider) ??
    pickProvider(process.env.KILO_INDEX_PROVIDER) ??
    pickProvider(kilo?.provider)

  // The zero-setup default: local embeddings when there is nothing to call.
  const provider = explicitProvider ?? (hasCloudKey ? ("mistral" as EmbedderProvider) : ("local" as EmbedderProvider))
  if (!explicitProvider && !hasCloudKey) {
    warnings.push(
      "No embedding credentials found; using the bundled local model (English-only, no network).",
    )
  }
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

  const customProfiles = file?.models
  const custom = customProfiles?.[provider]?.[modelId]
  if (provider === "local" && custom && !localModelSpec(modelId)) {
    warnings.push(
      `The local provider only loads its bundled models; custom metadata for "${modelId}" cannot supply weights. Use openai-compatible for a self-hosted model.`,
    )
  }
  const mirrored = getModelProfile(provider, modelId)
  if (
    custom &&
    mirrored &&
    ((custom.dimension !== undefined && custom.dimension !== mirrored.dimension) ||
      (custom.queryPrefix !== undefined && custom.queryPrefix !== (mirrored.queryPrefix ?? "")))
  ) {
    warnings.push(
      `Custom metadata for ${provider}/${modelId} differs from Kilo's catalog; a Kilo index built with this model may no longer be importable.`,
    )
  }
  const dimension =
    (typeof options.dimension === "number" && options.dimension > 0 ? options.dimension : undefined) ??
    // A model-specific entry is more precise than the legacy top-level
    // `dimension`, which may have been left behind by a previous model.
    (custom?.dimension && custom.dimension > 0 ? custom.dimension : undefined) ??
    (typeof file?.dimension === "number" && file.dimension > 0 ? file.dimension : undefined) ??
    (typeof kilo?.dimension === "number" && kilo.dimension > 0 ? kilo.dimension : undefined) ??
    modelDimensionFor({ customProfiles }, provider, modelId)
  if (!dimension) {
    warnings.push(`Unknown embedding dimension for ${provider}/${modelId}; it will be detected on first use`)
  }

  // Kilo decides where an import reads FROM; it does not decide where the own
  // index writes TO. Those were coupled through this one chain, and that is
  // what made "LanceDB by default" unreachable for exactly the people most
  // likely to have Kilo installed: kilo.jsonc's vectorStore sat above the
  // fallback, so a Kilo-on-Qdrant setup silently kept pinning the own index to
  // Qdrant. The coupling is reported below rather than dropped in silence.
  const kiloVectorStore = pickVectorStore(kilo?.vectorStore)
  const ownVectorStore = pickVectorStore(
    options.vectorStore,
    file?.vectorStore,
    process.env.KILO_INDEX_VECTOR_STORE,
  )
  if (kiloVectorStore && !ownVectorStore && kiloVectorStore !== "lancedb") {
    warnings.push(
      `Kilo indexes with ${kiloVectorStore}; your own index no longer inherits that. ` +
        `Set vectorStore explicitly in ${settingsFilePath(options.homeDir)} to change it.`,
    )
  }
  const vectorStore = ownVectorStore ?? "lancedb"

  if (vectorStore === "lancedb" && !lanceDbSupport().supported) {
    const { id } = lanceDbSupport()
    warnings.push(
      `LanceDB is the default store but has no native binary for ${id}. ` +
        `Indexing will fail until you set vectorStore=qdrant in ${settingsFilePath(options.homeDir)}.`,
    )
  }

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
    custom?.scoreThreshold ??
    kiloMinScore ??
    modelScoreThresholdFor({ customProfiles }, provider, modelId) ??
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
  // Search Kilo's index too. Off keeps the own index searchable in a workspace
  // whose Kilo collection was built with a profile this machine can no longer
  // embed — otherwise the whole search fails rather than answering from the half
  // that works.
  const searchKilo = options.searchKilo ?? file?.searchKilo ?? envFlag("KILO_INDEX_SEARCH_KILO") ?? true
  // Master switch for the own index. Off means: search still reads Kilo's index,
  // but nothing is written and nothing is auto-refreshed. Toggled from the TUI
  // footer indicator or `/indexing-config set enabled false`.
  const enabled = options.enabled ?? file?.enabled !== false
  // Companion indexer. On by default, and a no-op when codegraph is not
  // installed, so enabling it costs nothing for someone who does not use it.
  // `!== false` rather than `=== true`: the key is absent from most configs and
  // absent has to mean "on" or the default would never apply.
  const codegraph = options.codegraph ?? file?.codegraph !== false

  return {
    provider,
    modelId,
    dimension: dimension ?? 0,
    vectorStore,
    kiloVectorStore: kiloVectorStore ?? null,
    qdrantUrl,
    qdrantApiKey,
    lancedbDirectory,
    scoreThreshold,
    queryPrefix: modelQueryPrefixFor({ customProfiles }, provider, modelId),
    customProfiles,
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
    searchKilo,
    enabled,
    codegraph,
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
    scoreThreshold: modelScoreThresholdFor(settings, profile.provider, profile.modelId) ?? settings.scoreThreshold,
    queryPrefix: modelQueryPrefixFor(settings, profile.provider, profile.modelId),
  }
}
