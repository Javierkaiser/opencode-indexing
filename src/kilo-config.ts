import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { stripJsonComments } from "./jsonc.ts"
import type { ProviderCredentials } from "./types.ts"

/**
 * Kilo's effective indexing configuration, read the way Kilo reads its own
 * config files.
 *
 * The plugin never writes these files. It only needs to know where Kilo keeps
 * its index and which embedding profile built it: a project-level
 * `indexing.vectorStore` or `indexing.lancedb.directory` changes both the
 * import source and the collection a live search must read.
 */

export interface KiloConfigIndexing {
  enabled?: boolean
  provider?: string
  model?: string | null
  dimension?: number | null
  vectorStore?: string
  searchMinScore?: number
  searchMaxResults?: number
  embeddingBatchSize?: number
  fileExtensions?: string[]
  lancedb?: { directory?: string }
  qdrant?: { url?: string; apiKey?: string }
  mistral?: { apiKey?: string }
  openai?: { apiKey?: string }
  ollama?: { baseUrl?: string }
  "openai-compatible"?: { baseUrl?: string; apiKey?: string }
  gemini?: { apiKey?: string }
  voyage?: { apiKey?: string }
  openrouter?: { apiKey?: string }
}

export interface KiloConfigResult {
  indexing?: KiloConfigIndexing
  /** Files that contributed, lowest precedence first. Useful for diagnostics. */
  files: string[]
}

interface Candidate {
  file: string
  /** Value that wins when several candidates exist. Later wins. */
  order: number
}

const GLOBAL_FILES = ["config.json", "kilo.json", "kilo.jsonc", "opencode.json", "opencode.jsonc"]
const CONFIG_FILES = ["kilo.jsonc", "kilo.json", "opencode.jsonc", "opencode.json"]
const CONFIG_DIR_FILES = [...CONFIG_FILES, "config.json"]
const PROJECT_DIRS = [".kilo", ".kilocode", ".opencode"]

function configRoot(homeDir?: string): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg && xdg.trim() ? path.join(xdg.trim(), "kilo") : path.join(homeDir ?? os.homedir(), ".config", "kilo")
}

function homeDirPath(homeDir: string | undefined, dir: string): string {
  return path.join(homeDir ?? os.homedir(), dir)
}

function globalCandidates(homeDir?: string): Candidate[] {
  const candidates: Candidate[] = []
  let order = 0
  const root = configRoot(homeDir)
  for (const file of GLOBAL_FILES) candidates.push({ file: path.join(root, file), order: order++ })

  // Kilo's config editor also discovers these legacy home-level directories.
  for (const dir of PROJECT_DIRS) {
    for (const file of CONFIG_DIR_FILES) {
      candidates.push({ file: path.join(homeDirPath(homeDir, dir), file), order: order++ })
    }
  }

  const envFile = process.env.KILO_CONFIG
  if (envFile && envFile.trim()) candidates.push({ file: path.resolve(envFile.trim()), order: order++ })

  const envDir = process.env.KILO_CONFIG_DIR
  if (envDir && envDir.trim()) {
    for (const file of CONFIG_DIR_FILES) {
      candidates.push({ file: path.join(path.resolve(envDir.trim()), file), order: order++ })
    }
  }

  return candidates
}

/** Checkout roots from the workspace up to the nearest `.git`, nearest last. */
function projectRoots(root: string): string[] {
  const start = path.resolve(root)
  const roots: string[] = []
  let current = start
  for (;;) {
    roots.push(current)
    if (fs.existsSync(path.join(current, ".git"))) {
      // Farthest first: the workspace's own config has the last word.
      return roots.reverse()
    }
    const parent = path.dirname(current)
    // No checkout between here and the filesystem root: this is a plain
    // directory, and an unrelated parent config must not be inherited.
    if (parent === current) return [start]
    current = parent
  }
}

