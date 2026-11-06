/**
 * `Adapter.keccak256` parity across the three libraries.
 *
 * Pure hashing, so it needs no chain: each adapter sits on an unroutable
 * placeholder URL that is never dialled. The known vector is the hash of
 * the empty input.
 */
import { JsonRpcProvider, Network as V6Network } from 'ethers';
import { providers as v5Providers } from 'ethers-v5';
import { createPublicClient, http } from 'viem';
import { polygonAmoy } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import type { Adapter } from '../../src/index.js';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.js';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.js';
import { viemAdapter } from '../../src/adapters/viem.js';
import { TEST_NETWORKS } from '../fixtures/networks.js';

const UNUSED_RPC = 'http://127.0.0.1:1';

// keccak256("")
const EMPTY_INPUT_HASH = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';

const ADAPTERS: readonly (readonly [string, () => Adapter])[] = [
  [
    'viem',
    () =>
      viemAdapter({
        public: createPublicClient({ chain: polygonAmoy, transport: http(UNUSED_RPC) })
      })
  ],
  [
    'ethers-v5',
    () =>
      ethersV5Adapter({
        provider: new v5Providers.StaticJsonRpcProvider(UNUSED_RPC, TEST_NETWORKS.child.chainId)
      })
  ],
  [
    'ethers-v6',
    () =>
      ethersV6Adapter({
        provider: new JsonRpcProvider(UNUSED_RPC, V6Network.from(TEST_NETWORKS.child.chainId), {
          staticNetwork: true
        })
      })
  ]
];

describe.each(ADAPTERS)('Adapter: %s', (_name, build) => {
  it('keccak256 produces expected hash for known input', () => {
    expect(build().keccak256(new Uint8Array())).equals(EMPTY_INPUT_HASH);
  });
});
