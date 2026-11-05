import { describe, expect, it } from 'vitest';

import type { Hex, Receipt } from '../../src/adapter.ts';
import type { WaitOutcome } from '../../src/internal/confirmation.ts';

import { POSBridgeError } from '../../src/errors.ts';
import { memoiseConfirmation } from '../../src/internal/confirmation.ts';

/**
 * The shared confirmation wrapper must not trust a library to report every
 * replacement. A wait that resolves another transaction's receipt without
 * saying it was replaced would otherwise read as our transaction succeeding.
 */

const OURS: Hex = `0x${'ab'.repeat(32)}`;
const OTHER: Hex = `0x${'cd'.repeat(32)}`;

const receiptFor = (transactionHash: Hex): Receipt => ({
  transactionHash,
  status: 'success',
  blockNumber: 100n,
  logs: []
});

const settle = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e
  );

describe('memoiseConfirmation — receipt hash backstop', () => {
  it('rejects an unexplained receipt for a different transaction with TRANSACTION_REPLACED', async () => {
    const other = receiptFor(OTHER);
    let waits = 0;
    const confirmed = memoiseConfirmation({
      hash: OURS,
      wait: (): Promise<WaitOutcome> => {
        waits++;
        return Promise.resolve({ receipt: other });
      }
    });

    const first = await settle(confirmed());
    const second = await settle(confirmed());

    expect(first).instanceOf(POSBridgeError);
    expect(first).property('code').equals('TRANSACTION_REPLACED');
    expect(first).nested.property('info.transactionHash').equals(OURS);
    expect(first).nested.property('info.replacementHash').equals(OTHER);
    expect(first).nested.property('info.reason').equals('replaced');
    expect(first).nested.property('info.receipt').equals(other);
    expect(second).equals(first);
    expect(waits).equals(1);
  });

  it('accepts our own receipt whatever the hash casing', async () => {
    const confirmed = memoiseConfirmation({
      hash: OURS,
      wait: () =>
        Promise.resolve({ receipt: receiptFor(OURS.toUpperCase().replace('0X', '0x') as Hex) })
    });

    const receipt = await confirmed();

    expect(receipt).property('status').equals('success');
  });
});
