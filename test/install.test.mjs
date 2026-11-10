import * as assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { getModelDimension } from "../src/registry.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const installSource = await readFile(join(root, "install.mjs"), "utf8")

// Importing the installer must be inert: `isMain` keeps its run block from
// executing, so this exercises the exported helpers without installing anything.
const install = await import("../install.mjs")

const EXPECTED = {
  vectorStore: "lancedb",
  provider: "local",
  model: "potion-multilingual-128M",
  dimension: 256,
  autoRefresh: false,
  searchKilo: false,
  importFromKilo: false,
}

const flags = (overrides = {}) => ({
  aio: false,
  withCodegraph: false,
  local: false,
  package: false,
  skipDeps: false,
  noRestart: false,
  ...overrides,
})

test("AIO_SETTINGS is the frozen all-in-one preset", () => {
  assert.deepEqual(install.AIO_SETTINGS, EXPECTED)
  assert.equal(Object.isFrozen(install.AIO_SETTINGS), true)
})

test("AIO_SETTINGS model and dimension match the registry", () => {
  assert.equal(install.AIO_SETTINGS.model, "potion-multilingual-128M")
  assert.equal(install.AIO_SETTINGS.dimension, getModelDimension("local", install.AIO_SETTINGS.model))
})

test("mergeAioSettings keeps user settings and forces the preset", () => {
  const current = {
    apiKeys: { local: "secret" },
    qdrant: { url: "http://127.0.0.1:6333" },
    lancedb: { directory: "/var/lib/lancedb" },
    enabled: false,
    custom: "untouched",
    provider: "openai",
    model: "text-embedding-3-small",
    dimension: 1536,
    vectorStore: "qdrant",
    autoRefresh: true,
    searchKilo: true,
    importFromKilo: true,
  }

  const merged = install.mergeAioSettings(current)

  assert.deepEqual(merged.apiKeys, current.apiKeys)
  assert.deepEqual(merged.qdrant, current.qdrant)
  assert.equal(merged.lancedb.directory, current.lancedb.directory)
  assert.equal(merged.enabled, false)
  assert.equal(merged.custom, "untouched")
  assert.equal(merged.provider, EXPECTED.provider)
  assert.equal(merged.model, EXPECTED.model)
  assert.equal(merged.dimension, EXPECTED.dimension)
  assert.equal(merged.vectorStore, EXPECTED.vectorStore)
  assert.equal(merged.autoRefresh, EXPECTED.autoRefresh)
  assert.equal(merged.searchKilo, EXPECTED.searchKilo)
  assert.equal(merged.importFromKilo, EXPECTED.importFromKilo)
})

test("writeAioSettings creates parent dirs, writes JSON and is idempotent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oi-install-aio-"))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const file = join(directory, "nested", "deeper", "opencode.json")
  const current = { apiKeys: { local: "secret" }, enabled: false }

  const next = install.writeAioSettings(file, current)
  const raw = await readFile(file, "utf8")

  assert.deepEqual(next, install.mergeAioSettings(current))
  assert.ok(raw.endsWith("\n"), "written settings end with a newline")
  assert.deepEqual(JSON.parse(raw), next)

  const again = install.writeAioSettings(file, current)
  assert.deepEqual(again, next)
  assert.equal(await readFile(file, "utf8"), raw)
})

test("parseFlags reads --aio and its alias", () => {
  assert.deepEqual(install.parseFlags(["--aio"]), flags({ aio: true, withCodegraph: true }))
  assert.deepEqual(install.parseFlags(["--all-in-one"]), flags({ aio: true, withCodegraph: true }))
})

test("parseFlags keeps --with-codegraph independent of --aio", () => {
  const parsed = install.parseFlags(["--with-codegraph"])
  assert.equal(parsed.aio, false)
  assert.equal(parsed.withCodegraph, true)
})

test("parseFlags maps the remaining switches to booleans", () => {
  assert.deepEqual(
    install.parseFlags(["--local", "--skip-deps", "--no-restart", "--package"]),
    flags({ local: true, skipDeps: true, noRestart: true, package: true }),
  )
})

