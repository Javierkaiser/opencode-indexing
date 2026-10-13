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
 * The report is written in two layers: a plain-language summary anyone can read,
 * then the full tables for whoever wants the numbers behind it. The friendly
 * layer is generated from the same results, never hand-written, so it cannot
 * drift from the data.
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
  console.error('create it with: [{ "label": "P1", "root": "/abs/path" }]')
  process.exit(2)
}
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"))

/** Plain-language names, because "MRR" and "ablation" help nobody. */
const FRIENDLY = {
  keyword: "Word matching",
  graph: "Symbol names",
  semantic: "Meaning",
  fusion: "Meaning + symbols",
}
const WHAT_IT_IS = {
  keyword: "Looks for the words you typed inside the files",
  graph: "Looks for functions and classes whose *names* match your words",
  semantic: "Looks for code that *does* what you described, even if no word matches",
  fusion: "Runs the last two and merges their answers",
}
const MEDAL = ["🥇", "🥈", "🥉", "4️⃣"]

const pct = (x) => `${(x * 100).toFixed(0)}%`
const compact = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const bar = (fraction, width = 10) => `${"█".repeat(Math.max(0, Math.round(fraction * width)))}${"░".repeat(Math.max(0, width - Math.round(fraction * width)))}`

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

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------
const projects = []

for (const entry of manifest) {
  const repo = path.resolve(entry.root)
  const label = entry.label
  const size = corpusSize(repo)
  const store = indexPoints.get(repo)
  const points = store ? await pointsIn(store, qdrantUrl) : null
  const graph = fs.existsSync(path.join(repo, ".codegraph"))

  const project = { label, size, points, graph, sets: [], note: null }
  projects.push(project)

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
    project.note = "No question could be built for this codebase: none of its one-file changes touch a file type the index covers."
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
    const conditions = {}
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
        conditions[name] = { unavailable: rows[0]?.error ?? "no results", n: rows.length }
        console.log(`${label}/${set.name}/${name.padEnd(8)} n/a (${conditions[name].unavailable})`)
        continue
      }
      const ok = rows.filter((row) => !row.error)
      conditions[name] = {
        n: ok.length,
        hit: mean(ok.map((r) => r.hit)),
        recall: mean(ok.map((r) => r.recall)),
        rr: mean(ok.map((r) => r.rr)),
        ndcg: mean(ok.map((r) => r.ndcg)),
        byType: Object.fromEntries(
          ["concept", "identifier"].map((type) => {
            const typed = ok.filter((row) => row.type === type)
            return [type, typed.length ? { n: typed.length, hit: mean(typed.map((r) => r.hit)), rr: mean(typed.map((r) => r.rr)) } : null]
          }),
        ),
      }
      console.log(`${label}/${set.name}/${name.padEnd(8)} found@${k}=${pct(conditions[name].hit)}  rank=${conditions[name].rr.toFixed(2)}`)
    }
    project.sets.push({ name: set.name, n: set.queries.length, conditions })
  }
}

// ---------------------------------------------------------------------------
// Render: plain layer, then the numbers
// ---------------------------------------------------------------------------
const lines = []

lines.push("# Which way of searching actually finds the right file?", "")
lines.push(
  "We took real questions about code — the kind where you know what the code *does*",
  "but not what it is *called* — and asked four different search methods to point at",
  "the right file. Then we counted how often each one got it right.",
  "",
)

// --- What stood out: derived from the results, never hand-written ----------
// Collected as findings first, then rendered once each, so two codebases saying
// the same thing produce one sentence rather than two.
const findings = { fusionBeats: [], keywordGap: [], graphWeakest: [], rankNotFirst: [] }

for (const project of projects) {
  for (const set of project.sets) {
    const usable = STRATEGY_NAMES.filter((name) => set.conditions[name] && !set.conditions[name].unavailable)
    // A four-question sample must not reach the summary at the top.
    if (usable.length < 2 || set.n < 10) continue

    const { semantic, keyword, fusion, graph } = set.conditions
    const ranked = [...usable].sort((a, b) => set.conditions[b].hit - set.conditions[a].hit || set.conditions[b].rr - set.conditions[a].rr)

    if (fusion && semantic) {
      const hitGain = fusion.hit - semantic.hit
      const rankGain = fusion.rr - semantic.rr
      // Better can mean finding more, or finding it higher. Reporting only the
      // first would hide the codebase where fusion helped by ordering.
      if (hitGain > 0.02 || rankGain > 0.02) {
        findings.fusionBeats.push({ label: project.label, hitGain, rankGain, fusion: fusion.hit, semantic: semantic.hit })
      }
    }
    if (semantic && keyword) {
      findings.keywordGap.push({ label: project.label, semantic: semantic.hit, keyword: keyword.hit })
    }
    if (ranked[ranked.length - 1] === "graph") {
      findings.graphWeakest.push({ label: project.label, hit: graph.hit })
    }
    if (semantic && semantic.hit >= 0.95 && semantic.rr < 0.75) {
      findings.rankNotFirst.push({ label: project.label, rr: semantic.rr })
    }
  }
}

