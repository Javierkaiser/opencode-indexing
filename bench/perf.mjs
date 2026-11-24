#!/usr/bin/env node
/**
 * Indexing throughput benchmark for opencode-indexing.
 *
 * Generates synthetic TypeScript modules in a temporary workspace and runs the
 * real `runIndex` over them twice: once with
 * `KILO_INDEX_EMBEDDING_CONCURRENCY=1` and once with `3`. Embeddings are
 * deterministic fake vectors and both the vector store and the KV live in
 * memory, so the numbers measure batching and bookkeeping — not provider
 * latency, provider quality or cost.
 *
 * Nothing reads or writes the user's real settings, state or indexes:
 * `XDG_CONFIG_HOME` and `XDG_STATE_HOME` are redirected to the temp directory
 * before the indexer module is imported.
 *
 * Usage:
 *   npm run perf
 *   npm run perf -- --files 500 --latency 25
 *   node bench/perf.mjs --files 1000 --latency 25 --upsert 1
 */
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, "..")

const DIMENSION = 256
const EMBEDDING_BATCH_SIZE = 60
const BASELINE_CONCURRENCY = 1
const DEFAULT_CANDIDATE_CONCURRENCY = 3

const argv = process.argv.slice(2)
const wantsHelp = argv.includes("--help") || argv.includes("-h")

function printUsage() {
  console.log(`Indexing throughput benchmark on synthetic data.

Usage: npm run perf [-- options]

  --files <n>     synthetic .ts files to generate (default 1000)
  --latency <ms>  fake latency per embedding call (default 25)
  --upsert <ms>   fake latency per vectorStore.upsert call (default 1)
  --concurrency <n>  in-flight limit for the second run (default 3; the
                     first run always uses 1)
  --keep          keep the temporary workspace/config/state directories
  -h, --help      show this message
`)
}

