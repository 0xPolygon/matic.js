/**
 * Minimal browser stub for Node's `buffer` module.
 *
 * Same rationale as `events.ts`: the pos-sdk dist transitively pulls in
 * `'buffer'` via `readable-stream` and `safe-buffer`. We map the
 * import to this stub so `vite build` succeeds; runtime calls into
 * `Buffer.*` then throw a recognisable error caught by the spec's
 * console-error capture, surfacing the Node-only code path without a
 * silent polyfill.
 */

const notImplemented = (method: string): never => {
  throw new Error(
    `node:buffer stub: ${method} called in the browser. SDK code path is reaching for the Node Buffer API; resolve by removing the dep upstream or accepting the tradeoff and installing vite-plugin-node-polyfills.`
  );
};

const trap = (name: string): ((...args: unknown[]) => never) => {
  return (..._args: unknown[]): never => notImplemented(`Buffer.${name}`);
};

export const Buffer = {
  from: trap('from'),
  alloc: trap('alloc'),
  allocUnsafe: trap('allocUnsafe'),
  isBuffer: trap('isBuffer'),
  concat: trap('concat')
};
