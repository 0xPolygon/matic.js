/**
 * Regenerates `src/abi/<Contract>.ts` from `@polygonlabs/meta` — the
 * published single source of truth for Polygon contract ABIs (the npm face
 * of `0xPolygon/static`). `@polygonlabs/meta` is a build-time (dev)
 * dependency only.
 *
 * Why materialise local files instead of re-exporting meta directly:
 * tsup/rollup-dts cannot inline declarations from meta's `exports`-mapped
 * subpaths, so a pure `export { abi } from '@polygonlabs/meta/abi/...'`
 * publishes a `.d.ts` that references `@polygonlabs/meta` — which consumers
 * never install (it's a dev dep), breaking type resolution at
 * `@polygonlabs/pos-sdk/abi`. Emitting local `as const` modules keeps the
 * published JS *and* types self-contained with zero runtime dependency,
 * while meta stays the source of truth: this script is the only writer, and
 * CI gates drift via the `codegen-drift-check` script (regenerate, then
 * `git diff --exit-code`), invoked by the shared codegen-drift-check
 * workflow. A meta release surfaces as a Renovate bump that reruns the
 * suite, so the ABIs cannot silently diverge from their source.
 *
 * The bridge ABIs are byte-identical across networks (only addresses
 * differ, resolved separately via the address index), so each is read from
 * its `mainnet/v1` path and serves mainnet and amoy alike.
 *
 * Run: `pnpm run codegen`. Do not hand-edit `src/abi/<Contract>.ts`.
 */
import { writeFileSync } from 'node:fs';
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
  StateReceiver: '@polygonlabs/meta/abi/mainnet/v1/genesis/StateReceiver'
};

const abiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'abi');

const header = (specifier: string): string =>
  `// GENERATED FROM \`${specifier}\` — DO NOT EDIT.\n` +
  `// Regenerate with \`pnpm run codegen\`. See scripts/generate-abis.ts.\n\n`;

const indexLines: string[] = [];

for (const [name, specifier] of Object.entries(ABIS)) {
  const mod = (await import(specifier)) as { abi: readonly unknown[] };
  const body = `${header(specifier)}export const ${name}ABI = ${JSON.stringify(mod.abi, null, 2)} as const;\n`;
  writeFileSync(join(abiDir, `${name}.ts`), body);
  indexLines.push(`export { ${name}ABI } from './${name}.js';`);
}

writeFileSync(
  join(abiDir, 'index.ts'),
  `// GENERATED — DO NOT EDIT. Regenerate with \`pnpm run codegen\`.\n` +
    `// Barrel for the contract ABIs sourced from \`@polygonlabs/meta\` at\n` +
    `// build time and exposed publicly at \`@polygonlabs/pos-sdk/abi\`.\n\n` +
    `${indexLines.join('\n')}\n`
);

console.log(`Generated ${Object.keys(ABIS).length} ABI modules into src/abi/ from @polygonlabs/meta.`);
