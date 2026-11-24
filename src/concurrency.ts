/**
 * Run `fn` over `items` with at most `limit` callbacks in flight.
 *
 * Results keep the input order regardless of completion order. The first
 * rejection becomes the returned promise's rejection: no further items are
 * started, and workers already running are allowed to finish.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = items.length
  if (size === 0) return []
  const concurrency = Math.max(1, Math.floor(limit) || 1)
  const results = new Array<R>(size)
  let cursor = 0
  let failure: { error: unknown } | undefined

  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const index = cursor++
      if (index >= size) return
      try {
        results[index] = await fn(items[index]!, index)
      } catch (error) {
        failure ??= { error }
        return
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, size) }, worker))
  if (failure !== undefined) throw failure.error
  return results
}
