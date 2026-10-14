import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { stripJsonComments } from "./jsonc.ts"
import type { EmbedderProvider } from "./types.ts"

/**
 * User-facing settings file for the plugin.
 *
 * Location: `~/.config/opencode/indexing.json` (XDG aware).
 * This file is owned by opencode-indexing; `kilo.jsonc` is only ever read.
 */

export interface SettingsFile {
  vectorStore?: "qdrant" | "lancedb"
  qdrant?: {
    url?: string
    apiKey?: string
  }
  lancedb?: {
    directory?: string
  }
  provider?: EmbedderProvider
  model?: string
  dimension?: number | null
  apiKeys?: {
    mistral?: string
    openai?: string
    gemini?: string
    voyage?: string
    openrouter?: string
    ollama?: { baseUrl?: string }
    "openai-compatible"?: { baseUrl?: string; apiKey?: string }
  }
  /** Import vectors from Kilo Code's existing index instead of re-embedding. */
  importFromKilo?: boolean
  /** Refresh the index inline on search when few files changed. */
  autoRefresh?: boolean
  /** Master switch: when false the own index is neither written nor refreshed. */
  enabled?: boolean
  searchMinScore?: number | null
  searchMaxResults?: number
  embeddingBatchSize?: number
  maxFileSizeBytes?: number
  fileExtensions?: string[] | null
}

export function configDir(homeDir?: string): string {
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg && xdg.trim()) return path.join(xdg, "opencode")
  return path.join(homeDir ?? os.homedir(), ".config", "opencode")
}

export function settingsFilePath(homeDir?: string): string {
  return path.join(configDir(homeDir), "indexing.json")
}

/** Default directory for the plugin's own LanceDB stores. */
export function defaultLanceDbDirectory(homeDir?: string): string {
  const xdgState = process.env.XDG_STATE_HOME
  const base = xdgState && xdgState.trim() ? xdgState : path.join(homeDir ?? os.homedir(), ".local", "state")
  return path.join(base, "opencode-indexing", "lancedb")
}

/** Kilo's own LanceDB directory (read-only import source). */
export function kiloLanceDbDirectory(homeDir?: string): string {
  const override = process.env.KILO_INDEX_KILO_LANCEDB_DIR
  if (override && override.trim()) return override.trim()
  const xdgState = process.env.XDG_STATE_HOME
  const base = xdgState && xdgState.trim() ? xdgState : path.join(homeDir ?? os.homedir(), ".local", "state")
  return path.join(base, "kilo", "indexing", "lancedb")
}

export function readSettingsFile(homeDir?: string): SettingsFile | undefined {
  const file = settingsFilePath(homeDir)
  try {
    const raw = fs.readFileSync(file, "utf8")
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    return parsed as SettingsFile
  } catch {
    return undefined
  }
}

/** Remove keys whose value is undefined; keep the rest as-is. */
function compact<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value
  }
  return out as T
}

/**
 * Merge the two objects a level deep.
 *
 * Derived from the incoming keys rather than listing the provider names here.
 * The hand-written list this replaced silently dropped any credential added to
 * the shape but not to the list: the field existed, the resolver read it, and
 * the value never reached the file.
 */
function mergeNested<T extends Record<string, unknown>>(current: T | undefined, incoming: T): T {
  return compact({ ...(current ?? {}), ...incoming }) as T
}

function deepMerge(base: SettingsFile, patch: SettingsFile): SettingsFile {
  const out: SettingsFile = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (key === "qdrant" || key === "lancedb") {
      const current = (out as Record<string, unknown>)[key]
      ;(out as Record<string, unknown>)[key] = compact({
        ...(typeof current === "object" && current !== null ? current : {}),
        ...(value as Record<string, unknown>),
      })
      continue
    }
    if (key === "apiKeys") {
      const current = out.apiKeys ?? {}
      const incoming = value as NonNullable<SettingsFile["apiKeys"]>
      const merged: Record<string, unknown> = { ...current }
      for (const [provider, providerValue] of Object.entries(incoming)) {
        if (providerValue === undefined) continue
        // ollama and openai-compatible are objects; the rest are plain keys.
        // Both shapes merge the same way, so no per-provider branch is needed.
        merged[provider] =
          typeof providerValue === "object" && providerValue !== null
            ? mergeNested(
                typeof merged[provider] === "object" && merged[provider] !== null
                  ? (merged[provider] as Record<string, unknown>)
                  : undefined,
                providerValue as Record<string, unknown>,
              )
            : providerValue
      }
      out.apiKeys = compact(merged) as SettingsFile["apiKeys"]
      continue
    }
    ;(out as Record<string, unknown>)[key] = value
  }
  return out
}

/**
 * Merge `patch` into the settings file and persist atomically.
 * Returns the full updated settings.
 */
export function writeSettingsFile(patch: SettingsFile, homeDir?: string): SettingsFile {
  const file = settingsFilePath(homeDir)
  const current = readSettingsFile(homeDir) ?? {}
  const next = deepMerge(current, patch)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8")
  fs.renameSync(tmp, file)
  return next
}

/** Mask a secret for display: `sk-abc…xyz`. */
export function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (trimmed.length <= 8) return "••••"
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`
}
