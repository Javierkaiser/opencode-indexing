import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { stripJsonComments } from "./jsonc.ts"
import { configDir } from "./settings.ts"
import type { VectorStoreKind } from "./vector-store.ts"

/**
 * Registry of indexed workspaces.
 *
 * A Qdrant collection is named `oc-<sha256(root)[0:16]>`, which is a one-way
 * hash: the store can be listed but never mapped back to the directory it
 * belongs to. This registry keeps that mapping (plus the embedding profile and
 * the last run) so the plugin can list indexed workspaces by their real path
 * and forget one of them on request.
 *
 * Location: `<configDir>/indexing-workspaces.json` (XDG aware), next to the
 * settings file. Owned by opencode-indexing; never read by anything else.
 *
 * The registry is derived data: every function tolerates a missing, unreadable
 * or corrupt file and writes are best-effort, so a broken registry can never
 * fail an index run.
 */

export interface WorkspaceRecord {
  /** Absolute workspace root the store belongs to. */
  root: string
  /** Qdrant collection (`oc-…`) or LanceDB database path. */
  store: string
  /** Backend that owns the store. */
  kind: VectorStoreKind
  /** `provider:modelId:dimension`, or null when unknown. */
  profile: string | null
  /** ISO timestamp of the last recorded run. */
  updatedAt: string
}

/** Registry file path; `""` when no config dir can be resolved. */
export function workspacesFilePath(homeDir?: string): string {
  const dir = registryDir(homeDir)
  return dir ? path.join(dir, "indexing-workspaces.json") : ""
}

/** Every known workspace. A missing or corrupt file reads as an empty registry. */
export function readWorkspaces(homeDir?: string): WorkspaceRecord[] {
  const file = workspacesFilePath(homeDir)
  if (!file) return []
  try {
    const raw = fs.readFileSync(file, "utf8")
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown
    if (!Array.isArray(parsed)) return []
    const out: WorkspaceRecord[] = []
    for (const entry of parsed) {
      const record = toRecord(entry)
      if (record) out.push(record)
    }
    return out
  } catch {
    return []
  }
}

/**
 * Insert or update the record for `record.store`.
 *
 * The store name is the key: re-indexing the same root updates the profile and
 * timestamp instead of adding a second entry. Failures are swallowed — the
 * registry describes indexes that already exist, so losing it is cosmetic.
 */
export function recordWorkspace(record: WorkspaceRecord, homeDir?: string): void {
  const file = workspacesFilePath(homeDir)
  if (!file) return
  const records = readWorkspaces(homeDir)
  const index = records.findIndex((entry) => entry.store === record.store)
  if (index === -1) records.push(record)
  else records[index] = record
  writeWorkspaces(file, records)
}

/** Drop the record for `store`. Returns whether one existed. */
export function forgetWorkspace(store: string, homeDir?: string): boolean {
  const file = workspacesFilePath(homeDir)
  if (!file) return false
  const records = readWorkspaces(homeDir)
  const kept = records.filter((entry) => entry.store !== store)
  if (kept.length === records.length) return false
  writeWorkspaces(file, kept)
  return true
}

/** Keep only the fields we understand; anything else is dropped. */
function toRecord(entry: unknown): WorkspaceRecord | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined
  const row = entry as Record<string, unknown>
  const root = typeof row.root === "string" ? row.root : ""
  const store = typeof row.store === "string" ? row.store : ""
  if (!root || !store) return undefined
  return {
    root,
    store,
    kind: row.kind === "lancedb" ? "lancedb" : "qdrant",
    profile: typeof row.profile === "string" ? row.profile : null,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
  }
}

/** Atomic write, mirroring `writeSettingsFile`. Unwritable dirs are ignored. */
function writeWorkspaces(file: string, records: WorkspaceRecord[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + "\n", "utf8")
    fs.renameSync(tmp, file)
  } catch {
    // Read-only or missing config dir: the stores still work, they are just no
    // longer nameable afterwards.
  }
}

/**
 * Config dir the registry lives in, or `undefined` when it cannot be resolved.
 *
 * Without a home directory there is nowhere sensible to write, and guessing
 * (a relative path) would litter whatever the cwd happens to be.
 */
function registryDir(homeDir?: string): string | undefined {
  try {
    const xdg = process.env.XDG_CONFIG_HOME?.trim()
    const home = homeDir?.trim() || (!xdg ? os.homedir()?.trim() : "")
    if (!xdg && !home) return undefined
  } catch {
    return undefined
  }
  return configDir(homeDir)
}
