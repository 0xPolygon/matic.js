/**
 * Vite config for the browser smoke test of @polygonlabs/pos-sdk.
 *
 * # Why no Buffer / process polyfill plugins
 *
 * The whole point of this package is to catch SDK code paths that
 * accidentally rely on Node built-ins. If we silently install
 * `vite-plugin-node-polyfills` (or `define: { 'global.Buffer': ... }`)
 * the browser bundle would mask exactly the failure mode we are trying
 * to surface. A consumer who installs the SDK into their Vite app and
 * does NOT also install a Buffer polyfill plugin is the realistic
 * deployment surface — that is the configuration we mirror here.
 *
 * # Why we consume the published `dist/` shape
 *
 * The pos-sdk package.json exposes only the built `dist/` outputs
 * through `exports`. This app deliberately consumes the same artefacts
 * a published-npm consumer would: the tsup ESM bundle. That keeps the
 * smoke-test faithful to what users actually receive.
 */

import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const stub = (relative: string): string =>
  fileURLToPath(new URL(`./src/node-stubs/${relative}`, import.meta.url));

export default defineConfig({
  // # Why we alias Node built-ins to throw-on-call stubs
  //
  // The pos-sdk dist transitively imports from Node's `events` and
  // `buffer` modules via `@ethereumjs/util` / `readable-stream` /
  // `safe-buffer`. Vite's default behaviour is to externalise these
  // (resulting in `__vite-browser-external` empty stubs); the
  // production build then errors out with `"EventEmitter" is not
  // exported by ...` because Rollup needs every named import to
  // resolve to a real export.
  //
  // We deliberately do NOT install `vite-plugin-node-polyfills` or any
  // similar shim. The smoke test's job is to surface SDK code paths
  // that reach for Node-only APIs, and a transparent polyfill would
  // make those paths *work* in the browser, defeating the test. The
  // stubs under `src/node-stubs/` provide just enough surface for the
  // bundle to load — every method call throws a recognisable runtime
  // error which the Playwright spec's console-error capture surfaces
  // in the test report.
  resolve: {
    alias: [
      { find: /^events$/, replacement: stub('events.ts') },
      { find: /^buffer$/, replacement: stub('buffer.ts') }
    ]
  },
  build: {
    target: 'es2023',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      // Hard-fail every `node:*` protocol import. If the SDK ever
      // statically imports `node:crypto` / `node:fs` / etc., the
      // build breaks here with a clear message rather than falling
      // back to a silent shim.
      external: (id): boolean => /^node:/.test(id)
    }
  },
  preview: {
    host: '127.0.0.1',
    strictPort: true
  }
});
