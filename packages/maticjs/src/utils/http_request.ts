import { redactTokens } from '../adapters/sanitise.js';
import { HttpRequestFailedError, thrownValueMessage } from '../errors.js';

/**
 * Minimal native-`fetch` GET. Used only by the address service and the
 * proof-API client. Node 20+ provides `fetch` natively, so the BUILD_ENV
 * branching from the legacy webpack-era client (`require('node-fetch')`)
 * is gone.
 *
 * Every failure throws an `HttpRequestFailedError`
 * with the URL and response details in `info` so the call site is
 * identifiable in logs — including network-level failures (DNS, refused
 * connection, TLS), which the platform `fetch` raises as a bare
 * `TypeError: fetch failed` that would otherwise escape the SDK's typed
 * error contract; those are wrapped with the original error as `cause`.
 *
 * The body is read as text first (not `res.json()` directly) so that BOTH
 * response failure shapes are diagnosable, not just non-2xx:
 *
 * - non-2xx → status, statusText, and a body snippet (a CDN/WAF error or
 *   challenge page says *why* in its body; swallowing it made 0.x
 *   failures undiagnosable);
 * - 2xx with a non-JSON body (e.g. an HTML challenge page served with
 *   200) → the content-type and a body snippet, instead of a bare
 *   `SyntaxError: Unexpected token '<'` with no URL and no context.
 */
export async function httpGet<T>(
  url: string,
  {
    // Callers whose URLs carry credentials outside `token=` (a keyed base
    // URL) pass a stricter redactor; it replaces the default everywhere a
    // URL or body snippet is embedded in the error.
    redact = redactTokens,
    // A caller that knows which params it appended passes the URL's
    // error-safe form, built when the URL was (see `buildRequestUrl`), so
    // every error names the request the same way.
    safeUrl = redact(url)
  }: { redact?: (s: string) => string; safeUrl?: string } = {}
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      // Hard ceiling on any single index/proof-API fetch. Without one, a
      // blackholed endpoint stalls `POSClient.init` (and pins the single
      // inflight address-refresh slot) until the platform socket timeout
      // — minutes. 30s is far above the CDN's normal (<1s) while still
      // bounding the worst case; available on Node >= 20 and browsers.
      signal: AbortSignal.timeout(30_000)
    });
  } catch (err) {
    throw new HttpRequestFailedError(
      `GET ${safeUrl} failed at the network layer: ${thrownValueMessage(err)}`,
      {
        info: { url: safeUrl },
        cause: err instanceof Error ? err : new Error(thrownValueMessage(err))
      }
    );
  }
  const text = await res.text();
  // The URL and body are redacted BEFORE they are embedded in an error —
  // the minted error then never holds the secret (defence-in-depth on top
  // of the consumer-facing `sanitiseError`).
  if (!res.ok) {
    const snippet = redact(text.slice(0, 200));
    throw new HttpRequestFailedError(
      `GET ${safeUrl} failed: ${res.status} ${res.statusText}${snippet.length > 0 ? ` — ${snippet}` : ''}`,
      {
        info: { url: safeUrl, status: res.status, statusText: res.statusText, bodySnippet: snippet }
      }
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const contentType = res.headers.get('content-type') ?? 'unknown';
    const snippet = redact(text.slice(0, 200));
    throw new HttpRequestFailedError(
      `GET ${safeUrl} returned ${res.status} but the body is not JSON (content-type: ${contentType}): ${snippet}`,
      {
        info: { url: safeUrl, status: res.status, contentType, bodySnippet: snippet },
        cause: err instanceof Error ? err : new Error(String(err))
      }
    );
  }
}
