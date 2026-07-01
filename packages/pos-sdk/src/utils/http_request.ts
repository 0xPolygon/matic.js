import { POSBridgeError } from '../errors.js';

/**
 * Minimal native-`fetch` GET. Used only by the address service.
 * Node 20+ provides `fetch` natively, so the BUILD_ENV branching from
 * the legacy webpack-era client (`require('node-fetch')`) is gone.
 *
 * On a non-2xx response the function throws a `POSBridgeError` keyed on
 * `ROOT_HASH_RPC_FAILED` — the closest semantic match in the closed
 * error-code union for "an upstream HTTP fetch did not return a
 * usable body". The address-service passes the URL and status into
 * the error context so the call site is identifiable in logs.
 */
export async function httpGet<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });
  if (!res.ok) {
    throw new POSBridgeError(
      'ROOT_HASH_RPC_FAILED',
      `GET ${url} failed: ${res.status} ${res.statusText}`,
      { url, status: res.status, statusText: res.statusText }
    );
  }
  return (await res.json()) as T;
}
