/**
 * The three adapters behave the same on a real node for the primitives
 * the SDK builds on: a raw contract write, the chain id, and a receipt
 * lookup for a transaction that does not exist.
 *
 * The write is on the CHILD chain: the seed bridged a small DummyERC20
 * balance to L2 for each adapter-parity key.
 */
import { describe, expect, it } from 'vitest';

import { ChildERC20ABI } from '@polygonlabs/maticjs/abi';

import { buildAdapters } from '../src/adapters.ts';
import { erc20Abi } from '../src/devnet-abis.ts';
import { DEVNET_L1_CHAIN_ID, DEVNET_L2_CHAIN_ID } from '../src/kurtosis.ts';
import { getTestEnv } from '../src/test-env.ts';
import { confirmSuccess, readers } from './cycle.ts';

/** Receives the 1-wei transfers, so the move is visible on both sides. */
const SINK = '0x000000000000000000000000000000000000dEaD';
const UNKNOWN_TX = `0x${'0'.repeat(63)}1`;

const rows = buildAdapters({ suite: 'adapter-parity' });

describe.each(rows)('adapter parity via $name', (row) => {
  it('a raw write transfers 1 wei of child DummyERC20 and lands', async () => {
    const { tokens } = getTestEnv().E2E_ADDRESSES_JSON;
    const { l2 } = readers();
    const balanceOf = (account: `0x${string}`) =>
      l2.readContract({
        address: tokens.child.erc20,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account]
      });
    const senderBefore = await balanceOf(row.address);
    const sinkBefore = await balanceOf(SINK);
    expect(senderBefore > 0n, 'seeded child DummyERC20 balance').equals(true);

    const receipt = await confirmSuccess(
      await row.child.write({
        address: tokens.child.erc20,
        abi: ChildERC20ABI,
        functionName: 'transfer',
        args: [SINK, 1n]
      })
    );

    expect(
      receipt.logs.some((log) => log.address.toLowerCase() === tokens.child.erc20.toLowerCase())
    ).equals(true);
    expect(await balanceOf(row.address)).equals(senderBefore - 1n);
    expect(await balanceOf(SINK)).equals(sinkBefore + 1n);
  });

  it('getChainId() reports the devnet chain on each side', async () => {
    expect(await row.child.getChainId()).equals(DEVNET_L2_CHAIN_ID);
    expect(await row.parent.getChainId()).equals(DEVNET_L1_CHAIN_ID);
  });

  it('getTransactionReceipt() returns null for an unknown hash', async () => {
    expect(await row.parent.getTransactionReceipt(UNKNOWN_TX)).equals(null);
    expect(await row.child.getTransactionReceipt(UNKNOWN_TX)).equals(null);
  });
});
