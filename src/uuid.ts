import { createHash } from "node:crypto"

const HEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseUuid(uuid: string): Buffer {
  if (!HEX.test(uuid)) throw new Error(`Invalid UUID: ${uuid}`)
  return Buffer.from(uuid.replace(/-/g, ""), "hex")
}

/** RFC 4122 v5 UUID (SHA-1 based), same construction as the `uuid` npm package. */
export function uuidv5(name: string, namespace: string): string {
  const ns = parseUuid(namespace)
  const hash = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50 // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 4122 variant
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** UUIDv5 with the same namespace Kilo uses for chunk point IDs. */
export const CHUNK_NAMESPACE = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
