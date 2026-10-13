/**
 * Ranking metrics for a retrieval benchmark.
 *
 * Relevance is binary: a document is relevant to a query if it is listed in the
 * query's `expected` set. `ranked` is the list of file paths a strategy returned,
 * best first.
 */

/** 1 if any relevant document is within the first k positions, else 0. */
export function hitAtK(ranked, expected, k) {
  const top = ranked.slice(0, k)
  return top.some((doc) => expected.includes(doc)) ? 1 : 0
}

/** Fraction of the expected documents found within the first k positions. */
export function recallAtK(ranked, expected, k) {
  if (expected.length === 0) return 0
  const top = new Set(ranked.slice(0, k))
  return expected.filter((doc) => top.has(doc)).length / expected.length
}

/** Reciprocal rank of the first relevant document (0 when none is found). */
export function reciprocalRank(ranked, expected) {
  for (let i = 0; i < ranked.length; i++) {
    if (expected.includes(ranked[i])) return 1 / (i + 1)
  }
  return 0
}

/** nDCG@k with binary gains. */
export function ndcgAtK(ranked, expected, k) {
  const gain = (rank) => 1 / Math.log2(rank + 1)
  const dcg = ranked.slice(0, k).reduce((acc, doc, i) => acc + (expected.includes(doc) ? gain(i + 1) : 0), 0)
  const ideal = expected.slice(0, k).reduce((acc, _doc, i) => acc + gain(i + 1), 0)
  return ideal === 0 ? 0 : dcg / ideal
}

/** Arithmetic mean; 0 for an empty list. */
export function mean(values) {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}
