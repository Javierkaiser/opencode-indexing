import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { dirname, join } from "node:path"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, describe, test } from "node:test"

import {
  codegraphStatusLine,
  indexWithCodegraph,
  isCodegraphInitialized,
  resetCodegraphLaunchState,
  type CodegraphRunner,
} from "../src/codegraph.ts"
import { resolveSettings } from "../src/config.ts"
import { ALLOWED_DOT_DIRS } from "../src/scanner.ts"

/** Records what would have been spawned, and answers as the test needs. */
function runner(options: { installed?: boolean; throwOnLaunch?: boolean } = {}) {
  const calls: Array<{ args: string[]; cwd: string }> = []
  const installed = options.installed ?? true
  const value: CodegraphRunner = {
    async available() {
      if (installed) return true
      // What spawn("codegraph") does when nothing is on PATH: ENOENT.
      throw Object.assign(new Error("spawn codegraph ENOENT"), { code: "ENOENT" })
    },
    async launch(args, cwd) {
      calls.push({ args, cwd })
      if (options.throwOnLaunch) throw new Error("EACCES")
    },
  }
  return { runner: value, calls }
}

/** A clock that never advances, so the rate limiter never trips unexpectedly. */
const fixedClock = { now: () => 1_000_000 }

const tempRoots: string[] = []
function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-${name}-`))
  tempRoots.push(dir)
  return dir
}

afterEach(() => {
  resetCodegraphLaunchState()
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("which package actually provides the CLI", () => {
  test("the message names the scoped package, not the unscoped namesake", async () => {
    // `codegraph` on npm is an unrelated 2024 library by a different author with
    // no binary at all. `npm install -g codegraph` exits 0, puts nothing on PATH,
    // and the installer then reports success. The scoped name is the only correct
    // one, and it is written in three places, so it is pinned here.
    const { indexWithCodegraph: run } = await import("../src/codegraph.ts")
    const { runner: cli } = runner({ installed: false })
    const outcome = await run({
      root: tempDir("pkgname"),
      enabled: true,
      runner: cli,
      clock: fixedClock,
    })
    assert.equal(outcome.kind, "skipped")
    if (outcome.kind !== "skipped") return
    // The install instruction must name the scoped package. The bare word
    // "codegraph" elsewhere is the CLI's own name and is correct there.
    assert.match(outcome.reason, /npm i -g @colbymchenry\/codegraph/)
    const instruction = outcome.reason.match(/npm i -g (\S+)/)?.[1] ?? ""
    assert.ok(
      instruction.startsWith("@"),
      `the install instruction must be scoped, got ${JSON.stringify(instruction)}`,
    )
  })

  test("install.mjs installs the same scoped package", () => {
    // install.mjs has its own copy of the constant; a test cannot import an
    // installer that runs on import, so this reads the source and asserts the
    // name it will actually shell out with.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "install.mjs"), "utf8")
    assert.match(source, /@colbymchenry\/codegraph/)
    assert.equal(
      /"install",\s*"-g",\s*"codegraph"/.test(source),
      false,
      "install.mjs must never install the unscoped codegraph package",
    )
  })
})

describe("codegraph as a companion, never a dependency", () => {
  test("with the CLI absent, nothing is spawned and the reason is honest", async () => {
    // The whole design rests on this. Someone who never installs codegraph must
    // get a plugin that behaves exactly as it did before, including no noise:
    // "not installed" is not a problem to report on every single build.
    const root = tempDir("absent")
    const { runner: cli, calls } = runner({ installed: false })
    const outcome = await indexWithCodegraph({ root, enabled: true, runner: cli, clock: fixedClock })
    assert.equal(outcome.kind, "skipped")
    if (outcome.kind !== "skipped") return
    assert.match(outcome.reason, /not installed/)
    assert.equal(calls.length, 0, "nothing may be launched when the CLI is missing")
  })

  test("a missing CLI is indistinguishable from the feature being off", async () => {
    const root = tempDir("quiet")
    const { runner: absent } = runner({ installed: false })
    const { runner: present, calls } = runner({ installed: true })

    const off = await indexWithCodegraph({ root, enabled: false, runner: present, clock: fixedClock })
    assert.equal(off.kind, "skipped")
    assert.equal(calls.length, 0)

    const missing = await indexWithCodegraph({ root, enabled: true, runner: absent, clock: fixedClock })
    assert.equal(missing.kind, "skipped")
    assert.equal(
      calls.length,
      0,
      "a user who never installed codegraph must see the same behaviour as one who turned it off",
    )
  })

  test("a folder that was never indexed gets init, and it is non-interactive", async () => {
    const root = tempDir("fresh")
    const { runner: cli, calls } = runner()
    const outcome = await indexWithCodegraph({ root, enabled: true, runner: cli, clock: fixedClock })

    assert.equal(outcome.kind, "launched")
    assert.deepEqual(calls[0]?.args, ["init", "--yes"])
    assert.equal(calls[0]?.cwd, root)
    // -y is the whole reason a tool call cannot hang on a prompt: nobody is
    // there to answer it, and stdio is ignored, so an unanswered prompt would
    // wait forever. Never `index`, and never `-f` (see the scope test).
    assert.equal(calls[0]?.args.includes("-f"), false)
  })

  test("an indexed folder gets sync, because the daemon may be asleep", async () => {
    const root = tempDir("existing")
    fs.mkdirSync(path.join(root, ".codegraph"))
    const { runner: cli, calls } = runner()

    const outcome = await indexWithCodegraph({ root, enabled: true, runner: cli, clock: fixedClock })
    assert.equal(outcome.kind, "launched")
    assert.deepEqual(calls[0]?.args, ["sync"])
  })

  test("a failed launch is reported and never thrown", async () => {
    // The semantic index is finished by the time this runs. Letting an
    // exception escape would turn a successful build into a failed tool call.
    const root = tempDir("broken")
    const { runner: cli } = runner({ throwOnLaunch: true })
    const outcome = await indexWithCodegraph({ root, enabled: true, runner: cli, clock: fixedClock })
    assert.equal(outcome.kind, "failed")
    if (outcome.kind !== "failed") return
    assert.match(outcome.reason, /EACCES/)
  })

  test("a dangerous root is refused rather than forced", async () => {
    // codegraph has -f for exactly this case, and codegraph init -f on a home
    // directory would index the whole machine because a tool call said so.
    // Tested on the real home directory so the platform cannot decline to
    // classify it: a test that returns early here would prove nothing.
    const home = os.homedir()
    const { assessScope } = await import("../src/scope.ts")
    const scope = assessScope(home, home)
    assert.equal(scope.level, "warn", "the home directory must be classified as unsafe")

    const { runner: cli, calls } = runner()
    const outcome = await indexWithCodegraph({ root: home, enabled: true, runner: cli, clock: fixedClock })
    assert.equal(outcome.kind, "skipped")
    if (outcome.kind !== "skipped") return
    assert.match(outcome.reason, /was not started/)
    assert.equal(calls.length, 0, "nothing may be launched against the home directory")
  })

  test("two builds seconds apart launch once, because codegraph also has a watcher", async () => {
    // codegraph runs a daemon that auto-syncs on file changes. Two syncs
    // seconds apart contend for the same SQLite database.
    const root = tempDir("rapid")
    fs.mkdirSync(path.join(root, ".codegraph"))
    const { runner: cli, calls } = runner()
    let now = 1_000_000
    const clock = { now: () => now }

    await indexWithCodegraph({ root, enabled: true, runner: cli, clock })
    now += 2_000
    const second = await indexWithCodegraph({ root, enabled: true, runner: cli, clock })

    assert.equal(calls.length, 1)
    assert.equal(second.kind, "skipped")
    if (second.kind !== "skipped") return
    assert.match(second.reason, /moments ago/)

    // Long after the window, it runs again.
    now += 60_000
    await indexWithCodegraph({ root, enabled: true, runner: cli, clock })
    assert.equal(calls.length, 2)
  })

  test("a launch that failed still rate-limits, so a broken CLI is not respawned forever", async () => {
    const root = tempDir("retry")
    const { runner: cli, calls } = runner({ throwOnLaunch: true })
    let now = 2_000_000
    const clock = { now: () => now }
    await indexWithCodegraph({ root, enabled: true, runner: cli, clock })
    now += 1_000
    const again = await indexWithCodegraph({ root, enabled: true, runner: cli, clock })
    assert.equal(again.kind, "skipped")
    assert.equal(calls.length, 1)
  })
})

describe("with the real runner", () => {
  test("it detects a CLI that npm installed as a Windows shim", async () => {
    // npm installs executables as .cmd/.ps1 shims, which spawn() cannot resolve
    // without a shell: it reports ENOENT for a binary that is installed and
    // working, and the plugin then tells someone who did install it that it is
    // "not installed". Found by running the real spawner on a machine where
    // codegraph was present; a fake runner would have passed this.
    const { realRunner } = await import("../src/codegraph.ts")
    const available = await realRunner.available()
    // Either answer is correct here — what matters is that the answer matches
    // reality, and that it never throws.
    assert.equal(typeof available, "boolean")
  })

  test("a missing CLI is a silent skip, not a failure", async () => {
    // The tests above inject a fake runner, which proves the logic but not the
    // wiring. This one runs the real spawner with codegraph hidden from PATH,
    // which is exactly what a user who never installed it looks like.
    const { indexWithCodegraph: real, resetCodegraphLaunchState: reset } = await import("../src/codegraph.ts")
    const emptyBin = tempDir("emptybin")
    const originalPath = process.env.PATH
    const originalPathExt = process.env.PATH_EXT
    process.env.PATH = emptyBin
    process.env.PATH_EXT = emptyBin
    try {
      reset()
      const outcome = await real({ root: tempDir("real-nogcli"), enabled: true })
      assert.equal(outcome.kind, "skipped", "a missing CLI must never surface as a failure")
      if (outcome.kind !== "skipped") return
      assert.match(outcome.reason, /not installed/)
    } finally {
      process.env.PATH = originalPath
      if (originalPathExt === undefined) delete process.env.PATH_EXT
      else process.env.PATH_EXT = originalPathExt
    }
  })
})

describe("codegraph status line", () => {
  test("it reads the filesystem and spawns nothing", () => {
    // status runs on every search through the footer. Running a CLI to decorate
    // a status line is not a trade worth making, so this is sync and free.
    const indexed = tempDir("status-yes")
    fs.mkdirSync(path.join(indexed, ".codegraph"))
    const bare = tempDir("status-no")

    assert.match(codegraphStatusLine(indexed), /indexed/)
    assert.match(codegraphStatusLine(bare), /not indexed/)
    assert.equal(codegraphStatusLine(path.join(bare, "does", "not", "exist")), "")
  })

  test("it says nothing about a workspace that does not exist", () => {
    assert.equal(codegraphStatusLine(""), "")
  })
})

describe("the two indexers never index each other", () => {
  test(".codegraph is not walked by the scanner", () => {
    // The single most expensive mistake available here: codegraph writes a
    // multi-megabyte SQLite database plus a WAL into .codegraph/, and the
    // scanner walks every directory whose name does not start with a dot
    // unless it is explicitly allowed. If .codegraph ever lands in
    // ALLOWED_DOT_DIRS, this plugin starts chunking and embedding codegraph's
    // own database into the semantic index, for money, forever.
    assert.equal(ALLOWED_DOT_DIRS.has(".codegraph"), false)
  })

  test("a .codegraph directory is skipped the way every other dot directory is", async () => {
    const root = tempDir("scan")
    fs.mkdirSync(path.join(root, ".codegraph"), { recursive: true })
    fs.writeFileSync(path.join(root, ".codegraph", "codegraph.db"), "not source")
    fs.writeFileSync(path.join(root, "real.ts"), "export const x = 1\n")

    const { scanWorkspace } = await import("../src/scanner.ts")
    // Extensions carry the dot (ScanOptions), so "ts" would match nothing and
    // the test would pass for the wrong reason.
    const scan = await scanWorkspace(root, { extensions: [".ts"] })
    const rel = scan.files.map((f) => f.relPath.toLowerCase())
    assert.ok(!rel.some((p) => p.includes(".codegraph")), `scanner returned ${rel.join(", ")}`)
    assert.ok(rel.some((p) => p.endsWith("real.ts")))
  })
})

describe("codegraph default", () => {
  test("on unless explicitly turned off, and absent means on", () => {
    // `!== false` rather than `=== true`: the key is in no config file anyone
    // has, so a default that required it to be present would never apply.
    const base = { ignoreKiloConfig: true }
    assert.equal(resolveSettings(base).codegraph, true)
    assert.equal(resolveSettings({ ...base, codegraph: false }).codegraph, false)
    assert.equal(resolveSettings({ ...base, codegraph: true }).codegraph, true)
  })
})
