import * as assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, describe, test } from "node:test"

import {
  discoverKiloSources,
  importFromKilo,
  importReportToIndexReport,
  selectKiloSources,
  type KiloSourceInfo,
} from "../src/import.ts"
import { kiloCollectionCandidates, KILO_METADATA_ID } from "../src/kilo-store.ts"
import { lanceDbName, type LanceDbReader } from "../src/lancedb-store.ts"
import type { EmbeddingProfile, QdrantPoint, QueryHit } from "../src/types.ts"
import type { ExportBatch, StoreSearchOptions, VectorStoreAdapter, VectorStoreInfo } from "../src/vector-store.ts"

const PROFILE: EmbeddingProfile = { provider: "mistral", modelId: "codestral-embed-2505", dimension: 4 }

// Every import is recorded in the workspace registry, which lives next to the
// user's settings file: point XDG at a temp dir so tests never write there.
const configHome = mkdtempSync(path.join(os.tmpdir(), "oi-xdg-"))
process.env.XDG_CONFIG_HOME = configHome

after(() => rmSync(configHome, { recursive: true, force: true }))

/** In-memory adapter used as import target. */
class FakeTarget implements VectorStoreAdapter {
  readonly kind = "qdrant" as const
  readonly name = "oc-test"
  points: QdrantPoint[] = []
  upserts = 0
  markedComplete: Array<{ complete: boolean; dimension: number }> = []

  async exists() {
    return true
  }
  async info(): Promise<VectorStoreInfo> {
    return { kind: this.kind, name: this.name, exists: true, pointsCount: this.points.length, profile: PROFILE, complete: false }
  }
  async ensure() {
    return { created: false }
  }
  async upsert(points: QdrantPoint[]) {
    this.upserts++
    this.points.push(...points)
  }
  async deleteByFilePaths() {}
  async deleteAll() {}
  async search(_options: StoreSearchOptions): Promise<QueryHit[]> {
    return []
  }
  async exportBatch(): Promise<ExportBatch> {
    return { points: [] }
  }
  async markComplete(_profile: EmbeddingProfile, complete: boolean, dimension: number) {
    this.markedComplete.push({ complete, dimension })
  }
}

function chunkPayload(filePath: string, fileHash: string) {
  return {
    filePath,
    fileHash,
    codeChunk: `chunk for ${filePath}`,
    startLine: 1,
    endLine: 10,
    segmentHash: `hash-${filePath}`,
  }
}

/** Kilo metadata payload for a readable Qdrant collection. */
function qdrantMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    embedding_provider: "mistral",
    embedding_model_id: "codestral-embed-2505",
    embedding_dimension: 4,
    index_schema: 2,
    indexing_complete: true,
    ...overrides,
  }
}

/** A Qdrant holding one readable Kilo collection per workspace root. */
function qdrantWithSources(entries: Array<{ root: string; payload: Record<string, unknown> }>) {
  const collections = new Map<string, Record<string, unknown>>()
  for (const entry of entries) collections.set(kiloCollectionCandidates(entry.root)[0]!, entry.payload)
  return {
    async collectionExists(name: string) {
      return collections.has(name)
    },
    async getCollection(name: string) {
      return collections.has(name) ? { points_count: 12 } : null
    },
    async retrieve(name: string) {
      return collections.has(name) ? [{ id: KILO_METADATA_ID, payload: collections.get(name) }] : []
    },
  } as never
}

/** Fake Qdrant REST surface used by the import engine for qdrant sources. */
function makeFakeQdrant(pages: Array<{ points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> | null }>; next?: unknown }>) {
  let index = 0
  const scrollCalls: unknown[] = []
  return {
    scrollCalls,
    client: {
      async scroll(_name: string, _options: unknown) {
        scrollCalls.push(_options)
        const page = pages[Math.min(index, pages.length - 1)]
        index++
        return { points: page?.points ?? [], next: index < pages.length ? (page?.next ?? index) : undefined }
      },
    } as never,
  }
}

