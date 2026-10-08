/**
 * Standalone CLI harness for developing/testing the plugin core without OpenCode.
 *
 * Usage:
 *   node test/cli.ts status    [--root D:\path] [--vector-store qdrant|lancedb]
 *   node test/cli.ts search "query" [--root D:\path] [--path sub/dir]
 *   node test/cli.ts refresh   [--root D:\path] [--max-files 50]
 *   node test/cli.ts build     [--root D:\path] [--rebuild] [--skip-import]
 *   node test/cli.ts import    [--root D:\path] [--source <name>] [--rebuild]
 *   node test/cli.ts candidates [--root D:\path]
 *
 * Reads settings from ~/.config/opencode/indexing.json, then env vars, then
 * ~/.config/kilo/kilo.jsonc (same precedence as the plugin).
 * Writes manifests to test/.state/ (gitignored).
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { resolveSettings } from "../src/config.ts"
import { runIndex } from "../src/indexer.ts"
import { kiloCollectionCandidates } from "../src/kilo-store.ts"
import { createQdrant } from "../src/qdrant.ts"
import { searchCode } from "../src/search.ts"
import { getStatus } from "../src/status.ts"
import { createMemoryStorage } from "../src/storage.ts"
import { discoverKiloSources, importFromKilo } from "../src/import.ts"
import { createOwnStore, createSettingsQdrant } from "../src/store-factory.ts"

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

const command = process.argv[2] ?? "status"
const root = path.resolve(flag("root") ?? process.cwd())

// Persistent-enough state across CLI invocations: a JSON file.
const stateDir = path.join(import.meta.dirname ?? ".", ".state")
fs.mkdirSync(stateDir, { recursive: true })
const stateFile = path.join(stateDir, "kv.json")
let diskState: Record<string, unknown> = {}
try {
  diskState = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>
} catch {
  diskState = {}
}
const kv = createMemoryStorage(diskState)
const originalSet = kv.set.bind(kv)
const originalRemove = kv.remove.bind(kv)
kv.set = async (key, value) => {
  await originalSet(key, value)
  diskState[key] = value
  fs.writeFileSync(stateFile, JSON.stringify(diskState, null, 2))
}
kv.remove = async (key) => {
  await originalRemove(key)
  delete diskState[key]
  fs.writeFileSync(stateFile, JSON.stringify(diskState, null, 2))
}

const options = {
  provider: flag("provider"),
  model: flag("model"),
  dimension: flag("dimension") ? Number(flag("dimension")) : undefined,
  vectorStore: flag("vector-store") as "qdrant" | "lancedb" | undefined,
  qdrantUrl: flag("qdrant"),
  lancedbDirectory: flag("lancedb-dir"),
  searchMaxResults: flag("limit") ? Number(flag("limit")) : undefined,
  importFromKilo: hasFlag("skip-import") ? false : undefined,
}
const settings = resolveSettings({ ...options, homeDir: os.homedir() })
const qdrant = createQdrant({ url: settings.qdrantUrl, apiKey: settings.qdrantApiKey })

const print = (label: string, value: unknown) => {
  console.log(`\n=== ${label} ===`)
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2))
}

switch (command) {
  case "candidates": {
    print("workspace", root)
    print("kilo candidates", kiloCollectionCandidates(root))
    print("own store", { kind: settings.vectorStore, name: createOwnStore(settings, root).name })
    print("collections in qdrant", await qdrant.listCollections())
    break
  }
  case "status": {
    const status = await getStatus({ qdrant, kv, root, settings }, { checkFreshness: true })
    print("status", status)
    break
  }
  case "search": {
    const query = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : flag("q")
    if (!query) throw new Error("usage: cli.ts search \"query\" [--path sub/dir]")
    const outcome = await searchCode({ qdrant, kv, root, settings }, query, flag("path"), flag("limit") ? Number(flag("limit")) : undefined)
    print("meta", outcome.meta)
    if (outcome.errors.length) print("errors", outcome.errors)
    for (const [index, hit] of outcome.hits.entries()) {
      console.log(`\n${index + 1}. [${hit.source}] ${hit.filePath}:${hit.startLine}-${hit.endLine} (score ${hit.score.toFixed(4)})`)
      console.log(hit.codeChunk.slice(0, 400))
    }
    break
  }
  case "refresh":
  case "build": {
    const report = await runIndex(
      {
        kv,
        root,
        settings,
        qdrant,
        onProgress: (update) => {
          if (update.processed === 0 || update.processed === update.total || update.processed % 200 === 0) {
            console.log(`[${update.phase}] ${update.processed}/${update.total}`)
          }
        },
      },
      {
        mode: command === "refresh" ? "refresh" : "build",
        rebuild: hasFlag("rebuild"),
        skipImport: hasFlag("skip-import"),
        maxFiles: flag("max-files") ? Number(flag("max-files")) : undefined,
      },
    )
    print("report", report)
    break
  }
  case "import": {
    const store = createOwnStore(settings, root)
    const info = await store.info()
    const dimension = settings.dimension || info.profile?.dimension || 0
    if (!dimension) throw new Error("Embedding dimension unknown; run status first")
    const targetProfile = { provider: settings.provider, modelId: settings.modelId, dimension }
    if (hasFlag("rebuild")) {
      if (store.kind === "qdrant") {
        const client = createSettingsQdrant(settings)
        if (await client.collectionExists(store.name)) await client.deleteCollection(store.name)
      } else {
        fs.rmSync(store.name, { recursive: true, force: true })
      }
    }
    await store.ensure(dimension, targetProfile)
    const sources = await discoverKiloSources(root, { qdrant, targetProfile })
    print("sources", sources)
    const wanted = flag("source")
    const source = wanted ? sources.find((item) => item.name === wanted) : (sources.find((item) => item.compatible) ?? sources[0])
    if (!source) throw new Error("No Kilo source available for import")
    if (!source.compatible) throw new Error(`Source ${source.name} has an incompatible embedding profile`)
    const report = await importFromKilo({
      root,
      source,
      target: store,
      targetProfile,
      qdrant,
      onProgress: (update) => {
        if (update.imported % 1000 === 0 || update.imported === update.total) {
          console.log(`[import] ${update.imported}/${update.total ?? "?"}`)
        }
      },
    })
    print("import report", { imported: report.imported, batches: report.batches, skipped: report.skipped, durationMs: report.durationMs })
    break
  }
  default:
    console.error(`Unknown command: ${command}`)
    process.exit(1)
}