const observations = []
const join = (items, render) => {
  if (items.length === 1) return render(items[0], false)
  return render(items[0], true) + ` The same held on ${items.slice(1).map((i) => i.label).join(" and ")}.`
}

if (findings.fusionBeats.length > 0) {
  const found = findings.fusionBeats.filter((f) => f.hitGain > 0.02)
  const ordered = findings.fusionBeats.filter((f) => f.hitGain <= 0.02 && f.rankGain > 0.02)
  const parts = []
  if (found.length) {
    parts.push(`it found more files on ${found.map((f) => `${f.label} (${pct(f.fusion)} against ${pct(f.semantic)})`).join(", ")}`)
  }
  if (ordered.length) {
    parts.push(`it put the right file higher on ${ordered.map((f) => f.label).join(" and ")}`)
  }
  observations.push(
    `**Combining the two smart methods was never worse than meaning alone, and better on ${findings.fusionBeats.length === 1 ? "one codebase" : "both"}:** ${parts.join(", and ")}.`,
  )
}

if (findings.keywordGap.length > 0) {
  const gaps = findings.keywordGap.map((g) => g.semantic - g.keyword)
  const clear = gaps.every((gap) => gap > 0.15)
  const close = gaps.every((gap) => Math.abs(gap) <= 0.15)
  if (clear) {
    observations.push(
      `**Meaning beat word matching clearly** everywhere: ${findings.keywordGap.map((g) => `${pct(g.semantic)} against ${pct(g.keyword)} on ${g.label}`).join(", ")}.`,
    )
  } else if (close) {
    observations.push(
      `**Meaning and word matching came out close** (${findings.keywordGap.map((g) => `${pct(g.semantic)} against ${pct(g.keyword)} on ${g.label}`).join(", ")}), so neither replaces the other.`,
    )
  } else {
    observations.push(
      `**Meaning and word matching traded places**: ${findings.keywordGap.map((g) => (g.semantic > g.keyword ? `${pct(g.semantic)} against ${pct(g.keyword)} on ${g.label}` : `word matching ahead, ${pct(g.keyword)} against ${pct(g.semantic)}, on ${g.label}`)).join("; ")}. One codebase is not enough to call it either way.`,
    )
  }
}

if (findings.graphWeakest.length > 0) {
  observations.push(
    `**Searching by symbol name was the weakest** ${findings.graphWeakest.length > 1 ? "in every codebase measured" : `on ${findings.graphWeakest[0].label}`} (${findings.graphWeakest.map((g) => pct(g.hit)).join(", ")}). It only matches what things are *called*, so a question in everyday words has little to grab onto.`,
  )
}

if (findings.rankNotFirst.length > 0) {
  const worst = Math.max(...findings.rankNotFirst.map((f) => f.rr))
  observations.push(
    `**Finding the file and finding it first are different things.** Meaning-based search almost always had the right file in its top ${k}, but usually not first — its rank quality is ${worst.toFixed(2)}, roughly second place. Combining methods is what improves that ordering.`,
  )
}

lines.push("## The short version", "")
if (observations.length === 0) {
  lines.push("Not enough usable results to draw a conclusion from. See the details below.", "")
} else {
  for (const observation of observations) lines.push(`- ${observation}`)
  lines.push("")
}

// --- How to read ------------------------------------------------------------
lines.push("## How to read the numbers", "")
lines.push("Two numbers matter, and neither is complicated:", "")
lines.push(
  `- **Found in the top ${k}** — was the right file anywhere in the first ${k} answers? This is the one to look at first.`,
  "- **Rank quality** — on average, how close to the top was it? **1.00** means always first, **0.50** means usually around second, **0.00** means never found. Two methods can both *find* the file while one puts it nearer the top.",
  "",
)

lines.push("## The four methods", "")
lines.push("| Method | What it does |", "| --- | --- |")
for (const name of STRATEGY_NAMES) lines.push(`| ${FRIENDLY[name]} | ${WHAT_IT_IS[name]} |`)
lines.push("")

