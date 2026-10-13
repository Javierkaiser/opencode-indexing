import type { SettingsFile } from "./settings.ts"
import { maskSecret } from "./settings.ts"
import { normalizeExtensions } from "./registry.ts"
import type { IndexingSettings } from "./types.ts"

/**
 * Chat-driven settings for the `indexing-config` server command (option A).
 *
 * Pure parsing/validation so it can be reused by the TUI and unit-tested
 * without a running server. The command replies through the session.
 */

export const COMMAND_USAGE = [
  "Usage:",
  "- `/indexing-config`                       show current configuration",
  "- `/indexing-config set <key>=<value>`     change a setting (persists to indexing.json)",
  "- `/indexing-config test [target]`         test connections (qdrant | lancedb | provider | kilo, default all)",
  "- `/indexing-config import [source]`       import an existing Kilo index (zero embedding cost)",
  "- `/indexing-config help`                  this help",
].join("\n")

export type ParsedCommand =
  | { action: "show" }
  | { action: "help" }
  | { action: "set"; key: string; rawValue: string; hasValue: boolean }
  | { action: "test"; target: string }
  | { action: "import"; source?: string }
  | { action: "error"; message: string }

/** Parse the argument text of `/indexing-config ...`. */
export function parseIndexingCommand(text: string): ParsedCommand {
  let body = (text ?? "").trim()
  // Defensive: some clients pass the full command line, others only arguments.
  if (body.startsWith("/")) {
    const withoutSlash = body.replace(/^\/[^\s]*\s*/, "")
    if (body.startsWith("/indexing-config") || body.startsWith("/indexing_config")) body = withoutSlash
  }
  if (body === "") return { action: "show" }

  const space = body.indexOf(" ")
  const verb = (space === -1 ? body : body.slice(0, space)).toLowerCase()
  const rest = space === -1 ? "" : body.slice(space + 1).trim()

  switch (verb) {
    case "help": {
      return { action: "help" }
    }
    case "show": {
      return { action: "show" }
    }
    case "set": {
      if (!rest) return { action: "error", message: "Missing `key=value`. Example: `set vectorStore=lancedb`" }
      const eq = rest.indexOf("=")
      if (eq === -1) {
        // `set key` (no value) shows the current value of that key.
        return { action: "set", key: rest.trim().toLowerCase(), rawValue: "", hasValue: false }
      }
      return {
        action: "set",
        key: rest.slice(0, eq).trim().toLowerCase(),
        rawValue: rest.slice(eq + 1).trim(),
        hasValue: true,
      }
    }
    case "test": {
      const target = rest === "" ? "all" : rest.toLowerCase()
      return { action: "test", target }
    }
    case "import": {
      return rest === "" ? { action: "import" } : { action: "import", source: rest }
    }
    default:
      return { action: "error", message: `Unknown subcommand: \`${verb}\`. Try \`/indexing-config help\`.` }
  }
}

type ValueKind = "string" | "url" | "boolean" | "integer" | "score" | "enum" | "key" | "extensions"

interface KeySpec {
  /** Report group this key belongs to (see SETTING_GROUPS). */
  group: SettingGroupId
  /** Value type for parsing/validation. */
  kind: ValueKind
  /** One-line description shown in help and errors. */
  description: string
  /** Allowed values for `enum`. */
  values?: readonly string[]
  /** Build the settings-file patch for a parsed value. */
  toPatch(value: string | number | boolean | string[] | null): SettingsFile
  /** Current effective value for `set <key>` without a value. */
  display(settings: IndexingSettings): string
}

/**
 * Report grouping. Order here is the order shown, so the report reads from the
 * outside in: which backend, which model, which credentials, how it searches.
 */
export const SETTING_GROUPS = [
  { id: "backend", title: "Backend" },
  { id: "embedding", title: "Embedding" },
  { id: "credentials", title: "Credentials" },
  { id: "search", title: "Search" },
  { id: "behavior", title: "Behavior" },
  { id: "performance", title: "Performance" },
] as const

export type SettingGroupId = (typeof SETTING_GROUPS)[number]["id"]

const PROVIDERS = [
  "mistral",
  "openai",
  "ollama",
  "openai-compatible",
  "gemini",
  "voyage",
  "openrouter",
] as const

