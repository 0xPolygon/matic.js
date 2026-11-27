/**
 * A bigint `blockTag` given to `Adapter.read()` pins the read to that exact
 * block, and each library names that pin differently: viem takes a
 * `blockNumber` bigint (and refuses it spelled as `blockTag`), ethers takes a
 * `blockTag` hex quantity. A wrong shape would silently read the latest block
 * instead, so each adapter is checked at the call it makes into its library.
 *
 * No chain is needed: each adapter sits on an unroutable placeholder URL that
 * is never dialled, and the library call that would go to the network is
 * replaced by a spy that records what it was given.
 */
import { JsonRpcProvider, Network as V6Network } from 'ethers';
import { providers as v5Providers } from 'ethers-v5';
import { createPublicClient, http } from 'viem';
import { polygonAmoy } from 'viem/chains';
import { describe, expect, it, vi } from 'vitest';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.js';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.js';
import { viemAdapter } from '../../src/adapters/viem.js';
import { TEST_NETWORKS } from '../fixtures/networks.js';

const UNUSED_RPC = 'http://127.0.0.1:1';
const TOKEN = '0x3333333333333333333333333333333333333333';
const HOLDER = '0x4444444444444444444444444444444444444444';
const BLOCK = 42n;
const BLOCK_HEX = '0x2a';
const ONE = `0x${'0'.repeat(63)}1`;

const BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

const request = {
  address: TOKEN,
  abi: BALANCE_OF_ABI,
  functionName: 'balanceOf',
  args: [HOLDER],
  blockTag: BLOCK
} as const;

describe('Adapter.read with a bigint blockTag', () => {
  it('viem: readContract receives { blockNumber } as the bigint, and no blockTag', async () => {
    const client = createPublicClient({ chain: polygonAmoy, transport: http(UNUSED_RPC) });
    const readContract = vi.spyOn(client, 'readContract').mockResolvedValue(1n);

    await viemAdapter({ public: client }).read(request);

    expect(readContract).toHaveBeenCalledOnce();
    const [params] = readContract.mock.calls[0] ?? [];
    expect(params).property('blockNumber').equals(BLOCK);
    expect(params).not.property('blockTag');
  });

  it('ethers v5: the call is pinned to the block as a hex quantity', async () => {
    const provider = new v5Providers.StaticJsonRpcProvider(
      UNUSED_RPC,
      TEST_NETWORKS.child.chainId
    );
    const call = vi.spyOn(provider, 'call').mockResolvedValue(ONE);

    await ethersV5Adapter({ provider }).read(request);

    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0]?.[1]).equals(BLOCK_HEX);
  });

  it('ethers v6: the call is pinned to the block as a hex quantity', async () => {
    const provider = new JsonRpcProvider(UNUSED_RPC, V6Network.from(TEST_NETWORKS.child.chainId), {
      staticNetwork: true
    });
    const call = vi.spyOn(provider, 'call').mockResolvedValue(ONE);

    await ethersV6Adapter({ provider }).read(request);

    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0]?.[0]).property('blockTag').equals(BLOCK_HEX);
  });
});
