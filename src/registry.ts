import { createHash } from "node:crypto"

/**
 * Embedding model catalog, mirrored from Kilo Code / Roo Code
 * (`packages/kilo-indexing/src/indexing/model-registry.ts`) so that query
 * embeddings are compatible with existing Kilo indexes.
 *
 * The mirror is the compatibility contract: an import is accepted only when
 * provider, model id and dimension match byte for byte, so an entry here that
 * drifts from Kilo's silently makes an index un-importable. Entries marked
 * `kiloMirror: false` are ours alone and can never be imported.
 */

import type { EmbedderProvider, ModelProfile } from "./types.ts"

/** Input ceilings and batch limits are from each provider's own documentation. */
const profiles: Partial<Record<EmbedderProvider, Record<string, ModelProfile>>> = {
  openai: {
    "text-embedding-3-small": { dimension: 1536, scoreThreshold: 0.4, maxInputTokens: 8192, maxBatchItems: 2048, maxBatchTokens: 300_000 },
    "text-embedding-3-large": { dimension: 3072, scoreThreshold: 0.4, maxInputTokens: 8192, maxBatchItems: 2048, maxBatchTokens: 300_000 },
    "text-embedding-ada-002": { dimension: 1536, scoreThreshold: 0.4, maxInputTokens: 8192, maxBatchItems: 2048, maxBatchTokens: 300_000 },
  },
  ollama: {
    // 512 tokens is the smallest input in the catalog by a wide margin. A chunk of
    // real code is routinely longer, and Ollama truncates by default, so this one
    // is also the reason the Ollama adapter refuses to truncate silently.
    "mxbai-embed-large": { dimension: 1024, scoreThreshold: 0.3, maxInputTokens: 512, normalized: true },
    "nomic-embed-text": { dimension: 768, scoreThreshold: 0.3, queryPrefix: "search_query: ", maxInputTokens: 2048, normalized: true },
    // Ollama reports the tag, but Kilo stores whatever its config names, so an
    // index carrying this id was written by us and cannot be imported.
    "nomic-embed-text:latest": { dimension: 768, scoreThreshold: 0.3, queryPrefix: "search_query: ", maxInputTokens: 2048, normalized: true, kiloMirror: false },
    "all-minilm": { dimension: 384, scoreThreshold: 0.3, maxInputTokens: 512, normalized: true },
    "bge-m3": { dimension: 1024, scoreThreshold: 0.3, maxInputTokens: 8192, normalized: true, kiloMirror: false },
  },
  gemini: {
    // gemini-embedding-001 accepts only 2048 tokens, the tightest cloud ceiling here.
    // gemini-embedding-2 takes 8192 and is the better default despite costing more.
    "gemini-embedding-001": { dimension: 3072, scoreThreshold: 0.35, maxInputTokens: 2048 },
    "gemini-embedding-2": { dimension: 3072, scoreThreshold: 0.35, maxInputTokens: 8192, normalized: true, kiloMirror: false },
    "text-embedding-004": { dimension: 768, scoreThreshold: 0.35, maxInputTokens: 2048 },
    "embedding-001": { dimension: 768, scoreThreshold: 0.35, maxInputTokens: 2048 },
  },
  mistral: {
    "codestral-embed-2505": { dimension: 1536, scoreThreshold: 0.35, maxInputTokens: 8192, normalized: true },
    "codestral-embed": { dimension: 1536, scoreThreshold: 0.35, maxInputTokens: 8192, normalized: true },
    "mistral-embed": { dimension: 1024, scoreThreshold: 0.35, maxInputTokens: 8192, normalized: true },
  },
  voyage: {
    // 32k of context on a code-specific model: four times any other entry here, and
    // the reason voyage is a better default than codestral for code chunks.
    "voyage-code-4": { dimension: 1024, scoreThreshold: 0.35, maxInputTokens: 32_000, maxBatchItems: 1000, maxBatchTokens: 120_000, normalized: true, kiloMirror: false },
    "voyage-code-3": { dimension: 1024, scoreThreshold: 0.35, maxInputTokens: 32_000, maxBatchItems: 1000, maxBatchTokens: 120_000, normalized: true },
    "voyage-4-large": { dimension: 1024, scoreThreshold: 0.35, maxInputTokens: 32_000, maxBatchItems: 1000, maxBatchTokens: 120_000, normalized: true, kiloMirror: false },
    "voyage-4": { dimension: 1024, scoreThreshold: 0.35, maxInputTokens: 32_000, maxBatchItems: 1000, maxBatchTokens: 320_000, normalized: true, kiloMirror: false },
    "voyage-4-lite": { dimension: 1024, scoreThreshold: 0.35, maxInputTokens: 32_000, maxBatchItems: 1000, maxBatchTokens: 1_000_000, normalized: true, kiloMirror: false },
    "voyage-3": { dimension: 1024, scoreThreshold: 0.35, maxInputTokens: 32_000, maxBatchItems: 1000, normalized: true },
    "voyage-3-lite": { dimension: 512, scoreThreshold: 0.35, maxInputTokens: 32_000, maxBatchItems: 1000, normalized: true },
  },
  openrouter: {
    "openai/text-embedding-3-small": { dimension: 1536, scoreThreshold: 0.4, maxInputTokens: 8192, maxBatchTokens: 300_000 },
    "openai/text-embedding-3-large": { dimension: 3072, scoreThreshold: 0.4, maxInputTokens: 8192, maxBatchTokens: 300_000 },
    // Kilo's registry names this `google/gemini-embedding-2-preview`. Ours said
    // `google/gemini-embedding-001`, which can never match a Kilo index: the
    // profile comparison is exact string equality, so the drift was invisible and
    // simply made every Gemini-via-OpenRouter index un-importable.
    "google/gemini-embedding-2-preview": { dimension: 3072, scoreThreshold: 0.35, maxInputTokens: 8192 },
  },
  // Kilo's registry also lists `bedrock` and `vercel-ai-gateway`. Both are
  // deliberately absent: bedrock needs SigV4 request signing, and neither is a
  // provider this plugin offers. A catalog entry with no implemented adapter is
  // worse than a missing model, because it looks selectable and then fails.
  "openai-compatible": {},
}

