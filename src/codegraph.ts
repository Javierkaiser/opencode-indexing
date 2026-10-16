import * as fs from "node:fs"
import * as path from "node:path"

import { assessScope } from "./scope.ts"

/**
 * Companion integration with CodeGraph, the code-graph indexer.
 *
 * Two indexes, two signals: this plugin answers "where is the code that does
 * something like X", codegraph answers "who calls X, what breaks if I change
 * it". They are complementary, and indexing only one leaves the other stale.
 *
 * The decision this module makes is narrow on purpose. It never searches, never
 * parses, never reads codegraph's database: it either launches `codegraph init`
 * or `codegraph sync` and reports what it launched. Everything it knows about
 * codegraph comes from running its CLI.
 */

/** Directory codegraph writes its index into. Its presence is the "is it indexed" answer. */
const CODEGRAPH_DIR = ".codegraph"

/**
 * The npm package that provides the `codegraph` CLI.
 *
 * Scoped, and it has to be: the unscoped `codegraph` on npm is an unrelated
 * 2024 library with no binary. Installing that name exits 0 and leaves nothing
 * on PATH, which is the worst shape of failure for an installer step — it looks
 * like it worked.
 */
const CODEGRAPH_PACKAGE = "@colbymchenry/codegraph"

/**
 * Minimum seconds between launches for one workspace.
 *
 * codegraph is not the only writer of `.codegraph/`: it runs a daemon with a
 * file watcher that auto-syncs on change. Two `sync` invocations seconds apart
 * contend for the same database, so the second one is skipped rather than
 * allowed to collide. Also the cheap defence against a user hammering build.
 */
const MIN_LAUNCH_INTERVAL_MS = 15_000

export interface CodegraphLaunch {
  /** `init` on a folder that was never indexed, `sync` otherwise. */
  action: "init" | "sync"
  /** Command as run, for the message the user sees. */
  command: string
  /** Why it ran, or why it did not. Always present. */
  detail: string
}

export type CodegraphOutcome =
  | { kind: "launched"; launch: CodegraphLaunch }
  /** Nothing was started; `reason` is user-facing and complete on its own. */
  | { kind: "skipped"; reason: string }
  /** Could not start at all. Never fatal: the semantic index does not depend on this. */
  | { kind: "failed"; reason: string }

/**
 * The seam that keeps the test suite away from real processes.
 *
 * `src/` had no `child_process` use before this, so there is no precedent to
 * follow. Defaulting to the real spawner and injecting in tests keeps the module
 * honest without making every test shell out.
 */
export interface CodegraphRunner {
  /** Resolves true when the `codegraph` CLI answers. Never throws. */
  available(): Promise<boolean>
  /**
   * Starts the command and returns immediately.
   *
   * Deliberately not awaited to completion: `init` on a large monorepo can run
   * for minutes, and a tool call that blocks that long is worse than one that
   * finishes. The caller therefore reports "started", never "succeeded".
   */
  launch(args: string[], cwd: string): Promise<void>
}

/** Monotonic-enough clock, injectable so tests do not have to wait 15 seconds. */
export interface CodegraphClock {
  now(): number
}

const realClock: CodegraphClock = { now: () => Date.now() }

/** Last launch per workspace, so the interval gate survives across calls. */
const lastLaunch = new Map<string, number>()

/** Whether `.codegraph/` exists. Sync rather than async: it runs on every build. */
export function isCodegraphInitialized(root: string): boolean {
  try {
    return fs.existsSync(path.join(root, CODEGRAPH_DIR))
  } catch {
    return false
  }
}

/**
 * Spawn options shared by both commands.
 *
 * `shell` is true on Windows and false elsewhere, and it is not a stylistic
 * choice: npm installs its executables as `codegraph.cmd` / `codegraph.ps1`
 * shims, which `spawn` cannot resolve on its own — it reports ENOENT for a
 * binary that is installed and working. Verified by running both shapes.
 *
 * The arguments are fixed literals chosen here, never user input, so there is
 * no path for quoting to matter; `shell` is what buys Windows compatibility.
 */
function spawnOptions(cwd?: string): Record<string, unknown> {
  return {
    cwd,
    stdio: "ignore",
    windowsHide: true,
    shell: process.platform === "win32",
  }
}

/**
 * The CLI runner.
 *
 * `version` is the cheapest command that proves both existence and runnability;
 * `init --help` would do too but prints help. stdio is ignored rather than
 * inherited so codegraph's output cannot corrupt the TUI, and `--yes` on init is
 * what keeps it from blocking on a prompt nobody can answer.
 */
