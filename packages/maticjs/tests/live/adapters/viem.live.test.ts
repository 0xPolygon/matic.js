/**
 * Adapter parity test — viem, live reads against Amoy and Sepolia.
 *
 * No mocks and no signer: every row is a read. Without the RPC URLs the
 * whole `describe` is skipped. The write path and the pure `keccak256`
 * case live in `packages/e2e` and `tests/unit/adapter-keccak256.test.ts`.
 *
 * The three adapter parity files (`viem.live.test.ts`, `ethers-v5.live.test.ts`,
 * `ethers-v6.live.test.ts`) carry **the same `it()` names with the same
 * expectations** so a future regression in any one library lights up
 * exactly one of the three files. Names are mirrored verbatim — do not
 * rename without updating all three.
 */
import { createPublicClient, http } from 'viem';
import { polygonAmoy, sepolia } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import type { Hex } from '../../../src/index.js';

import { RootChainManagerABI } from '../../../src/abi/index.js';
import { viemAdapter } from '../../../src/adapters/viem.js';
import { TEST_NETWORKS } from '../../fixtures/networks.js';
import { HAS_LIVE_RPC, noteSkippedIfNoLiveRpc, readLiveEnv } from '../helpers.js';

noteSkippedIfNoLiveRpc('Adapter: viem');

describe.skipIf(!HAS_LIVE_RPC)('Adapter: viem', { timeout: 60_000 }, () => {
  const env = readLiveEnv();

  it('getChainId returns 80002 on Amoy', async () => {
    const publicClient = createPublicClient({
      chain: polygonAmoy,
      transport: http(env.childRpc)
    });
    const adapter = viemAdapter({ public: publicClient });
    const chainId = await adapter.getChainId();
    expect(chainId).equals(TEST_NETWORKS.child.chainId);
  });

  it('read RootChainManager.tokenToType matches expected value', async () => {
    // RootChainManager lives on the parent chain. tokenToType is a
    // mapping read; for an unregistered token (e.g. address(0)) it
    // returns the zero `bytes32`.
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(env.parentRpc)
    });
    const adapter = viemAdapter({ public: publicClient });
    // Bridge-registered address index — we read the live address from
    // the SDK's address fetcher rather than hard-coding it here.
    const { createAddressFetcher } = await import('../../../src/services/address-service.js');
    const fetcher = createAddressFetcher({ network: 'amoy' });
    const addresses = await fetcher.get();
    const result = await adapter.read({
      address: addresses.RootChainManager,
      abi: RootChainManagerABI,
      functionName: 'tokenToType',
      args: ['0x0000000000000000000000000000000000000000']
    });
    // Unregistered token ⇒ zero bytes32. The viem read decodes a
    // `bytes32` into a 0x-prefixed 66-character hex string.
    expect(result).a('string');
    expect((result as string).toLowerCase()).equals(
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    );
  });

  it('getTransactionReceipt returns null for nonexistent hash', async () => {
    const publicClient = createPublicClient({
      chain: polygonAmoy,
      transport: http(env.childRpc)
    });
    const adapter = viemAdapter({ public: publicClient });
    const r = await adapter.getTransactionReceipt(
      // 32 bytes of zeros — a hash that cannot exist on-chain.
      ('0x' + '00'.repeat(32)) as Hex
    );
    expect(r).equals(null);
  });
});
