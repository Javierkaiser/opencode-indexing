import * as assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"

import { SKILL_DESCRIPTION, SKILL_FILE, SKILL_ID, SKILL_NAME, readSkill } from "../src/skill.ts"

/**
 * Pins the bundled skill: the loader points at a real file, that file names
 * the tools by their real names, the server registers the loader's values, and
 * the tarball ships the directory. The skill is prose, so nothing at runtime
 * fails when it drifts from the tools - this test is the drift alarm.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (relative: string): string => readFileSync(join(root, relative), "utf8")

describe("bundled skill", () => {
  test("the loader points at the shipped file and reads it", () => {
    assert.equal(SKILL_ID, "opencode-indexing")
    assert.ok(SKILL_NAME.length > 0)
    assert.ok(SKILL_DESCRIPTION.length > 0)
    // A fake URI is not a file: the host cannot give it a base directory or
    // list supporting files, and `Skill.prepare` treats it as a filesystem path.
    assert.ok(isAbsolute(SKILL_FILE), "the skill path must be an absolute filesystem path")
    assert.equal(SKILL_FILE, join(root, "skills", "opencode-indexing", "SKILL.md"))
    assert.ok(existsSync(SKILL_FILE), `${SKILL_FILE} is missing; registration would only log a warning`)
    assert.equal(readSkill(), readFileSync(SKILL_FILE, "utf8"))
  })

  test("the skill names every tool and behavior it relies on", () => {
    const skill = readSkill()

    for (const tool of [
      "indexing_search",
      "indexing_status",
      "indexing_refresh",
      "indexing_build",
      "indexing_import",
      "indexing_config",
      "indexing_config_set",
    ]) {
      assert.match(skill, new RegExp(`\\b${tool}\\b`), `${tool} must be written the way the host names it`)
    }
    assert.match(skill, /`path`/)
    assert.match(skill, /searchMaxResults/)
    assert.match(skill, /searchKilo/)
    assert.match(skill, /paused/)
  })

  test("the server registers the loader's values, not an inline copy", () => {
    const server = read("index.ts")

    assert.match(server, /ctx\.skill\.transform/)
    assert.match(server, /id: SKILL_ID/)
    assert.match(server, /name: SKILL_NAME/)
    assert.match(server, /description: SKILL_DESCRIPTION/)
    assert.match(server, /path: SKILL_FILE/)
    assert.match(server, /content: readSkill\(\)/)
    assert.match(server, /autoinvoke: true/)
    assert.doesNotMatch(server, /opencode-indexing:\/\/skill/)
    assert.doesNotMatch(server, /SKILL_CONTENT/)
  })

  test("the package ships the skills directory", () => {
    const pkg = JSON.parse(read("package.json")) as { files?: string[] }

    assert.ok(
      pkg.files?.includes("skills"),
      "files must include skills, or the path registered from index.ts does not exist when installed",
    )
  })
})
