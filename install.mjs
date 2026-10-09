#!/usr/bin/env node
/**
 * Cross-platform installer for opencode-indexing.
 *
 * Works on Windows, Linux and macOS (Node >= 22.6; Node 26 recommended).
 *
 *   node install.mjs [--skip-deps] [--no-restart]
 *
 * What it does:
 *  1. Copies the plugin into <config>/opencode/plugins/opencode-indexing
 *     (config dir honors $XDG_CONFIG_HOME, defaulting to ~/.config).
 *  2. Installs runtime dependencies (ignore + optional lancedb/tree-sitter).
 *  3. Merges tool permissions into <config>/opencode/opencode.json.
 *  4. Restarts the OpenCode service so the plugin loads.
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

const source = dirname(fileURLToPath(import.meta.url))
const configRoot = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config")
const configDir = join(configRoot, "opencode")
const dest = join(configDir, "plugins", "opencode-indexing")
const configFile = join(configDir, "opencode.json")

const isWindows = process.platform === "win32"
const log = (message) => console.log(message)
const warn = (message) => console.warn(message)

log("Installing opencode-indexing")
log(`  from: ${source}`)
log(`  to:   ${dest}`)

// ---------------------------------------------------------------------------
// 1. Copy plugin files (keep a previously installed node_modules in place)
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

// ---------------------------------------------------------------------------
// 2. Minimal runtime package.json + dependency install
// ---------------------------------------------------------------------------
const sourcePkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"))
const installedPkg = {
  name: sourcePkg.name,
  version: sourcePkg.version,
  type: "module",
  exports: {
    ".": "./index.ts",
    "./rpc": "./src/rpc.ts",
    "./tui": "./tui.ts",
  },
  dependencies: {
    ignore: ">=7.0.0",
  },
  optionalDependencies: {
    "@lancedb/lancedb": "0.26.2",
    "web-tree-sitter": "0.25.10",
    "tree-sitter-wasms": "0.1.13",
  },
  // The host (OpenCode TUI) provides the renderer stack; declaring optional
  // peers documents the contract without forcing a duplicate install.
  peerDependencies: {
    "@opencode/theme": ">=2.0.23",
    "@opentui/core": ">=0.5.14",
    "@opentui/solid": ">=0.5.14",
    "solid-js": ">=1.9.12",
  },
  peerDependenciesMeta: {
    "@opencode/theme": { optional: true },
    "@opentui/core": { optional: true },
    "@opentui/solid": { optional: true },
    "solid-js": { optional: true },
  },
}
writeFileSync(join(dest, "package.json"), JSON.stringify(installedPkg, null, 2) + "\n", "utf8")

if (!skipDeps) {
  log("  installing runtime deps (ignore + optional lancedb/tree-sitter)...")
  const npm = isWindows ? "npm.cmd" : "npm"
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
// 3. Merge tool permissions into opencode.json (JSONC tolerant)
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

const TOOLS = ["indexing_search", "indexing_status", "indexing_refresh", "indexing_build", "indexing_import"]
try {
  let cfg = {}
  if (existsSync(configFile)) {
    cfg = JSON.parse(stripJsonc(readFileSync(configFile, "utf8")))
    if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) cfg = {}
  }
  if (typeof cfg.permission !== "object" || cfg.permission === null || Array.isArray(cfg.permission)) {
    cfg.permission = {}
  }
  for (const tool of TOOLS) cfg.permission[tool] = "allow"
  mkdirSync(configDir, { recursive: true })
  writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8")
  log(`  permissions added to ${configFile}`)
} catch (error) {
  warn(`  could not update ${configFile}: ${error instanceof Error ? error.message : String(error)}`)
}

// ---------------------------------------------------------------------------
// 4. Restart the OpenCode service so the plugin loads
// ---------------------------------------------------------------------------
if (!noRestart) {
  log("  restarting OpenCode service...")
  const opencode = isWindows ? "opencode.cmd" : "opencode"
  const result = spawnSync(opencode, ["service", "restart"], { stdio: "inherit", shell: isWindows })
  if (result.error || result.status !== 0) {
    warn("  could not restart automatically. Run: opencode service restart")
  }
}

log("Done.")
log("Verify with: opencode api get /api/info")
log("Then run in a session: indexing_status  (or /indexing-config in any client)")
