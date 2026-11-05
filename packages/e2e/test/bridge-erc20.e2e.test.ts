/**
 * ERC-20 bridge writes through each adapter, against the devnet's
 * pos-portal DummyERC20 (already mapped root ↔ child).
 *
 * The cycle runs deposit → state sync → burn → checkpoint → exit and checks
 * the token balances on both chains at each step, so a write that returns a
 * hash but moves nothing fails here. The balance deltas are read with plain
 * viem, not through the SDK, so a write the SDK misreports cannot hide
 * behind the SDK's own reads; the SDK's `getBalance` is checked against them.
 */
import { describe, expect, it } from 'vitest';

import { buildAdapters } from '../src/adapters.ts';
import { getTestEnv } from '../src/test-env.ts';
import {
  confirmSuccess,
  CYCLE_TIMEOUT_MS,
  erc20BalanceOf,
  exitWhenCheckpointed,
  HASH_PATTERN,
  initPos,
  readers,
  waitForCheckpoint,
  waitForStateSync
} from './cycle.ts';

const AMOUNT = 10n ** 17n;

const rows = buildAdapters({ suite: 'bridge-erc20' });

describe.concurrent('ERC-20 deposit and exit cycle', { timeout: CYCLE_TIMEOUT_MS }, () => {
  it.each(rows)('via $name', async (row) => {
    const { tokens } = getTestEnv().E2E_ADDRESSES_JSON;
    const { l1, l2 } = readers();
    const pos = await initPos(row);
    const parentToken = pos.parent.erc20(tokens.root.erc20);
    const childToken = pos.child.erc20(tokens.child.erc20);
    const parentBalance = () =>
      erc20BalanceOf({ client: l1, token: tokens.root.erc20, owner: row.address });
    const childBalance = () =>
      erc20BalanceOf({ client: l2, token: tokens.child.erc20, owner: row.address });

    const parentBefore = await parentBalance();
    const childBefore = await childBalance();
    expect(parentBefore >= AMOUNT, 'seeded root DummyERC20 balance').equals(true);
    expect(await parentToken.getBalance(row.address)).equals(parentBefore);
    expect(await childToken.getBalance(row.address)).equals(childBefore);

    await confirmSuccess(await parentToken.approve(AMOUNT));
    expect(await parentToken.getAllowance(row.address)).equals(AMOUNT);

    const deposit = await confirmSuccess(await parentToken.deposit(AMOUNT, row.address));
    expect(await parentBalance()).equals(parentBefore - AMOUNT);

    await waitForStateSync({
      read: childBalance,
      done: (balance) => balance === childBefore + AMOUNT,
      label: `${row.name} child DummyERC20 balance`
    });
    expect(await childToken.getBalance(row.address)).equals(childBefore + AMOUNT);
    expect(await pos.isDeposited(deposit.transactionHash)).equals(true);

    const burn = await confirmSuccess(await childToken.startWithdraw(AMOUNT));
    expect(await childBalance()).equals(childBefore);
    await waitForCheckpoint({
      pos,
      burnHash: burn.transactionHash,
      label: `${row.name} burn ${burn.transactionHash}`
    });
    expect(await parentToken.isWithdrawExited(burn.transactionHash)).equals(false);

    await exitWhenCheckpointed({
      exit: () => parentToken.completeWithdraw(burn.transactionHash),
      label: `${row.name} ERC-20 burn ${burn.transactionHash}`
    });

    expect(await parentToken.isWithdrawExited(burn.transactionHash)).equals(true);
    expect(await parentBalance()).equals(parentBefore);
    expect(await parentToken.getBalance(row.address)).equals(parentBefore);
  });
});

describe.each(rows)('ERC-20 approve via $name', (row) => {
  it('approve(1n) returns a hash and confirms success', async () => {
    const { tokens } = getTestEnv().E2E_ADDRESSES_JSON;
    const pos = await initPos(row);
    const parentToken = pos.parent.erc20(tokens.root.erc20);

    const tx = await parentToken.approve(1n);
    expect(tx.hash).match(HASH_PATTERN);
    await confirmSuccess(tx);
    expect(await parentToken.getAllowance(row.address)).equals(1n);
  });
});
