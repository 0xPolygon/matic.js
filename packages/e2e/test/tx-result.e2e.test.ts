/**
 * The `TxResult` contract on a real node, through each adapter: a write
 * resolves when the transaction is broadcast, with its hash, and
 * `confirmed()` is the only thing that waits for the receipt.
 *
 * Every write is a 1-wei `approve` of the root DummyERC20 to the ERC-20
 * predicate: it needs no balance and moves nothing.
 */
import { TransactionReceiptNotFoundError } from 'viem';
import { describe, expect, it } from 'vitest';

import { buildAdapters } from '../src/adapters.ts';
import { getTestEnv } from '../src/test-env.ts';
import { HASH_PATTERN, initPos, readers } from './cycle.ts';

const CONFIRM_WITHIN_MS = 60_000;
/** How many writes the "resolves before it is mined" check samples. */
const BROADCAST_SAMPLES = 3;

const rows = buildAdapters({ suite: 'tx-result' });

async function approveOneWei(row: (typeof rows)[number]) {
  const { tokens } = getTestEnv().E2E_ADDRESSES_JSON;
  const pos = await initPos(row);
  return pos.parent.erc20(tokens.root.erc20).approve(1n);
}

describe.each(rows)('TxResult via $name', (row) => {
  it('hash is a 0x-prefixed 32-byte hex string as soon as the write resolves', async () => {
    const tx = await approveOneWei(row);
    expect(tx.hash).match(HASH_PATTERN);
    await tx.confirmed();
  });

  it('confirmed() resolves to a success receipt for that hash within 60 s', async () => {
    const tx = await approveOneWei(row);
    const start = Date.now();
    const receipt = await tx.confirmed();
    expect(Date.now() - start).lessThan(CONFIRM_WITHIN_MS);
    expect(receipt).property('transactionHash').equals(tx.hash);
    expect(receipt).property('status').equals('success');
    expect(receipt.blockNumber > 0n).equals(true);
  });

  it('confirmed() can be awaited twice and returns the same receipt', async () => {
    const tx = await approveOneWei(row);
    const first = await tx.confirmed();
    const second = await tx.confirmed();
    expect(second).deep.equals(first);
  });

  // Devnet blocks are 1 s, so a check on how long the write took cannot
  // tell broadcast from confirmation. Instead, read the receipt straight
  // after the write resolves, with no sleep. A write that waited for the
  // receipt would make that read find one every time. A write that returns
  // on broadcast finds none unless the block happened to be sealed in
  // the few milliseconds between the two calls, so the check allows one
  // such race in its samples and fails if the receipt was there in most.
  // The receipt is read with plain viem, not through the adapter under
  // test, so an adapter that misreports receipts cannot pass this check.
  it('the write resolves before the transaction is mined', async () => {
    const { l1 } = readers();
    let unminedAtResolve = 0;
    for (let i = 0; i < BROADCAST_SAMPLES; i++) {
      const tx = await approveOneWei(row);
      // viem's getTransactionReceipt throws TransactionReceiptNotFoundError
      // for a transaction that is not mined yet, rather than returning null.
      const minedAtResolve = await l1
        .getTransactionReceipt({ hash: tx.hash })
        .then(() => true)
        .catch((err: unknown) => {
          if (err instanceof TransactionReceiptNotFoundError) return false;
          throw err;
        });
      if (!minedAtResolve) unminedAtResolve++;
      expect(await tx.confirmed())
        .property('status')
        .equals('success');
    }
    expect(unminedAtResolve).least(BROADCAST_SAMPLES - 1);
  });
});