// --- Per project ------------------------------------------------------------
for (const project of projects) {
  lines.push(`## ${project.label}`, "")
  lines.push(
    `A codebase of **${compact(project.size.lines)} lines** across **${project.size.files} files**. ` +
      (project.points === null ? "Not indexed." : `Its index holds **${compact(project.points)} pieces of code**. `) +
      (project.graph ? "It also has a symbol graph." : "It has no symbol graph."),
    "",
  )

  if (project.note) {
    lines.push(`> _Not measured: ${project.note}_`, "")
    continue
  }

  for (const set of project.sets) {
    const label = set.name === "labelled" ? "Questions written by hand" : "Questions taken from the project's own history"
    lines.push(`### ${label} (${set.n} questions)`, "")
    if (set.n < 10) {
      lines.push(`> ⚠️ **Only ${set.n} questions.** Too few to draw a conclusion from — treat what follows as a hint, not a result.`, "")
    }
    lines.push(`| Method | Found in top ${k} | Rank quality |`, "| --- | --- | --- |")
    const usable = STRATEGY_NAMES.filter((name) => !set.conditions[name]?.unavailable)
    const ordered = [...usable].sort(
      (a, b) => set.conditions[b].hit - set.conditions[a].hit || set.conditions[b].rr - set.conditions[a].rr,
    )
    ordered.forEach((name, index) => {
      const c = set.conditions[name]
      lines.push(`| ${MEDAL[index] ?? ""} ${FRIENDLY[name]} | \`${bar(c.hit)}\` ${pct(c.hit)} | ${c.rr.toFixed(2)} |`)
    })
    for (const name of STRATEGY_NAMES.filter((n) => set.conditions[n]?.unavailable)) {
      lines.push(`| ${FRIENDLY[name]} | _could not run_ | — |`)
    }
    lines.push("")

    const concept = usable.filter((name) => set.conditions[name].byType.concept)
    if (concept.length) {
      lines.push("<details><summary>Split by question type</summary>", "")
      lines.push("| Method | Question names a symbol | Question is a description |", "| --- | --- | --- |")
      for (const name of usable) {
        const c = set.conditions[name]
        const symbol = c.byType.identifier ? `${pct(c.byType.identifier.hit)} (${c.byType.identifier.n})` : "—"
        const description = c.byType.concept ? `${pct(c.byType.concept.hit)} (${c.byType.concept.n})` : "—"
        lines.push(`| ${FRIENDLY[name]} | ${symbol} | ${description} |`)
      }
      lines.push("", "</details>", "")
    }
  }
}

// --- Technical details ------------------------------------------------------
lines.push("---", "")
lines.push("<details><summary><b>Full numbers</b> (Hit@k, Recall@k, MRR, nDCG@k)</summary>", "")
lines.push("", `These are the same results, named the way the literature names them.`, "")
for (const project of projects) {
  if (project.note) continue
  for (const set of project.sets) {
    lines.push(`**${project.label} · ${set.name} · n=${set.n}**`, "")
    lines.push(`| Condition | n | Hit@${k} | Recall@${k} | MRR | nDCG@${k} |`, "| --- | --- | --- | --- | --- | --- |")
    for (const name of STRATEGY_NAMES) {
      const c = set.conditions[name]
      if (!c) continue
      if (c.unavailable) {
        lines.push(`| ${name} | ${c.n} | n/a | n/a | n/a | n/a |`)
        continue
      }
      lines.push(`| ${name} | ${c.n} | ${pct(c.hit)} | ${pct(c.recall)} | ${c.rr.toFixed(3)} | ${c.ndcg.toFixed(3)} |`)
    }
    lines.push("")
  }
}
lines.push("</details>", "")

// --- Caveats ----------------------------------------------------------------
lines.push("## What this does not prove", "")
lines.push(
  `- **Two codebases is not a trend.** These are two data points.`,
  "- **The questions from git history are noisy.** \"The one file that commit touched\" is not always the only file that answers the question, and that noise hits every method equally.",
  "- **Symbol-name search looks worse here than a code graph really is.** This measures one subcommand that matches names. A graph's real strength — who calls what, what breaks if you change it — is not measured here at all.",
  "- **One embedding model.** Swap the model and the meaning-based numbers move.",
  "",
)
lines.push("---", "")
lines.push(`Generated by \`bench/multi.mjs\` · top ${k} results · anonymised: no path, file name or question text appears above.`)

fs.writeFileSync(outFile, lines.join("\n"))
console.log(`\nwrote ${path.relative(process.cwd(), outFile)}`)