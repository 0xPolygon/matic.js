import type { Options } from 'tsup';

import { defineConfig } from 'tsup';

// esbuild's `Plugin` type, sourced via tsup's own option type so we
// don't take a direct dependency on the (un-hoisted, transitive)
// `esbuild` package for types.
type EsbuildPlugin = NonNullable<Options['esbuildPlugins']>[number];

/**
 * The v5 adapter SOURCE imports from the `ethers-v5` devDep alias
 * (`npm:ethers@5`) so the compiler sees the genuine v5 type surface and
 * the `@polygonlabs/source` dev condition resolves to a real package.
 * Published consumers, however, install a bare `ethers` (v5 or v6) — the
 * alias name `ethers-v5` does not exist in their node_modules. This
 * plugin keeps `ethers-v5` external (never bundled) AND rewrites the
 * emitted specifier to `ethers`, so `dist/adapters/ethers-v5.js` imports
 * from the package the consumer actually has installed.
 */
const rewriteEthersV5External: EsbuildPlugin = {
  name: 'rewrite-ethers-v5-external',
  setup(build) {
    build.onResolve({ filter: /^ethers-v5$/ }, () => ({
      path: 'ethers',
      external: true
    }));
  }
};

export default defineConfig({
  esbuildPlugins: [rewriteEthersV5External],
  // Multi-entry: the main barrel plus one entry per adapter subpath.
  // Each adapter is its own entry so consumers import only the web3
  // library they actually use — `@polygonlabs/maticjs/viem` statically
  // imports viem, `/ethers-v5` imports ethers, etc. The object keys
  // map to the emitted filenames (`dist/index.js`, `dist/adapters/viem.js`),
  // matching the package.json `exports` targets.
  entry: {
    index: 'src/index.ts',
    'adapters/viem': 'src/adapters/viem.ts',
    'adapters/ethers-v5': 'src/adapters/ethers-v5.ts',
    'adapters/ethers-v6': 'src/adapters/ethers-v6.ts',
    // Vendored `as const` ABIs, exposed at `@polygonlabs/maticjs/abi` so
    // consumers can call contract methods the SDK doesn't wrap directly,
    // pairing them with `pos.getAddresses()`.
    'abi/index': 'src/abi/index.ts'
  },
  // viem / ethers are optional peer deps and must never be bundled into
  // the adapter outputs — tsup externalises everything in `dependencies`
  // and `peerDependencies` by default, so the imports stay as bare
  // `import ... from 'viem'` specifiers in the emitted JS.
  //
  // ESM-only, deliberately: the runtime deps (@polygonlabs/verror)
  // are ESM-only packages, so a `.cjs` artifact could never
  // `require` them — the earlier dual-format build shipped dead `.cjs`
  // files that were both unreachable (no `require` export condition) and
  // unloadable. CJS consumers on Node >= 20 use `await import()` (or
  // native `require(esm)` on Node >= 20.19); see README.
  format: ['esm'],
  target: 'es2023',
  // The ABIs under `src/abi/` are codegenned from `@polygonlabs/meta` (a
  // build-time dev dependency) as local `as const` modules — see
  // `scripts/generate-abis.ts`. They are local source, so tsup inlines
  // both the JS and the declarations with no external reference; the
  // published package carries the ABI bytes and types with no runtime
  // dependency on meta. (A pure re-export from meta cannot work here:
  // rollup-dts won't follow meta's `exports`-mapped subpaths, so the
  // emitted `.d.ts` would reference `@polygonlabs/meta`, which consumers
  // don't install.)
  dts: true,
  clean: true,
  sourcemap: true,
  // Code splitting ON: with five entry points and `splitting: false`,
  // shared modules (errors.ts above all) were duplicated into every
  // entry bundle, so an error class thrown by an adapter chunk was a
  // different class object from the one imported from the main entry. Splitting hoists shared modules into one chunk that every
  // entry imports, restoring a single class identity per process.
  splitting: true,
  treeshake: true
});
