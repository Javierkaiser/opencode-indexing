import { readFileSync } from "node:fs"

/**
 * Version of the installed plugin, as declared by its own package.json.
 *
 * Read from the manifest instead of hardcoded: the file is the single source of
 * truth for a release, and a constant here would drift from it silently,
 * reporting a version the user does not actually have. The manifest sits next
 * to `index.ts` in both install paths — an npm package and a local install,
 * whose derived package.json keeps the `version` field — so `../package.json`
 * from `src/` always resolves to it.
 *
 * Cached because every `settings.get` calls this. A failure is cached too:
 * the version is cosmetic, and the UI must never break because the manifest is
 * missing or unreadable, so it degrades to "unknown" once and stays there.
 */
let cached: string | undefined

export function pluginVersion(): string {
  if (cached !== undefined) return cached
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown
    }
    cached = typeof manifest.version === "string" && manifest.version.trim() !== "" ? manifest.version : "unknown"
  } catch {
    cached = "unknown"
  }
  return cached
}