test("validateFlags rejects --aio combined with --local", () => {
  const message = install.validateFlags(flags({ aio: true, local: true }))
  assert.equal(typeof message, "string")
  assert.match(message, /--local/)
  assert.equal(install.validateFlags(flags({ aio: true, local: false })), undefined)
})

test("pickMode resolves explicit flags before the checkout heuristic", () => {
  assert.equal(install.pickMode(flags({ aio: true }), true), "package")
  assert.equal(install.pickMode(flags({ local: true }), false), "local")
  assert.equal(install.pickMode(flags({ package: true }), true), "package")
  assert.equal(install.pickMode(flags(), true), "local")
  assert.equal(install.pickMode(flags(), false), "package")
})

test("install.mjs does not index automatically but prefetches the model", () => {
  assert.equal(installSource.includes("index.build"), false, "installer must not trigger index.build")
  assert.equal(installSource.includes("settings.test"), true, "installer must call settings.test to prefetch the model")
})

test("the local copy list includes the bundled skill", () => {
  // `--local` mirrors package.json's `files`; a skills directory missing there
  // registers the plugin without its skill and logs a warning at startup.
  assert.match(installSource, /const COPY_ENTRIES = \[[\s\S]*?"skills"/)
})

test("install.ps1 exposes -Aio and forwards --aio", async () => {
  const script = await readFile(join(root, "install.ps1"), "utf8")
  assert.match(script, /\[switch\]\$Aio\b/)
  assert.match(script, /--aio/)
})

test("README documents --aio", async () => {
  const readme = await readFile(join(root, "README.md"), "utf8")
  assert.match(readme, /--aio/)
})

/**
 * The decisions below are exported by install.mjs so the run path stays small.
 * A missing helper fails loudly here instead of surfacing as a `TypeError`.
 */
const helper = (name) => {
  const fn = install[name]
  assert.equal(typeof fn, "function", `${name} is not exported by install.mjs yet`)
  return fn
}

test("aioProfileDecision never overwrites an install or a settings file", () => {
  const decide = helper("aioProfileDecision")

  assert.deepEqual(decide({ installed: true, settingsExist: true }), { apply: false, reason: "installed" })
  assert.deepEqual(decide({ installed: true, settingsExist: false }), { apply: false, reason: "installed" })
  assert.deepEqual(decide({ installed: false, settingsExist: true }), { apply: false, reason: "settings" })
  assert.deepEqual(decide({ installed: false, settingsExist: false }), { apply: true, reason: "none" })
})

const skipFile = join(root, ".config", "opencode", "indexing.json")

test("aioSkipMessage explains an existing install and leaves the settings path visible", () => {
  const message = helper("aioSkipMessage")("installed", skipFile, true)

  assert.match(message, /already installed/)
  assert.ok(message.includes(skipFile), "the message names the settings file")
  assert.match(message, /untouched/)
  // Removing the file is not enough while the plugin is installed: the other
  // half of the guard would still skip. Point at Settings instead.
  assert.match(message, /Settings -> Indexing/)
  assert.doesNotMatch(message, /remove that file/)
})

test("aioSkipMessage reports an existing install with no settings file", () => {
  const message = helper("aioSkipMessage")("installed", skipFile, false)

  assert.match(message, /already installed/)
  assert.match(message, /no settings file/i, "capitalised at the start of a sentence, so the check is case-insensitive")
})

test("aioSkipMessage names the settings file it refused to replace", () => {
  const message = helper("aioSkipMessage")("settings", skipFile, true)

  assert.match(message, /already exists/)
  assert.ok(message.includes(skipFile), "the message names the settings file")
  assert.match(message, /untouched/)
})

test("aioSkipMessage is silent when the profile is applied", () => {
  assert.equal(helper("aioSkipMessage")("none", skipFile, false), "")
})

test("install.mjs gates the all-in-one profile behind the existing-install decision", () => {
  assert.match(installSource, /\baioProfileDecision\b/)
  assert.match(installSource, /\bhasExistingInstall\b/)
  // Best effort: the call site reads the decision into `aioDecision` and only
  // then runs `checkAioProfile`.
  assert.match(installSource, /\baioDecision\b/)
})
