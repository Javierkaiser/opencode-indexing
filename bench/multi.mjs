#!/usr/bin/env node
/**
 * Multi-repository comparison of retrieval strategies.
 *
 * Runs the same four conditions over several codebases and writes a report that
 * names none of them. Projects appear as P1..Pn with their size; the mapping
 * from label to path lives in `projects.local.json`, which is gitignored,
 * because a report that could identify the repository it describes is not safe
 * to publish.
 *
 * Conditions are an ablation: each one is a single ranker standing alone, so the
 * numbers say what each signal contributes rather than how much stacking helps.
 *
 * Usage:
 *   node bench/multi.mjs --k 10
 *   node bench/multi.mjs --projects bench/projects.local.json --out bench/results.md
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { hitAtK, recallAtK, reciprocalRank, ndcgAtK, mean } from "./lib/metrics.mjs"
import { makeStrategies, STRATEGY_NAMES, walk, isTextFile } from "./lib/strategies.mjs"
import { queriesFromCommits } from "./lib/commits.mjs"
import { resolveSettings } from "../src/config.ts"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

const k = Number(flag("k", 10))
const manifestFile = path.resolve(flag("projects", path.join(HERE, "projects.local.json")))
const outFile = path.resolve(flag("out", path.join(HERE, "results.md")))
const semanticTemplate = flag("semantic-cmd", "node test/cli.ts search {query} --root {root}")
const commitLimit = Number(flag("commit-queries", 40))

// Read from the plugin rather than copying the list, so the benchmark cannot
// quietly drift from what is actually indexed.
const indexedExtensions = new Set(
  resolveSettings({ homeDir: os.homedir() })
    .fileExtensions.map((extension) => extension.toLowerCase()),
)

if (!fs.existsSync(manifestFile)) {
  console.error(`no manifest at ${manifestFile}`)
  console.error("create it with: [{ \"label\": \"P1\", \"root\": \"/abs/path\" }]")
  process.exit(2)
}
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"))

/** root -> index collection, so a report can state how big each index is. */
function readIndexPoints() {
  const file = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "opencode",
    "indexing-workspaces.json",
  )
  const map = new Map()
  try {
    for (const entry of JSON.parse(fs.readFileSync(file, "utf8"))) {
      if (entry?.root && entry?.store) map.set(entry.root, entry.store)
    }
  } catch {
    // No registry yet: sizes fall back to "not indexed".
  }
  return map
}

async function pointsIn(collection, qdrantUrl) {
  try {
    const response = await fetch(`${qdrantUrl}/collections/${collection}`)
    if (!response.ok) return null
    const body = await response.json()
    return body?.result?.points_count ?? null
  } catch {
    return null
  }
}

function corpusSize(repo) {
  let files = 0
  let lines = 0
  for (const file of walk(repo)) {
    if (!isTextFile(file)) continue
    try {
      const text = fs.readFileSync(file, "utf8")
      if (text.length > 2_000_000) continue
      files++
      lines += text.split("\n").length
    } catch {
      // unreadable file: not counted
    }
  }
  return { files, lines }
}

const indexPoints = readIndexPoints()
const qdrantUrl = process.env.KILO_INDEX_QDRANT_URL ?? "http://localhost:6333"
const pct = (x) => `${(x * 100).toFixed(1)}%`
const compact = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

const projectLines = []
const reportLines = ["# Benchmark results — multi-repository", "", "Anonymised by design: no path, file name or query text appears below.", ""]

