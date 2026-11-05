/**
 * The only vitest config in this package. There is no `test` script, so the
 * root `pnpm test` (`pnpm -r --if-present run test`) never runs the e2e
 * tier; it runs only through `pnpm run e2e` or `test:e2e`.
 *
 * # Which SDK the tests import
 *
 * The tests import the SDK's BUILT dist through its public entry points,
 * the same files a consumer installs (`scripts/run-e2e.sh` builds it
 * first). That needs one piece of help. The built adapters import their
 * web3 library by its bare name: `/viem` imports `viem`, and both
 * `/ethers-v5` and `/ethers-v6` import `ethers`. In a consumer's install,
 * `ethers` is whichever major they chose. Here, the SDK is a workspace
 * symlink, so Node would resolve `ethers` from `packages/maticjs`, where it
 * is ethers 6, and the ethers v5 adapter would get the wrong major.
 *
 * `consumerPeerResolution` resolves those bare imports the way a consumer's
 * install would, from this package: `ethers` imported by the ethers v5
 * adapter becomes this package's `ethers-v5` (ethers 5), and every other
 * `viem` / `ethers` import becomes this package's copy. The test code's own
 * imports of those libraries resolve to the same files, so the test and the
 * SDK share one instance of each library. The resolved files are loaded by
 * Node directly, not transformed.
 *
 * # Run order and timeouts
 *
 * Files run one at a time (`fileParallelism: false`) in a fixed order. Rows
 * inside a file may run concurrently: each (suite × adapter) has its own key.
 * The validator file runs last because it can change the validator set.
 */
import type { Plugin } from 'vitest/config';
import type { TestSpecification } from 'vitest/node';

import { existsSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node';

const FILE_ORDER = [
  'tx-result.e2e.test.ts',
  'bigint-roundtrip.e2e.test.ts',
  'adapter-parity.e2e.test.ts',
  'bridge-erc20.e2e.test.ts',
  'bridge-erc721.e2e.test.ts',
  'bridge-erc1155.e2e.test.ts',
  'bridge-ether.e2e.test.ts',
  'staking-writes.e2e.test.ts',
  'staking-delegation.e2e.test.ts',
  'staking-validator.e2e.test.ts'
];

class ExplicitOrderSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const rank = (file: TestSpecification) => {
      const index = FILE_ORDER.findIndex((name) => file.moduleId.endsWith(name));
      return index === -1 ? FILE_ORDER.length : index;
    };
    return [...files].sort((a, b) => rank(a) - rank(b) || a.moduleId.localeCompare(b.moduleId));
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    return files;
  }
}

/** Resolve a specifier as Node would from this package, to a file path. */
const resolveHere = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));

const PEERS = /^(viem|ethers|ethers-v5)(\/.*)?$/;

function consumerPeerResolution(): Plugin {
  const sdkEntry = resolveHere('@polygonlabs/maticjs');
  if (!existsSync(sdkEntry)) {
    throw new Error(
      `${sdkEntry} does not exist: build the SDK first (pnpm --filter @polygonlabs/maticjs run build)`
    );
  }
  const sdkDist = dirname(sdkEntry) + sep;
  const ethersV5Adapter = resolveHere('@polygonlabs/maticjs/ethers-v5');
  return {
    name: 'maticjs-e2e-consumer-peer-resolution',
    enforce: 'pre',
    resolveId(source, importer) {
      const match = PEERS.exec(source);
      if (!match || !importer) return null;
      const fromSdk = importer.startsWith(sdkDist);
      const fromTests = !importer.includes(`${sep}node_modules${sep}`) && !fromSdk;
      if (!fromSdk && !fromTests) return null;
      const specifier =
        importer === ethersV5Adapter && match[1] === 'ethers'
          ? `ethers-v5${match[2] ?? ''}`
          : source;
      return { id: resolveHere(specifier), external: true };
    }
  };
}

export default defineConfig({
  plugins: [consumerPeerResolution()],
  test: {
    include: ['test/**/*.e2e.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 300_000,
    testTimeout: 900_000,
    sequence: {
      sequencer: ExplicitOrderSequencer,
      shuffle: false
    }
  }
});
