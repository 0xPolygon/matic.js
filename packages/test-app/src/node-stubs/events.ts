/**
 * Minimal browser stub for Node's `events` module.
 *
 * # Why this exists
 *
 * The pos-sdk dist transitively imports `EventEmitter` from `'events'`
 * via `@ethereumjs/util`'s `asyncEventEmitter.js`. Vite's default
 * behaviour is to externalise the module (treat it as not-bundled),
 * which works in dev mode but breaks `vite build`'s production path
 * with `"EventEmitter" is not exported by "__vite-browser-external"`.
 *
 * # Why we don't use a real polyfill
 *
 * The whole point of this smoke test is to surface SDK code paths
 * that touch Node-only APIs in the browser. A real `EventEmitter`
 * polyfill would silently make the SDK *work* in the browser, masking
 * exactly the regression we want to catch. This stub instead provides
 * just enough surface for the bundle to *load* — every real method
 * call on it throws a recognisable runtime error so the test spec's
 * console-error capture sees the SDK reaching for Node land.
 *
 * If this stub starts blocking new test scenarios because some
 * actually-browser-safe SDK code path uses an `EventEmitter` for
 * legitimate reasons, replace it with the real `events` polyfill via
 * `vite-plugin-node-polyfills`. That decision should be made
 * intentionally, not by reflex — losing the runtime catch is the
 * cost.
 */

const NOT_IMPLEMENTED = (method: string): Error =>
  new Error(
    `node:events stub: ${method} called in the browser. This means the SDK is reaching for a Node-only API; install vite-plugin-node-polyfills to support it (and accept the tradeoff that the test loses its detection signal for this dep).`
  );

export class EventEmitter {
  on(_event: string, _listener: (...args: unknown[]) => void): this {
    throw NOT_IMPLEMENTED('EventEmitter#on');
  }
  once(_event: string, _listener: (...args: unknown[]) => void): this {
    throw NOT_IMPLEMENTED('EventEmitter#once');
  }
  off(_event: string, _listener: (...args: unknown[]) => void): this {
    throw NOT_IMPLEMENTED('EventEmitter#off');
  }
  emit(_event: string, ..._args: unknown[]): boolean {
    throw NOT_IMPLEMENTED('EventEmitter#emit');
  }
  removeListener(_event: string, _listener: (...args: unknown[]) => void): this {
    throw NOT_IMPLEMENTED('EventEmitter#removeListener');
  }
  removeAllListeners(_event?: string): this {
    throw NOT_IMPLEMENTED('EventEmitter#removeAllListeners');
  }
}