describe("importFromKilo (qdrant source)", () => {
  test("copies vectors and payloads without embedding, paginating via next", async () => {
    const fake = makeFakeQdrant([
      {
        points: [
          { id: "1", vector: [0.1, 0.2, 0.3, 0.4], payload: chunkPayload("src\\a.ts", "h1") },
          { id: "2", vector: [0.5, 0.6, 0.7, 0.8], payload: chunkPayload("src\\b.ts", "h2") },
        ],
        next: "cursor-1",
      },
      {
        points: [{ id: "3", vector: [0.9, 0.1, 0.2, 0.3], payload: chunkPayload("lib\\c.ts", "h3") }],
      },
    ])
    const target = new FakeTarget()
    const source: KiloSourceInfo = {
      kind: "qdrant",
      name: "ws-abc",
      pointsCount: 3,
      profile: PROFILE,
      complete: true,
      schema: 2,
      compatible: true,
    }
    const progress: number[] = []
    const report = await importFromKilo({
      root: "D:\\proj",
      source,
      target,
      targetProfile: PROFILE,
      qdrant: fake.client,
      batchLimit: 2,
      onProgress: (update) => {
        progress.push(update.imported)
      },
    })

    assert.equal(report.imported, 3)
    assert.equal(report.batches, 2)
    assert.equal(report.skipped, 0)
    assert.deepEqual(target.points.map((point) => point.id), ["1", "2", "3"])
    assert.deepEqual(target.points[0]!.vector, [0.1, 0.2, 0.3, 0.4], "vectors copied verbatim")
    assert.deepEqual(progress, [2, 3])
    assert.deepEqual(report.files, { "src\\a.ts": "h1", "src\\b.ts": "h2", "lib\\c.ts": "h3" })
    assert.equal(target.markedComplete.length, 1)
    assert.equal(target.markedComplete[0]!.complete, true)
    // Metadata exclusion filter is always sent.
    assert.deepEqual((fake.scrollCalls[0] as { filter: unknown }).filter, {
      must_not: [{ key: "type", match: { value: "metadata" } }],
    })
  })

  test("skips metadata-looking and invalid payloads", async () => {
    const fake = makeFakeQdrant([
      {
        points: [
          { id: "1", vector: [1, 2, 3, 4], payload: { type: "metadata", indexing_complete: true } },
          { id: "2", vector: [1, 2, 3, 4], payload: { filePath: "x.ts" } },
          { id: "3", vector: [1, 2, 3, 4], payload: chunkPayload("ok.ts", "h") },
        ],
      },
    ])
    const target = new FakeTarget()
    const report = await importFromKilo({
      root: "D:\\proj",
      source: { kind: "qdrant", name: "ws-x", pointsCount: 3, profile: PROFILE, compatible: true },
      target,
      targetProfile: PROFILE,
      qdrant: fake.client,
    })
    assert.equal(report.imported, 1)
    assert.equal(report.skipped, 2)
    assert.equal(target.points[0]!.id, "3")
  })

  test("fails instead of marking the index complete when nothing was imported", async () => {
    // Every point filtered out as metadata. Marking the manifest complete here
    // would make an empty index look healthy: the manifest would claim the
    // workspace is fully indexed and the freshness check would agree.
    const fake = makeFakeQdrant([
      { points: [{ id: "1", vector: [1, 2, 3, 4], payload: { type: "metadata", indexing_complete: true } }] },
    ])
    const target = new FakeTarget()
    await assert.rejects(
      importFromKilo({
        root: "D:\\proj",
        source: { kind: "qdrant", name: "ws-x", pointsCount: 1, profile: PROFILE, compatible: true },
        target,
        targetProfile: PROFILE,
        qdrant: fake.client,
      }),
      /Imported 0 chunks/,
    )
    assert.equal(target.upserts, 0)
    assert.deepEqual(target.markedComplete, [], "an import that copied nothing must not mark complete")
  })

  test("rejects incompatible profiles before touching the target", async () => {
    const target = new FakeTarget()
    await assert.rejects(
      importFromKilo({
        root: "D:\\proj",
        source: {
          kind: "qdrant",
          name: "ws-x",
          pointsCount: 1,
          profile: { provider: "openai", modelId: "text-embedding-3-small", dimension: 1536 },
          compatible: false,
        },
        target,
        targetProfile: PROFILE,
      }),
      /does not match/,
    )
    assert.equal(target.upserts, 0)
  })

  test("skipFiles drops points a more authoritative source already imported", async () => {
    const fake = makeFakeQdrant([
      {
        points: [
          { id: "1", vector: [0.1, 0.2, 0.3, 0.4], payload: chunkPayload("src\\a.ts", "delta-hash") },
          { id: "2", vector: [0.5, 0.6, 0.7, 0.8], payload: chunkPayload("src\\b.ts", "baseline-hash") },
          { id: "3", vector: [0.9, 0.1, 0.2, 0.3], payload: chunkPayload("src\\c.ts", "baseline-hash") },
        ],
      },
    ])
    const target = new FakeTarget()
    const report = await importFromKilo({
      root: "D:\\proj",
      source: { kind: "qdrant", name: "ws-base", pointsCount: 3, profile: PROFILE, compatible: true },
      target,
      targetProfile: PROFILE,
      qdrant: fake.client,
      skipFiles: new Set(["src\\a.ts"]),
    })

    assert.equal(report.imported, 2)
    assert.equal(report.skipped, 1)
    assert.deepEqual(target.points.map((point) => point.id), ["2", "3"], "the shadowed point is never upserted")
    assert.deepEqual(
      report.files,
      { "src\\b.ts": "baseline-hash", "src\\c.ts": "baseline-hash" },
      "a skipped file must not enter the manifest seed",
    )
  })

  test("a source fully shadowed by skipFiles is not an empty-read failure", async () => {
    // This is what importing the baseline after the delta looks like when both
    // cover the same files: nothing left to copy is an answer, not an error.
    const fake = makeFakeQdrant([
      { points: [{ id: "1", vector: [0.1, 0.2, 0.3, 0.4], payload: chunkPayload("src\\a.ts", "baseline-hash") }] },
    ])
    const target = new FakeTarget()
    const report = await importFromKilo({
      root: "D:\\proj",
      source: { kind: "qdrant", name: "ws-base", pointsCount: 1, profile: PROFILE, compatible: true },
      target,
      targetProfile: PROFILE,
      qdrant: fake.client,
      skipFiles: new Set(["src\\a.ts"]),
    })

    assert.equal(report.imported, 0)
    assert.equal(report.skipped, 1)
    assert.deepEqual(report.files, {})
    assert.deepEqual(target.markedComplete, [], "an all-skipped pass must not claim completion for the store")
  })

  test("an unsupported provider is refused as such, not as a profile mismatch", async () => {
    const target = new FakeTarget()
    await assert.rejects(
      importFromKilo({
        root: "D:\\proj",
        source: {
          kind: "qdrant",
          name: "ws-kilo",
          pointsCount: 1,
          compatible: false,
          reason: "provider",
          profile: {
            provider: "kilo" as unknown as EmbeddingProfile["provider"],
            modelId: "mistral-embed",
            dimension: 1024,
          },
        },
        target,
        targetProfile: PROFILE,
      }),
      (error: Error) => {
        assert.match(error.message, /kilo/)
        assert.match(error.message, /cannot embed with/)
        assert.match(error.message, /supported provider/, "the fix is re-indexing Kilo, not switching the model")
        return true
      },
    )
    assert.equal(target.upserts, 0)
  })

  test("a newer schema is refused naming the schema this build reads", async () => {
    const target = new FakeTarget()
    await assert.rejects(
      importFromKilo({
        root: "D:\\proj",
        source: { kind: "qdrant", name: "ws-new", pointsCount: 1, compatible: false, reason: "schema", schema: 3, profile: PROFILE },
        target,
        targetProfile: PROFILE,
      }),
      (error: Error) => {
        assert.match(error.message, /schema 3/)
        assert.match(error.message, /schemas 1 and 2/)
        assert.match(error.message, /update the plugin/)
        return true
      },
    )
    assert.equal(target.upserts, 0)
  })
})

