/**
 * Query set derived from git history.
 *
 * A commit subject is a natural-language description of an intent, and the
 * files it touched are an objective answer to "where does that live?". Neither
 * the semantic index nor the symbol graph supplies either, so this avoids the
 * circularity of labelling ground truth from the tool being measured.
 *
 * Reported separately from the hand-labelled set: the two are different
 * distributions and averaging them together would hide what each one shows.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

const STOP = new Set(["the", "a", "an", "of", "to", "and", "or", "for", "in", "on", "with", "how", "where", "what", "which", "is", "are", "do", "does", "we", "it", "that", "this", "from", "into", "used", "use", "when", "by", "be", "before", "them", "they", "their", "its", "not", "has", "have", "but", "all", "can", "will", "was", "were", "been", "add", "adds", "added", "update", "updates", "updated", "change", "changes", "changed", "make", "makes", "made", "fix", "fixes", "fixed"])

const NOISE = /^(merge|bump|release|wip|initial commit|revert|update deps|dependabot|chore\(deps\))/i

function contentWords(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP.has(word))
}

/** Subject may name a symbol; that makes the query an identifier question. */
function classify(subject, file) {
  const base = path.basename(file).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const words = contentWords(subject)
  const namesSymbol = words.some((word) => base.some((part) => part.length >= 4 && (part.startsWith(word) || word.startsWith(part))))
  return namesSymbol ? "identifier" : "concept"
}

/**
 * @param {string} repo
 * @param {{ limit?: number, scan?: number, perFileCap?: number, extensions?: Set<string> }} [options]
 *
 * `extensions` restricts queries to files the index actually covers. Without it
 * a commit that touched a PowerShell script counts as a retrieval failure for
 * the semantic condition when the real answer is "that file type was never
 * indexed" — the harness would be measuring the wrong thing.
 */
export function queriesFromCommits(repo, options = {}) {
  const limit = options.limit ?? 40
  const scan = options.scan ?? 600
  const perFileCap = options.perFileCap ?? 3
  const extensions = options.extensions

  const raw = execFileSync(
    "git",
    ["log", "--no-merges", "--name-only", "--pretty=format:@@@%h|%s", "-n", String(scan)],
    { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )

  const perFile = new Map()
  const queries = []

  for (const block of raw.split(/^@@@/m).slice(1)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const header = lines.shift()
    if (!header) continue
    const [hash, ...rest] = header.split("|")
    const subject = rest.join("|").trim()
    const files = lines.filter((line) => !line.startsWith("@@@"))

    // A commit touching several files has no single answer.
    if (files.length !== 1) continue
    const file = files[0]
    if (!file || NOISE.test(subject)) continue
    if (contentWords(subject).length < 2) continue
    if (!fs.existsSync(path.join(repo, file))) continue
    if (extensions && !extensions.has(path.extname(file).toLowerCase())) continue

    const used = perFile.get(file) ?? 0
    if (used >= perFileCap) continue

    perFile.set(file, used + 1)
    queries.push({
      id: `c${String(queries.length + 1).padStart(3, "0")}`,
      type: classify(subject, file),
      query: subject,
      expected: [file],
      commit: hash,
    })
    if (queries.length >= limit) break
  }

  return queries
}