/**
 * Entry-isolation gate over the built `dist/`.
 *
 * The bridge and staking surfaces ship as separate entries so that a
 * bridge-only consumer never loads the staking ABIs (~80 KB) and a
 * staking-only consumer never loads the bridge's proof machinery
 * (`@ethereumjs/mpt`, `@ethereumjs/rlp`). Bundlers with `sideEffects: false` would
 * tree-shake either way, but Node and other unbundled ESM consumers load
 * every module in an entry's static import closure — so the guarantee
 * only holds if the code-split chunks keep the two apart. A shared ABI
 * barrel silently merged them once; this check fails the build when it
 * happens again.
 *
 * The Plasma ABIs (`PlasmaDepositManagerABI`, `PlasmaWithdrawManagerABI`, the
 * burn-only predicate, …) follow the same rule: they live only in the
 * `plasma/abi/index.js` entry and the Plasma entry, so none of the bridge,
 * staking and `./abi` closures may load them. The `./abi` entry is held to it
 * explicitly because it is the one a Plasma ABI would be added to by mistake.
 * The Plasma entry in turn loads every Plasma ABI but no staking ABI, and no
 * web3 library: it takes its adapters as arguments, so a `viem` or `ethers`
 * import in its closure would load a library the consumer may not have
 * installed. The `plasma/abi` entry must itself hold every Plasma ABI (so the
 * markers cannot go stale unnoticed) and no staking ABI.
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
// The `\b` keeps prose such as "is imported from '…'" in a bundled
// comment from being read as an import.
const SPECIFIER = /(?:^|[\s;])(?:import|export)\b\s*(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g;

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
// Plasma ABIs, identified by exported binding and by a function or event
// name that appears in no bridge or staking ABI. A bare `DepositManager`
// pattern would be wrong: `GasSwapperABI` contains `IDepositManager`.
const PLASMA_ABI_MARKERS = [
  /\bPlasmaDepositManagerABI\b/,
  /\bPlasmaWithdrawManagerABI\b/,
  /"startExitWithBurntTokens"/,
  /"processExitsBatch"/,
  /"depositERC20ForUser"/,
  // One quoted function name per ABI that appears in no other src module, so a
  // single leaked ABI is named by its own marker.
  /"depositBulk"/,
  /"addExitToQueue"/,
  /"interpretStateUpdate"/,
  // `currentSupply` and `exists` are generic names a future module could
  // contain, so the MRC20 and ExitNFT ABIs are identified by their exported
  // bindings, which only those two ABI modules and their Plasma importers carry.
  /\bPlasmaMRC20ABI\b/,
  /"changeStateSyncerAddress"/,
  /\bPlasmaExitNFTABI\b/,
  /"delMin"/
];
const BRIDGE_ONLY_DEPS = ['@ethereumjs/mpt', '@ethereumjs/rlp'];

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
const plasmaLoadedBy = (closure) =>
  PLASMA_ABI_MARKERS.flatMap((pattern) =>
    [...closure.files].filter(([, text]) => pattern.test(text)).map(([file]) => ({ pattern, file }))
  );
const abiEntry = closureOf('abi/index.js');
for (const [entry, closure] of [
  ['dist/index.js', bridge],
  ['dist/staking/index.js', staking],
  ['dist/abi/index.js', abiEntry]
]) {
  for (const { pattern, file } of plasmaLoadedBy(closure)) {
    failures.push(
      `${entry} closure loads a Plasma ABI marker ${pattern} (via ${file.slice(distDir.length + 1)})`
    );
  }
}
for (const dep of BRIDGE_ONLY_DEPS) {
  if (staking.bare.has(dep)) failures.push(`dist/staking/index.js closure imports '${dep}'`);
}

const plasma = closureOf('plasma/index.js');
for (const { abi, patterns } of STAKING_ABI_MARKERS) {
  for (const [file, text] of plasma.files) {
    if (patterns.some((p) => p.test(text))) {
      failures.push(
        `dist/plasma/index.js closure loads the ${abi} ABI (via ${file.slice(distDir.length + 1)})`
      );
      break;
    }
  }
}
// `viem` and `ethers` are matched with their subpaths (`viem/chains`,
// `ethers/lib/utils`), and the `ethers-v5` alias the v5 adapter is written
// against, so none of them can be reached by another route.
const WEB3_LIBRARY = /^(?:viem|ethers)(?:[-/]|$)/;
for (const spec of plasma.bare) {
  if (WEB3_LIBRARY.test(spec)) failures.push(`dist/plasma/index.js closure imports '${spec}'`);
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
// The same non-vacuity check for the Plasma markers: the Plasma ABI entry is
// where they are meant to live, so a marker it lacks is stale. The `./abi`
// entry is asserted marker-free above, which would pass vacuously if every
// marker were stale; this is what makes that absence meaningful.
const plasmaAbi = closureOf('plasma/abi/index.js');
for (const pattern of PLASMA_ABI_MARKERS) {
  if (![...plasmaAbi.files.values()].some((text) => pattern.test(text)))
    failures.push(
      `Plasma marker ${pattern} not found in dist/plasma/abi/index.js closure (stale marker?)`
    );
}
for (const { abi, patterns } of STAKING_ABI_MARKERS) {
  for (const [file, text] of plasmaAbi.files) {
    if (patterns.some((p) => p.test(text))) {
      failures.push(
        `dist/plasma/abi/index.js closure loads the ${abi} ABI (via ${file.slice(distDir.length + 1)})`
      );
      break;
    }
  }
}
// And the other direction for the Plasma entry: it must load every Plasma ABI
// it calls, each identified by its own marker. A marker it lacks means an ABI
// the entry no longer imports on its own, or a stale marker.
for (const pattern of PLASMA_ABI_MARKERS) {
  if (![...plasma.files.values()].some((text) => pattern.test(text)))
    failures.push(
      `Plasma marker ${pattern} not found in dist/plasma/index.js closure (stale marker?)`
    );
}
// The bare-specifier walk must see the proof dependencies the Plasma entry
// builds exit payloads with, or the web3 check above would pass vacuously.
for (const dep of BRIDGE_ONLY_DEPS) {
  if (!plasma.bare.has(dep))
    failures.push(`'${dep}' not found in dist/plasma/index.js closure (stale marker?)`);
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
  `✓ entry isolation: bridge closure (${bridge.files.size} files) has no staking or Plasma ABI; ` +
    `/abi closure (${abiEntry.files.size} files) has no Plasma ABI; ` +
    `/plasma/abi closure (${plasmaAbi.files.size} files) holds every Plasma ABI and no staking ABI; ` +
    `staking closure (${staking.files.size} files) has no Plasma ABI and no ${BRIDGE_ONLY_DEPS.join(' / ')}; ` +
    `/plasma closure (${plasma.files.size} files) loads every Plasma ABI, no staking ABI, and no viem or ethers`
);
