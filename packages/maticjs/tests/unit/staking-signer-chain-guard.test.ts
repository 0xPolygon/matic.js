import { createPublicClient, createWalletClient, custom } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { viemAdapter } from '../../src/adapters/viem.ts';
import { UnsupportedNetworkError } from '../../src/errors.ts';
import { StakingClient } from '../../src/staking/index.ts';

/**
 * Staking writes are pinned to the parent chain. The pin is only useful if
 * the adapter compares it with the chain the SIGNING wallet is on: a
 * browser wallet the user switched to Polygon keeps the dapp's Ethereum RPC
 * where it was, so a check against the RPC alone would pass while the
 * wallet signs on the wrong network. This drives a staking write through a
 * real viem public client (on Ethereum) and an unpinned wallet client (as
 * an injected wallet is), both on stub transports.
 */

const ETHEREUM = 1;
const POLYGON = 137;
const HASH = '0x1111111111111111111111111111111111111111111111111111111111111111';
const FROM = '0x2222222222222222222222222222222222222222';

// Arbitrary addresses: the guard runs before anything reaches a contract.
const STAKING_ADDRESSES = {
  StakeManager: '0x3333333333333333333333333333333333333333',
  MaticToken: '0x4444444444444444444444444444444444444444',
  PolToken: '0x5555555555555555555555555555555555555555'
} as const;

const chainTransport = (chainId: number) =>
  custom({
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
      throw new Error(`stub transport: unexpected RPC ${method}`);
    }
  });

const build = async ({ walletChain }: { walletChain: number }) => {
  const publicClient = createPublicClient({ transport: chainTransport(ETHEREUM) });
  const walletClient = createWalletClient({
    account: FROM,
    transport: chainTransport(walletChain)
  });
  const writeSpy = vi.spyOn(walletClient, 'writeContract').mockResolvedValue(HASH);
  const staking = await StakingClient.init({
    network: 'mainnet',
    parent: viemAdapter({ public: publicClient, wallet: walletClient }),
    addresses: STAKING_ADDRESSES
  });
  return { staking, broadcasts: () => writeSpy.mock.calls.length };
};

describe('staking writes — signing-wallet chain guard', () => {
  it('rejects when only the wallet is on the wrong chain, before broadcasting', async () => {
    const { staking, broadcasts } = await build({ walletChain: POLYGON });
    const err = await staking.pol.approveStakeManager({ amount: 1n }, { gasLimit: 100_000n }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).property('name').equals('StakingWriteError');
    expect(err).nested.property('info.operation').equals('approveStakeManager');
    expect(UnsupportedNetworkError.has(err)).equals(true);
    expect(broadcasts()).equals(0);
  });

  it('broadcasts when the wallet is on the parent chain', async () => {
    const { staking, broadcasts } = await build({ walletChain: ETHEREUM });
    const result = await staking.pol.approveStakeManager({ amount: 1n }, { gasLimit: 100_000n });
    expect(result).property('hash').equals(HASH);
    expect(broadcasts()).equals(1);
  });
});
