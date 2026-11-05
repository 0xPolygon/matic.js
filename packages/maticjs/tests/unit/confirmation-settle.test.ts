import { describe, expect, it } from 'vitest';

import type { Hex, Receipt } from '../../src/adapter.ts';
import type { WaitOutcome } from '../../src/internal/confirmation.ts';

import {
  ConfirmationError,
  isMaticjsError,
  TransactionReplacedError,
  TransactionRevertedError
} from '../../src/errors.ts';
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
  it('rejects an unexplained receipt for a different transaction with TransactionReplacedError', async () => {
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

    expect(TransactionReplacedError.has(first)).equals(true);
    expect(TransactionReplacedError.find(first))
      .nested.property('info.transactionHash')
      .equals(OURS);
    expect(TransactionReplacedError.find(first))
      .nested.property('info.replacementHash')
      .equals(OTHER);
    expect(TransactionReplacedError.find(first)).nested.property('info.reason').equals('replaced');
    expect(TransactionReplacedError.find(first)).nested.property('info.receipt').deep.equals(other);
    expect(second).equals(first);
    expect(waits).equals(1);
  });

  it('raises the hash-mismatch TransactionReplacedError with no cause', async () => {
    const confirmed = memoiseConfirmation({
      hash: OURS,
      wait: (): Promise<WaitOutcome> => Promise.resolve({ receipt: receiptFor(OTHER) })
    });

    const err = await settle(confirmed());

    const found = TransactionReplacedError.find(err);
    if (found === null) throw new Error('expected TransactionReplacedError');
    expect(found).nested.property('info.reason').equals('replaced');
    expect(found.cause).equals(undefined);
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

/**
 * A library that reports a revert or replacement by rejecting (ethers) has
 * given its own final verdict. That error is the consumer's library error,
 * so it is rethrown as the same object, not wrapped, and the verdict stays
 * memoised like the SDK's own.
 */
describe('memoiseConfirmation — library verdict pass-through', () => {
  const reverted = (transactionHash: Hex): Receipt => ({
    ...receiptFor(transactionHash),
    status: 'reverted'
  });

  it.each(['CALL_EXCEPTION', 'TRANSACTION_REPLACED'])(
    'rethrows a %s rejection by identity and memoises it',
    async (code) => {
      const libraryError = Object.assign(new Error('library verdict'), { code });
      let waits = 0;
      const confirmed = memoiseConfirmation({
        hash: OURS,
        wait: (): Promise<WaitOutcome> => {
          waits++;
          return Promise.resolve({ libraryRejection: libraryError });
        }
      });

      const first = await settle(confirmed());
      const second = await settle(confirmed());

      expect(first).equals(libraryError);
      expect(isMaticjsError(first)).equals(false);
      expect(second).equals(libraryError);
      expect(waits).equals(1);
    }
  );

  it('leaves the cause unset when the library raised nothing', async () => {
    const confirmed = memoiseConfirmation({
      hash: OURS,
      wait: () => Promise.resolve({ receipt: reverted(OURS) })
    });

    const found = TransactionRevertedError.find(await settle(confirmed()));
    if (found === null) throw new Error('expected TransactionRevertedError');
    expect(found.cause).equals(undefined);
  });

  it('resolves a successful repriced receipt', async () => {
    const confirmed = memoiseConfirmation({
      hash: OURS,
      wait: () =>
        Promise.resolve({
          receipt: receiptFor(OTHER),
          replacement: { reason: 'repriced', hash: OTHER }
        })
    });

    const receipt = await confirmed();

    expect(receipt).property('transactionHash').equals(OTHER);
  });
});

/**
 * A failed wait says nothing about the transaction, so it is not memoised:
 * the raw wait error is rethrown as the same object, and the next call
 * waits again.
 */
describe('memoiseConfirmation — wait failure', () => {
  it('rethrows the raw wait error unchanged and retries on the next call', async () => {
    const waitError = new Error('request timed out');
    let waits = 0;
    const confirmed = memoiseConfirmation({
      hash: OURS,
      wait: (): Promise<WaitOutcome> => {
        waits++;
        return Promise.reject(waitError);
      }
    });

    const first = await settle(confirmed());
    const second = await settle(confirmed());

    expect(first).equals(waitError);
    expect(isMaticjsError(first)).equals(false);
    expect(second).equals(waitError);
    expect(waits).equals(2);
  });

  it('wraps an SDK condition from the wait in ConfirmationError, not memoised', async () => {
    let waits = 0;
    const confirmed = memoiseConfirmation({
      hash: OURS,
      wait: (): Promise<WaitOutcome> => {
        waits++;
        return Promise.reject(
          new TransactionRevertedError('stand-in condition', {
            info: { transactionHash: OURS, receipt: receiptFor(OURS) }
          })
        );
      }
    });

    const first = await settle(confirmed());
    const second = await settle(confirmed());

    expect(first).property('name').equals('ConfirmationError');
    expect(ConfirmationError.find(first)).nested.property('info.transactionHash').equals(OURS);
    expect(TransactionRevertedError.has(first)).equals(true);
    expect(second).not.equals(first);
    expect(waits).equals(2);
  });
});
