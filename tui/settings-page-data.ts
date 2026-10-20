/**
 * Data layer for the TUI settings page (option B).
 *
 * Pure functions over the RPC client, separated from the renderer so they can
 * be unit-tested without one. The page (`tui/settings-page.ts`) consumes these.
 */

import type { SettingsPageStore } from "./page-store.ts"
import { loadWorkspaces, type WorkspaceRow, type WorkspacesView } from "./workspaces.ts"
import type { ThemeLike } from "./page-style.ts"
import { describeError } from "../src/errors.ts"

export interface SettingsView {
  vectorStore: "qdrant" | "lancedb"
  qdrantUrl: string
  qdrantApiKey: string
  lancedbDirectory: string
  provider: string
  model: string
  dimension: number
  importFromKilo: boolean
  autoRefresh: boolean
  /** Master switch for writing the own index. */
  enabled: boolean
  searchMaxResults: number
  /** Providers that have a usable credential or base URL configured. */
  configuredProviders: string[]
  settingsFile: string
}

export interface KiloSourceView {
  kind: string
  name: string
  pointsCount: number | null
  complete: boolean | null
  profile: string | null
  compatible: boolean
}

export interface StatusView {
  summary: string
  recommendation: string
}

/**
 * The RPC slice this page needs.
 *
 * Every workspace-scoped method takes an optional `directory`. Callers normally
 * never pass one: `bindWorkspace` injects it into the client the TUI hands this
 * page, so the call sites below cannot forget it. The field stays on the types
 * because the bound client is what actually sends it.
 */
export interface SettingsPageRpc {
  "settings.get": (input: Record<string, never>) => Promise<{ settings: SettingsView; version?: string }>
  "settings.set": (input: { patch: Record<string, unknown> }) => Promise<{ settings: SettingsView }>
  "settings.test": (input: { target: "qdrant" | "lancedb" | "provider" | "kilo"; directory?: string }) => Promise<{ ok: boolean; message: string }>
  "kilo.discover": (input?: { directory?: string }) => Promise<{ sources: KiloSourceView[]; problems?: string[] }>
  "status.get": (input: { checkFreshness?: boolean; directory?: string }) => Promise<StatusView>
  "index.build": (input: { rebuild?: boolean; skipImport?: boolean; directory?: string }) => Promise<{ summary: string; error?: string }>
  "index.refresh": (input: { maxFiles?: number; directory?: string }) => Promise<{ summary: string; error?: string }>
  "index.import": (input: { source?: string; rebuild?: boolean; directory?: string }) => Promise<{ summary: string; error?: string }>
  "workspaces.list": (input: Record<string, never>) => Promise<{ workspaces: WorkspaceRow[] }>
  "workspace.forget": (input: { store: string }) => Promise<{ ok: boolean; reason?: "refused" | "failed"; summary: string; pointsDeleted: number | null }>
}

/**
 * Props the page receives from the host plugin.
 *
 * Declared here rather than in the page module so the mount logic
 * (`tui/page-mount.ts`) can be unit-tested in Node without a renderer.
 */
export interface SettingsPageProps {
  /** Resolves the RPC subclient lazily (the server plugin may still be starting). */
  rpc: () => SettingsPageRpc
  /** Host toast helper. */
  toast: (message: string, variant?: "success" | "error" | "info") => void
  /** Selection state driven by the host keymap. */
  store: SettingsPageStore
  /** Opens the dialog-based editor; the page itself is read-only for settings. */
  onEdit: () => void
  /** Host theme tokens; absent on hosts without theme support. */
  theme?: ThemeLike | null
}

export interface SettingsPageData {
  settings: SettingsView
  /**
   * Version of the server plugin answering the RPC.
   *
   * "unknown" when the response did not carry one (older server, or a manifest
   * it could not read), so the page never renders an empty value.
   */
  version: string
  sources: KiloSourceView[]
  /**
   * Sources that exist but could not be read.
   *
   * Kept apart from `sources` on purpose: an empty list with problems is a
   * different answer from an empty list without them, and the page has to be
   * able to tell the user which one they are looking at.
   */
  problems: string[]
  status: StatusView
  /** Indexed workspaces, so the page can show what exists on disk. */
  workspaces: WorkspacesView
}

export interface ConfigRow {
  label: string
  value: string
}