export const realRunner: CodegraphRunner = {
  async available() {
    const { spawn } = await import("node:child_process")
    return new Promise<boolean>((resolve) => {
      try {
        const child = spawn("codegraph", ["version"], spawnOptions())
        child.once("error", () => resolve(false))
        child.once("close", (code) => resolve(code === 0))
      } catch {
        resolve(false)
      }
    })
  },
  async launch(args, cwd) {
    const { spawn } = await import("node:child_process")
    await new Promise<void>((resolve) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn("codegraph", args, {
          ...spawnOptions(cwd),
          // Detached so the index keeps building after the service restarts.
          // Without this a restart mid-init orphans a half-written database.
          // Not on Windows: a detached shell process is not unref-able the same
          // way, and the host holds the handle anyway.
          detached: process.platform !== "win32",
        })
        // Nothing is awaited on purpose: see the interface note. `unref` only
        // exists on non-Windows, where detached was requested at all.
        child.unref()
      } catch {
        resolve()
        return
      }
      child.once("error", () => resolve())
      child.once("spawn", () => resolve())
    })
  },
}

export interface CodegraphOptions {
  root: string
  enabled: boolean
  runner?: CodegraphRunner
  clock?: CodegraphClock
}

/**
 * Launch codegraph for a workspace, if it makes sense to.
 *
 * Returns what happened; the caller decides how to say it. Never throws: a
 * companion indexer must not be able to fail the semantic one.
 */
export async function indexWithCodegraph(options: CodegraphOptions): Promise<CodegraphOutcome> {
  const { root, enabled } = options
  if (!enabled) return { kind: "skipped", reason: "codegraph indexing is turned off (set codegraph=true)" }

  const runner = options.runner ?? realRunner
  const clock = options.clock ?? realClock

  // A home directory or a drive root is reported rather than indexed. codegraph
  // has `-f` for exactly this case; passing it here would index the user's whole
  // machine because a tool call said so.
  const scope = assessScope(root)
  if (scope.level === "warn") {
    return { kind: "skipped", reason: `${root} is ${scope.reason}; codegraph indexing was not started` }
  }

  const last = lastLaunch.get(root)
  const now = clock.now()
  if (last !== undefined && now - last < MIN_LAUNCH_INTERVAL_MS) {
    return { kind: "skipped", reason: "codegraph was launched for this workspace moments ago" }
  }

  // "Not installed" arrives as either a false or a throw: spawn() reports a
  // missing binary as ENOENT on the error event. Both mean the same ordinary
  // thing, so both are a skip. A throw here is not a failure of this plugin —
  // it is the absence of an optional companion, which is the case the whole
  // design has to get right.
  let available: boolean
  try {
    available = await runner.available()
  } catch {
    available = false
  }
  if (!available) {
    return { kind: "skipped", reason: `the codegraph CLI is not installed (npm i -g ${CODEGRAPH_PACKAGE})` }
  }

  const initialized = isCodegraphInitialized(root)
  const args = initialized ? ["sync"] : ["init", "--yes"]
  const action = initialized ? "sync" : "init"

  // Recorded before launching, so a failed launch still rate-limits: otherwise
  // a broken CLI would be spawned again on every single build.
  lastLaunch.set(root, now)

  try {
    await runner.launch(args, root)
  } catch (error) {
    return { kind: "failed", reason: `could not start \`codegraph ${args.join(" ")}\`: ${message(error)}` }
  }

  return {
    kind: "launched",
    launch: {
      action,
      command: `codegraph ${args.join(" ")}`,
      detail: initialized
        ? "syncing changes since the last index"
        : "building the first index for this folder",
    },
  }
}

/** Test seam: forget the rate-limit state. */
export function resetCodegraphLaunchState(): void {
  lastLaunch.clear()
}

/**
 * One line for `indexing_status`, or "" when there is nothing worth saying.
 *
 * Deliberately does not run the CLI: status is called on every search via the
 * footer, and spawning a process to decorate a status line is not a trade worth
 * making. The directory's existence is the whole answer.
 */
export function codegraphStatusLine(root: string): string {
  try {
    if (!fs.existsSync(root)) return ""
    const initialized = isCodegraphInitialized(root)
    return initialized
      ? "codegraph: indexed (synced on the next indexing_build)"
      : "codegraph: not indexed (initialised on the next indexing_build)"
  } catch {
    return ""
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