function projectCandidates(root: string): Candidate[] {
  if (process.env.KILO_DISABLE_PROJECT_CONFIG) return []
  const candidates: Candidate[] = []
  let order = 0
  const roots = projectRoots(root)

  // Kilo's `ConfigPaths.files` reads the workspace root and its ancestors up
  // to the worktree first; the `.kilo`/`.kilocode` directories are merged after
  // them, so their values win.
  for (const dir of roots) {
    for (const file of CONFIG_FILES) {
      candidates.push({ file: path.join(dir, file), order: order++ })
    }
  }
  for (const dir of roots) {
    for (const subdir of PROJECT_DIRS) {
      for (const file of CONFIG_DIR_FILES) {
        candidates.push({ file: path.join(dir, subdir, file), order: order++ })
      }
    }
  }
  return candidates
}

function readJsoncFile(file: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8")
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Merge plain objects recursively. Arrays and scalars replace the old value. */
function mergeDeep(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(source)) {
    const current = out[key]
    out[key] = isRecord(current) && isRecord(value) ? mergeDeep(current, value) : value
  }
  return out
}

function virtualContent(): Record<string, unknown> | undefined {
  const raw = process.env.KILO_CONFIG_CONTENT
  if (!raw || !raw.trim()) return undefined
  try {
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Effective `indexing` section for `root`, following Kilo's precedence:
 * global files, `KILO_CONFIG`, project files, `KILO_CONFIG_DIR`, then
 * `KILO_CONFIG_CONTENT`.
 *
 * `root` omitted means "global only", which is what the plugin's own settings
 * resolver uses. Passing a root adds project-level config for reading Kilo;
 * it never changes where the own index writes.
 */
export function readKiloConfig(root?: string, homeDir?: string): KiloConfigResult {
  const candidates = [...globalCandidates(homeDir)]
  if (root) candidates.push(...projectCandidates(path.resolve(root)))

  const files: string[] = []
  let merged: Record<string, unknown> = {}
  for (const candidate of candidates.sort((left, right) => left.order - right.order)) {
    if (!fs.existsSync(candidate.file)) continue
    const parsed = readJsoncFile(candidate.file)
    if (!parsed) continue
    if (isRecord(parsed.indexing)) merged = mergeDeep(merged, parsed.indexing)
    files.push(candidate.file)
  }

  const virtual = virtualContent()
  if (virtual && isRecord(virtual.indexing)) {
    merged = mergeDeep(merged, virtual.indexing)
    files.push("KILO_CONFIG_CONTENT")
  }

  return {
    indexing: Object.keys(merged).length > 0 ? (merged as KiloConfigIndexing) : undefined,
    files,
  }
}

/** Global-only variant used by the plugin's own settings defaults. */
export function readKiloIndexingConfig(homeDir?: string): KiloConfigIndexing | undefined {
  return readKiloConfig(undefined, homeDir).indexing
}

/**
 * Credentials Kilo would use, for embedding a query against a Kilo source.
 *
 * These are only consulted when the plugin's own settings do not already have a
 * key for that provider: the user's explicit plugin configuration stays first.
 */
export function kiloCredentials(config: KiloConfigIndexing | undefined): ProviderCredentials {
  if (!config) return {}
  const text = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
  }
  return {
    ...(text(config.mistral?.apiKey) ? { mistralApiKey: text(config.mistral?.apiKey) } : {}),
    ...(text(config.openai?.apiKey) ? { openAiApiKey: text(config.openai?.apiKey) } : {}),
    ...(text(config.ollama?.baseUrl) ? { ollamaBaseUrl: text(config.ollama?.baseUrl) } : {}),
    ...(text(config["openai-compatible"]?.baseUrl)
      ? { openAiCompatibleBaseUrl: text(config["openai-compatible"]?.baseUrl) }
      : {}),
    ...(text(config["openai-compatible"]?.apiKey)
      ? { openAiCompatibleApiKey: text(config["openai-compatible"]?.apiKey) }
      : {}),
    ...(text(config.gemini?.apiKey) ? { geminiApiKey: text(config.gemini?.apiKey) } : {}),
    ...(text(config.voyage?.apiKey) ? { voyageApiKey: text(config.voyage?.apiKey) } : {}),
    ...(text(config.openrouter?.apiKey) ? { openRouterApiKey: text(config.openrouter?.apiKey) } : {}),
  }
}

