/**
 * Ether bridge writes through each adapter.
 *
 * Ether has no root token contract. It is deposited with
 * `pos.depositEther`, arrives on L2 as MaticWETH, is burned with
 * MaticWETH's `withdraw`, and is exited through the RootChainManager like
 * any ERC-20 burn. `completeWithdraw` builds the exit from the burn alone
 * and never uses the parent wrapper's token address, so the exit goes
 * through `parent.erc20(ETHER_SENTINEL)`, the address the SDK uses for
 * ether internally (not exported).
 *
 * The L1 balance is checked to the wei: each leg's balance change plus the
 * gas it paid must equal the amount bridged. Only this row's key spends
 * from its L1 balance, so the reads are exact.
 */
import { describe, expect, it } from 'vitest';

import { ContractNotAvailableOnNetworkError } from '@polygonlabs/maticjs';

import { buildAdapters } from '../src/adapters.ts';
import { getTestEnv } from '../src/test-env.ts';
import {
  confirmSuccess,
  CYCLE_TIMEOUT_MS,
  exitWhenCheckpointed,
  gasPaid,
  initPos,
  readers,
  waitForCheckpoint,
  waitForStateSync
} from './cycle.ts';

const ETHER_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const AMOUNT = 10n ** 16n;

const rows = buildAdapters({ suite: 'bridge-ether' });

describe.concurrent('ether deposit and exit cycle', { timeout: CYCLE_TIMEOUT_MS }, () => {
  it.each(rows)('via $name', async (row) => {
    const { tokens } = getTestEnv().E2E_ADDRESSES_JSON;
    const { l1 } = readers();
    const pos = await initPos(row);
    const childWeth = pos.child.erc20(tokens.child.maticWeth);
    const parentEther = pos.parent.erc20(ETHER_SENTINEL);

    const childBefore = await childWeth.getBalance(row.address);

    const l1BeforeDeposit = await l1.getBalance({ address: row.address });
    const deposit = await confirmSuccess(await pos.depositEther(AMOUNT, row.address));
    const l1AfterDeposit = await l1.getBalance({ address: row.address });
    const depositGas = await gasPaid({ client: l1, hash: deposit.transactionHash });
    expect(l1BeforeDeposit - l1AfterDeposit).equals(AMOUNT + depositGas);

    await waitForStateSync({
      read: () => childWeth.getBalance(row.address),
      done: (balance) => balance === childBefore + AMOUNT,
      label: `${row.name} child MaticWETH balance`
    });
    expect(await pos.isDeposited(deposit.transactionHash)).equals(true);

    const burn = await confirmSuccess(await childWeth.startWithdraw(AMOUNT));
    expect(await childWeth.getBalance(row.address)).equals(childBefore);
    await waitForCheckpoint({
      pos,
      burnHash: burn.transactionHash,
      label: `${row.name} burn ${burn.transactionHash}`
    });
    expect(await parentEther.isWithdrawExited(burn.transactionHash)).equals(false);

    const l1BeforeExit = await l1.getBalance({ address: row.address });
    const exit = await exitWhenCheckpointed({
      exit: () => parentEther.completeWithdraw(burn.transactionHash),
      label: `${row.name} MaticWETH burn ${burn.transactionHash}`
    });
    const l1AfterExit = await l1.getBalance({ address: row.address });
    const exitGas = await gasPaid({ client: l1, hash: exit.transactionHash });
    expect(l1AfterExit - l1BeforeExit + exitGas).equals(AMOUNT);

    expect(await parentEther.isWithdrawExited(burn.transactionHash)).equals(true);
  });
});

describe.each(rows)('ether with gas swap via $name', (row) => {
  it('depositEtherWithGas rejects with ContractNotAvailableOnNetworkError', async () => {
    const pos = await initPos(row);
    const l1Before = await readers().l1.getBalance({ address: row.address });

    const err: unknown = await pos.depositEtherWithGas(AMOUNT, row.address, 1n, '0x').then(
      () => undefined,
      (e: unknown) => e
    );
    expect(ContractNotAvailableOnNetworkError.has(err)).equals(true);
    expect(err).property('name').equals('DepositError');
    // Rejected before broadcast: nothing was spent.
    expect(await readers().l1.getBalance({ address: row.address })).equals(l1Before);
  });
});
