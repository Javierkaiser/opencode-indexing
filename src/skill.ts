import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * The bundled skill, shipped as Markdown beside `src`.
 *
 * Registering the real file, rather than a URI such as
 * `opencode-indexing://skill/indexing`, is what lets the host give the model a
 * base directory and list supporting files. The content is read when the
 * plugin registers it, inside a try/catch: a missing file must leave the tools
 * working and log a warning, not crash the server at import time.
 */
export const SKILL_ID = "opencode-indexing"
export const SKILL_NAME = "Semantic code search (indexing)"
export const SKILL_DESCRIPTION =
  "Use indexing_search to find code by intent; check indexing_status and run indexing_refresh when the index may be stale. Explains when Grep, Glob or Read are the better tool."
export const SKILL_FILE = fileURLToPath(new URL("../skills/opencode-indexing/SKILL.md", import.meta.url))

export const readSkill = (): string => readFileSync(SKILL_FILE, "utf8")
