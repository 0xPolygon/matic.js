/**
 * Post-build declaration fixup + packaging invariants. Runs as part of
 * `pnpm run build` (and therefore `prepublishOnly`).
 *
 * Plain JavaScript, deliberately: `build` runs across the full supported
 * Node matrix (20/22/24) in CI, and Node 20 cannot execute TypeScript
 * natively.
 *
 * 1. Rewrites the `ethers-v5` module specifier to `ethers` in the emitted
 *    declaration files. The SOURCE imports from the `ethers-v5` devDep
 *    alias (`npm:ethers@^5.8.0`) so the compiler sees the genuine v5 type
 *    surface, and a tsup/esbuild plugin already rewrites the specifier in
 *    the emitted JS — but rollup-dts does not run esbuild plugins, so
 *    without this step the shipped `dist/adapters/ethers-v5.d.ts` imports
 *    from a package consumers never have. With `skipLibCheck: true` (the
 *    overwhelming default) that failure is SILENT: the adapter's types
 *    degrade to `any`.
 *
 * 2. Fails the build if any emitted runtime/type artifact still references
 *    a build-time-only package (`ethers-v5`, `@polygonlabs/meta`) — the
 *    class of packaging bug that ships artifacts unusable outside this
 *    repo.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name);
    return entry.isDirectory() ? walk(p) : [p];
  });
}

const files = walk(dist);

// 1. Rewrite `from 'ethers-v5'` → `from 'ethers'` in declaration output.
let rewrites = 0;
for (const file of files.filter((f) => f.endsWith('.d.ts') || f.endsWith('.d.cts'))) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(/(['"])ethers-v5\1/g, '$1ethers$1');
  if (after !== before) {
    writeFileSync(file, after);
    rewrites++;
  }
}

// 2. Invariants: no build-time-only specifier may survive in any shipped
//    runtime or type artifact (sourcemaps are exempt — they carry
//    provenance paths, not resolvable imports).
const offenders = [];
for (const file of files.filter((f) => !f.endsWith('.map'))) {
  const content = readFileSync(file, 'utf8');
  for (const banned of ["'ethers-v5'", '"ethers-v5"', '@polygonlabs/meta']) {
    if (content.includes(banned)) {
      offenders.push(`${file}: contains ${banned}`);
    }
  }
}
if (offenders.length > 0) {
  console.error('Packaging invariant violated — build-time-only specifiers in dist:');
  for (const line of offenders) console.error(`  ${line}`);
  process.exit(1);
}

console.log(`fix-dts-specifiers: rewrote ${rewrites} declaration file(s); dist invariants OK.`);
