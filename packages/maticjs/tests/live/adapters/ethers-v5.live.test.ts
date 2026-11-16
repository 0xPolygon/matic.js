/**
 * Adapter parity test — ethers v5, live reads against Amoy and Sepolia.
 *
 * Mirrors `viem.live.test.ts` `it()`-for-`it()` so a future regression in v5
 * lights up here and only here. Names and expectations are kept
 * verbatim — see the docstring on `viem.live.test.ts`.
 */
import { providers } from 'ethers-v5';
import { describe, expect, it } from 'vitest';

import type { Hex } from '../../../src/index.js';

import { RootChainManagerABI } from '../../../src/abi/index.js';
import { ethersV5Adapter } from '../../../src/adapters/ethers-v5.js';
import { TEST_NETWORKS } from '../../fixtures/networks.js';
import { HAS_LIVE_RPC, noteSkippedIfNoLiveRpc, readLiveEnv } from '../helpers.js';

noteSkippedIfNoLiveRpc('Adapter: ethers v5');

describe.skipIf(!HAS_LIVE_RPC)('Adapter: ethers v5', { timeout: 60_000 }, () => {
  const env = readLiveEnv();

  it('getChainId returns 80002 on Amoy', async () => {
    // StaticJsonRpcProvider matches team backend.md guidance: a static
    // provider for read-only flows that never subscribe to events.
    const provider = new providers.StaticJsonRpcProvider(env.childRpc);
    const adapter = ethersV5Adapter({ provider });
    const chainId = await adapter.getChainId();
    expect(chainId).equals(TEST_NETWORKS.child.chainId);
  });

  it('read RootChainManager.tokenToType matches expected value', async () => {
    const provider = new providers.StaticJsonRpcProvider(env.parentRpc);
    const adapter = ethersV5Adapter({ provider });
    const { createAddressFetcher } = await import('../../../src/services/address-service.js');
    const fetcher = createAddressFetcher({ network: 'amoy' });
    const addresses = await fetcher.get();
    const result = await adapter.read({
      address: addresses.RootChainManager,
      abi: RootChainManagerABI,
      functionName: 'tokenToType',
      args: ['0x0000000000000000000000000000000000000000']
    });
    expect(result).a('string');
    expect((result as string).toLowerCase()).equals(
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    );
  });

  it('getTransactionReceipt returns null for nonexistent hash', async () => {
    const provider = new providers.StaticJsonRpcProvider(env.childRpc);
    const adapter = ethersV5Adapter({ provider });
    const r = await adapter.getTransactionReceipt(('0x' + '00'.repeat(32)) as Hex);
    expect(r).equals(null);
  });
});
