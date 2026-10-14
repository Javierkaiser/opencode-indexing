/**
 * Turns whatever a `catch` block received into a message a person can read.
 *
 * The idiom `error instanceof Error ? error.message : String(error)` silently
 * throws away the message for anything that is not an `Error`, and two of those
 * reach the user here: the RPC layer rejects with a plain
 * `{ _tag: "RpcError", type: "...", message: "..." }` object, and a `throw` of a
 * non-Error value does the same. Both surfaced as the literal string
 * `[object Object]`, which is the one output guaranteed to tell the reader
 * nothing about what went wrong.
 */

/** Shown when there is genuinely nothing to say. Avoids an empty toast. */
const UNKNOWN = "unknown error"

const clean = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return clean(error.message) ?? clean(error.name) ?? UNKNOWN
  }

  if (typeof error === "string") return clean(error) ?? UNKNOWN
  if (error === null || error === undefined) return UNKNOWN
  if (typeof error !== "object") return String(error)

  const record = error as Record<string, unknown>

  // The RPC contract puts the human part here; `type` is the machine half.
  const message = clean(record.message)
  if (message) return message

  // Some layers nest the real failure one level down.
  for (const key of ["error", "cause", "reason"]) {
    const nested = record[key]
    if (nested && nested !== error) {
      const described = describeError(nested)
      if (described !== UNKNOWN) return described
    }
  }

  const type = clean(record.type) ?? clean(record._tag)
  if (type) return type

  try {
    const json = JSON.stringify(record)
    if (json && json !== "{}" && json !== "null") return json.length > 400 ? `${json.slice(0, 397)}...` : json
  } catch {
    // Circular or otherwise unserialisable.
  }

  return UNKNOWN
}
