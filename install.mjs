#!/usr/bin/env node
/**
 * Installer for opencode-indexing.
 *
 * Works on Windows, Linux and macOS (Node >= 22.6; Node 26 recommended).
 *
 *   node install.mjs [--local|--package] [spec] [--skip-deps] [--no-restart] [--with-codegraph]
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
 * Both modes write the tool permission rules and restart the service, so either
 * one leaves a working install.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const argv = process.argv.slice(2)
const has = (name) => argv.some((arg) => arg.toLowerCase() === name)
const skipDeps = has("--skip-deps")
const noRestart = has("--no-restart")
const withCodegraph = has("--with-codegraph")

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
 * Whether this looks like the repository rather than an installed copy.
 *
 * `.git` and `test/` are both absent from the published tarball, so their
 * presence means someone is running the installer out of a working tree and
 * almost certainly wants the source they are editing to be what gets loaded.
 */
function looksLikeCheckout() {
  return existsSync(join(source, ".git")) || existsSync(join(source, "test"))
}

const mode = has("--local") ? "local" : has("--package") ? "package" : looksLikeCheckout() ? "local" : "package"
const reason = has("--local") || has("--package") ? "requested" : looksLikeCheckout() ? "a checkout" : "an installed copy"

// A positional argument is the package spec for --package. `@latest` rather than
// the version this file was published as, because an exact version is skipped by
// `opencode plugin check` and `plugin update`: pinning would silently opt the
// install out of the update path OpenCode provides.
const positional = argv.filter((arg) => !arg.startsWith("-"))
const spec = positional[0] ?? `${sourcePkg.name}@latest`

log(`Installing ${sourcePkg.name} ${sourcePkg.version}`)
log(`  from: ${source}`)
log(`  mode: ${mode} (${reason})`)
if (withCodegraph) log("  + codegraph (via --with-codegraph, package mode)")

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
function restartService() {
  if (noRestart) return
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
  "package.json",
  "tsconfig.json",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
]

function installLocal() {
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

  if (skipDeps) {
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
    .filter((id) => id === "opencode.indexing").length
}

function installPackage() {
  log(`  spec: ${spec}`)

  const added = spawnSync(opencodeBin, ["plugin", "add", spec], { stdio: "inherit", shell: isWindows })
  if (added.error || added.status !== 0) {
    // Nothing has been removed at this point, so a failure here leaves the
    // previous install exactly as it was.
    warn(`  \`opencode plugin add\` failed (${added.error?.message ?? `exit ${added.status}`}); the previous install was left untouched`)
    return false
  }

  // Remove the copied plugin *after* the package is in place. Both sources
  // define `id: "opencode.indexing"`, and the config directory is scanned
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
// Run
// ---------------------------------------------------------------------------
if (mode === "local") {
  installLocal()
  if (withCodegraph) warn("  --with-codegraph is ignored in --local mode; codegraph is not installed there")
} else {
  if (!installPackage()) {
  warn("  not writing permissions or restarting: the install did not complete")
  process.exit(1)
  }
  if (withCodegraph) installCodegraph()

}

writePermissions()
// Before the count below, not after: `plugin list` asks the running service,
// which still holds the configuration from before this install.
restartService()

if (mode === "package") {
  const count = registeredCount()
  if (count !== undefined && count > 1) {
    warn(`  ${count} entries report id opencode.indexing; only one should. Check \`opencode plugin list\`.`)
  }
}

log("Done.")
if (mode === "package") {
  log("Update with: opencode plugin update")
  log("Remove with: opencode plugin remove " + spec)
} else {
  log("Verify with: opencode api get /api/info")
  log("Then run in a session: indexing_status  (or /indexing-config in any client)")
}
