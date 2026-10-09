import * as assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, describe, test } from "node:test"

import {
  forgetWorkspace,
  readWorkspaces,
  recordWorkspace,
  workspacesFilePath,
  type WorkspaceRecord,
} from "../src/workspaces.ts"
import { assessScope } from "../src/scope.ts"

const originalXdg = process.env.XDG_CONFIG_HOME
/** The registry lives next to the settings file: keep tests out of the real one. */
const xdgHome = mkdtempSync(path.join(os.tmpdir(), "oi-workspaces-"))
process.env.XDG_CONFIG_HOME = xdgHome

after(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdg
  rmSync(xdgHome, { recursive: true, force: true })
})

function record(root: string, store: string, overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    root,
    store,
    kind: "qdrant",
    profile: "mistral:codestral-embed:1024",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

/** Every test starts from a registry that does not exist yet. */
function resetRegistry(): void {
  rmSync(workspacesFilePath(), { force: true })
}

describe("workspace registry", () => {
  test("the file sits next to the settings file in the config dir", () => {
    assert.equal(workspacesFilePath(), path.join(xdgHome, "opencode", "indexing-workspaces.json"))
  })

  test("a missing file reads as an empty registry", () => {
    resetRegistry()
    assert.deepEqual(readWorkspaces(), [])
  })

  test("a corrupt or non-array file reads as empty instead of throwing", () => {
    const file = workspacesFilePath()
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "{ this is not json", "utf8")
    assert.deepEqual(readWorkspaces(), [])

    writeFileSync(file, JSON.stringify({ workspaces: [] }), "utf8")
    assert.deepEqual(readWorkspaces(), [])

    writeFileSync(file, JSON.stringify(["nonsense", { root: "no-store" }]), "utf8")
    assert.deepEqual(readWorkspaces(), [])
  })

  test("recording upserts by store, so re-indexing never duplicates", () => {
    resetRegistry()
    const first = record("D:\\proj", "oc-1a06d5eeba99bff7")
    recordWorkspace(first)
    recordWorkspace(record("D:\\other", "oc-2b17e6fccbaaccf8"))
    recordWorkspace(record("D:\\proj", "oc-1a06d5eeba99bff7", {
      profile: "openai:text-embedding-3-small:1536",
      updatedAt: "2026-02-03T04:05:06.000Z",
    }))

    const records = readWorkspaces()
    assert.equal(records.length, 2, "same store updates instead of appending")
    assert.deepEqual(records[0], {
      root: "D:\\proj",
      store: "oc-1a06d5eeba99bff7",
      kind: "qdrant",
      profile: "openai:text-embedding-3-small:1536",
      updatedAt: "2026-02-03T04:05:06.000Z",
    })
    assert.equal(records[1]!.store, "oc-2b17e6fccbaaccf8")
  })

  test("records survive a read-modify-write round trip through the file", () => {
    resetRegistry()
    recordWorkspace(record("D:\\proj", "oc-1a06d5eeba99bff7", { kind: "lancedb", profile: null }))
    assert.ok(existsSync(workspacesFilePath()))

    const [only] = readWorkspaces()
    assert.equal(only!.root, "D:\\proj")
    assert.equal(only!.kind, "lancedb")
    assert.equal(only!.profile, null)
  })

  test("forget reports whether an entry existed", () => {
    resetRegistry()
    recordWorkspace(record("D:\\proj", "oc-1a06d5eeba99bff7"))
    recordWorkspace(record("D:\\other", "oc-2b17e6fccbaaccf8"))

    assert.equal(forgetWorkspace("oc-1a06d5eeba99bff7"), true)
    assert.deepEqual(
      readWorkspaces().map((entry) => entry.store),
      ["oc-2b17e6fccbaaccf8"],
    )
    assert.equal(forgetWorkspace("oc-1a06d5eeba99bff7"), false, "already gone")
    assert.equal(forgetWorkspace("oc-does-not-exist"), false)
  })

  test("an unwritable config dir degrades to an empty registry", () => {
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = "NUL:\\unwritable"
    try {
      assert.deepEqual(readWorkspaces(), [])
      assert.equal(forgetWorkspace("oc-1a06d5eeba99bff7"), false)
      recordWorkspace(record("D:\\proj", "oc-1a06d5eeba99bff7"))
      assert.deepEqual(readWorkspaces(), [], "a failed write never throws and never reports")
    } finally {
      process.env.XDG_CONFIG_HOME = previous
    }
  })
})

describe("assessScope", () => {
  const temporaries: string[] = []

  function makeDir(name: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), name))
    temporaries.push(dir)
    return dir
  }

  function gitRepo(parent: string, name: string): void {
    const dir = path.join(parent, name)
    mkdirSync(path.join(dir, ".git"), { recursive: true })
    writeFileSync(path.join(dir, "README.md"), "# repo\n", "utf8")
  }

  after(() => {
    for (const dir of temporaries) rmSync(dir, { recursive: true, force: true })
  })

  test("a plain project is fine", () => {
    const home = makeDir("oi-home-")
    const project = makeDir("oi-project-")
    mkdirSync(path.join(project, "src"), { recursive: true })

    const assessment = assessScope(project, home)
    assert.equal(assessment.level, "ok")
    assert.equal(assessment.reason, "")
  })

  test("the home directory itself warns", () => {
    const home = makeDir("oi-home-")
    const assessment = assessScope(home, home)
    assert.equal(assessment.level, "warn")
    assert.match(assessment.reason, /home directory/)
  })

  test("a parent of the home directory warns", () => {
    const home = makeDir("oi-home-")
    const parent = path.dirname(home)
    const assessment = assessScope(parent, home)
    assert.equal(assessment.level, "warn")
    assert.match(assessment.reason, /home directory/)
  })

  test("a project inside the home directory does not warn", () => {
    const home = makeDir("oi-home-")
    const project = path.join(home, "code", "my-project")
    mkdirSync(path.join(project, "src"), { recursive: true })

    const assessment = assessScope(project, home)
    assert.equal(assessment.level, "ok", "projects normally live under the home directory")
  })

  test("a drive root warns", () => {
    const home = makeDir("oi-home-")
    const assessment = assessScope(path.parse(os.tmpdir()).root, home)
    assert.equal(assessment.level, "warn")
    assert.notEqual(assessment.reason, "")
  })

  test("three git repositories in the direct subdirectories warn", () => {
    const home = makeDir("oi-home-")
    const container = makeDir("oi-container-")
    for (const name of ["alpha", "beta", "gamma"]) gitRepo(container, name)

    const assessment = assessScope(container, home)
    assert.equal(assessment.level, "warn")
    assert.match(assessment.reason, /3 of its direct subdirectories are git repositories/)
  })

  test("node_modules and dot-directories are not counted as repositories", () => {
    const home = makeDir("oi-home-")
    const container = makeDir("oi-container-")
    gitRepo(container, "alpha")
    gitRepo(container, "beta")
    gitRepo(container, "node_modules")
    gitRepo(container, ".hidden")

    const assessment = assessScope(container, home)
    assert.equal(assessment.level, "ok", "only two real repositories were present")
  })

  test("an empty directory is fine", () => {
    const home = makeDir("oi-home-")
    const empty = makeDir("oi-empty-")
    const assessment = assessScope(empty, home)
    assert.equal(assessment.level, "ok")
  })
})
