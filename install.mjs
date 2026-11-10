#!/usr/bin/env node
/**
 * Installer for opencode-indexing.
 *
 * Works on Windows, Linux and macOS (Node >= 22.6; Node 26 recommended).
 *
 *   node install.mjs [--local|--package] [spec] [--skip-deps] [--no-restart] [--with-codegraph] [--aio]
 *   npx @javierkaiser/opencode-indexing
 *
 * There are two ways to install, because there are two audiences.
 *
 *  --local    Copies the plugin into <config>/opencode/plugins/opencode-indexing
 *             and installs its runtime dependencies there. This is the
 *             development path: edits to the source take effect on restart,
 *             with no publish in between.
 *
 *  --package  Hands the job to `opencode plugin add`, which installs the
 *             published package into OpenCode's own cache and records it in the
 *             global `plugins` array. This is the user-facing path: OpenCode
 *             owns the install, so `opencode plugin check` and `plugin update`
 *             work on it.
 *
 * The mode is picked from where this file runs. A checkout has `.git` or `test/`
 * beside it and gets `--local`; anything else — the npx cache, a global install,
 * an unpacked tarball — gets `--package`. Pass either flag to override, and the
 * installer says which one it chose and why.
 *
 *  --aio      Installs the published package, the codegraph companion and an
 *             all-in-one profile in `indexing.json`: LanceDB, the local
 *             multilingual model, no Kilo index and no auto-refresh. It also
 *             prefetches the embedding model through the running service.
 *             An existing install or settings file is never overwritten: the
 *             profile step is skipped and the file left as it was.
 *             `--all-in-one` is the same flag. Implies `--package` and
 *             `--with-codegraph`; it cannot be combined with `--local`.
 *
 * Both modes write the tool permission rules and restart the service, so either
 * one leaves a working install.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const source = dirname(fileURLToPath(import.meta.url))
const sourcePkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"))
const configRoot = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config")
const configDir = join(configRoot, "opencode")
const dest = join(configDir, "plugins", "opencode-indexing")
const configFile = join(configDir, "opencode.json")

const isWindows = process.platform === "win32"
const opencodeBin = isWindows ? "opencode.cmd" : "opencode"
const log = (message) => console.log(message)
const warn = (message) => console.warn(message)

/**
 * The all-in-one profile written to `indexing.json`.
 *
 * LanceDB and the local multilingual model make a working install with no
 * external service, no API key and no dependency on a Kilo index. Kilo is
 * switched off on both sides: it is neither imported nor searched.
 */
export const AIO_SETTINGS = Object.freeze({
  vectorStore: "lancedb",
  provider: "local",
  model: "potion-multilingual-128M",
  dimension: 256,
  autoRefresh: false,
  searchKilo: false,
  importFromKilo: false,
})

/**
 * Turn the command line into the flags the installer works with.
 *
 * `--aio` implies the published package and the codegraph companion, so
 * `withCodegraph` is derived here instead of being spelled out at every use.
 * Matching is case-insensitive, like the rest of this file.
 */
export function parseFlags(args) {
  const has = (name) => args.some((arg) => arg.toLowerCase() === name)
  const aio = has("--aio") || has("--all-in-one")
  return {
    aio,
    withCodegraph: has("--with-codegraph") || aio,
    local: has("--local"),
    package: has("--package"),
    skipDeps: has("--skip-deps"),
    noRestart: has("--no-restart"),
  }
}

export function validateFlags(flags) {
  if (flags.aio && flags.local) return "--aio installs the published package; it cannot be combined with --local."
  return undefined
}

export function pickMode(flags, isCheckout) {
  if (flags.local) return "local"
  if (flags.aio || flags.package) return "package"
  return isCheckout ? "local" : "package"
}

export function mergeAioSettings(current) {
  const base = current !== null && typeof current === "object" && !Array.isArray(current) ? current : {}
  return { ...base, ...AIO_SETTINGS }
}

export function writeAioSettings(file, current) {
  const next = mergeAioSettings(current)
  mkdirSync(dirname(file), { recursive: true })
  // Same write-then-rename as the plugin's own settings writer, so a crash
  // mid-write cannot leave a truncated settings file behind.
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8")
  renameSync(tmp, file)
  return next
}

