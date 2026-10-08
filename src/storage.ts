import type { KVStore } from "./types.ts"

const PREFIX = "oi/"

/** Adapts OpenCode's plugin storage (ctx.storage) to the plugin's KVStore. */
export function createPluginStorage(storage: {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: Array<{ key: string; value: unknown }>
    next?: string
  }>
}): KVStore {
  return {
    async get(key) {
      try {
        return await storage.get(PREFIX + key)
      } catch {
        return undefined
      }
    },
    async set(key, value) {
      await storage.set(PREFIX + key, value as never)
    },
    async remove(key) {
      await storage.remove(PREFIX + key)
    },
    async scan(options) {
      const result = await storage.scan({ ...options, prefix: PREFIX + options.prefix })
      return {
        entries: result.entries.map((entry) => ({
          key: entry.key.startsWith(PREFIX) ? entry.key.slice(PREFIX.length) : entry.key,
          value: entry.value,
        })),
        next: result.next?.startsWith(PREFIX) ? result.next.slice(PREFIX.length) : result.next,
      }
    },
  }
}

/** In-memory KVStore for tests and CLI harnesses. */
export function createMemoryStorage(initial?: Record<string, unknown>): KVStore {
  const map = new Map<string, unknown>(Object.entries(initial ?? {}))
  return {
    async get(key) {
      return map.get(key)
    },
    async set(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
    async scan(options) {
      const keys = [...map.keys()].filter((k) => k.startsWith(options.prefix)).sort()
      const after = options.after
      const start = after ? keys.findIndex((k) => k > after) : 0
      const slice = start < 0 ? [] : keys.slice(start, options.limit ? start + options.limit : undefined)
      return {
        entries: slice.map((key) => ({ key, value: map.get(key) })),
        next: options.limit && start + options.limit < keys.length ? slice[slice.length - 1] : undefined,
      }
    },
  }
}
