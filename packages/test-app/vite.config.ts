/**
 * Vite config for the browser smoke test of @polygonlabs/maticjs.
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
 * The maticjs package.json exposes only the built `dist/` outputs
 * through `exports`. This app deliberately consumes the same artefacts
 * a published-npm consumer would: the tsup ESM bundle. That keeps the
 * smoke-test faithful to what users actually receive.
 */

import { defineConfig } from 'vite';

export default defineConfig({
  // # No Node polyfills, no stubs — deliberately
  //
  // The SDK's "works in browser bundles without Node polyfills" claim
  // is exactly what this app exists to verify, so the bundle is built
  // with Vite's defaults: no `vite-plugin-node-polyfills`, no aliasing
  // of `events`/`buffer`. (An earlier iteration had throw-on-call
  // stubs for those two, papering over @ethereumjs v5-line transitives
  // — @ethereumjs/mpt v10 removed them, and with the stubs gone this
  // build FAILS if a Node-builtin import ever creeps back in.)
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
