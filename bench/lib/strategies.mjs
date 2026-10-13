/**
 * Retrieval strategies for the benchmark.
 *
 * Each one maps a natural-language query to a ranked list of repository-relative
 * file paths. Shared by the single-repository runner and the multi-repository
 * comparison so both score exactly the same thing.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".lancedb", ".codegraph", "docs", "bin", "obj", "target", "vendor"])
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".wasm", ".zip", ".tgz", ".gz", ".7z", ".exe", ".dll", ".so", ".dylib", ".jar", ".class", ".pyc", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mp3", ".sqlite", ".db", ".bin"])
const SKIP_FILE = [/package-lock\.json$/i, /yarn\.lock$/i, /\.(lock|map)$/i]
const STOP = new Set(["the", "a", "an", "of", "to", "and", "or", "for", "in", "on", "with", "how", "where", "what", "which", "is", "are", "do", "does", "we", "it", "that", "this", "from", "into", "used", "use", "when", "by", "be", "before", "them", "they", "their", "its", "not", "has", "have", "but", "all", "can", "will", "was", "were", "been"])

const rel = (repo, file) => path.relative(repo, file).split(path.sep).join("/")

export const terms = (query) =>
  [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t)))]

export function* walk(repo, dir) {
  for (const entry of fs.readdirSync(dir ?? repo, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir ?? repo, entry.name)
    if (entry.isDirectory()) yield* walk(repo, full)
    else yield full
  }
}

/**
 * Text or not, decided by the bytes rather than by extension.
 *
 * An extension list silently scored zero on any language it did not know: a
 * C# or Rust repository produced an empty baseline that looked like the other
 * strategies winning, rather than like a bug here.
 */
export function isTextFile(file) {
  if (BINARY_EXT.has(path.extname(file).toLowerCase())) return false
  let handle
  try {
    handle = fs.openSync(file, "r")
    const buffer = Buffer.alloc(1024)
    const read = fs.readSync(handle, buffer, 0, 1024, 0)
    return !buffer.subarray(0, read).includes(0)
  } catch {
    return false
  } finally {
    if (handle !== undefined) fs.closeSync(handle)
  }
}