/**
 * Whether this looks like the repository rather than an installed copy.
 *
 * `.git` and `test/` are both absent from the published tarball, so their
 * presence means someone is running the installer out of a working tree and
 * almost certainly wants the source they are editing to be what gets loaded.
 */
function looksLikeCheckout() {
  return existsSync(join(source, ".git")) || existsSync(join(source, "test"))
}

// ---------------------------------------------------------------------------
// Tool permissions (both modes)
// ---------------------------------------------------------------------------
function stripJsonc(input) {
  // Strip a UTF-8 BOM: editors on Windows may add one and JSON.parse rejects it.
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1)
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    const next = input[i + 1]
    if (inLine) {
      if (ch === "\n") {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && next === "/") {
      inLine = true
      i++
      continue
    }
    if (ch === "/" && next === "*") {
      inBlock = true
      i++
      continue
    }
    out += ch
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

// V2 permissions are an ordered rule list of { action, resource, effect }, not a
// flat action map. The old `permission` object is the V1 shape and V2 ignores it
// entirely, so entries written in it never applied.
const TOOLS = ["indexing_search", "indexing_status", "indexing_config", "indexing_config_set", "indexing_refresh", "indexing_build", "indexing_import"]
// Everything else only reads. This one writes the settings file, so the host
// asks the user before it runs instead of taking it on trust.
const ASK_BEFORE_RUN = new Set(["indexing_config_set"])

/**
 * Add one permission rule per tool to the global config.
 *
 * `opencode plugin add` installs the plugin but knows nothing about its tools,
 * so a package-mode install has to write these itself or the `ask` gate on
 * `indexing_config_set` is lost. The read tools would be allowed by the base
 * `{ "*": "allow" }` policy anyway; they are written out so the set is visible
 * and can be tightened in one place.
 */
function writePermissions() {
  try {
    let cfg = {}
    if (existsSync(configFile)) {
      cfg = JSON.parse(stripJsonc(readFileSync(configFile, "utf8")))
      if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) cfg = {}
    }

    // Drop the V1 entries this installer used to write. Anything else the user
    // put there is left untouched.
    if (cfg.permission && typeof cfg.permission === "object" && !Array.isArray(cfg.permission)) {
      for (const tool of TOOLS) delete cfg.permission[tool]
      if (Object.keys(cfg.permission).length === 0) delete cfg.permission
    }

    if (!Array.isArray(cfg.permissions)) cfg.permissions = []
    for (const tool of TOOLS) {
      const effect = ASK_BEFORE_RUN.has(tool) ? "ask" : "allow"
      const rule = cfg.permissions.find((entry) => entry && entry.action === tool)
      if (rule) {
        rule.resource = "*"
        rule.effect = effect
      } else {
        cfg.permissions.push({ action: tool, resource: "*", effect })
      }
    }

    mkdirSync(configDir, { recursive: true })
    writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8")
    log(`  permissions added to ${configFile}`)
  } catch (error) {
    warn(`  could not update ${configFile}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// Service restart (both modes)
// ---------------------------------------------------------------------------
function restartService(skipRestart) {
  if (skipRestart) return
  log("  restarting OpenCode service...")
  const result = spawnSync(opencodeBin, ["service", "restart"], { stdio: "inherit", shell: isWindows })
  if (result.error || result.status !== 0) {
    warn("  could not restart automatically. Run: opencode service restart")
  }
}

// ---------------------------------------------------------------------------
// Local mode: copy the working tree into the config directory
// ---------------------------------------------------------------------------
/**
 * Entries copied into the plugin directory.
 *
 * An allowlist rather than a blocklist: a blocklist copied whatever local debris
 * happened to be in the working tree — a stray `test-run.log` was shipped into
 * every install. This mirrors the `files` field in package.json, minus the
 * installers, which are not needed inside an installed plugin.
 */
const COPY_ENTRIES = [
  "index.ts",
  "tui.ts",
  "tui",
  "src",
  "skills",
  "package.json",
  "tsconfig.json",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
]

function installLocal(skipDependencyInstall) {
  log(`  to:   ${dest}`)
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(dest)) {
    if (entry === "node_modules") continue
    rmSync(join(dest, entry), { recursive: true, force: true })
  }
  for (const entry of COPY_ENTRIES) {
    const from = join(source, entry)
    if (!existsSync(from)) {
      warn(`  skipping missing entry: ${entry}`)
      continue
    }
    cpSync(from, join(dest, entry), { recursive: true })
  }
  log("  files copied")

  // The installed package.json is derived, never hand-written: the list this
  // used to keep in parallel is how `apache-arrow` came to be declared for the
  // installer and missing from the published package, which broke every Kilo
  // LanceDB import for one of the two install paths and not the other.
  const installedPkg = {
    name: sourcePkg.name,
    version: sourcePkg.version,
    type: "module",
    exports: sourcePkg.exports,
    dependencies: sourcePkg.dependencies,
    optionalDependencies: sourcePkg.optionalDependencies,
    peerDependencies: sourcePkg.peerDependencies,
    peerDependenciesMeta: sourcePkg.peerDependenciesMeta,
  }
  writeFileSync(join(dest, "package.json"), JSON.stringify(installedPkg, null, 2) + "\n", "utf8")

  if (skipDependencyInstall) {
    log("  skipping dependency install (--skip-deps)")
    return
  }

  log("  installing runtime deps (ignore + mini-semantic-search + optional lancedb/tree-sitter/apache-arrow)...")
  const npm = isWindows ? "npm.cmd" : "npm"
  // --omit=peer drops peer dependencies, and apache-arrow is a peer of
  // @lancedb/lancedb: it is declared explicitly above so the native binary
  // does not load and then throw on first use.
  const result = spawnSync(
    npm,
    ["install", "--omit=dev", "--omit=peer", "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: dest, stdio: "inherit", shell: isWindows },
  )
  if (result.error || result.status !== 0) {
    warn(`  dependency install failed (${result.error?.message ?? `exit ${result.status}`}); the plugin still runs with reduced features`)
  }
}

// ---------------------------------------------------------------------------
// Package mode: let OpenCode own the install
// ---------------------------------------------------------------------------
/** How many entries `opencode plugin list` reports for this plugin. */
function registeredCount() {
  const result = spawnSync(opencodeBin, ["plugin", "list"], { encoding: "utf8", shell: isWindows })
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return undefined
  // `plugin list` prints a table: `ID  VERSION  SOURCE`. Compare the first
  // column exactly rather than by prefix, so a longer id that happens to start
  // the same way is not counted as this plugin.
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((id) => id === "javierkaiser.indexing").length
}

/**
 * Whether this plugin is already installed, measured before `installPackage`.
 *
 * Three independent signals, cheapest first: a copied plugin in the config
 * directory, an entry in `opencode.json`, and the running service's own list.
 * A service that is down makes `registeredCount()` undefined, and no answer is
 * not evidence of an install, so that case falls through to false.
 */
function hasExistingInstall() {
  if (existsSync(dest)) return true

  if (existsSync(configFile)) {
    try {
      const cfg = JSON.parse(stripJsonc(readFileSync(configFile, "utf8")))
      const plugins = cfg && Array.isArray(cfg.plugins) ? cfg.plugins : []
      // Both spellings OpenCode accepts: a bare spec string, or an object with
      // `package`. `@latest`, `@0.10.0` and no suffix all mean this plugin.
      const isThisPackage = (value) =>
        typeof value === "string" && (value === sourcePkg.name || value.startsWith(`${sourcePkg.name}@`))
      const found = plugins.some(
        (entry) => isThisPackage(entry) || (entry !== null && typeof entry === "object" && isThisPackage(entry.package)),
      )
      if (found) return true
    } catch {
      // An unreadable config is not an install; the remaining probes decide.
    }
  }

  const count = registeredCount()
  return typeof count === "number" && count > 0
}

function installPackage(packageSpec) {
  log(`  spec: ${packageSpec}`)

  const added = spawnSync(opencodeBin, ["plugin", "add", packageSpec], { stdio: "inherit", shell: isWindows })
  if (added.error || added.status !== 0) {
    // Nothing has been removed at this point, so a failure here leaves the
    // previous install exactly as it was.
    warn(`  \`opencode plugin add\` failed (${added.error?.message ?? `exit ${added.status}`}); the previous install was left untouched`)
    return false
  }

  // Remove the copied plugin *after* the package is in place. Both sources
  // define `id: "javierkaiser.indexing"`, and the config directory is scanned
  // automatically, so leaving the copy behind would load the plugin twice.
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true })
    log(`  removed the copied plugin at ${dest} (it would load twice)`)
  }

  return true
}

