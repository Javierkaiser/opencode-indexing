/**
 * A tiny in-process TTL cache.
 *
 * Search reads a little metadata before it can answer — the own store's points
 * and profile, the Kilo collection name — and paying a round trip for it on
 * every search is pure latency. Values age out on their own, so the cache is
 * never a source of truth: anything that changes an index or the settings
 * invalidates it explicitly.
 */

export interface TtlCacheOptions {
  /** Clock used for expiry checks (`Date.now` by default); injectable for tests. */
  now?: () => number
}

export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>()
  private readonly now: () => number

  constructor(options: TtlCacheOptions = {}) {
    this.now = options.now ?? Date.now
  }

  /** The value while it has not expired; `undefined` otherwise. */
  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: K, value: V, ttlMs: number): void {
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs })
  }

  delete(key: K): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  /** Live keys, for prefix invalidation. Expired entries are pruned first. */
  keys(): K[] {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
    }
    return [...this.entries.keys()]
  }
}