function readOption(name, fallback) {
  const inline = argv.find((argument) => argument.startsWith(`--${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 3)
  const index = argv.indexOf(`--${name}`)
  if (index !== -1 && index + 1 < argv.length && !argv[index + 1].startsWith("-")) {
    return argv[index + 1]
  }
  return fallback
}

function numberOption(name, fallback, { integer = false } = {}) {
  const raw = readOption(name, String(fallback))
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || (integer && (!Number.isInteger(value) || value < 1))) {
    throw new Error(`--${name} must be ${integer ? "a positive integer" : "a number >= 0"} (received "${raw}")`)
  }
  return value
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

function generateSource(id) {
  return `export interface Item${id} {
  readonly id: string
  name: string
  quantity: number
  active: boolean
}

export const DEFAULT_ITEM_${id}: Item${id} = {
  id: "item-${id}",
  name: "widget-${id}",
  quantity: 1,
  active: true,
}

export function normalizeItem${id}(input: Partial<Item${id}>): Item${id} {
  const quantity = Math.max(0, Math.trunc(input.quantity ?? DEFAULT_ITEM_${id}.quantity))
  return {
    ...DEFAULT_ITEM_${id},
    ...input,
    id: input.id ?? DEFAULT_ITEM_${id}.id,
    quantity,
  }
}

export function itemTotal${id}(item: Item${id}, unitPrice: number): number {
  return Math.round(item.quantity * unitPrice * 100) / 100
}

export function activateItem${id}(item: Item${id}): Item${id} {
  return item.active ? item : { ...item, active: true }
}

export class ItemRepository${id} {
  private readonly items = new Map<string, Item${id}>()

  add(item: Item${id}): void {
    this.items.set(item.id, item)
  }

  get(id: string): Item${id} | undefined {
    return this.items.get(id)
  }

  remove(id: string): boolean {
    return this.items.delete(id)
  }

  listActive(): Item${id}[] {
    return [...this.items.values()].filter((item) => item.active)
  }

  total(unitPrice: number): number {
    return this.listActive().reduce((sum, item) => sum + itemTotal${id}(item, unitPrice), 0)
  }
}
`
}

async function generateWorkspace(directory, fileCount) {
  await fs.mkdir(directory, { recursive: true })
  for (let index = 0; index < fileCount; index += 1) {
    const id = String(index + 1).padStart(4, "0")
    await fs.writeFile(path.join(directory, `module-${id}.ts`), generateSource(id), "utf8")
  }
}

/** Small deterministic 32-bit hash; only needs to spread text across vectors. */
function seedOf(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Deterministic unit-ish vector for a chunk, so repeated runs see the same data. */
function vectorFor(text, dimension) {
  const vector = new Array(dimension)
  let state = seedOf(text) || 1
  for (let index = 0; index < dimension; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    vector[index] = ((state >>> 0) / 0xffffffff) * 2 - 1
  }
  return vector
}

function createFakeEmbedder({ latencyMs }) {
  const stats = { active: 0, maxActive: 0 }
  return {
    provider: "openai",
    modelId: "perf-fake-256",
    dimension: DIMENSION,
    stats,
    async embed(texts) {
      stats.active += 1
      stats.maxActive = Math.max(stats.maxActive, stats.active)
      try {
        // The fake latency stands in for one provider round trip.
        await delay(latencyMs)
        return texts.map((text) => vectorFor(text, DIMENSION))
      } finally {
        stats.active -= 1
      }
    },
  }
}

function createFakeKV() {
  const values = new Map()
  const stats = { writes: 0 }
  return {
    stats,
    async get(key) {
      return values.get(key)
    },
    async set(key, value) {
      stats.writes += 1
      values.set(key, value)
    },
    async remove(key) {
      values.delete(key)
    },
    async scan() {
      return { entries: [] }
    },
  }
}

function createFakeStore({ upsertDelayMs }) {
  const points = new Map()
  const name = "perf-bench"
  const info = (exists) => ({
    kind: "lancedb",
    name,
    exists,
    pointsCount: exists ? points.size : 0,
  })
  return {
    kind: "lancedb",
    name,
    async exists() {
      return points.size > 0
    },
    async info() {
      return info(points.size > 0)
    },
    async ensure() {
      return { created: true }
    },
    async upsert(batch) {
      await delay(upsertDelayMs)
      for (const point of batch) points.set(point.id, point)
    },
    async deleteByFilePaths(relPaths) {
      const doomed = new Set(relPaths)
      for (const [id, point] of points) {
        if (doomed.has(point.payload?.filePath)) points.delete(id)
      }
    },
    async deleteAll() {
      points.clear()
    },
    async search() {
      return []
    },
    async exportBatch() {
      return { points: [] }
    },
    async markComplete() {},
  }
}

/** Minimal Qdrant stand-in: the run never imports, so no method is reached. */
const fakeQdrant = {
  listCollections: async () => [],
  getCollection: async () => null,
  collectionExists: async () => false,
  createCollection: async () => {},
  deleteCollection: async () => {},
  retrieve: async () => [],
  scroll: async () => ({ points: [] }),
  query: async () => [],
  upsert: async () => {},
  deletePoints: async () => {},
  createPayloadIndex: async () => {},
}

function buildSettings(tempRoot) {
  return {
    provider: "openai",
    modelId: "perf-fake-256",
    dimension: DIMENSION,
    vectorStore: "lancedb",
    kiloVectorStore: null,
    qdrantUrl: "http://127.0.0.1:6333",
    lancedbDirectory: path.join(tempRoot, "lancedb"),
    scoreThreshold: 0.4,
    searchMinScore: 0.4,
    searchMaxResults: 50,
    embeddingBatchSize: EMBEDDING_BATCH_SIZE,
    maxFileSizeBytes: 1024 * 1024,
    fileExtensions: [".ts"],
    autoRefresh: false,
    importFromKilo: false,
    searchKilo: false,
    enabled: true,
    codegraph: false,
    credentials: {},
    warnings: [],
  }
}

async function measureRun(runIndex, { workspace, settings, concurrency, latencyMs, upsertDelayMs }) {
  process.env.KILO_INDEX_EMBEDDING_CONCURRENCY = String(concurrency)

  const kv = createFakeKV()
  const store = createFakeStore({ upsertDelayMs })
  const embedder = createFakeEmbedder({ latencyMs })

  const marks = new Map()
  const onProgress = (update) => {
    const now = performance.now()
    const mark = marks.get(update.phase)
    if (mark) mark.last = now
    else marks.set(update.phase, { first: now, last: now })
  }

  const startedAt = performance.now()
  const report = await runIndex(
    { kv, root: workspace, settings, store, qdrant: fakeQdrant, embedder, onProgress },
    { mode: "build", skipImport: true },
  )
  const finishedAt = performance.now()

  if (report.errors.length > 0) {
    throw new Error(`runIndex reported ${report.errors.length} error(s): ${report.errors[0]}`)
  }

  const firstOf = (phase) => marks.get(phase)?.first ?? null
  const lastOf = (phase) => marks.get(phase)?.last ?? null
  const scanStart = firstOf("scanning")
  const chunkStart = firstOf("chunking")
  const chunkEnd = lastOf("chunking")
  const embedEnd = lastOf("embedding")
  const doneAt = lastOf("done") ?? finishedAt
  const wallMs = doneAt - startedAt

  return {
    concurrency,
    report,
    kv: kv.stats,
    embedder: embedder.stats,
    wallMs,
    scanMs: scanStart !== null && chunkStart !== null ? chunkStart - scanStart : null,
    chunkingMs: chunkStart !== null && chunkEnd !== null ? chunkEnd - chunkStart : null,
    embeddingMs: chunkEnd !== null && embedEnd !== null ? embedEnd - chunkEnd : null,
    finalizeMs: embedEnd !== null ? doneAt - embedEnd : null,
    chunksPerSecond: wallMs > 0 ? report.chunksUpserted / (wallMs / 1000) : null,
    rssMiB: process.memoryUsage().rss / (1024 * 1024),
  }
}

function formatNumber(value, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a"
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function speedup(baseline, candidate) {
  if (!baseline || !candidate || candidate <= 0) return "n/a"
  return `${(baseline / candidate).toFixed(2)}×`
}

function printTable(first, second) {
  const rows = [
    ["Files scanned", formatNumber(first.report.scanned), formatNumber(second.report.scanned), "—"],
    ["Chunks upserted", formatNumber(first.report.chunksUpserted), formatNumber(second.report.chunksUpserted), "—"],
    ["Batches", formatNumber(first.report.batches), formatNumber(second.report.batches), "—"],
    ["Scan (ms)", formatNumber(first.scanMs), formatNumber(second.scanMs), "—"],
    ["Chunking (ms)", formatNumber(first.chunkingMs), formatNumber(second.chunkingMs), "—"],
    [
      "Embedding + upsert (ms)",
      formatNumber(first.embeddingMs),
      formatNumber(second.embeddingMs),
      speedup(first.embeddingMs, second.embeddingMs),
    ],
    ["Finalize (ms)", formatNumber(first.finalizeMs), formatNumber(second.finalizeMs), "—"],
    [
      "Total wall (ms)",
      formatNumber(first.wallMs),
      formatNumber(second.wallMs),
      speedup(first.wallMs, second.wallMs),
    ],
    [
      "Chunks/s",
      formatNumber(first.chunksPerSecond),
      formatNumber(second.chunksPerSecond),
      speedup(second.chunksPerSecond, first.chunksPerSecond),
    ],
    ["Manifest KV writes", formatNumber(first.kv.writes), formatNumber(second.kv.writes), "—"],
    ["Max concurrent embeds", formatNumber(first.embedder.maxActive), formatNumber(second.embedder.maxActive), "—"],
    ["RSS after run (MiB)", formatNumber(first.rssMiB, 1), formatNumber(second.rssMiB, 1), "—"],
  ]

  const lines = [
    `| Metric | concurrency ${first.concurrency} | concurrency ${second.concurrency} | Speedup |`,
    "| --- | ---: | ---: | ---: |",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ]
  console.log(lines.join("\n"))
}

async function main() {
  if (wantsHelp) {
    printUsage()
    return
  }

  const fileCount = numberOption("files", 1000, { integer: true })
  const latencyMs = numberOption("latency", 25)
  const upsertDelayMs = numberOption("upsert", 1)
  const concurrencies = [
    BASELINE_CONCURRENCY,
    numberOption("concurrency", DEFAULT_CANDIDATE_CONCURRENCY, { integer: true }),
  ]
  const keepTemp = argv.includes("--keep")

  let tempRoot
  try {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-indexing-perf-"))
    const workspace = path.join(tempRoot, "workspace")
    const configHome = path.join(tempRoot, "config")
    const stateHome = path.join(tempRoot, "state")
    await Promise.all([
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(configHome, { recursive: true }),
      fs.mkdir(stateHome, { recursive: true }),
    ])

    // Redirect every XDG lookup before importing modules that read them.
    process.env.XDG_CONFIG_HOME = configHome
    process.env.XDG_STATE_HOME = stateHome

    await generateWorkspace(workspace, fileCount)

    const { runIndex } = await import(pathToFileURL(path.join(REPO_ROOT, "src", "indexer.ts")).href)
    const settings = buildSettings(tempRoot)

    // Warm the lazy tree-sitter/WASM chunker and the module graph once, so the
    // first measured run is not charged for initialization the second avoids.
    const warmupWorkspace = path.join(tempRoot, "warmup")
    await generateWorkspace(warmupWorkspace, 4)
    await measureRun(runIndex, {
      workspace: warmupWorkspace,
      settings,
      concurrency: concurrencies[0],
      latencyMs,
      upsertDelayMs,
    })

    console.log(
      `files: ${fileCount} · fake embed latency: ${latencyMs} ms/call · ` +
        `upsert delay: ${upsertDelayMs} ms/call · batch size: ${EMBEDDING_BATCH_SIZE} · dimension: ${DIMENSION}`,
    )
    console.log(
      `warm-up: 4 files, not measured · run order: ${concurrencies.join(", then ")} (single measured run each)\n`,
    )

    const runs = []
    for (const concurrency of concurrencies) {
      runs.push(
        await measureRun(runIndex, {
          workspace,
          settings,
          concurrency,
          latencyMs,
          upsertDelayMs,
        }),
      )
    }

    const [first, second] = runs
    printTable(first, second)

    const notes = []
    if (first.embedder.maxActive === concurrencies[0] && second.embedder.maxActive === concurrencies[1]) {
      notes.push(
        `\`KILO_INDEX_EMBEDDING_CONCURRENCY\` was honored: observed ${first.embedder.maxActive} and ` +
          `${second.embedder.maxActive} in-flight embedding calls.`,
      )
    } else if (first.embedder.maxActive === second.embedder.maxActive) {
      notes.push(
        `Requested ${concurrencies.join(" and ")} in-flight embedding calls; both runs used the same ` +
          `observed value (${first.embedder.maxActive}). This build may ignore ` +
          `\`KILO_INDEX_EMBEDDING_CONCURRENCY\`, or there were too few batches to reach the requested limit.`,
      )
    } else {
      notes.push(
        `Requested ${concurrencies.join(" and ")} in-flight embedding calls; observed ` +
          `${first.embedder.maxActive} and ${second.embedder.maxActive}. This build may ignore ` +
          `\`KILO_INDEX_EMBEDDING_CONCURRENCY\`, or there were too few batches to reach the requested limit.`,
      )
    }
    if (first.report.chunksUpserted !== second.report.chunksUpserted) {
      notes.push(
        `Warning: the runs produced different chunk counts (${first.report.chunksUpserted} vs ` +
          `${second.report.chunksUpserted}); the synthetic workspace should be identical.`,
      )
    }
    notes.push(
      "Synthetic files, deterministic fake vectors and an in-memory store/KV: this measures batching" +
        " and bookkeeping, not provider quality, latency or cost.",
    )
    console.log(`\nNotes:\n${notes.map((note) => `- ${note}`).join("\n")}`)
  } finally {
    if (tempRoot) {
      if (keepTemp) console.error(`\nkept temporary directory: ${tempRoot}`)
      else await fs.rm(tempRoot, { recursive: true, force: true })
    }
  }
}

main().catch((error) => {
  console.error(`perf benchmark failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
