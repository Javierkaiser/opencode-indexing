/**
 * Data layer for the TUI settings page (option B).
 *
 * Pure functions over the RPC client, separated from the JSX so they can be
 * unit-tested without a renderer. The JSX page (`tui/settings-page.tsx`)
 * consumes these.
 */

import type { SettingsPageStore } from "./page-store.ts"
import { loadWorkspaces, type WorkspaceRow, type WorkspacesView } from "./workspaces.ts"
import type { ThemeLike } from "./page-style.ts"

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
  hasMistralKey: boolean
  hasOpenAiKey: boolean
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

export interface SettingsPageRpc {
  "settings.get": (input: Record<string, never>) => Promise<{ settings: SettingsView }>
  "settings.set": (input: { patch: Record<string, unknown> }) => Promise<{ settings: SettingsView }>
  "settings.test": (input: { target: "qdrant" | "lancedb" | "provider" | "kilo" }) => Promise<{ ok: boolean; message: string }>
  "kilo.discover": () => Promise<{ sources: KiloSourceView[] }>
  "status.get": (input: { checkFreshness?: boolean }) => Promise<StatusView>
  "index.build": (input: { rebuild?: boolean; skipImport?: boolean }) => Promise<{ summary: string }>
  "index.refresh": (input: { maxFiles?: number }) => Promise<{ summary: string }>
  "index.import": (input: { source?: string; rebuild?: boolean }) => Promise<{ summary: string }>
  "workspaces.list": (input: Record<string, never>) => Promise<{ workspaces: WorkspaceRow[] }>
  "workspace.forget": (input: { store: string }) => Promise<{ ok: boolean; summary: string; pointsDeleted: number | null }>
}

/**
 * Props the JSX page receives from the host plugin.
 *
 * Declared here rather than in the `.tsx` so the mount logic (`tui/page-mount.ts`)
 * can be unit-tested in Node, which cannot execute JSX.
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
  sources: KiloSourceView[]
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
  hasMistralKey: false,
  hasOpenAiKey: false,
  settingsFile: "(unavailable)",
}

/**
 * Load everything the page renders in one go (settings, sources, status).
 *
 * Every call degrades instead of rejecting: `settings.get` is what gates the
 * whole render, so letting it throw would leave the page on "Loading…" forever
 * with no explanation — which is exactly what happens if the server plugin is
 * not ready yet, the case the lazy RPC resolver exists for.
 */
export async function loadSettingsPageData(rpc: SettingsPageRpc): Promise<SettingsPageData> {
  const [settingsResponse, sourcesResponse, status, workspaces] = await Promise.all([
    rpc["settings.get"]({}).catch(() => ({ settings: UNKNOWN_SETTINGS })),
    rpc["kilo.discover"]().catch(() => ({ sources: [] as KiloSourceView[] })),
    rpc["status.get"]({ checkFreshness: false }).catch(() => ({ summary: "(status unavailable)", recommendation: "" })),
    // loadWorkspaces already degrades to an empty view, so it cannot reject.
    loadWorkspaces(rpc),
  ])
  return {
    settings: settingsResponse.settings,
    sources: sourcesResponse.sources,
    status,
    workspaces,
  }
}

/** Build the configuration rows shown in the page. */
export function configRows(settings: SettingsView): ConfigRow[] {
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
  ]
  const keys: string[] = []
  if (settings.hasMistralKey) keys.push("mistral")
  if (settings.hasOpenAiKey) keys.push("openai")
  rows.push({ label: "API keys", value: keys.length > 0 ? `${keys.join(", ")} configured` : "none configured" })
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
          results.push(`${target}: FAIL (${error instanceof Error ? error.message : String(error)})`)
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
    run: async (rpc) => (await rpc["index.build"]({})).summary,
  },
  {
    id: "build-scratch",
    title: "Build from scratch (skip import)",
    description: "Embeds every file with the configured model",
    kind: "none",
    run: async (rpc) => (await rpc["index.build"]({ skipImport: true })).summary,
  },
  {
    id: "refresh",
    title: "Refresh (incremental)",
    description: "Only new/changed/deleted files since the last run",
    kind: "none",
    run: async (rpc) => (await rpc["index.refresh"]({})).summary,
  },
  {
    id: "import",
    title: "Import Kilo index…",
    description: "Copy vectors from a Kilo source without re-embedding",
    kind: "source",
    run: async (rpc, source) => (await rpc["index.import"](source ? { source } : {})).summary,
  },
]

export function actionById(id: string): PageAction | undefined {
  return PAGE_ACTIONS.find((action) => action.id === id)
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
