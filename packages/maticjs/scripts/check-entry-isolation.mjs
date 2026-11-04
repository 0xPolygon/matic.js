/**
 * Entry-isolation gate over the built `dist/`.
 *
 * The bridge and staking surfaces ship as separate entries so that a
 * bridge-only consumer never loads the staking ABIs (~80 KB) and a
 * staking-only consumer never loads the bridge's proof machinery
 * (`@ethereumjs/mpt`, `rlp`). Bundlers with `sideEffects: false` would
 * tree-shake either way, but Node and other unbundled ESM consumers load
 * every module in an entry's static import closure — so the guarantee
 * only holds if the code-split chunks keep the two apart. A shared ABI
 * barrel silently merged them once; this check fails the build when it
 * happens again.
 *
 * It walks the static relative imports of each entry file (the chunks
 * esbuild emits), then asserts on the closure's text and its bare
 * specifiers. Deterministic: reads files only.
 *
 * Run: `node scripts/check-entry-isolation.mjs` after `pnpm run build`.
 * `scripts/pack-smoke.mjs` (the `test:pack` script, run in CI's build
 * matrix) invokes it right after building.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// Matches `import … from '…'`, `export … from '…'` and bare `import '…'`.
const SPECIFIER = /(?:^|[\s;])(?:import|export)\s*(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g;

const closureOf = (entry) => {
  const files = new Map();
  const bare = new Set();
  const visit = (file) => {
    if (files.has(file)) return;
    const text = readFileSync(file, 'utf8');
    files.set(file, text);
    for (const [, spec] of text.matchAll(SPECIFIER)) {
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
      else bare.add(spec);
    }
  };
  visit(join(distDir, entry));
  return { files, bare };
};

// Each staking ABI is identified two ways: its exported binding name and
// a function name that appears in no bridge ABI. Either one present in
// the bridge closure means that ABI's array was loaded.
const STAKING_ABI_MARKERS = [
  { abi: 'StakeManager', patterns: [/\bStakeManagerABI\b/, /"stakeForPOL"/] },
  { abi: 'ValidatorShare', patterns: [/\bValidatorShareABI\b/, /"buyVoucherPOL"/] },
  { abi: 'PolToken', patterns: [/\bPolTokenABI\b/, /"CAP_MANAGER_ROLE"/] }
];
const BRIDGE_ONLY_DEPS = ['@ethereumjs/mpt', 'rlp'];

const failures = [];

const bridge = closureOf('index.js');
for (const { abi, patterns } of STAKING_ABI_MARKERS) {
  for (const [file, text] of bridge.files) {
    if (patterns.some((p) => p.test(text))) {
      failures.push(
        `dist/index.js closure loads the ${abi} ABI (via ${file.slice(distDir.length + 1)})`
      );
      break;
    }
  }
}

const staking = closureOf('staking/index.js');
for (const dep of BRIDGE_ONLY_DEPS) {
  if (staking.bare.has(dep)) failures.push(`dist/staking/index.js closure imports '${dep}'`);
}
// Sanity: the walk must actually see what it guards, or a renamed marker
// would pass vacuously.
for (const { abi, patterns } of STAKING_ABI_MARKERS) {
  const seen = [...staking.files.values()].some((text) => patterns.every((p) => p.test(text)));
  if (!seen)
    failures.push(
      `marker for the ${abi} ABI not found in dist/staking/index.js closure (stale marker?)`
    );
}
for (const dep of BRIDGE_ONLY_DEPS) {
  if (!bridge.bare.has(dep))
    failures.push(`'${dep}' not found in dist/index.js closure (stale marker?)`);
}

if (failures.length > 0) {
  for (const f of failures) console.error(`✗ ${f}`);
  console.error('entry-isolation: FAILED');
  process.exit(1);
}
console.log(
  `✓ entry isolation: bridge closure (${bridge.files.size} files) has no staking ABI; ` +
    `staking closure (${staking.files.size} files) has no ${BRIDGE_ONLY_DEPS.join(' / ')}`
);