/** Shown when `settings.get` fails: the page renders instead of hanging. */
export const UNKNOWN_SETTINGS: SettingsView = {
  vectorStore: "qdrant",
  qdrantUrl: "(unavailable)",
  qdrantApiKey: "",
  lancedbDirectory: "(unavailable)",
  provider: "(unavailable)",
  model: "",
  dimension: 0,
  importFromKilo: false,
  enabled: false,
  autoRefresh: false,
  searchMaxResults: 0,
  configuredProviders: [],
  settingsFile: "(unavailable)",
}

/**
 * Budget for each RPC behind the page before it is treated as failed.
 *
 * The calls are local (host RPC to a plugin in the same process), so ten
 * seconds is far past any healthy answer: reaching it means the call is hung,
 * not slow.
 */
export const LOAD_TIMEOUT_MS = 10_000

export interface LoadSettingsPageDataOptions {
  /**
   * Per-call budget, injectable so tests can exercise the timeout in
   * milliseconds instead of ten seconds.
   */
  timeoutMs?: number
}

/**
 * Rejects when `promise` has not settled within `ms`.
 *
 * A hung RPC is worse than a failed one: `settings.get` gates the whole render,
 * so a call that never answers leaves the page on "Loading…" with no error and
 * no way to retry. Timing out turns that into the same degradation as a
 * rejection.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** The server's version, or "unknown" when the response did not carry one. */
function knownVersion(version: string | undefined): string {
  return typeof version === "string" && version.trim() !== "" ? version : "unknown"
}

/**
 * Load everything the page renders in one go (settings, sources, status).
 *
 * Every call degrades instead of rejecting: `settings.get` is what gates the
 * whole render, so letting it throw would leave the page on "Loading…" forever
 * with no explanation — which is exactly what happens if the server plugin is
 * not ready yet, the case the lazy RPC resolver exists for. Each call also gets
 * a timeout, so an RPC that never answers degrades the same way instead of
 * hanging the page.
 */
export async function loadSettingsPageData(rpc: SettingsPageRpc, options: LoadSettingsPageDataOptions = {}): Promise<SettingsPageData> {
  const timeoutMs = options.timeoutMs ?? LOAD_TIMEOUT_MS
  const [settingsResponse, sourcesResponse, status, workspaces] = await Promise.all([
    withTimeout(rpc["settings.get"]({}), timeoutMs).catch(() => ({ settings: UNKNOWN_SETTINGS, version: "unknown" })),
    withTimeout(rpc["kilo.discover"]({}), timeoutMs).catch(() => ({ sources: [] as KiloSourceView[], problems: [] as string[] })),
    withTimeout(rpc["status.get"]({ checkFreshness: false }), timeoutMs).catch(() => ({ summary: "(status unavailable)", recommendation: "" })),
    // loadWorkspaces already degrades to an empty view; the timeout covers a
    // `workspaces.list` that never answers.
    withTimeout(loadWorkspaces(rpc), timeoutMs).catch(() => ({ rows: [], unknownCount: 0 })),
  ])
  return {
    settings: settingsResponse.settings,
    version: knownVersion(settingsResponse.version),
    sources: sourcesResponse.sources,
    problems: sourcesResponse.problems ?? [],
    status,
    workspaces,
  }
}

/** Build the configuration rows shown in the page. */
export function configRows(settings: SettingsView, version = "unknown"): ConfigRow[] {
  const rows: ConfigRow[] = [
    {
      label: "Vector store",
      value: settings.vectorStore === "qdrant" ? `Qdrant · ${settings.qdrantUrl}` : `LanceDB · ${settings.lancedbDirectory}`,
    },
    {
      label: "Embeddings",
      value: `${settings.provider}/${settings.model}${settings.dimension ? ` (${settings.dimension}d)` : ""}`,
    },
    {
      label: "Import from Kilo",
      value: settings.importFromKilo ? "ON · imports without embedding cost" : "OFF · always index from scratch",
    },
    { label: "Auto-refresh", value: settings.autoRefresh ? "ON" : "OFF" },
    { label: "Max results", value: String(settings.searchMaxResults) },
    { label: "Settings file", value: settings.settingsFile },
    // Right after the settings file: the two rows answer "where does this come
    // from?", which is the pair a bug report needs.
    { label: "Plugin version", value: version },
  ]
  // Derived from the server's list rather than a pair of booleans, so a
  // provider added anywhere else shows up here without a change to this file.
  const keys = settings.configuredProviders
  rows.push({ label: "Credentials", value: keys.length > 0 ? `${keys.join(", ")} configured` : "none configured" })
  return rows
}

