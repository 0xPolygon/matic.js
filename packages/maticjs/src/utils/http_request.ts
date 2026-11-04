import { redactTokens } from '../adapters/sanitise.js';
import { POSBridgeError } from '../errors.js';

/**
 * Minimal native-`fetch` GET. Used only by the address service and the
 * proof-API client. Node 20+ provides `fetch` natively, so the BUILD_ENV
 * branching from the legacy webpack-era client (`require('node-fetch')`)
 * is gone.
 *
 * Every failure throws a `POSBridgeError` keyed on `HTTP_REQUEST_FAILED`
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
export async function httpGet<T>(url: string): Promise<T> {
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
    throw new POSBridgeError(
      'HTTP_REQUEST_FAILED',
      `GET ${redactTokens(url)} failed at the network layer: ${err instanceof Error ? err.message : String(err)}`,
      { url: redactTokens(url) },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }
  const text = await res.text();
  // Redact auth tokens BEFORE embedding the URL/body in an error — the
  // minted error then never holds the secret (defence-in-depth on top of
  // the consumer-facing `sanitiseError`).
  const safeUrl = redactTokens(url);
  if (!res.ok) {
    const snippet = redactTokens(text.slice(0, 200));
    throw new POSBridgeError(
      'HTTP_REQUEST_FAILED',
      `GET ${safeUrl} failed: ${res.status} ${res.statusText}${snippet.length > 0 ? ` — ${snippet}` : ''}`,
      { url: safeUrl, status: res.status, statusText: res.statusText, bodySnippet: snippet }
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const contentType = res.headers.get('content-type') ?? 'unknown';
    const snippet = redactTokens(text.slice(0, 200));
    throw new POSBridgeError(
      'HTTP_REQUEST_FAILED',
      `GET ${safeUrl} returned ${res.status} but the body is not JSON (content-type: ${contentType}): ${snippet}`,
      { url: safeUrl, status: res.status, contentType, bodySnippet: snippet }
    );
  }
}