const defaults: Record<string, string> = {
  openai: "text-embedding-3-small",
  ollama: "nomic-embed-text",
  gemini: "gemini-embedding-001",
  mistral: "codestral-embed-2505",
  voyage: "voyage-code-3",
  bedrock: "amazon.titan-embed-text-v2:0",
  openrouter: "openai/text-embedding-3-small",
  "openai-compatible": "",
}

export const DEFAULT_SEARCH_MIN_SCORE = 0.4
export const DEFAULT_MAX_SEARCH_RESULTS = 50
export const DEFAULT_EMBEDDING_BATCH_SIZE = 60
export const DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024
export const MAX_SEARCH_RESULTS = 200

/**
 * Ceiling used when a model is not in the catalog.
 *
 * `mxbai-embed-large` takes 512 tokens, and Ollama truncates anything longer
 * without saying so. For an unknown model the safe assumption is the tightest
 * documented one: a shorter index beat a silently wrong index.
 */
export const FALLBACK_MAX_INPUT_TOKENS = 512

/** Scanner extension allowlist mirrored from Kilo's tree-sitter index. */
export const DEFAULT_SCANNER_EXTENSIONS: readonly string[] = [
  ".bash",
  ".bazel",
  ".bzl",
  ".build",
  ".gradle",
  ".ninja",
  ".sh",
  ".zsh",
  ".css",
  ".ejs",
  ".erb",
  ".htm",
  ".html",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".vue",
  ".c",
  ".cpp",
  ".cs",
  ".go",
  ".h",
  ".hpp",
  ".m",
  ".mm",
  ".rs",
  ".swift",
  ".zig",
  ".ex",
  ".exs",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".dart",
  ".el",
  ".elm",
  ".lua",
  ".php",
  ".py",
  ".r",
  ".rb",
  ".vb",
  ".ml",
  ".mli",
  ".ql",
  ".rdl",
  ".res",
  ".resi",
  ".sol",
  ".tla",
  ".json",
  ".markdown",
  ".md",
  ".rst",
  ".sql",
  ".toml",
  ".yaml",
  ".yml",
]