describe("importFromKilo (lancedb source)", () => {
  const LANCE_SOURCE: KiloSourceInfo = {
    kind: "lancedb",
    name: path.join(os.tmpdir(), "kilo-lancedb", "ws-abc"),
    pointsCount: 3,
    profile: PROFILE,
    complete: false,
    schema: 2,
    compatible: true,
  }

  function lancePoint(id: string, filePath: string, fileHash: string): QdrantPoint {
    return { id, vector: [0.1, 0.2, 0.3, 0.4], payload: chunkPayload(filePath, fileHash) }
  }

  /** Reader stand-in: yields fixed pages and records open/close calls. */
  function fakeLanceSource(pages: QdrantPoint[][]) {
    const calls = { opened: 0, closed: 0 }
    const factory = async (_dbPath: string): Promise<LanceDbReader> => {
      calls.opened++
      let index = 0
      return {
        info: {
          vectorExists: true,
          metadataExists: false,
          pointsCount: pages.reduce((total, page) => total + page.length, 0),
        },
        async next() {
          const page = pages[index] ?? []
          index++
          return { points: page, done: index >= pages.length }
        },
        close() {
          calls.closed++
        },
      }
    }
    return { calls, factory }
  }

  test("imports every page through one reader, opened and closed exactly once", async () => {
    const source = fakeLanceSource([
      [lancePoint("1", "src\\a.ts", "h1"), lancePoint("2", "src\\b.ts", "h2")],
      [lancePoint("3", "lib\\c.ts", "h3")],
    ])
    const target = new FakeTarget()
    const progress: number[] = []

    const report = await importFromKilo({
      root: "D:\\proj",
      source: LANCE_SOURCE,
      target,
      targetProfile: PROFILE,
      lanceDbReader: source.factory,
      batchLimit: 2,
      onProgress: (update) => {
        progress.push(update.imported)
      },
    })

    assert.equal(report.imported, 3)
    assert.equal(report.batches, 2)
    assert.equal(report.skipped, 0)
    assert.deepEqual(target.points.map((point) => point.id), ["1", "2", "3"])
    assert.deepEqual(progress, [2, 3])
    assert.deepEqual(report.files, { "src\\a.ts": "h1", "src\\b.ts": "h2", "lib\\c.ts": "h3" })
    assert.deepEqual(source.calls, { opened: 1, closed: 1 }, "one connection for the whole import")
    assert.equal(target.markedComplete.length, 1)
  })

  test("skipFiles filters a page before the upsert and the file map", async () => {
    const source = fakeLanceSource([[lancePoint("1", "src\\a.ts", "delta-hash"), lancePoint("2", "src\\b.ts", "baseline-hash")]])
    const target = new FakeTarget()

    const report = await importFromKilo({
      root: "D:\\proj",
      source: LANCE_SOURCE,
      target,
      targetProfile: PROFILE,
      lanceDbReader: source.factory,
      skipFiles: new Set(["src\\a.ts"]),
    })

    assert.equal(report.imported, 1)
    assert.equal(report.skipped, 1)
    assert.deepEqual(target.points.map((point) => point.id), ["2"])
    assert.deepEqual(report.files, { "src\\b.ts": "baseline-hash" })
    assert.deepEqual(source.calls, { opened: 1, closed: 1 })
  })

  test("closes the reader when a page upsert fails", async () => {
    const source = fakeLanceSource([[lancePoint("1", "src\\a.ts", "h1")]])
    const target = new FakeTarget()
    target.upsert = async () => {
      throw new Error("destination unavailable")
    }

    await assert.rejects(
      importFromKilo({
        root: "D:\\proj",
        source: LANCE_SOURCE,
        target,
        targetProfile: PROFILE,
        lanceDbReader: source.factory,
      }),
      /destination unavailable/,
    )
    assert.deepEqual(source.calls, { opened: 1, closed: 1 })
    assert.deepEqual(target.markedComplete, [])
  })

  test("a missing source table imports nothing instead of throwing on open", async () => {
    const target = new FakeTarget()
    await assert.rejects(
      importFromKilo({
        root: "D:\\proj",
        source: { ...LANCE_SOURCE, pointsCount: 0 },
        target,
        targetProfile: PROFILE,
        lanceDbReader: async () => null,
      }),
      /Imported 0 chunks/,
    )
    assert.equal(target.upserts, 0)
  })
})

