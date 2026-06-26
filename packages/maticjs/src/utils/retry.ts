// Shared helper for retrying transient network failures.
//
// Node.js 19+ enables keep-alive on the global HTTP(S) agent by default. When
// a server closes an idle keep-alive connection, the next request that reuses
// that socket fails with a transient error (ECONNRESET, or a node-fetch
// "Premature close" while reading the response body). These are not real
// failures — a retry on a fresh socket succeeds. This helper centralises both
// the transient-error classification and the backoff loop so call sites
// (Ethereum RPC reads, the ABI/config metadata fetch) don't each reimplement it.

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  // node-fetch surfaces a prematurely-closed response-body stream with this code.
  'ERR_STREAM_PREMATURE_CLOSE'
]);

interface ErrorLike {
  code?: unknown;
  errno?: unknown;
  message?: unknown;
}

/**
 * True for connection-level failures that are safe to retry on a fresh socket:
 * the known transient `code`/`errno` values, plus node-fetch's "Premature
 * close" / "socket hang up" (which arrive as a wrapped FetchError whose message
 * — not always its `code` — carries the cause).
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') {
    return false;
  }
  const { code, errno, message } = err as ErrorLike;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) {
    return true;
  }
  if (typeof errno === 'string' && TRANSIENT_CODES.has(errno)) {
    return true;
  }
  if (typeof message === 'string') {
    const lower = message.toLowerCase();
    return lower.includes('premature close') || lower.includes('socket hang up');
  }
  return false;
}

export interface RetryOptions {
  /** Number of retries AFTER the first attempt. Default 2 (so up to 3 tries). */
  retries?: number;
  /** Base backoff in ms; the i-th retry waits up to `baseDelayMs * 2^i`. Default 50. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff delay, in ms. Default 250. */
  maxDelayMs?: number;
  /** Predicate deciding whether an error is retryable. Default: transient network errors. */
  shouldRetry?: (err: unknown) => boolean;
}

/**
 * Run `fn`, retrying on retryable errors with full-jitter exponential backoff.
 * Full jitter (delay drawn from `[0, cap]`) avoids synchronised retry bursts
 * when many calls fail at once. Non-retryable errors propagate immediately.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 50;
  const maxDelayMs = options.maxDelayMs ?? 250;
  const shouldRetry = options.shouldRetry ?? isTransientNetworkError;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) {
        throw err;
      }
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delayMs = Math.random() * cap;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
