import * as fs from "node:fs"
import * as path from "node:path"

import { workspaceHash } from "./registry.ts"
import { defaultLanceDbDirectory } from "./settings.ts"
import type { VectorStoreAdapter, VectorStoreInfo, StoreSearchOptions, ExportBatch } from "./vector-store.ts"
import type { EmbeddingProfile, QdrantPoint, QueryHit } from "./types.ts"

/**
 * LanceDB-backed adapter for the plugin's own index.
 *
 * The two-table layout mirrors Kilo Code's `lancedb-vector-store.ts` so both
 * stores stay import-compatible:
 *
 * - `vector`: one row per code chunk: id, vector, filePath, fileHash,
 *   codeChunk, startLine, endLine.
 * - `metadata`: key/value rows. Every value is stored as a string because
 *   LanceDB infers the `value` column type from the first inserted row.
 *
 * The native module is optional and only loaded on first use. Every native
 * call runs through a module-level promise queue because the bindings must not
 * be entered concurrently; the queue is never re-entered from inside a task.
 */

export interface LanceDbStoreOptions {
  /** Workspace root path (used for collection naming + relative paths). */
  root: string
  /** Base directory for the embedded databases. Defaults to defaultLanceDbDirectory(). */
  directory?: string
  /** Explicit database directory name override (for tests/imports). */
  dbName?: string
}

/** Raw table state of an arbitrary LanceDB directory (used by the import engine). */
export interface LanceDbRawTables {
  vectorExists: boolean
  metadataExists: boolean
  pointsCount: number
  profile?: EmbeddingProfile
  complete?: boolean
  schema?: number
}

const VECTOR_TABLE = "vector"
const METADATA_TABLE = "metadata"
const SCHEMA = "2"
const DEFAULT_MIN_SCORE = 0.4
const DEFAULT_MAX_RESULTS = 50
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXPORT_COLUMNS = ["id", "vector", "filePath", "fileHash", "codeChunk", "startLine", "endLine"] as const
const REQUIRED_PAYLOAD_FIELDS = ["filePath", "fileHash", "codeChunk", "startLine", "endLine"] as const

const METADATA_KEYS = {
  schema: "index_schema",
  size: "vector_size",
  provider: "embedding_provider",
  model: "embedding_model_id",
  dimension: "embedding_dimension",
  complete: "indexing_complete",
  updatedAt: "updated_at",
} as const

const METADATA_KEY_VALUES: readonly string[] = Object.values(METADATA_KEYS)

// ---------------------------------------------------------------------------
// Native module access
// ---------------------------------------------------------------------------

let lancedbPromise: Promise<any> | undefined
function loadLanceDb(): Promise<any> {
  lancedbPromise ??= import("@lancedb/lancedb").catch((error) => {
    lancedbPromise = undefined
    throw new Error(
      `LanceDB no está disponible (instala @lancedb/lancedb@0.26.2 o usa vectorStore=qdrant): ${error instanceof Error ? error.message : String(error)}`,
    )
  })
  return lancedbPromise
}