describe("discoverKiloSources", () => {
  const ROOT = path.join(os.tmpdir(), "discover-root")

  /** A reachable Qdrant with no collection for this workspace. */
  function emptyQdrant() {
    return { collectionExists: async () => false } as never
  }

  test("says nothing was found when nothing exists", async () => {
    const problems: string[] = []
    const sources = await discoverKiloSources(ROOT, {
      qdrant: emptyQdrant(),
      lancedbDirectory: path.join(os.tmpdir(), "oi-absent-lancedb"),
      onProblem: (message) => problems.push(message),
    })

    assert.deepEqual(sources, [])
    // Silence here is correct: there is no index and nothing failed.
    assert.deepEqual(problems, [])
  })

  test("reports an unreadable LanceDB index instead of calling it absent", async () => {
    // The directory is present but the native module cannot load, which is what
    // a missing `apache-arrow` looks like. Swallowing it produced "No Kilo
    // index found" for an index that was sitting on disk.
    const directory = mkdtempSync(path.join(os.tmpdir(), "oi-lancedb-"))
    try {
      const { lanceDbName } = await import("../src/lancedb-store.ts")
      const dbPath = path.join(directory, lanceDbName(ROOT))
      // A database directory with an unreadable table inside: connecting throws
      // rather than returning an empty schema, which is what a corrupt or
      // half-written store does in practice.
      mkdirSync(path.join(dbPath, "vector.lance"), { recursive: true })
      writeFileSync(path.join(dbPath, "vector.lance", "_versions"), "not a lance manifest")

      const problems: string[] = []
      const sources = await discoverKiloSources(ROOT, {
        qdrant: emptyQdrant(),
        lancedbDirectory: directory,
        onProblem: (message) => problems.push(message),
      })

      assert.deepEqual(sources, [], "an unreadable source is not an importable one")
      assert.equal(problems.length, 1, "exactly one problem, so the message cannot be mistaken for 'nothing here'")
      assert.match(problems[0], /exists at/, "the message must say the index is there")
      assert.match(problems[0], /could not be read: \S/, "and carry the reason, not just the verdict")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("reports an unreachable Qdrant rather than reporting no index", async () => {
    const problems: string[] = []
    const sources = await discoverKiloSources(ROOT, {
      qdrant: {
        collectionExists: async () => {
          throw new Error("Unable to connect to Qdrant at localhost:6333")
        },
      } as never,
      lancedbDirectory: path.join(os.tmpdir(), "oi-absent-lancedb"),
      onProblem: (message) => problems.push(message),
    })

    assert.deepEqual(sources, [])
    assert.equal(problems.length, 1)
    assert.match(problems[0], /Could not reach the Qdrant server/)
    assert.match(problems[0], /Unable to connect/, "the underlying reason must survive")
  })

  test("an optional onProblem does not have to be provided", async () => {
    // Discovery runs on hot paths (every status read) that have nowhere to put a
    // message, so the hook is genuinely optional.
    const sources = await discoverKiloSources(ROOT, {
      qdrant: emptyQdrant(),
      lancedbDirectory: path.join(os.tmpdir(), "oi-absent-lancedb"),
    })
    assert.deepEqual(sources, [])
  })
})

describe("discoverKiloSources compatibility reasons", () => {
  const ROOT = path.join(os.tmpdir(), "reason-root")
  const TARGET: EmbeddingProfile = { provider: "mistral", modelId: "codestral-embed-2505", dimension: 4 }

  async function discover(payload: Record<string, unknown>, targetProfile?: EmbeddingProfile) {
    const sources = await discoverKiloSources(ROOT, {
      qdrant: qdrantWithSources([{ root: ROOT, payload }]),
      lancedbDirectories: [],
      targetProfile,
    })
    assert.equal(sources.length, 1)
    return sources[0]!
  }

  test("providers this plugin cannot embed with are refused as such", async () => {
    // Kilo's gateway, AWS Bedrock and Vercel's AI Gateway are providers Kilo
    // accepts and this plugin does not. The source is unusable regardless of the
    // model, so the reason must not be reported as a profile mismatch.
    for (const provider of ["kilo", "bedrock", "vercel-ai-gateway"]) {
      const source = await discover(qdrantMeta({ embedding_provider: provider }), TARGET)
      assert.equal(source.compatible, false, `${provider} must be refused`)
      assert.equal(source.reason, "provider", `${provider} has no embedder here`)
    }
  })

  test("a newer index schema is refused even with a matching profile", async () => {
    const source = await discover(qdrantMeta({ index_schema: 3 }), TARGET)
    assert.equal(source.compatible, false)
    assert.equal(source.reason, "schema")
  })

  test("a different profile is refused as a profile mismatch", async () => {
    const source = await discover(qdrantMeta(), {
      provider: "mistral",
      modelId: "codestral-embed-2505",
      dimension: 1024,
    })
    assert.equal(source.compatible, false)
    assert.equal(source.reason, "profile")
  })

  test("schemas 1, 2, null and absent are readable with a matching profile", async () => {
    const withoutSchema = qdrantMeta()
    delete withoutSchema.index_schema
    for (const payload of [
      qdrantMeta({ index_schema: 1 }),
      qdrantMeta({ index_schema: 2 }),
      qdrantMeta({ index_schema: null }),
      withoutSchema,
    ]) {
      const source = await discover(payload, TARGET)
      assert.equal(source.compatible, true, `schema ${String(payload.index_schema)} must stay readable`)
      assert.equal(source.reason, undefined)
    }
  })
})

describe("discoverKiloSources worktrees", () => {
  const MAIN = path.join(os.tmpdir(), "wt-main")
  const LINKED = path.join(os.tmpdir(), "wt-feature")
  const TARGET: EmbeddingProfile = { provider: "mistral", modelId: "codestral-embed-2505", dimension: 4 }

  test("a linked worktree reads the baseline from its main checkout and the delta from itself", async () => {
    const sources = await discoverKiloSources(LINKED, {
      baselineRoot: MAIN,
      qdrant: qdrantWithSources([
        { root: MAIN, payload: qdrantMeta() },
        { root: LINKED, payload: qdrantMeta() },
      ]),
      lancedbDirectories: [],
    })

    assert.deepEqual(
      sources.map((source) => source.role),
      ["baseline", "delta"],
      "the main checkout comes first: its index is the one Kilo built for the repository",
    )
    assert.notEqual(sources[0]!.name, sources[1]!.name, "one Kilo collection per checkout")
  })

  test("without a baseline the role stays unset", async () => {
    const sources = await discoverKiloSources(LINKED, {
      qdrant: qdrantWithSources([{ root: LINKED, payload: qdrantMeta() }]),
      lancedbDirectories: [],
      targetProfile: TARGET,
    })
    assert.equal(sources.length, 1)
    assert.equal(sources[0]!.role, undefined)
  })

  test("a baseline equal to the root leaves the role unset", async () => {
    const sources = await discoverKiloSources(LINKED, {
      baselineRoot: LINKED,
      qdrant: qdrantWithSources([{ root: LINKED, payload: qdrantMeta() }]),
      lancedbDirectories: [],
    })
    assert.equal(sources.length, 1)
    assert.equal(sources[0]!.role, undefined)
  })
})

describe("Kilo source selection", () => {
  const source = (kind: "qdrant" | "lancedb", name: string, role?: "baseline" | "delta"): KiloSourceInfo => ({
    kind,
    name,
    pointsCount: 1,
    compatible: true,
    ...(role ? { role } : {}),
  })

  test("LanceDB wins when Kilo has no configured store", () => {
    const picked = selectKiloSources([source("qdrant", "ws-old"), source("lancedb", "new")])
    assert.deepEqual(picked.map((item) => item.kind), ["lancedb"])
  })

  test("the configured store wins over the other backend", () => {
    const picked = selectKiloSources([source("qdrant", "ws-old"), source("lancedb", "new")], "qdrant")
    assert.deepEqual(picked.map((item) => item.name), ["ws-old"])
  })

  test("the other backend is used when the configured store has no source", () => {
    const picked = selectKiloSources([source("lancedb", "new")], "qdrant")
    assert.deepEqual(picked.map((item) => item.name), ["new"])
  })

  test("a worktree keeps baseline and delta in the same backend", () => {
    const picked = selectKiloSources(
      [
        source("lancedb", "main", "baseline"),
        source("lancedb", "feature", "delta"),
        source("qdrant", "old-main", "baseline"),
        source("qdrant", "old-feature", "delta"),
      ],
      "lancedb",
    )
    assert.deepEqual(picked.map((item) => item.name), ["main", "feature"])
  })

  test("an explicit LanceDB directory is the only place Kilo is looked for", async () => {
    const configured = mkdtempSync(path.join(os.tmpdir(), "oi-kilo-dir-"))
    const root = path.join(os.tmpdir(), "configured-root")
    try {
      const dbPath = path.join(configured, lanceDbName(root))
      mkdirSync(path.join(dbPath, "vector.lance"), { recursive: true })
      writeFileSync(path.join(dbPath, "vector.lance", "_versions"), "not a lance manifest")

      const problems: string[] = []
      const sources = await discoverKiloSources(root, {
        qdrant: { collectionExists: async () => false } as never,
        kiloConfig: { lancedb: { directory: configured } },
        onProblem: (message) => problems.push(message),
      })

      assert.deepEqual(sources, [])
      assert.equal(problems.length, 1)
      assert.match(problems[0]!, /exists at/)
      assert.ok(problems[0]!.includes(dbPath), "the configured directory is the one probed")
    } finally {
      rmSync(configured, { recursive: true, force: true })
    }
  })
})

describe("importReportToIndexReport", () => {
  test("maps counters for tool output", () => {
    const report = importReportToIndexReport({
      source: { kind: "lancedb", name: "dir", pointsCount: 10, compatible: true },
      imported: 8,
      batches: 2,
      skipped: 2,
      durationMs: 123,
      errors: [],
      files: {},
    })
    assert.equal(report.mode, "build")
    assert.equal(report.chunksUpserted, 8)
    assert.equal(report.batches, 2)
    assert.equal(report.durationMs, 123)
  })
})