/** One-line description of a Kilo source for selection lists. */
export function describeSource(source: KiloSourceView): string {
  const points = source.pointsCount ?? "?"
  const state = source.complete === true ? "complete" : source.complete === false ? "incomplete" : "unknown"
  const profile = source.profile ?? "unknown profile"
  return `${points} pts · ${state} · ${profile}${source.compatible ? "" : " · INCOMPATIBLE"}`
}

export interface PageAction {
  id: string
  title: string
  description: string
  /** Arg accepted by the action, when it needs one. */
  kind: "none" | "source"
  /** Run the action through the RPC; returns a human-readable result line. */
  run(rpc: SettingsPageRpc, arg?: string): Promise<string>
}

export const PAGE_ACTIONS: readonly PageAction[] = [
  {
    id: "status",
    title: "Status (with freshness)",
    description: "Scan the workspace and summarize both indexes",
    kind: "none",
    run: async (rpc) => {
      const status = await rpc["status.get"]({ checkFreshness: true })
      return status.recommendation ? `${status.summary} — ${status.recommendation}` : status.summary
    },
  },
  {
    id: "test",
    title: "Test connections",
    description: "Qdrant, LanceDB and the embedding provider",
    kind: "none",
    run: async (rpc) => {
      const results: string[] = []
      for (const target of ["qdrant", "lancedb", "provider"] as const) {
        try {
          const result = await rpc["settings.test"]({ target })
          results.push(`${target}: ${result.ok ? "OK" : "FAIL"} (${result.message})`)
        } catch (error) {
          results.push(`${target}: FAIL (${describeError(error)})`)
        }
      }
      return results.join(" · ")
    },
  },
  {
    id: "build",
    title: "Build (import from Kilo when possible)",
    description: "Imports a compatible Kilo index, then indexes the delta",
    kind: "none",
    run: async (rpc) => summaryOf(await rpc["index.build"]({})),
  },
  {
    id: "build-scratch",
    title: "Build from scratch (skip import)",
    description: "Embeds every file with the configured model",
    kind: "none",
    run: async (rpc) => summaryOf(await rpc["index.build"]({ skipImport: true })),
  },
  {
    id: "refresh",
    title: "Refresh (incremental)",
    description: "Only new/changed/deleted files since the last run",
    kind: "none",
    run: async (rpc) => summaryOf(await rpc["index.refresh"]({})),
  },
  {
    id: "import",
    title: "Import Kilo index…",
    description: "Copy vectors from a Kilo source without re-embedding",
    kind: "source",
    run: async (rpc, source) => summaryOf(await rpc["index.import"](source ? { source } : {})),
  },
]

export function actionById(id: string): PageAction | undefined {
  return PAGE_ACTIONS.find((action) => action.id === id)
}

/**
 * Flattens an index run's result into the single line the page shows.
 *
 * A failed run arrives as data rather than a rejection, so the reason has to be
 * read from here or it never reaches the screen.
 */
function summaryOf(result: { summary: string; error?: string }): string {
  return result.error ? `${result.summary}: ${result.error}` : result.summary
}

/** Row index of the dialog editor, right after the actions. */
export const EDIT_ROW = PAGE_ACTIONS.length
/** Row index of the manual reload, the last navigable row. */
export const RELOAD_ROW = PAGE_ACTIONS.length + 1

/** One navigable row of the action list. */
export interface PageRow {
  row: number
  title: string
  description: string
}

/**
 * Text of one action row.
 *
 * The description is appended to the title for the selected row only. It is part
 * of the same string on purpose: mounting it as a second element made the host
 * draw it over the title, mangling both.
 */
export function actionRowText(row: PageRow, selected: boolean): string {
  return selected ? `${row.title} — ${row.description}` : row.title
}

/**
 * Every navigable row, in display order: the actions, then the dialog editor and
 * the manual reload. Lives here rather than in the JSX so the row model is
 * unit-testable and cannot drift from `PAGE_ACTIONS`.
 */
export const PAGE_ROWS: readonly PageRow[] = [
  ...PAGE_ACTIONS.map((action, position) => ({
    row: position,
    title: action.title,
    description: action.description,
  })),
  { row: EDIT_ROW, title: "Edit settings…", description: "Opens the dialog editor" },
  { row: RELOAD_ROW, title: "Reload status", description: "Re-reads settings, sources and status" },
]
