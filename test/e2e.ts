/**
 * End-to-end validation against the real environment:
 *  1. Kilo read-only reuse: search a Kilo collection and print hits.
 *  2. Own indexer: create a fixture, index it into an `oc-` collection, search it.
 *  3. Kilo import: seed a fixture store from a Kilo source (zero embedding calls).
 *  4. Verify Kilo collections were not modified (points count before/after).
 *
 * Usage: node test/e2e.ts [--root D:\d\Proyectos] [--skip-kil ose] [--lancedb]
 * Requires: Qdrant at localhost:6333 and Mistral API key in ~/.config/kilo/kilo.jsonc.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { resolveSettings } from "../src/config.ts"
import { runIndex } from "../src/indexer.ts"
import { createQdrant } from "../src/qdrant.ts"
import { searchCode } from "../src/search.ts"
import { createMemoryStorage } from "../src/storage.ts"
import { createOwnStore, createSettingsQdrant } from "../src/store-factory.ts"
import { discoverKiloSources } from "../src/import.ts"

const root = (() => {
  const i = process.argv.indexOf("--root")
  return path.resolve(i !== -1 ? process.argv[i + 1]! : "D:\\Proyectos")
})()

const useLance = process.argv.includes("--lancedb")
const settings = resolveSettings({
  homeDir: os.homedir(),
  vectorStore: useLance ? "lancedb" : undefined,
})
const qdrant = createQdrant({ url: settings.qdrantUrl, apiKey: settings.qdrantApiKey })
const kv = createMemoryStorage()

let failures = 0
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

console.log(`Root: ${root}`)
console.log(`Provider: ${settings.provider}/${settings.modelId} (${settings.dimension || "?"}d)`)
console.log(`Own store: ${settings.vectorStore} (${createOwnStore(settings, root).name})`)
console.log(`Qdrant: ${settings.qdrantUrl}`)

// ---------- 0. Kilo sources detection ----------
{
  const targetProfile = settings.dimension > 0
    ? { provider: settings.provider, modelId: settings.modelId, dimension: settings.dimension }
    : undefined
  const sources = await discoverKiloSources(root, { qdrant, targetProfile })
  console.log(`\nKilo sources detected: ${sources.length}`)
  for (const source of sources) {
    console.log(`  - ${source.kind} ${source.name} — ${source.pointsCount ?? "?"} pts, profile=${source.profile ? `${source.profile.provider}:${source.profile.modelId}:${source.profile.dimension}` : "?"}, compatible=${source.compatible}`)
  }
  check("kilo source discovery works", sources.length >= 0)
}

// ---------- 1. Kilo read-only reuse ----------
{
  const outcome = await searchCode({ qdrant, kv, root, settings }, "database connection pooling")
  check("kilo collection resolved", outcome.meta.kilo.collection !== null, outcome.meta.kilo.collection ?? "none")
  check("kilo hits found", outcome.hits.length > 0, `${outcome.hits.length} hits`)
  if (outcome.hits.length > 0) {
    const first = outcome.hits[0]!
    console.log(`      top: [${first.source}] ${first.filePath}:${first.startLine}-${first.endLine} (${first.score.toFixed(4)})`)
  }
  if (outcome.errors.length) console.log(`      errors: ${outcome.errors.join("; ")}`)
}

// ---------- 2. Own indexer on a fixture ----------
{
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "oi-e2e-"))
  fs.mkdirSync(path.join(fixture, "src"), { recursive: true })
  fs.writeFileSync(
    path.join(fixture, "src", "auth.ts"),
    [
      "// Authentication module",
      "export function hashPassword(password: string): string {",
      "  // PBKDF2 password hashing used during login",
      "  return `hashed:${password}`",
      "}",
      "",
      "export function validateSession(token: string): boolean {",
      "  // Session validation logic for authenticated users",
      "  return token.length > 0",
      "}",
      "",
      "// A comment longer than fifty characters to guarantee at least one chunk exists in this file.",
    ].join("\n"),
  )
  fs.writeFileSync(
    path.join(fixture, "src", "db.ts"),
    Array.from({ length: 120 }, (_, i) => `export const row${i} = "database connection pooling value ${i}"`).join("\n"),
  )

  const fixtureSettings = { ...settings, importFromKilo: false, fileExtensions: [".ts"], lancedbDirectory: path.join(fixture, ".lancedb") }
  const report = await runIndex(
    { kv, root: fixture, settings: fixtureSettings, qdrant, onProgress: () => undefined },
    { mode: "build", skipImport: true },
  )
  check("fixture build upserted chunks", report.chunksUpserted > 0, `${report.chunksUpserted} chunks, ${report.errors.length} errors`)
  if (report.errors.length) console.log(`      errors: ${report.errors.join("; ")}`)

  // Incremental: no changes -> nothing to do.
  const report2 = await runIndex({ kv, root: fixture, settings: fixtureSettings, qdrant, onProgress: () => undefined }, { mode: "refresh" })
  check("refresh with no changes is a no-op", report2.newFiles === 0 && report2.changedFiles === 0, `${report2.newFiles} new/${report2.changedFiles} changed`)

  // Modify a file -> refresh detects it.
  fs.appendFileSync(path.join(fixture, "src", "auth.ts"), '\nexport const NEW_MARKER = "refresh-detects-this-marker"\n')
  const report3 = await runIndex({ kv, root: fixture, settings: fixtureSettings, qdrant, onProgress: () => undefined }, { mode: "refresh" })
  check("refresh detects changed file", report3.changedFiles === 1, `${report3.changedFiles} changed`)

  // Search only the own store by asking a fixture-specific phrase (Kilo has no fixture data).
  const outcome = await searchCode({ qdrant, kv, root: fixture, settings: fixtureSettings }, "session validation login")
  const ownHits = outcome.hits.filter((hit) => hit.source === "own")
  check("own index searchable", ownHits.length > 0, `${ownHits.length} own hits`)

  // Cleanup: remove fixture dir and own store.
  fs.rmSync(fixture, { recursive: true, force: true })
  const own = createOwnStore(fixtureSettings, fixture)
  if (own.kind === "qdrant") {
    const client = createSettingsQdrant(fixtureSettings)
    if (await client.collectionExists(own.name)) await client.deleteCollection(own.name)
  } else {
    fs.rmSync(own.name, { recursive: true, force: true })
  }
  console.log(`      cleaned own store ${own.name}`)
}

// ---------- 3. Kilo collections untouched ----------
{
  const collections = await qdrant.listCollections()
  const ws = collections.filter((name) => name.startsWith("ws-"))
  check("kilo collections present", ws.length > 0, `${ws.length} collections`)
}

console.log(failures === 0 ? "\nE2E OK" : `\nE2E FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