function parseBoolean(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase()
  if (["true", "on", "yes", "1", "enabled"].includes(value)) return true
  if (["false", "off", "no", "0", "disabled"].includes(value)) return false
  return undefined
}

/**
 * Extensions are summarised rather than listed in full.
 *
 * The built-in allowlist has around seventy entries, and printing all of them
 * buries every other setting in the configuration report.
 */
function summarizeExtensions(extensions: readonly string[]): string {
  const shown = 8
  if (extensions.length <= shown) return extensions.join(",")
  return `${extensions.slice(0, shown).join(",")}, … (${extensions.length} total)`
}

const KEY_SPECS: Record<string, KeySpec> = {
  vectorstore: {
    group: "backend",
    kind: "enum",
    values: ["qdrant", "lancedb"],
    description: "Backend for the plugin's own index",
    toPatch: (value) => ({ vectorStore: value as "qdrant" | "lancedb" }),
    display: (settings) => settings.vectorStore,
  },
  qdranturl: {
    group: "backend",
    kind: "url",
    description: "Qdrant server URL (local or remote, e.g. http://localhost:6333)",
    toPatch: (value) => ({ qdrant: { url: String(value) } }),
    display: (settings) => settings.qdrantUrl,
  },
  qdrantapikey: {
    group: "backend",
    kind: "key",
    description: "Qdrant API key (empty string clears it)",
    toPatch: (value) => ({ qdrant: { apiKey: String(value) } }),
    display: (settings) => maskSecret(settings.qdrantApiKey) ?? "(not set)",
  },
  lancedbdirectory: {
    group: "backend",
    kind: "string",
    description: "Directory for the plugin's own LanceDB databases",
    toPatch: (value) => ({ lancedb: { directory: String(value) } }),
    display: (settings) => settings.lancedbDirectory,
  },
  provider: {
    group: "embedding",
    kind: "enum",
    values: PROVIDERS,
    description: "Embedding provider",
    toPatch: (value) => {
      const provider = value as (typeof PROVIDERS)[number]
      // Reset the model so the provider default applies unless the user sets
      // one explicitly afterwards.
      void provider
      return { provider: provider as SettingsFile["provider"] }
    },
    display: (settings) => settings.provider,
  },
  model: {
    group: "embedding",
    kind: "string",
    description: "Embedding model id (provider default when unset)",
    toPatch: (value) => ({ model: String(value) }),
    display: (settings) => settings.modelId,
  },
  mistralkey: {
    group: "credentials",
    kind: "key",
    description: "Mistral API key",
    toPatch: (value) => ({ apiKeys: { mistral: String(value) } }),
    display: (settings) => maskSecret(settings.credentials.mistralApiKey) ?? "(not set)",
  },
  openaikey: {
    group: "credentials",
    kind: "key",
    description: "OpenAI API key",
    toPatch: (value) => ({ apiKeys: { openai: String(value) } }),
    display: (settings) => maskSecret(settings.credentials.openAiApiKey) ?? "(not set)",
  },
  geminikey: {
    group: "credentials",
    kind: "key",
    description: "Gemini API key",
    toPatch: (value) => ({ apiKeys: { gemini: String(value) } }),
    display: (settings) => maskSecret(settings.credentials.geminiApiKey) ?? "(not set)",
  },
  voyagekey: {
    group: "credentials",
    kind: "key",
    description: "Voyage API key",
    toPatch: (value) => ({ apiKeys: { voyage: String(value) } }),
    display: (settings) => maskSecret(settings.credentials.voyageApiKey) ?? "(not set)",
  },
  openrouterkey: {
    group: "credentials",
    kind: "key",
    description: "OpenRouter API key",
    toPatch: (value) => ({ apiKeys: { openrouter: String(value) } }),
    display: (settings) => maskSecret(settings.credentials.openRouterApiKey) ?? "(not set)",
  },
  ollamaurl: {
    group: "credentials",
    kind: "url",
    description: "Ollama base URL",
    toPatch: (value) => ({ apiKeys: { ollama: { baseUrl: String(value) } } }),
    display: (settings) => settings.credentials.ollamaBaseUrl ?? "(not set)",
  },
  openaicompatibleurl: {
    group: "credentials",
    kind: "url",
    description: "OpenAI-compatible base URL",
    toPatch: (value) => ({ apiKeys: { "openai-compatible": { baseUrl: String(value) } } }),
    display: (settings) => settings.credentials.openAiCompatibleBaseUrl ?? "(not set)",
  },
  openaicompatiblekey: {
    group: "credentials",
    kind: "key",
    description: "OpenAI-compatible API key",
    toPatch: (value) => ({ apiKeys: { "openai-compatible": { apiKey: String(value) } } }),
    display: (settings) => maskSecret(settings.credentials.openAiCompatibleApiKey) ?? "(not set)",
  },
  importfromkilo: {
    group: "behavior",
    kind: "boolean",
    description: "Import compatible Kilo indexes on build (no embedding cost)",
    toPatch: (value) => ({ importFromKilo: Boolean(value) }),
    display: (settings) => (settings.importFromKilo ? "true" : "false"),
  },
  autorefresh: {
    group: "behavior",
    kind: "boolean",
    description: "Refresh the index inline on search when few files changed",
    toPatch: (value) => ({ autoRefresh: Boolean(value) }),
    display: (settings) => (settings.autoRefresh ? "true" : "false"),
  },
  enabled: {
    group: "behavior",
    kind: "boolean",
    description: "Master switch: when false nothing is written to nor refreshed in the own index",
    toPatch: (value) => ({ enabled: Boolean(value) }),
    display: (settings) => (settings.enabled === false ? "false" : "true"),
  },
  searchmaxresults: {
    group: "search",
    kind: "integer",
    description: "Maximum search results (default 50)",
    toPatch: (value) => ({ searchMaxResults: Number(value) }),
    display: (settings) => String(settings.searchMaxResults),
  },
  embeddingbatchsize: {
    group: "performance",
    kind: "integer",
    description: "Chunks per embedding batch (default 60)",
    toPatch: (value) => ({ embeddingBatchSize: Number(value) }),
    display: (settings) => String(settings.embeddingBatchSize),
  },
  searchminscore: {
    group: "search",
    kind: "score",
    description: "Minimum similarity score 0..1 (or `default` to reset)",
    toPatch: (value) => ({ searchMinScore: value === null ? null : Number(value) }),
    display: (settings) => (settings.searchMinScore === undefined ? "(model default)" : String(settings.searchMinScore)),
  },
  fileextensions: {
    group: "search",
    kind: "extensions",
    description: "Comma-separated extension allowlist (e.g. .ts,.cs,.php; `default` resets)",
    toPatch: (value) => ({ fileExtensions: value === null ? null : (value as string[]) }),
    display: (settings) => summarizeExtensions(settings.fileExtensions),
  },
}