// ---------------------------------------------------------------------------
// Codegraph as a companion MCP (opt-in, --with-codegraph)
// ---------------------------------------------------------------------------
/**
 * Whether a `codegraph` CLI is available on PATH.
 *
 * A plain spawn is the cheapest, shell-independent probe and matches what
 * the bench harness `resolveBinary()` does. It is treated as read-only here.
 */
function hasCodegraphBin() {
  try {
    const probe = spawnSync("codegraph", ["--version"], { stdio: "ignore", shell: isWindows })
    if (probe.error) return false
    // status is either 0 or, on some wrappers, undefined-but-no-error; treat both as present
    return probe.status === 0 || probe.status === null
  } catch {
    return false
  }
}

/**
 * The npm package that provides the `codegraph` CLI.
 *
 * Scoped, and it has to be. The unscoped `codegraph` on npm is an unrelated
 * 2024 library with no binary, so installing that name succeeds and leaves
 * nothing on PATH — a silent no-op that looks like a working install.
 */
const CODEGRAPH_PACKAGE = "@colbymchenry/codegraph"

/**
 * Install codegraph and register its MCP with OpenCode.
 *
 * The only consent gate is the flag itself, as the user requested: this is
 * an install step, not a recommendation. A failure in either half is reported
 * and tolerated — the plugin is already installed and still works with
 * semantic search only.
 */
