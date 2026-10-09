/**
 * Data layer for the "indexed workspaces" view.
 *
 * Own collections are named `oc-` + sha256(root).slice(0,16), which cannot be
 * reversed, so the server also keeps a registry of the directories it indexed
 * (`~/.config/opencode/indexing-workspaces.json`). Without that registry the only
 * thing knowable about a collection is its hash and its size.
 *
 * Pure functions over the RPC client so they can be unit-tested without a
 * renderer.
 */

export interface WorkspaceRow {
  /** Collection name, e.g. `oc-1a06d5eeba99bff7`. */
  store: string
  /** Directory, or null when the registry has no entry for this collection. */
  root: string | null
  points: number | null
  /** Whether the registry/collection says the run finished. */
  complete: boolean | null
  profile: string | null
  updatedAt: string | null
  source: "registry" | "collection"
}

export interface WorkspacesView {
  rows: WorkspaceRow[]
  /** Rows whose directory is unknown; shown so they can still be forgotten. */
  unknownCount: number
}

/** The RPC slice this view needs. */
export interface WorkspacesRpc {
  "workspaces.list": (input: Record<string, never>) => Promise<{ workspaces: WorkspaceRow[] }>
  "workspace.forget": (input: { store: string }) => Promise<{ ok: boolean; summary: string; pointsDeleted: number | null }>
}

/** Formats the point count for a one-line row. */
export function formatPoints(points: number | null): string {
  if (points === null || points === undefined) return "unknown size"
  if (!Number.isFinite(points) || points < 0) return "unknown size"
  if (points < 1000) return `${Math.floor(points)} pts`
  if (points < 1_000_000) return `${(points / 1000).toFixed(1)}k pts`
  return `${(points / 1_000_000).toFixed(1)}M pts`
}

/** Formats the registry timestamp, keeping unknown dates explicit. */
export function formatUpdatedAt(updatedAt: string | null): string {
  if (!updatedAt) return "last run unknown"
  const parsed = new Date(updatedAt)
  if (Number.isNaN(parsed.getTime())) return "last run unknown"
  return `last run ${parsed.toISOString().slice(0, 10)}`
}

/** `D:\Proyectos\servicio-comprobantes — 8.6k pts · last run 2026-10-09`. */
export function describeRow(row: WorkspaceRow): string {
  const name = row.root ?? `unknown workspace (${row.store})`
  const parts = [formatPoints(row.points), formatUpdatedAt(row.updatedAt)]
  if (row.complete === false) parts.push("incomplete")
  return `${name} — ${parts.join(" · ")}`
}

/** Loads what the section renders, degrading to an empty list on failure. */
export async function loadWorkspaces(rpc: WorkspacesRpc): Promise<WorkspacesView> {
  try {
    const response = await rpc["workspaces.list"]({})
    const rows = response.workspaces ?? []
    return { rows, unknownCount: rows.filter((row) => row.root === null).length }
  } catch {
    return { rows: [], unknownCount: 0 }
  }
}

/**
 * Asks the user which workspace to forget and deletes it.
 *
 * Confirms before deleting: this drops the collection and its registry entry,
 * and re-indexing later costs embedding credits again.
 */
export async function forgetWorkspaceFlow(rpc: WorkspacesRpc, pick: (workspaces: WorkspaceRow[]) => Promise<WorkspaceRow | undefined>, confirm: (row: WorkspaceRow) => Promise<boolean>): Promise<string> {
  const view = await loadWorkspaces(rpc)
  if (view.rows.length === 0) return "No indexed workspaces to forget."
  const row = await pick(view.rows)
  if (!row) return "Cancelled."
  const confirmed = await confirm(row)
  if (!confirmed) return "Cancelled."
  const result = await rpc["workspace.forget"]({ store: row.store })
  return result.summary
}
