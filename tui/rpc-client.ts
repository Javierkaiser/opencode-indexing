/**
 * Shared RPC client type for the TUI plugin.
 *
 * Kept in its own module so the footer, the settings page and the workspace list
 * can all reference the same contract without editing each other's code.
 */

import type { SettingsPageRpc } from "./settings-page-data.ts"

export type RpcClient = SettingsPageRpc & {
  "workspaces.list": (input: Record<string, never>) => Promise<WorkspacesListResult>
  "workspace.forget": (input: { store: string }) => Promise<{ ok: boolean; reason?: "refused" | "failed"; summary: string; pointsDeleted: number | null }>
}

/** One indexed workspace as reported by the server. */
export interface WorkspaceEntry {
  /** Collection name, e.g. `oc-1a06d5eeba99bff7`. */
  store: string
  /** Directory it belongs to, or null when unknown. */
  root: string | null
  points: number | null
  complete: boolean | null
  profile: string | null
  /** ISO timestamp of the last recorded run, when known. */
  updatedAt: string | null
  /** Where the row came from: the registry written by the indexer, or just the collection. */
  source: "registry" | "collection"
}

export interface WorkspacesListResult {
  workspaces: WorkspaceEntry[]
}