function installCodegraph() {
  log("  installing codegraph as a companion MCP server...")

  if (!hasCodegraphBin()) {
    log(`  codegraph CLI missing; running npm install -g ${CODEGRAPH_PACKAGE}...`)
    const npm = isWindows ? "npm.cmd" : "npm"
    // Scoped on purpose. `codegraph` on the unscoped registry is an unrelated
    // 2024 library with no CLI at all, and installing it would look successful
    // while leaving nothing on PATH to register.
    const installed = spawnSync(npm, ["install", "-g", CODEGRAPH_PACKAGE], {
      stdio: "inherit",
      shell: isWindows,
    })
    if (installed.error || installed.status !== 0) {
      warn(`  could not install codegraph (npm install -g ${CODEGRAPH_PACKAGE} failed); skipping MCP registration`)
      return
    }
  }

  const register = spawnSync("codegraph", ["install", "--target", "opencode"], {
    stdio: "inherit",
    shell: isWindows,
  })
  if (register.error || register.status !== 0) {
    warn("  codegraph is present but `codegraph install --target opencode` failed")
    warn("  run it manually once to finish MCP registration: codegraph install --target opencode")
    return
  }

  log("  codegraph installed and registered with OpenCode")
}

// ---------------------------------------------------------------------------
// All-in-one profile (--aio)
// ---------------------------------------------------------------------------
/** The plugin's own settings file, resolved the same way `src/settings.ts` does. */
const settingsFile = join(configDir, "indexing.json")

/**
 * Whether `--aio` may apply its profile.
 *
 * The profile is a deliberate, one-shot choice. Re-applying it on every run
 * would overwrite a setup the user has since edited, so an existing install or
 * an existing settings file blocks it instead.
 */
export function aioProfileDecision({ installed, settingsExist }) {
  if (installed) return { apply: false, reason: "installed" }
  if (settingsExist) return { apply: false, reason: "settings" }
  return { apply: true, reason: "none" }
}

/** The explanation printed when the profile is skipped, one line per `\n`. */
export function aioSkipMessage(reason, settingsFile, settingsExist) {
  if (reason === "installed") {
    return settingsExist
      ? `The plugin is already installed; the all-in-one profile was not applied.\nYour settings at ${settingsFile} were left untouched.\nTo apply the profile deliberately, back up and remove that file, then run this again.`
      : "The plugin is already installed; the all-in-one profile was not applied.\nNo settings file exists yet, so nothing was overwritten.\nConfigure the local profile from Settings -> Indexing if you want it."
  }
  if (reason === "settings") {
    return `A settings file already exists at ${settingsFile}; the all-in-one profile was not applied.\nThe file was left untouched.\nTo apply the profile deliberately, back up and remove that file, then run this again.`
  }
  return ""
}

const RPC_PATH = "/api/rpc/javierkaiser.indexing/settings.test"
const RPC_ATTEMPTS = 10
const RPC_DELAY_MS = 3000

