import pLimit from 'p-limit';

/**
 * Run an async `fn` over every element of `items` with at most `limit`
 * invocations in flight at any time, preserving input order in the
 * returned array and rejecting on the first failure.
 *
 * Compared to plain `Promise.all(items.map(fn))` this caps concurrency, so
 * fan-out work that hits a rate-limited RPC endpoint (e.g. fetching one
 * receipt per transaction in a 280-tx Polygon block) does not flood the
 * upstream and trigger 429s or socket exhaustion. Compared to the legacy
 * `mapPromise` helper that Stage 2 deletes, this rejects on the first
 * failure rather than swallowing errors into a per-item result wrapper —
 * callers that want partial success must wrap their per-item `fn` in a
 * `try/catch` and return a discriminated result themselves. That choice
 * matches every other Promise-returning API in the SDK (we throw; we do
 * not return `{ ok, value | error }`).
 */
export async function withConcurrency<T, R>(
  limit: number,
  items: readonly T[],
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const gate = pLimit(limit);
  return Promise.all(items.map((item) => gate(() => fn(item))));
}
