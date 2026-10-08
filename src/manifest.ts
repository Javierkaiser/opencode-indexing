import type { FileEntry, KVStore, Manifest, ManifestFileRecord } from "./types.ts"
import { workspaceHash } from "./registry.ts"

export function manifestKey(root: string): string {
  return `manifest/${workspaceHash(root).slice(0, 16)}`
}

export async function loadManifest(kv: KVStore, root: string): Promise<Manifest | undefined> {
  const value = await kv.get(manifestKey(root))
  if (!value || typeof value !== "object") return undefined
  const manifest = value as Manifest
  if (manifest.version !== 1 || typeof manifest.files !== "object" || manifest.files === null) return undefined
  return manifest
}

export async function saveManifest(kv: KVStore, manifest: Manifest): Promise<void> {
  await kv.set(manifestKey(manifest.root), manifest)
}

export async function removeManifest(kv: KVStore, root: string): Promise<void> {
  await kv.remove(manifestKey(root))
}

export interface FileDiff {
  /** No record at all. */
  added: FileEntry[]
  /** Record exists but size/mtime changed: hash must be recomputed to confirm. */
  maybeStale: FileEntry[]
  /** Same size+mtime: no file read needed. */
  unchanged: FileEntry[]
  /** Recorded but missing on disk. */
  deleted: string[]
}

export function diffFiles(manifest: Manifest | undefined, files: FileEntry[]): FileDiff {
  const diff: FileDiff = { added: [], maybeStale: [], unchanged: [], deleted: [] }
  const seen = new Set<string>()
  if (!manifest) {
    diff.added = [...files]
    return diff
  }
  for (const file of files) {
    seen.add(file.relPath)
    const record = manifest.files[file.relPath]
    if (!record) {
      diff.added.push(file)
      continue
    }
    if (record.size === file.size && record.mtimeMs === file.mtimeMs) {
      diff.unchanged.push(file)
    } else {
      diff.maybeStale.push(file)
    }
  }
  for (const relPath of Object.keys(manifest.files)) {
    if (!seen.has(relPath)) diff.deleted.push(relPath)
  }
  return diff
}

export function setRecord(manifest: Manifest, relPath: string, record: ManifestFileRecord): void {
  manifest.files[relPath] = record
}

export function deleteRecords(manifest: Manifest, relPaths: readonly string[]): void {
  for (const relPath of relPaths) delete manifest.files[relPath]
}

export function emptyManifest(
  root: string,
  collection: string,
  profile: Manifest["profile"],
): Manifest {
  return { version: 1, root, collection, profile, files: {} }
}