/** Keyword baseline: rank files by distinct query terms, then by hit count. */
export function keywordRanked(repo, query, limit) {
  const ts = terms(query)
  if (ts.length === 0) return []
  const scored = []
  for (const file of walk(repo)) {
    const relative = rel(repo, file)
    if (SKIP_FILE.some((re) => re.test(relative))) continue
    if (!isTextFile(file)) continue
    let text
    try {
      text = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    if (text.length > 2_000_000) continue
    const low = text.toLowerCase()
    let distinct = 0
    let hits = 0
    for (const t of ts) {
      const count = low.split(t).length - 1
      if (count > 0) {
        distinct++
        hits += Math.min(count, 20)
      }
    }
    if (distinct === 0) continue
    scored.push({ file: relative, distinct, hits })
  }
  scored.sort((a, b) => b.distinct - a.distinct || b.hits - a.hits || a.file.localeCompare(b.file))
  return scored.slice(0, limit).map((s) => s.file)
}

/**
 * The plugin's own semantic search, invoked through test/cli.ts.
 *
 * `cwd` is the plugin repository, not the corpus: `test/cli.ts` is part of the
 * harness and the corpus is reached through `--root`. Running from the corpus
 * instead makes every query fail to find the script and score zero, which
 * reads like a terrible retrieval result rather than a broken command.
 */
export function semanticRanked(repo, query, limit, template, cwd) {
  const [bin, ...rest] = template.split(/\s+/)
  const args = rest.map((a) => a.replace("{query}", query).replace("{root}", repo))
  let out = ""
  try {
    out = execFileSync(bin, args, { cwd: cwd ?? repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch (error) {
    out = `${error.stdout ?? ""}${error.stderr ?? ""}`
    if (!out.trim()) throw new Error(`semantic command failed: ${error.message}`)
  }
  const ranked = []
  for (const line of out.split(/\r?\n/)) {
    for (const match of line.matchAll(/[\w./\\-]+\.\w{1,6}/g)) {
      const candidate = match[0].replaceAll("\\", "/")
      if (!ranked.includes(candidate) && fs.existsSync(path.join(repo, candidate))) ranked.push(candidate)
    }
  }
  return ranked.slice(0, limit)
}

/** Windows ships a .cmd shim for npm binaries; resolve whichever is on PATH. */
export function resolveBinary(name) {
  if (process.platform !== "win32") return name
  const shim = `${name}.cmd`
  // Look along PATH, not the working directory: a relative check reports the
  // bare name as missing while the command works fine from a shell.
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const onPath = dirs.some((dir) => fs.existsSync(path.join(dir, shim)) || fs.existsSync(path.join(dir, name)))
  return onPath ? shim : name
}

/**
 * Symbol-graph lookup.
 *
 * This matches symbol names, not meaning. It is the honest structural baseline:
 * a query whose words match no symbol cannot reach anything through it, which
 * is the complementarity the plugin claims rather than a defect.
 */
export function graphRanked(repo, query, limit, graphPath) {
  const bin = resolveBinary("codegraph")
  const onWindows = process.platform === "win32"
  // Node cannot exec a .cmd shim directly on Windows, so that case goes through
  // the shell — which means quoting is our job. Passing an args array with
  // `shell: true` concatenates them bare, turning a multi-word query into one
  // argument per word.
  const quote = (value) => `"${String(value).replace(/["&|<>^%]/g, " ")}"`
  const parts = [
    bin,
    "query",
    quote(query),
    "--json",
    "-l",
    quote(limit * 4),
    "-p",
    quote(graphPath ?? repo),
  ]
  const out = execFileSync(onWindows ? parts.join(" ") : parts[0], onWindows ? [] : parts.slice(1), {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    shell: onWindows,
  })
  const rows = JSON.parse(out)
  const ranked = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const filePath = row?.node?.filePath
    if (typeof filePath !== "string") continue
    const candidate = filePath.replaceAll("\\", "/")
    if (candidate && !ranked.includes(candidate)) ranked.push(candidate)
    if (ranked.length >= limit) break
  }
  return ranked
}

/**
 * Reciprocal rank fusion.
 *
 * Combines rankings without needing their scores on a common scale, which is
 * the point: a cosine score and a graph score are not comparable numbers.
 */
export function reciprocalRankFusion(rankings, constant = 60) {
  const scores = new Map()
  for (const ranked of rankings) {
    ranked.forEach((file, index) => {
      scores.set(file, (scores.get(file) ?? 0) + 1 / (constant + index + 1))
    })
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([file]) => file)
}

/**
 * The ablation: each condition is one ranker standing alone.
 *
 * `keyword` is the floor every deployment already has; `graph` and `semantic`
 * are the two additions measured on their own; `fusion` is the pair combined.
 *
 * Rankings are memoised per query. Beyond halving the embedding API calls —
 * the semantic strategy embeds every query — it also means `fusion` fuses the
 * very same runs `semantic` and `graph` were scored on, rather than a second,
 * slightly different sample of them.
 */
export function makeStrategies({ repo, limit, semanticTemplate, graphPath, cwd }) {
  const cache = new Map()
  const memo = (name, run) => (query) => {
    const key = `${name}:${query}`
    if (!cache.has(key)) cache.set(key, run(query))
    return cache.get(key)
  }

  const semantic = memo("semantic", (query) => semanticRanked(repo, query, limit, semanticTemplate, cwd))
  const graph = memo("graph", (query) => graphRanked(repo, query, limit, graphPath))

  return {
    keyword: memo("keyword", (query) => keywordRanked(repo, query, limit)),
    graph,
    semantic,
    fusion: (query) =>
      reciprocalRankFusion([semantic(query), graph(query)].filter(Array.isArray)).slice(0, limit),
  }
}

export const STRATEGY_NAMES = ["keyword", "graph", "semantic", "fusion"]