/** Synchronous sleep: the RPC below uses `spawnSync`, so no timer can run. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Call the plugin's `settings.test` RPC through the OpenCode CLI.
 *
 * A command line rather than an HTTP request: the API port and auth token are
 * the service's business, and `opencode api` already knows both. On Windows the
 * body has to travel as one escaped string inside a shell command, which is
 * what the quote replacement is for; elsewhere the arguments go through as-is.
 *
 * Retries cover a service still coming back from the restart, not a test that
 * answered: a parsed `ok: false` is a result and is returned immediately.
 */
function callSettingsTest(input) {
  const body = JSON.stringify({ input })
  const command = `${opencodeBin} api post ${RPC_PATH} --data "${body.replace(/"/g, '\\"')}"`
  let problem = "no response"
  for (let attempt = 1; attempt <= RPC_ATTEMPTS; attempt++) {
    const result = isWindows
      ? spawnSync(command, { encoding: "utf8", shell: true })
      : spawnSync(opencodeBin, ["api", "post", RPC_PATH, "--data", body], { encoding: "utf8" })
    if (result.error) {
      problem = result.error.message
    } else if (typeof result.stdout !== "string" || result.stdout.trim() === "") {
      problem = `exit ${result.status} with no output`
    } else {
      try {
        const parsed = JSON.parse(result.stdout)
        const payload =
          parsed && typeof parsed === "object" && parsed.output && typeof parsed.output === "object" ? parsed.output : parsed
        if (payload && typeof payload === "object" && typeof payload.ok === "boolean") return payload
        problem = "unexpected response shape"
      } catch {
        problem = "response was not JSON"
      }
    }
    if (attempt < RPC_ATTEMPTS) sleepSync(RPC_DELAY_MS)
  }
  warn(`  settings.test ${input.target}: ${problem} after ${RPC_ATTEMPTS} attempts; skipping`)
  return undefined
}

function reportTest(target, result) {
  if (!result) return
  const message = typeof result.message === "string" ? result.message.trim() : ""
  const line = `  settings.test ${target}: ${result.ok ? "OK" : "FAILED"}${message ? ` — ${message}` : ""}`
  if (result.ok) log(line)
  else warn(line)
}

/**
 * Merge the all-in-one profile into `indexing.json`.
 *
 * An existing file is parsed first so unrelated keys (credentials, Qdrant
 * settings) survive. A file that exists but does not parse is left untouched:
 * it is the user's, and overwriting it would discard whatever they meant to
 * put there. `writeAioSettings` does the atomic write.
 */
