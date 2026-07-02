import { POSBridgeError } from '../errors.js';

/**
 * Minimal native-`fetch` GET. Used only by the address service and the
 * proof-API client. Node 20+ provides `fetch` natively, so the BUILD_ENV
 * branching from the legacy webpack-era client (`require('node-fetch')`)
 * is gone.
 *
 * Every failure throws a `POSBridgeError` keyed on `ROOT_HASH_RPC_FAILED`
 * — the closest semantic match in the closed error-code union for "an
 * upstream HTTP fetch did not return a usable body" — with the URL and
 * response details in `info` so the call site is identifiable in logs.
 *
 * The body is read as text first (not `res.json()` directly) so that BOTH
 * failure shapes are diagnosable, not just non-2xx:
 *
 * - non-2xx → status, statusText, and a body snippet (a CDN/WAF error or
 *   challenge page says *why* in its body; swallowing it made 0.x
 *   failures undiagnosable);
 * - 2xx with a non-JSON body (e.g. an HTML challenge page served with
 *   200) → the content-type and a body snippet, instead of a bare
 *   `SyntaxError: Unexpected token '<'` with no URL and no context.
 */
export async function httpGet<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });
  const text = await res.text();
  if (!res.ok) {
    const snippet = text.slice(0, 200);
    throw new POSBridgeError(
      'ROOT_HASH_RPC_FAILED',
      `GET ${url} failed: ${res.status} ${res.statusText}${snippet.length > 0 ? ` — ${snippet}` : ''}`,
      { url, status: res.status, statusText: res.statusText, bodySnippet: snippet }
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const contentType = res.headers.get('content-type') ?? 'unknown';
    const snippet = text.slice(0, 200);
    throw new POSBridgeError(
      'ROOT_HASH_RPC_FAILED',
      `GET ${url} returned ${res.status} but the body is not JSON (content-type: ${contentType}): ${snippet}`,
      { url, status: res.status, contentType, bodySnippet: snippet }
    );
  }
}