/** Normalize an extension list: trim, lowercase, ensure leading dot, dedupe. */
export function normalizeExtensions(input: readonly string[] | undefined): string[] {
  if (!input || input.length === 0) return [...DEFAULT_SCANNER_EXTENSIONS]
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input) {
    if (typeof raw !== "string") continue
    let ext = raw.trim().toLowerCase()
    if (!ext) continue
    if (!ext.startsWith(".")) ext = `.${ext}`
    if (!seen.has(ext)) {
      seen.add(ext)
      out.push(ext)
    }
  }
  return out.length > 0 ? out : [...DEFAULT_SCANNER_EXTENSIONS]
}

export function getDefaultModelId(provider: EmbedderProvider): string {
  return defaults[provider] ?? ""
}

/**
 * Providers whose adapter has been exercised against the real service.
 *
 * Not a quality judgement, a statement of fact. The others were written from
 * each provider's documentation and tested against fixtures written alongside
 * them, so a wrong assumption about a field name or a response shape would pass
 * every test and fail on first use. Surfacing that where a provider is chosen is
 * cheaper than letting a user discover it from a failed indexing run.
 */
export const LIVE_TESTED_PROVIDERS: ReadonlySet<string> = new Set(["mistral"])

export function isLiveTested(provider: EmbedderProvider): boolean {
  return LIVE_TESTED_PROVIDERS.has(provider)
}

/**
 * Every model id the catalog knows for a provider, in catalog order.
 */
export function listModelIds(provider: EmbedderProvider): string[] {
  return Object.keys(profiles[provider] ?? {})
}

/**
 * Whether an index built with this profile could ever be imported from Kilo.
 *
 * `undefined` means the profile is unknown to us, which is a different thing
 * from "not importable": a model we have never heard of may still be exactly
 * what a Kilo index holds.
 */
export function isKiloMirrored(provider: EmbedderProvider, modelId: string): boolean | undefined {
  const profile = getModelProfile(provider, modelId)
  if (!profile) return undefined
  return profile.kiloMirror !== false
}

export function getModelProfile(provider: EmbedderProvider, modelId: string): ModelProfile | undefined {
  return profiles[provider]?.[modelId]
}

export function getModelDimension(provider: EmbedderProvider, modelId: string): number | undefined {
  return getModelProfile(provider, modelId)?.dimension
}

export function getModelScoreThreshold(provider: EmbedderProvider, modelId: string): number | undefined {
  return getModelProfile(provider, modelId)?.scoreThreshold
}

export function getModelQueryPrefix(provider: EmbedderProvider, modelId: string): string | undefined {
  return getModelProfile(provider, modelId)?.queryPrefix
}

/**
 * Largest input the model accepts, in tokens.
 *
 * Falls back to the most conservative ceiling any catalog model has, rather than
 * the most generous: guessing high means sending a 32,000-character chunk to a
 * model that accepts 512, which comes back silently truncated and gets indexed
 * as if it covered the whole function.
 */
export function getModelMaxInputTokens(provider: EmbedderProvider, modelId: string): number {
  return getModelProfile(provider, modelId)?.maxInputTokens ?? FALLBACK_MAX_INPUT_TOKENS
}

/** sha256 hex of a workspace path (no normalization, mirrors Kilo). */
export function workspaceHash(root: string): string {
  return createHash("sha256").update(root).digest("hex")
}

export function profileKey(profile: { provider: string; modelId: string; dimension: number }): string {
  return `${profile.provider}:${profile.modelId}:${profile.dimension}`
}