function applyAioSettings() {
  let current = {}
  let readable = true
  if (existsSync(settingsFile)) {
    try {
      const parsed = JSON.parse(stripJsonc(readFileSync(settingsFile, "utf8")))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed
    } catch (error) {
      readable = false
      warn(`  could not parse ${settingsFile} (${error instanceof Error ? error.message : String(error)}); leaving it untouched`)
    }
  }

  if (readable) {
    try {
      const next = writeAioSettings(settingsFile, current)
      log(`  settings written to ${settingsFile}`)
      log(
        `  profile: ${next.vectorStore} · ${next.provider}/${next.model} (${next.dimension}d) · autoRefresh ${next.autoRefresh ? "on" : "off"} · kilo ${next.searchKilo ? "on" : "off"}`,
      )
    } catch (error) {
      warn(`  could not write ${settingsFile}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  warnAioOptionsOverride()
}

/**
 * Warn when `opencode.json` overrides the profile through plugin options.
 *
 * Plugin options take precedence over `indexing.json`, so an install can look
 * correct and still run with different settings. Best-effort: a config this
 * installer cannot read is not a reason to fail the install.
 */
function warnAioOptionsOverride() {
  try {
    if (!existsSync(configFile)) return
    const cfg = JSON.parse(stripJsonc(readFileSync(configFile, "utf8")))
    if (!cfg || !Array.isArray(cfg.plugins)) return
    const keys = Object.keys(AIO_SETTINGS)
    const override = cfg.plugins.find((entry) => {
      if (!entry || typeof entry !== "object") return false
      if (typeof entry.package !== "string" || !entry.package.startsWith(sourcePkg.name)) return false
      const options = entry.options
      return typeof options === "object" && options !== null && !Array.isArray(options) && keys.some((key) => key in options)
    })
    if (override) {
      warn(`  ${configFile} sets plugin options for ${override.package}; those win over the AIO profile in ${settingsFile}`)
    }
  } catch {
    // Advisory only, and the install is already done.
  }
}

/**
 * Run the profile checks through the just-restarted service.
 *
 * The provider test is the model prefetch: it downloads and quantizes the
 * multilingual model (~512 MB) and answers `OK (256 dimensions)`. Nothing is
 * indexed here — an install must not touch any workspace.
 */
function checkAioProfile(skipRestart) {
  if (skipRestart) {
    log("  skipped the model download (--no-restart)")
    log(`  after restarting, fetch it with: opencode api post ${RPC_PATH} --data '{"input":{"target":"provider"}}'`)
    return
  }

  log("  checking the vector store through the running service...")
  reportTest("lancedb", callSettingsTest({ target: "lancedb" }))

  log("  prefetching the embedding model (~512 MB download; this can take several minutes)...")
  reportTest("provider", callSettingsTest({ target: "provider" }))
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2)
  const flags = parseFlags(argv)
  const invalid = validateFlags(flags)
  if (invalid) {
    warn(invalid)
    process.exit(1)
  }

  const isCheckout = looksLikeCheckout()
  const mode = pickMode(flags, isCheckout)
  const reason = flags.aio
    ? "requested (--aio)"
    : flags.local || flags.package
      ? "requested"
      : isCheckout
        ? "a checkout"
        : "an installed copy"

  // A positional argument is the package spec for --package. `@latest` rather than
  // the version this file was published as, because an exact version is skipped by
  // `opencode plugin check` and `plugin update`: pinning would silently opt the
  // install out of the update path OpenCode provides.
  const positional = argv.filter((arg) => !arg.startsWith("-"))
  const spec = positional[0] ?? `${sourcePkg.name}@latest`

  log(`Installing ${sourcePkg.name} ${sourcePkg.version}`)
  log(`  from: ${source}`)
  log(`  mode: ${mode} (${reason})`)
  if (flags.aio) log("  + all-in-one: lancedb + local multilingual model, no Kilo")
  if (flags.withCodegraph) {
    log(flags.aio ? "  + codegraph (via --aio)" : "  + codegraph (via --with-codegraph, package mode)")
  }

  // The guard that keeps `--aio` safe to re-run protects an existing setup from
  // a second profile write. It has to be decided here, before `installPackage`:
  // once `opencode plugin add` has run, every later check would report this
  // plugin as installed and the decision would always be "skip".
  const alreadyInstalled = flags.aio ? hasExistingInstall() : false
  const settingsExist = existsSync(settingsFile)
  const aioDecision = flags.aio ? aioProfileDecision({ installed: alreadyInstalled, settingsExist }) : undefined

  if (mode === "local") {
    installLocal(flags.skipDeps)
    if (flags.withCodegraph) warn("  --with-codegraph is ignored in --local mode; codegraph is not installed there")
  } else {
    if (!installPackage(spec)) {
      warn("  not writing permissions or restarting: the install did not complete")
      process.exit(1)
    }
    if (flags.aio) {
      if (aioDecision.apply) {
        applyAioSettings()
      } else {
        log("")
        for (const line of aioSkipMessage(aioDecision.reason, settingsFile, settingsExist).split("\n")) log(line)
        log("")
      }
    }
    if (flags.withCodegraph) installCodegraph()
  }

  writePermissions()
  // Before the count below, not after: `plugin list` asks the running service,
  // which still holds the configuration from before this install.
  restartService(flags.noRestart)

  if (mode === "package") {
    const count = registeredCount()
    if (count !== undefined && count > 1) {
      warn(`  ${count} entries report id javierkaiser.indexing; only one should. Check \`opencode plugin list\`.`)
    }
    // Only when the profile was applied: both checks validate a profile that,
    // when skipped, is not the one on disk.
    if (flags.aio && aioDecision.apply) checkAioProfile(flags.noRestart)
  }

  log("Done.")
  if (mode === "package") {
    log("Update with: opencode plugin update")
    log("Remove with: opencode plugin remove " + spec)
  } else {
    log("Verify with: opencode api get /api/info")
    log("Then run in a session: indexing_status  (or /indexing-config in any client)")
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
