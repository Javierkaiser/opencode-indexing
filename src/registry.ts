import { createHash } from "node:crypto"

/**
 * Embedding model catalog, mirrored from Kilo Code / Roo Code
 * (`packages/kilo-indexing/src/indexing/model-registry.ts`) so that query
 * embeddings are compatible with existing Kilo indexes.
 */

import type { EmbedderProvider, ModelProfile } from "./types.ts"

const profiles: Partial<Record<EmbedderProvider, Record<string, ModelProfile>>> = {
  openai: {
    "text-embedding-3-small": { dimension: 1536, scoreThreshold: 0.4 },
    "text-embedding-3-large": { dimension: 3072, scoreThreshold: 0.4 },
    "text-embedding-ada-002": { dimension: 1536, scoreThreshold: 0.4 },
  },
  ollama: {
    "nomic-embed-text": { dimension: 768, scoreThreshold: 0.3, queryPrefix: "search_query: " },
    "nomic-embed-text:latest": { dimension: 768, scoreThreshold: 0.3, queryPrefix: "search_query: " },
    "mxbai-embed-large": { dimension: 1024, scoreThreshold: 0.3 },
    "all-minilm": { dimension: 384, scoreThreshold: 0.3 },
  },
  gemini: {
    "gemini-embedding-001": { dimension: 3072, scoreThreshold: 0.35 },
    "text-embedding-004": { dimension: 768, scoreThreshold: 0.35 },
    "embedding-001": { dimension: 768, scoreThreshold: 0.35 },
  },
  mistral: {
    "codestral-embed-2505": { dimension: 1536, scoreThreshold: 0.35 },
    "codestral-embed": { dimension: 1536, scoreThreshold: 0.35 },
    "mistral-embed": { dimension: 1024, scoreThreshold: 0.35 },
  },
  voyage: {
    "voyage-code-3": { dimension: 1024, scoreThreshold: 0.35 },
    "voyage-3": { dimension: 1024, scoreThreshold: 0.35 },
    "voyage-3-lite": { dimension: 512, scoreThreshold: 0.35 },
  },
  openrouter: {
    "openai/text-embedding-3-small": { dimension: 1536, scoreThreshold: 0.4 },
    "openai/text-embedding-3-large": { dimension: 3072, scoreThreshold: 0.4 },
    "google/gemini-embedding-001": { dimension: 3072, scoreThreshold: 0.35 },
  },
  "openai-compatible": {},
}

const defaults: Record<string, string> = {
  openai: "text-embedding-3-small",
  ollama: "nomic-embed-text",
  gemini: "gemini-embedding-001",
  mistral: "codestral-embed-2505",
  voyage: "voyage-code-3",
  openrouter: "openai/text-embedding-3-small",
  "openai-compatible": "",
}

export const DEFAULT_SEARCH_MIN_SCORE = 0.4
export const DEFAULT_MAX_SEARCH_RESULTS = 50
export const DEFAULT_EMBEDDING_BATCH_SIZE = 60
export const DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024
export const MAX_SEARCH_RESULTS = 200

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

/** sha256 hex of a workspace path (no normalization, mirrors Kilo). */
export function workspaceHash(root: string): string {
  return createHash("sha256").update(root).digest("hex")
}

export function profileKey(profile: { provider: string; modelId: string; dimension: number }): string {
  return `${profile.provider}:${profile.modelId}:${profile.dimension}`
}
