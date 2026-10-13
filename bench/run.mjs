#!/usr/bin/env node
/**
 * Retrieval benchmark for opencode-indexing.
 *
 * Runs a labeled query set through one or more strategies and reports ranking
 * metrics (Hit@k, Recall@k, MRR, nDCG@k). Two strategies ship here:
 *
 *   grep   - keyword baseline (OR of the query terms, ranked by coverage).
 *   plugin - the plugin's own semantic search, invoked through test/cli.ts.
 *            Requires a configured embedding provider and a built index.
 *
 * Usage:
 *   node bench/run.mjs --strategy grep
 *   node bench/run.mjs --strategy grep,plugin --k 10
 *   node bench/run.mjs --vector-cmd 'node test/cli.ts search {query} --root {root}'
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { hitAtK, recallAtK, reciprocalRank, ndcgAtK, mean } from "./lib/metrics.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, "..")
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

const repo = path.resolve(flag("repo", ROOT))
const k = Number(flag("k", 10))
const strategies = flag("strategy", "grep").split(",").map((s) => s.trim()).filter(Boolean)
const setFile = path.resolve(flag("queries", path.join(HERE, "queries.json")))
const outFile = path.resolve(flag("out", path.join(HERE, "results.md")))

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".lancedb", ".codegraph", "docs"])
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".sh", ".ps1", ".yml", ".yaml", ".txt"])
const SKIP_FILE = [/\.(png|jpe?g|gif|ico|pdf|wasm|zip|tgz|lock)$/i, /package-lock\.json$/]
const STOP = new Set(["the", "a", "an", "of", "to", "and", "or", "for", "in", "on", "with", "how", "where", "what", "which", "is", "are", "do", "does", "we", "it", "that", "this", "from", "into", "used", "use", "when", "by", "be", "before", "them", "they", "their", "its"])

const rel = (p) => path.relative(repo, p).split(path.sep).join("/")

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

const terms = (q) =>
  [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t)))]

function grepRanked(query, limit) {
  const ts = terms(query)
  const scored = []
  for (const file of walk(repo)) {
    if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue
    const r = rel(file)
    if (SKIP_FILE.some((re) => re.test(r))) continue
    let text
    try { text = fs.readFileSync(file, "utf8") } catch { continue }
    if (text.length > 2_000_000) continue
    const low = text.toLowerCase()
    let distinct = 0
    let hits = 0
    for (const t of ts) {
      const c = low.split(t).length - 1
      if (c > 0) { distinct++; hits += Math.min(c, 20) }
    }
    if (distinct === 0) continue
    scored.push({ file: r, distinct, hits })
  }
  scored.sort((a, b) => b.distinct - a.distinct || b.hits - a.hits || a.file.localeCompare(b.file))
  return scored.slice(0, limit).map((s) => s.file)
}

function pluginRanked(query, limit) {
  const tmpl = flag("vector-cmd", "node test/cli.ts search {query} --root {root}")
  const [bin, ...rest] = tmpl.split(/\s+/)
  const args = rest.map((a) => a.replace("{query}", query).replace("{root}", repo))
  let out = ""
  try {
    out = execFileSync(bin, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch (error) {
    out = `${error.stdout ?? ""}${error.stderr ?? ""}`
    if (!out.trim()) throw new Error(`plugin command failed: ${error.message}`)
  }
  const ranked = []
  for (const line of out.split(/\r?\n/)) {
    for (const m of line.matchAll(/[\w./\\-]+\.\w{1,6}/g)) {
      const cand = m[0].replaceAll("\\", "/")
      if (!ranked.includes(cand) && fs.existsSync(path.join(repo, cand))) ranked.push(cand)
    }
  }
  return ranked.slice(0, limit)
}

const STRATEGIES = { grep: grepRanked, plugin: pluginRanked }

const data = JSON.parse(fs.readFileSync(setFile, "utf8"))
const results = {}
for (const strategy of strategies) {
  const fn = STRATEGIES[strategy]
  if (!fn) {
    console.error(`unknown strategy: ${strategy} (have: ${Object.keys(STRATEGIES).join(", ")})`)
    process.exit(2)
  }
  const rows = []
  for (const q of data.queries) {
    let ranked = []
    let error
    try { ranked = fn(q.query, k) } catch (e) { error = String(e.message ?? e) }
    rows.push({
      id: q.id, type: q.type, query: q.query, expected: q.expected, ranked, error,
      hit: error ? 0 : hitAtK(ranked, q.expected, k),
      recall: error ? 0 : recallAtK(ranked, q.expected, k),
      rr: error ? 0 : reciprocalRank(ranked, q.expected),
      ndcg: error ? 0 : ndcgAtK(ranked, q.expected, k),
    })
  }
  results[strategy] = {
    rows,
    agg: {
      n: rows.length,
      hit: mean(rows.map((r) => r.hit)),
      recall: mean(rows.map((r) => r.recall)),
      mrr: mean(rows.map((r) => r.rr)),
      ndcg: mean(rows.map((r) => r.ndcg)),
    },
  }
}

const pct = (x) => `${(x * 100).toFixed(1)}%`
const lines = [`# Benchmark results`, "", `Corpus: \`${path.relative(ROOT, repo) || "."}\` · k=${k} · queries=${data.queries.length}`, ""]
lines.push(`| Strategy | Hit@${k} | Recall@${k} | MRR | nDCG@${k} |`, "| --- | --- | --- | --- | --- |")
for (const s of strategies) {
  const a = results[s].agg
  lines.push(`| ${s} | ${pct(a.hit)} | ${pct(a.recall)} | ${a.mrr.toFixed(3)} | ${a.ndcg.toFixed(3)} |`)
}
lines.push("")
lines.push(`### By query type`, "")
lines.push(`| Strategy | type | n | Hit@${k} | MRR |`, "| --- | --- | --- | --- | --- |")
for (const s of strategies) {
  for (const t of ["concept", "identifier"]) {
    const rows = results[s].rows.filter((r) => r.type === t)
    if (!rows.length) continue
    lines.push(`| ${s} | ${t} | ${rows.length} | ${pct(mean(rows.map((r) => r.hit)))} | ${mean(rows.map((r) => r.rr)).toFixed(3)} |`)
  }
}
lines.push("")
for (const s of strategies) {
  lines.push(`## ${s} — per query`, "")
  lines.push(`| id | type | rank of first hit | hit@${k} |`, "| --- | --- | --- | --- |")
  for (const r of results[s].rows) {
    const rank = r.ranked.findIndex((d) => r.expected.includes(d))
    lines.push(`| ${r.id} | ${r.type} | ${r.error ? `ERROR: ${r.error}` : rank === -1 ? "not found" : rank + 1} | ${r.hit ? "✓" : "✗"} |`)
  }
  lines.push("")
}

fs.writeFileSync(outFile, lines.join("\n"))
for (const s of strategies) {
  const a = results[s].agg
  console.log(`${s.padEnd(8)} Hit@${k}=${pct(a.hit)}  Recall@${k}=${pct(a.recall)}  MRR=${a.mrr.toFixed(3)}  nDCG@${k}=${a.ndcg.toFixed(3)}`)
}
console.log(`\nwrote ${path.relative(ROOT, outFile)}`)