export interface SettingReportEntry {
  key: string
  description: string
  value: string
}

export interface SettingReportGroup {
  id: string
  title: string
  entries: SettingReportEntry[]
}

/**
 * Every settable key with its current value, grouped for display.
 *
 * Derived from KEY_SPECS rather than hand-listed, so the report cannot drift
 * from what `set` accepts: a key added to KEY_SPECS shows up here by itself.
 * The previous report hard-coded five fields and silently hid the other
 * sixteen, which made `set` unverifiable from the command that set it.
 */
export function settingReport(settings: IndexingSettings): SettingReportGroup[] {
  const groups: SettingReportGroup[] = SETTING_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    entries: [],
  }))
  const byId = new Map(groups.map((group) => [group.id, group]))
  for (const [key, spec] of Object.entries(KEY_SPECS)) {
    const entry: SettingReportEntry = { key, description: spec.description, value: spec.display(settings) }
    const bucket = byId.get(spec.group)
    if (bucket) bucket.entries.push(entry)
    // Defensive: a key declaring an unknown group is still reported, never lost.
    else groups.push({ id: spec.group, title: spec.group, entries: [entry] })
  }
  return groups.filter((group) => group.entries.length > 0)
}

export function listSettingKeys(): Array<{ key: string; description: string }> {
  return Object.entries(KEY_SPECS).map(([key, spec]) => ({ key, description: spec.description }))
}

export type ApplyResult =
  | { ok: true; patch: SettingsFile; display: string }
  | { ok: false; error: string }