for (const entry of manifest) {
  const repo = path.resolve(entry.root)
  const label = entry.label
  const size = corpusSize(repo)
  const store = indexPoints.get(repo)
  const points = store ? await pointsIn(store, qdrantUrl) : null
  const graph = fs.existsSync(path.join(repo, ".codegraph"))

  reportLines.push(`## ${label}`, "")
  reportLines.push("| files | lines | own index | symbol graph |", "| --- | --- | --- | --- |")
  reportLines.push(
    `| ${size.files} | ${compact(size.lines)} | ${points === null ? "not indexed" : `${points} pts`} | ${graph ? "indexed" : "not indexed"} |`,
  )
  reportLines.push("")

  const sets = []
  if (entry.queries) {
    sets.push({ name: "labelled", queries: JSON.parse(fs.readFileSync(path.resolve(entry.queries), "utf8")).queries })
  }
  let commitQueries = []
  try {
    commitQueries = queriesFromCommits(repo, { limit: commitLimit, extensions: indexedExtensions })
    if (commitQueries.length > 0) sets.push({ name: "commits", queries: commitQueries })
  } catch (error) {
    console.error(`${label}: commit-derived queries unavailable — ${error.message}`)
  }

  if (commitQueries.length === 0 && !entry.queries) {
    // Silently dropping the project would read as "measured, nothing to say".
    reportLines.push(
      `_Not measured: no single-file commit in the scanned history touches a file type the index covers, so no query could be generated._`,
      "",
    )
    console.log(`${label}: no usable commit-derived queries, skipped`)
    continue
  }

  const strategies = makeStrategies({
    repo,
    limit: k,
    semanticTemplate,
    graphPath: repo,
    // The harness lives here; the corpus is reached through --root.
    cwd: path.join(HERE, ".."),
  })

  for (const set of sets) {
    reportLines.push(`### ${label} · query set: ${set.name} (n=${set.queries.length})`, "")
    reportLines.push(`| Condition | n | Hit@${k} | Recall@${k} | MRR | nDCG@${k} |`, "| --- | --- | --- | --- | --- | --- |")

    for (const name of STRATEGY_NAMES) {
      const rows = []
      for (const query of set.queries) {
        let ranked = []
        let error
        try {
          ranked = strategies[name](query.query) ?? []
        } catch (e) {
          error = String(e.message ?? e)
        }
        rows.push({
          id: query.id,
          type: query.type,
          error,
          hit: error ? 0 : hitAtK(ranked, query.expected, k),
          recall: error ? 0 : recallAtK(ranked, query.expected, k),
          rr: error ? 0 : reciprocalRank(ranked, query.expected),
          ndcg: error ? 0 : ndcgAtK(ranked, query.expected, k),
        })
      }

      const failed = rows.filter((row) => row.error).length
      if (failed === rows.length) {
        // A condition that could not run at all is not a condition that scored
        // zero; saying "0%" would blame the strategy for a missing index.
        reportLines.push(`| ${name} | ${rows.length} | n/a | n/a | n/a | n/a |`)
        console.log(`${label}/${set.name}/${name.padEnd(8)} n/a (${rows[0]?.error ?? "no results"})`)
        continue
      }
      const ok = rows.filter((row) => !row.error)
      reportLines.push(
        `| ${name} | ${ok.length} | ${pct(mean(ok.map((r) => r.hit)))} | ${pct(mean(ok.map((r) => r.recall)))} | ${mean(ok.map((r) => r.rr)).toFixed(3)} | ${mean(ok.map((r) => r.ndcg)).toFixed(3)} |`,
      )
      console.log(`${label}/${set.name}/${name.padEnd(8)} Hit@${k}=${pct(mean(ok.map((r) => r.hit)))}  MRR=${mean(ok.map((r) => r.rr)).toFixed(3)}`)

      for (const type of ["concept", "identifier"]) {
        const typed = ok.filter((row) => row.type === type)
        if (!typed.length) continue
        projectLines.push(`| ${label} | ${set.name} | ${name} | ${type} | ${typed.length} | ${pct(mean(typed.map((r) => r.hit)))} | ${mean(typed.map((r) => r.rr)).toFixed(3)} |`)
      }
    }
    reportLines.push("")
    if (set.queries.length < 10) {
      // A sample this size cannot support a comparison. Saying so is the
      // difference between a benchmark and a coincidence.
      reportLines.push(
        `_n=${set.queries.length} is too small to conclude from: treat these numbers as indicative only._`,
        "",
      )
    }
  }
}

if (projectLines.length > 0) {
  reportLines.push("## By query type", "")
  reportLines.push(`| Project | Query set | Condition | Type | n | Hit@${k} | MRR |`, "| --- | --- | --- | --- | --- | --- | --- |")
  reportLines.push(...projectLines)
  reportLines.push("")
}

reportLines.unshift(`k=${k} · embedding profile recorded in bench/README.md · the model matters for these numbers.`, "")
fs.writeFileSync(outFile, reportLines.join("\n"))
console.log(`\nwrote ${path.relative(process.cwd(), outFile)}`)