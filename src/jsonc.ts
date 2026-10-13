/** Minimal JSONC → JSON (strips // and block comments and trailing commas, preserving strings). */
export function stripJsonComments(input: string): string {
  // A UTF-8 BOM is not valid JSON and is what PowerShell and several Windows
  // editors write by default. Left in place, JSON.parse throws and the caller
  // silently falls back to defaults, losing whatever the file held.
  if (input.charCodeAt(0) === 0xfeff) input = input.replace(/^\uFEFF+/, "")
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
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
  // Trailing commas
  return out.replace(/,(\s*[}\]])/g, "$1")
}
