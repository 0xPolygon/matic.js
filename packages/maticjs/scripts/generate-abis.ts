/**
 * Regenerates `src/abi/<Contract>.ts` and `src/abi/plasma/<Contract>.ts` from `@polygonlabs/meta` — the
 * published single source of truth for Polygon contract ABIs (the npm face
 * of `0xPolygon/static`). `@polygonlabs/meta` is a build-time (dev)
 * dependency only.
 *
 * Why materialise local files instead of re-exporting meta directly:
 * tsup/rollup-dts cannot inline declarations from meta's `exports`-mapped
 * subpaths, so a pure `export { abi } from '@polygonlabs/meta/abi/...'`
 * publishes a `.d.ts` that references `@polygonlabs/meta` — which consumers
 * never install (it's a dev dep), breaking type resolution at
 * `@polygonlabs/maticjs/abi`. Emitting local `as const` modules keeps the
 * published JS *and* types self-contained with zero runtime dependency,
 * while meta stays the source of truth: this script is the only writer, and
 * CI gates drift via the `codegen-drift-check` script (regenerate, then
 * `git diff --exit-code`), invoked by the shared codegen-drift-check
 * workflow. A meta release surfaces as a Renovate bump that reruns the
 * suite, so the ABIs cannot silently diverge from their source.
 *
 * The bridge ABIs are byte-identical across networks (only addresses
 * differ, resolved separately via the address index), so each is read from
 * its `mainnet/v1` path and serves mainnet and amoy alike. The staking ABIs
 * are read from `mainnet/v1` too; amoy's StakeManager only adds `drain` and
 * `drainValidatorShares`, which the SDK never calls.
 *
 * The Plasma ABIs are written to `src/abi/plasma/` and exposed at
 * `@polygonlabs/maticjs/plasma/abi`, never through `./abi`: they are
 * Plasma-bridge-only, so keeping them out of the `./abi` barrel means a
 * consumer of the PoS ABIs never loads them, and each carries a `Plasma`
 * prefix on its binding (`PlasmaDepositManagerABI`) so it cannot be mistaken
 * for a PoS contract of the same name. `RootChain` stays in `./abi` because
 * both bridges use it.
 *
 * Run: `pnpm run codegen`. Do not hand-edit anything under `src/abi/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local `<Name>ABI` binding → meta subpath module (each exports `abi`).
const ABIS: Record<string, string> = {
  RootChainManager: '@polygonlabs/meta/abi/mainnet/v1/pos/RootChainManager',
  ChildERC20: '@polygonlabs/meta/abi/mainnet/v1/pos/ChildERC20',
  ChildERC721: '@polygonlabs/meta/abi/mainnet/v1/pos/ChildERC721',
  ChildERC1155: '@polygonlabs/meta/abi/mainnet/v1/pos/ChildERC1155',
  ERC20Predicate: '@polygonlabs/meta/abi/mainnet/v1/pos/ERC20Predicate',
  ERC721Predicate: '@polygonlabs/meta/abi/mainnet/v1/pos/ERC721Predicate',
  ERC1155Predicate: '@polygonlabs/meta/abi/mainnet/v1/pos/ERC1155Predicate',
  EtherPredicate: '@polygonlabs/meta/abi/mainnet/v1/pos/EtherPredicate',
  GasSwapper: '@polygonlabs/meta/abi/mainnet/v1/pos/GasSwapper',
  RootChain: '@polygonlabs/meta/abi/mainnet/v1/plasma/RootChain',
  StakeManager: '@polygonlabs/meta/abi/mainnet/v1/plasma/StakeManager',
  ValidatorShare: '@polygonlabs/meta/abi/mainnet/v1/plasma/ValidatorShare',
  PolToken: '@polygonlabs/meta/abi/mainnet/v1/plasma/PolToken',
  StateReceiver: '@polygonlabs/meta/abi/mainnet/v1/genesis/StateReceiver'
};

// Plasma-bridge ABIs: file name (also the binding without its `Plasma` prefix
// and `ABI` suffix) → meta subpath module. Written under `src/abi/plasma/`,
// each exported as `Plasma${file}ABI`. The file name is not always meta's own
// name: meta's `ERC20PredicateBurnOnly` is the Plasma `ERC20Predicate`.
const PLASMA_ABIS: Record<string, string> = {
  DepositManager: '@polygonlabs/meta/abi/mainnet/v1/plasma/DepositManager',
  WithdrawManager: '@polygonlabs/meta/abi/mainnet/v1/plasma/WithdrawManager',
  ExitNFT: '@polygonlabs/meta/abi/mainnet/v1/plasma/ExitNFT',
  PriorityQueue: '@polygonlabs/meta/abi/mainnet/v1/plasma/PriorityQueue',
  MRC20: '@polygonlabs/meta/abi/mainnet/v1/plasma/MRC20',
  ChildERC20: '@polygonlabs/meta/abi/mainnet/v1/plasma/ChildERC20',
  ERC20Predicate: '@polygonlabs/meta/abi/mainnet/v1/plasma/ERC20PredicateBurnOnly'
};

const abiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'abi');
const plasmaAbiDir = join(abiDir, 'plasma');

const header = (specifier: string): string =>
  `// GENERATED FROM \`${specifier}\` — DO NOT EDIT.\n` +
  `// Regenerate with \`pnpm run codegen\`. See scripts/generate-abis.ts.\n\n`;

const loadAbi = async (specifier: string): Promise<readonly unknown[]> => {
  const mod = (await import(specifier)) as { abi: readonly unknown[] };
  return mod.abi;
};

mkdirSync(plasmaAbiDir, { recursive: true });

const indexLines: string[] = [];

for (const [name, specifier] of Object.entries(ABIS)) {
  const body = `${header(specifier)}export const ${name}ABI = ${JSON.stringify(await loadAbi(specifier), null, 2)} as const;\n`;
  writeFileSync(join(abiDir, `${name}.ts`), body);
  indexLines.push(`export { ${name}ABI } from './${name}.js';`);
}

writeFileSync(
  join(abiDir, 'index.ts'),
  `// GENERATED — DO NOT EDIT. Regenerate with \`pnpm run codegen\`.\n` +
    `// Barrel for the contract ABIs sourced from \`@polygonlabs/meta\` at\n` +
    `// build time and exposed publicly at \`@polygonlabs/maticjs/abi\`.\n\n` +
    `${indexLines.join('\n')}\n`
);

const plasmaIndexLines: string[] = [];

for (const [file, specifier] of Object.entries(PLASMA_ABIS)) {
  const binding = `Plasma${file}ABI`;
  const body = `${header(specifier)}export const ${binding} = ${JSON.stringify(await loadAbi(specifier), null, 2)} as const;\n`;
  writeFileSync(join(plasmaAbiDir, `${file}.ts`), body);
  plasmaIndexLines.push(`export { ${binding} } from './${file}.js';`);
}

writeFileSync(
  join(plasmaAbiDir, 'index.ts'),
  `// GENERATED — DO NOT EDIT. Regenerate with \`pnpm run codegen\`.\n` +
    `// Barrel for the Plasma-bridge contract ABIs sourced from \`@polygonlabs/meta\`\n` +
    `// at build time and exposed publicly at \`@polygonlabs/maticjs/plasma/abi\`.\n\n` +
    `${plasmaIndexLines.join('\n')}\n`
);

console.log(
  `Generated ${Object.keys(ABIS).length} ABI modules into src/abi/ and ` +
    `${Object.keys(PLASMA_ABIS).length} into src/abi/plasma/ from @polygonlabs/meta.`
);