/** Serialize native calls: the LanceDB bindings are not reentrant. */
let nativeQueue: Promise<unknown> = Promise.resolve()
function native<T>(run: () => Promise<T>): Promise<T> {
  const task = nativeQueue.then(run)
  nativeQueue = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

function wrapNativeError(operation: string, dbPath: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`LanceDB ${operation} failed at ${dbPath}: ${message}`, { cause: error })
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Database directory name for a workspace: `<basename>-<sha256(root)[0:16]>` (mirrors Kilo). */
export function lanceDbName(root: string): string {
  return `${path.basename(root)}-${workspaceHash(root).slice(0, 16)}`
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

class LanceDbStoreAdapter implements VectorStoreAdapter {
  readonly kind = "lancedb" as const
  readonly name: string

  private readonly dbPath: string
  private readonly root: string
  private db: any = null
  private vectorTable: any = null
  private metadataTable: any = null

  constructor(options: LanceDbStoreOptions) {
    this.root = options.root
    this.name = path.join(
      options.directory ?? defaultLanceDbDirectory(),
      options.dbName ?? lanceDbName(options.root),
    )
    this.dbPath = this.name
  }

  async exists(): Promise<boolean> {
    try {
      const db = await this.getDbIfExists()
      if (!db) return false
      const names = await this.runNative("list tables", () => db.tableNames() as Promise<string[]>)
      return names.includes(VECTOR_TABLE)
    } catch {
      return false
    }
  }

  async info(): Promise<VectorStoreInfo> {
    const db = await this.getDbIfExists()
    if (!db) {
      return { kind: "lancedb", name: this.dbPath, exists: false, pointsCount: null }
    }
    return this.runNative("read info", async () => {
      const names = (await db.tableNames()) as string[]
      if (!names.includes(VECTOR_TABLE)) {
        return { kind: "lancedb", name: this.dbPath, exists: false, pointsCount: null }
      }
      const vectorTable = await this.openVectorTable(db)
      const pointsCount = (await vectorTable.countRows()) as number
      const result: VectorStoreInfo = { kind: "lancedb", name: this.dbPath, exists: true, pointsCount }
      if (names.includes(METADATA_TABLE)) {
        const meta = await readMetadataMap(await this.openMetadataTable(db))
        const profile = profileFromMetadataMap(meta)
        if (profile) result.profile = profile
        if (meta.has(METADATA_KEYS.complete)) result.complete = meta.get(METADATA_KEYS.complete) === "true"
        const schema = toFiniteNumber(meta.get(METADATA_KEYS.schema))
        if (schema !== undefined) result.schema = schema
      }
      return result
    })
  }

  async ensure(dimension: number, profile: EmbeddingProfile): Promise<{ created: boolean }> {
    if (!Number.isFinite(dimension) || dimension <= 0 || !Number.isInteger(dimension)) {
      throw new Error(`Invalid embedding dimension for LanceDB store: ${dimension}`)
    }
    const db = await this.getDb()
    return this.runNative("ensure tables", async () => {
      const names = (await db.tableNames()) as string[]

      if (!names.includes(VECTOR_TABLE)) {
        const vectorTable = await db.createTable(VECTOR_TABLE, [sampleRow(dimension)])
        await vectorTable.delete("id = 'sample'")
        this.vectorTable = vectorTable
        // A metadata table without a vector table is a partial/stale store:
        // there are no points to protect, so refresh it to match the new table.
        if (names.includes(METADATA_TABLE)) {
          await db.dropTable(METADATA_TABLE)
        }
        this.metadataTable = await db.createTable(METADATA_TABLE, initialMetadataRows(dimension, profile))
        return { created: true }
      }

      // Existing store: validate, never recreate silently.
      const vectorTable = await this.openVectorTable(db)
      const pointsCount = (await vectorTable.countRows()) as number

      const hasMetadataTable = names.includes(METADATA_TABLE)
      const meta = hasMetadataTable ? await readMetadataMap(await this.openMetadataTable(db)) : new Map<string, string>()
      const storedSchema = meta.get(METADATA_KEYS.schema)
      const storedSize = toFiniteNumber(meta.get(METADATA_KEYS.size))

      // A store with no points whose metadata was cleared (deleteAll) is safe
      // to re-seed: there is nothing to protect, and bricking the store would
      // make `deleteAll()` a one-way operation.
      if (storedSchema === undefined || storedSize === undefined) {
        if (pointsCount > 0) {
          throw new Error(
            `LanceDB index at "${this.dbPath}" has ${pointsCount} points but incomplete metadata. ` +
              `Delete the database directory or rebuild the index with the current embedding model.`,
          )
        }
        if (hasMetadataTable) {
          await db.dropTable(METADATA_TABLE)
        }
        this.metadataTable = await db.createTable(METADATA_TABLE, initialMetadataRows(dimension, profile))
        return { created: true }
      }

      if (String(storedSchema) !== SCHEMA) {
        throw new Error(
          `LanceDB index at "${this.dbPath}" uses schema ${storedSchema}, but this plugin needs schema ${SCHEMA}. ` +
            `Delete the database directory or rebuild the index with the current embedding model.`,
        )
      }

      if (storedSize !== dimension) {
        throw new Error(
          `LanceDB index at "${this.dbPath}" uses vector size ${storedSize}, but the current embedding model produces ${dimension}. ` +
            `Delete the database directory or switch back to a ${storedSize}-dimension model.`,
        )
      }

      if (pointsCount > 0) {
        const storedProfile = profileFromMetadataMap(meta)
        if (!storedProfile || !profilesEqual(storedProfile, profile)) {
          const stored = storedProfile
            ? `${storedProfile.provider}/${storedProfile.modelId} (${storedProfile.dimension} dimensions)`
            : "an unknown model"
          throw new Error(
            `LanceDB index at "${this.dbPath}" was built with ${stored}, but the current embedding model is ` +
              `${profile.provider}/${profile.modelId} (${profile.dimension} dimensions). ` +
              `Delete the database directory or switch back to the model that built the index.`,
          )
        }
      }

      return { created: false }
    })
  }

  async upsert(points: QdrantPoint[]): Promise<void> {
    if (points.length === 0) return
    const rows = points
      .filter((point) => isPayloadValid(point.payload))
      .map((point) => ({
        id: point.id,
        vector: point.vector,
        // Stored with forward slashes so lookups/deletes are separator-agnostic
        // (a Kilo index imported from another OS may use either separator).
        filePath: toForwardSlashes(String(point.payload.filePath)),
        fileHash: point.payload.fileHash,
        codeChunk: point.payload.codeChunk,
        startLine: point.payload.startLine,
        endLine: point.payload.endLine,
      }))
    if (rows.length === 0) return

    const table = await this.requireVectorTable()

    // Replace rows with the same id first. Ids that do not look like UUIDs are
    // skipped in the delete predicate (they can never be injected) and the
    // point is simply appended.
    const validIds = rows.map((row) => row.id).filter((id) => UUID_PATTERN.test(id))
    if (validIds.length > 0) {
      const idList = validIds.map((id) => `'${escapeSqlString(id)}'`).join(", ")
      await this.runNative("delete existing points", () => table.delete(`id IN (${idList})`))
    }
    await this.runNative("add points", () => table.add(rows))
  }

  async deleteByFilePaths(relPaths: string[]): Promise<void> {
    if (relPaths.length === 0) return
    const table = await this.requireVectorTable()
    // Match both separator styles: rows written by this plugin use `/`, but
    // databases created by Kilo on Windows may contain native `\` paths.
    const candidates = new Set<string>()
    for (const relPath of relPaths) {
      const relative = path.normalize(path.isAbsolute(relPath) ? path.relative(this.root, relPath) : relPath)
      candidates.add(relative)
      candidates.add(toForwardSlashes(relative))
      candidates.add(relative.replaceAll("/", "\\"))
    }
    const pathList = [...candidates].map((relPath) => `'${escapeSqlString(relPath)}'`).join(", ")
    await this.runNative("delete points by file path", () => table.delete(`\`filePath\` IN (${pathList})`))
  }

  async deleteAll(): Promise<void> {
    const db = await this.getDbIfExists()
    if (!db) return
    await this.runNative("delete all points", async () => {
      const names = (await db.tableNames()) as string[]
      if (names.includes(VECTOR_TABLE)) {
        const table = await this.openVectorTable(db)
        await table.delete("true")
        try {
          await table.optimize({ cleanupOlderThan: new Date(), deleteUnverified: false })
        } catch {
          // Optimization is best-effort: stale versions only waste disk space.
        }
      }
      if (names.includes(METADATA_TABLE)) {
        const table = await this.openMetadataTable(db)
        await table.delete("true")
      }
    })
  }

  async search(options: StoreSearchOptions): Promise<QueryHit[]> {
    const table = await this.getVectorTable()
    if (!table) return []

    const minScore = options.minScore ?? DEFAULT_MIN_SCORE
    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS
    const prefix = options.pathPrefix !== undefined ? normalizeSearchPrefix(options.pathPrefix) : undefined

    const rows = await this.runNative("search", async () => {
      let query: any = table.search(options.vector)
      if (prefix !== undefined) {
        // Rows are stored with `/`; match that plus the native-separator variant
        // so databases written by Kilo on Windows also filter correctly.
        const variants = forwardSlashVariants(prefix)
        const like = variants
          .map((variant) => `\`filePath\` LIKE '${escapeLikePattern(variant)}%'`)
          .join(" OR ")
        query = query.where(variants.length > 1 ? `(${like})` : like)
      }
      return query.distanceType("cosine").distanceRange(0, 1 - minScore).limit(maxResults).toArray()
    })

    const hits: QueryHit[] = []
    for (const row of rows as Array<Record<string, unknown>>) {
      const payload = chunkPayload(row)
      if (!payload) continue
      const distance = toFiniteNumber(row._distance)
      if (distance === undefined) continue
      hits.push({ id: String(row.id ?? ""), score: 1 - distance, payload })
    }
    return hits
  }

  async exportBatch(options: { limit: number; cursor?: unknown }): Promise<ExportBatch & { done: boolean }> {
    const limit = normalizeLimit(options.limit)
    if (limit <= 0) return { points: [], done: true }
    const offset = normalizeOffset(options.cursor)

    const table = await this.getVectorTable()
    if (!table) return { points: [], done: true }

    const rows = (await this.runNative("export batch", () =>
      table.query().select([...EXPORT_COLUMNS]).offset(offset).limit(limit).toArray(),
    )) as Array<Record<string, unknown>>

    const points: QdrantPoint[] = []
    for (const row of rows) {
      const point = rowToPoint(row)
      if (point) points.push(point)
    }
    const done = rows.length < limit
    return { points, next: done ? undefined : offset + rows.length, done }
  }

  async markComplete(profile: EmbeddingProfile, complete: boolean, dimension: number): Promise<void> {
    const db = await this.getDbIfExists()
    if (!db) {
      throw new Error(`LanceDB index at "${this.dbPath}" does not exist; call ensure() before markComplete().`)
    }
    await this.runNative("mark complete", async () => {
      const names = (await db.tableNames()) as string[]
      if (!names.includes(METADATA_TABLE)) {
        throw new Error(`LanceDB index at "${this.dbPath}" is missing its metadata table.`)
      }
      const table = await this.openMetadataTable(db)
      await upsertMetadata(table, METADATA_KEYS.schema, SCHEMA)
      await upsertMetadata(table, METADATA_KEYS.provider, profile.provider)
      await upsertMetadata(table, METADATA_KEYS.model, profile.modelId)
      await upsertMetadata(table, METADATA_KEYS.dimension, profile.dimension)
      await upsertMetadata(table, METADATA_KEYS.size, dimension)
      await upsertMetadata(table, METADATA_KEYS.complete, complete ? "true" : "false")
      await upsertMetadata(table, METADATA_KEYS.updatedAt, Date.now())
    })
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async getDb(): Promise<any> {
    if (this.db) return this.db
    return this.runNative("connect", async () => {
      if (this.db) return this.db
      const lancedb = await loadLanceDb()
      fs.mkdirSync(this.dbPath, { recursive: true })
      this.db = await lancedb.connect(this.dbPath)
      return this.db
    })
  }

  private async getDbIfExists(): Promise<any | null> {
    if (this.db) return this.db
    if (!fs.existsSync(this.dbPath)) return null
    return this.getDb()
  }

  private async getVectorTable(): Promise<any | null> {
    if (this.vectorTable) return this.vectorTable
    const db = await this.getDbIfExists()
    if (!db) return null
    return this.runNative("open vector table", async () => {
      const names = (await db.tableNames()) as string[]
      if (!names.includes(VECTOR_TABLE)) return null
      return this.openVectorTable(db)
    })
  }

  private async requireVectorTable(): Promise<any> {
    const table = await this.getVectorTable()
    if (!table) {
      throw new Error(`LanceDB index at "${this.dbPath}" does not exist; call ensure() before writing points.`)
    }
    return table
  }

  /** Must be called from inside a `native()` task (all callers do). */
  private async openVectorTable(db: any): Promise<any> {
    if (!this.vectorTable) {
      this.vectorTable = await db.openTable(VECTOR_TABLE)
    }
    return this.vectorTable
  }

  /** Must be called from inside a `native()` task (all callers do). */
  private async openMetadataTable(db: any): Promise<any> {
    if (!this.metadataTable) {
      this.metadataTable = await db.openTable(METADATA_TABLE)
    }
    return this.metadataTable
  }

  private async runNative<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await native(run)
    } catch (error) {
      throw wrapNativeError(operation, this.dbPath, error)
    }
  }
}

export function createLanceDbStore(options: LanceDbStoreOptions): VectorStoreAdapter {
  return new LanceDbStoreAdapter(options)
}

// ---------------------------------------------------------------------------
// Kilo-layout readers (import engine; never write)
// ---------------------------------------------------------------------------

/**
 * Read the raw table state of an arbitrary LanceDB directory (e.g. a Kilo
 * Code store). Missing paths yield empty/false values instead of throwing.
 */
export async function readLanceDbInfoAt(dbPath: string): Promise<LanceDbRawTables> {
  const empty: LanceDbRawTables = { vectorExists: false, metadataExists: false, pointsCount: 0 }
  if (!isDirectory(dbPath)) return { ...empty }
  const db = await openReadOnly(dbPath)
  try {
    return await native(async () => {
      const names = (await db.tableNames()) as string[]
      const vectorExists = names.includes(VECTOR_TABLE)
      const metadataExists = names.includes(METADATA_TABLE)
      const result: LanceDbRawTables = { vectorExists, metadataExists, pointsCount: 0 }
      if (vectorExists) {
        const table = await db.openTable(VECTOR_TABLE)
        result.pointsCount = (await table.countRows()) as number
      }
      if (metadataExists) {
        const meta = await readMetadataMap(await db.openTable(METADATA_TABLE))
        const profile = profileFromMetadataMap(meta)
        if (profile) result.profile = profile
        if (meta.has(METADATA_KEYS.complete)) result.complete = meta.get(METADATA_KEYS.complete) === "true"
        const schema = toFiniteNumber(meta.get(METADATA_KEYS.schema))
        if (schema !== undefined) result.schema = schema
      }
      return result
    })
  } catch (error) {
    throw wrapNativeError("read info", dbPath, error)
  } finally {
    closeQuietly(db)
  }
}

/**
 * Read a page of chunk points (with full vectors) from an arbitrary LanceDB
 * directory. Missing paths/tables yield an empty, finished batch.
 */
export async function readLanceDbBatch(
  dbPath: string,
  opts: { limit: number; offset: number },
): Promise<{ points: QdrantPoint[]; done: boolean }> {
  const limit = normalizeLimit(opts.limit)
  if (limit <= 0 || !isDirectory(dbPath)) return { points: [], done: true }
  const offset = normalizeOffset(opts.offset)

  const db = await openReadOnly(dbPath)
  try {
    return await native(async () => {
      const names = (await db.tableNames()) as string[]
      if (!names.includes(VECTOR_TABLE)) return { points: [], done: true }
      const table = await db.openTable(VECTOR_TABLE)
      // `Query.offset` is supported by @lancedb/lancedb 0.26.2 (no fallback needed).
      const rows = (await table.query().select([...EXPORT_COLUMNS]).offset(offset).limit(limit).toArray()) as Array<
        Record<string, unknown>
      >
      const points: QdrantPoint[] = []
      for (const row of rows) {
        const point = rowToPoint(row)
        if (point) points.push(point)
      }
      return { points, done: rows.length < limit }
    })
  } catch (error) {
    throw wrapNativeError("read batch", dbPath, error)
  } finally {
    closeQuietly(db)
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function sampleRow(dimension: number): Record<string, unknown> {
  return {
    id: "sample",
    vector: new Array<number>(dimension).fill(0),
    filePath: "sample",
    fileHash: "sample",
    codeChunk: "sample",
    startLine: 0,
    endLine: 0,
  }
}

function initialMetadataRows(dimension: number, profile: EmbeddingProfile): Array<{ key: string; value: string }> {
  return [
    { key: METADATA_KEYS.schema, value: SCHEMA },
    { key: METADATA_KEYS.size, value: String(dimension) },
    { key: METADATA_KEYS.provider, value: profile.provider },
    { key: METADATA_KEYS.model, value: profile.modelId },
    { key: METADATA_KEYS.dimension, value: String(profile.dimension) },
    { key: METADATA_KEYS.complete, value: "false" },
  ]
}

async function readMetadataMap(table: any): Promise<Map<string, string>> {
  const rows = (await table.query().select(["key", "value"]).toArray()) as Array<Record<string, unknown>>
  const map = new Map<string, string>()
  for (const row of rows) {
    if (typeof row.key !== "string") continue
    map.set(row.key, row.value === undefined || row.value === null ? "" : String(row.value))
  }
  return map
}

async function upsertMetadata(table: any, key: string, value: unknown): Promise<void> {
  assertMetadataKey(key)
  await table.delete(`key = '${escapeSqlString(key)}'`)
  // Values are always stored as strings: LanceDB infers the column type from
  // the first row, and a numeric first value corrupts later string rows.
  await table.add([{ key, value: String(value) }])
}

function assertMetadataKey(key: string): void {
  if (!METADATA_KEY_VALUES.includes(key)) {
    throw new Error(`Invalid LanceDB metadata key: ${key}`)
  }
}

function profilesEqual(a: EmbeddingProfile, b: EmbeddingProfile): boolean {
  return a.provider === b.provider && a.modelId === b.modelId && a.dimension === b.dimension
}

function profileFromMetadataMap(meta: Map<string, string>): EmbeddingProfile | undefined {
  const provider = (meta.get(METADATA_KEYS.provider) ?? "").trim()
  const modelId = (meta.get(METADATA_KEYS.model) ?? "").trim()
  const dimension = toFiniteNumber(meta.get(METADATA_KEYS.dimension))
  if (provider.length === 0 || modelId.length === 0 || dimension === undefined || dimension <= 0) return undefined
  return { provider: provider as EmbeddingProfile["provider"], modelId, dimension }
}

function isPayloadValid(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload) return false
  for (const field of REQUIRED_PAYLOAD_FIELDS) {
    const value = payload[field]
    if (value === undefined || value === null) return false
  }
  return true
}

function chunkPayload(row: Record<string, unknown>): Record<string, unknown> | null {
  const payload: Record<string, unknown> = {
    filePath: row.filePath,
    fileHash: row.fileHash,
    codeChunk: row.codeChunk,
    startLine: row.startLine,
    endLine: row.endLine,
  }
  return isPayloadValid(payload) ? payload : null
}

function rowToPoint(row: Record<string, unknown>): QdrantPoint | undefined {
  if (typeof row.id !== "string" || row.id.length === 0) return undefined
  const payload = chunkPayload(row)
  if (!payload) return undefined
  return { id: row.id, vector: toNumberArray(row.vector), payload }
}

/** LanceDB returns the vector column as a native `Vector`; normalize to numbers. */
function toNumberArray(value: unknown): number[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map((entry) => Number(entry))
  if (typeof value === "object") {
    const length = (value as { length?: unknown }).length
    if (typeof length === "number" && Number.isFinite(length) && length >= 0) {
      return Array.from(value as ArrayLike<unknown>, (entry) => Number(entry))
    }
  }
  return []
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function normalizeLimit(value: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value)
  return 0
}

function normalizeOffset(cursor: unknown): number {
  if (typeof cursor === "number" && Number.isFinite(cursor) && cursor > 0) return Math.floor(cursor)
  return 0
}

/**
 * Normalize a user-supplied path prefix into the separator convention used by
 * stored file paths (forward slashes; rows are normalized on write). Falls back
 * to matching the native-separator variant at query time.
 */
function normalizeSearchPrefix(prefix: string): string | undefined {
  const trimmed = prefix.trim()
  if (trimmed.length === 0) return undefined
  const normalized = path.posix.normalize(toForwardSlashes(trimmed))
  if (normalized.length === 0 || normalized === ".") return undefined
  return normalized
}

/** Convert a file path to forward slashes (the storage convention). */
function toForwardSlashes(value: string): string {
  return value.replaceAll("\\", "/")
}

/** Forward-slash prefix plus its native-separator variant, deduplicated. */
function forwardSlashVariants(prefix: string): string[] {
  const forward = toForwardSlashes(prefix)
  const native = prefix.replaceAll("/", "\\")
  return [...new Set([forward, native])]
}

/** Escape a value for use inside a single-quoted SQL string literal. */
function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''")
}

/**
 * Escape a prefix for a `LIKE` pattern. DataFusion treats backslash as the
 * pattern escape character, so backslashes must be doubled before escaping
 * `%`/`_` (same order as Kilo).
 */
function escapeLikePattern(value: string): string {
  return escapeSqlString(value).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Open an arbitrary LanceDB directory read-only (caller may close()). */
function openReadOnly(dbPath: string): Promise<any> {
  return native(async () => {
    try {
      const lancedb = await loadLanceDb()
      return await lancedb.connect(dbPath)
    } catch (error) {
      throw wrapNativeError("open for read", dbPath, error)
    }
  })
}

function closeQuietly(connection: any): void {
  if (!connection || typeof connection.close !== "function") return
  // Schedule on the native queue so a close never interleaves with an active task.
  void native(async () => {
    connection.close()
  }).catch(() => {
    // Connections are also released on GC; closing is best-effort.
  })
}