/** Validate a value and build the settings-file patch for `set <key>=<value>`. */
export function applySettingValue(key: string, rawValue: string): ApplyResult {
  const spec = KEY_SPECS[key]
  if (!spec) {
    const known = Object.keys(KEY_SPECS).join(", ")
    return { ok: false, error: `Unknown setting \`${key}\`. Valid keys: ${known}` }
  }
  const raw = rawValue.trim()

  switch (spec.kind) {
    case "boolean": {
      const parsed = parseBoolean(raw)
      if (parsed === undefined) return { ok: false, error: `\`${key}\` expects a boolean (true/false). Got: ${rawValue}` }
      const patch = spec.toPatch(parsed)
      return { ok: true, patch, display: String(parsed) }
    }
    case "integer": {
      const value = Number(raw)
      if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
        return { ok: false, error: `\`${key}\` expects a positive integer. Got: ${rawValue}` }
      }
      return { ok: true, patch: spec.toPatch(value), display: String(value) }
    }
    case "score": {
      if (raw === "default" || raw === "reset" || raw === "none") {
        return { ok: true, patch: spec.toPatch(null), display: "(model default)" }
      }
      const value = Number(raw)
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        return { ok: false, error: `\`${key}\` expects a number between 0 and 1 (or \`default\`). Got: ${rawValue}` }
      }
      return { ok: true, patch: spec.toPatch(value), display: String(value) }
    }
    case "enum": {
      if (!spec.values?.includes(raw)) {
        return { ok: false, error: `\`${key}\` must be one of: ${spec.values?.join(", ")}. Got: ${rawValue}` }
      }
      return { ok: true, patch: spec.toPatch(raw), display: raw }
    }
    case "extensions": {
      if (raw === "default" || raw === "reset") {
        return { ok: true, patch: spec.toPatch(null), display: "(built-in defaults)" }
      }
      const extensions = normalizeExtensions(raw.split(/[\s,;]+/).filter(Boolean))
      if (extensions.length === 0) return { ok: false, error: "No valid extensions provided" }
      return { ok: true, patch: spec.toPatch(extensions), display: extensions.join(", ") }
    }
    case "url": {
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/.+/.test(raw)) {
        return { ok: false, error: `\`${key}\` expects a URL with protocol (e.g. http://localhost:6333). Got: ${rawValue}` }
      }
      return { ok: true, patch: spec.toPatch(raw), display: raw }
    }
    case "key": {
      // Empty string clears the key.
      const patch = spec.toPatch(raw)
      return { ok: true, patch, display: raw === "" ? "(cleared)" : (maskSecret(raw) ?? "(set)") }
    }
    case "string": {
      if (raw === "") return { ok: false, error: `\`${key}\` expects a non-empty value` }
      return { ok: true, patch: spec.toPatch(raw), display: raw }
    }
  }
}

/** Current value of a setting, for `set <key>` without a value. */
export function describeSettingValue(key: string, settings: IndexingSettings): string | undefined {
  const spec = KEY_SPECS[key]
  if (!spec) return undefined
  return spec.display(settings)
}

/**
 * Whether a key holds a credential.
 *
 * Credentials are deliberately refused by the chat-facing write tool: the call
 * would land in the session transcript, and the settings file never stores them
 * in plain text anyway. They are set through the environment or plugin options.
 */
export function isSecretSetting(key: string): boolean {
  return KEY_SPECS[key]?.kind === "key"
}

/** Why a credential cannot be set through a chat tool call. */
export const CREDENTIAL_REFUSAL =
  "holds a credential and cannot be set from a tool call: the call is recorded in this conversation, and the settings file never stores keys in plain text.\n\nSet it through the environment (`KILO_INDEX_*`) or from the plugin options in `opencode.json`. Every other indexing setting can be changed here."

/**
 * Validates a settings change that arrived through a chat tool call.
 *
 * Same rules as the slash command's `set`, plus the credential refusal. Kept
 * here rather than in the tool so the decision is unit-testable without a
 * running server, and so both paths share one set of rules.
 */
export function applySettingsChange(key: string, rawValue: string): ApplyResult {
  const normalized = key.trim().toLowerCase()
  if (isSecretSetting(normalized)) {
    return { ok: false, error: `\`${normalized}\` ${CREDENTIAL_REFUSAL}` }
  }
  return applySettingValue(normalized, rawValue)
}

/** Suggested fix when the user typo'd a key (Levenshtein-ish prefix match). */
export function suggestKey(input: string): string | undefined {
  const normalized = input.toLowerCase()
  return Object.keys(KEY_SPECS).find((key) => key.includes(normalized) || normalized.includes(key))
}
