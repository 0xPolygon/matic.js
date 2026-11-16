import type { Hex, Receipt } from '../adapter.js';

import {
  ConfirmationError,
  TransactionReplacedError,
  TransactionRevertedError,
  withOperation
} from '../errors.js';

/**
 * Why the transaction at our nonce is not the one we broadcast, as every
 * supported library reports it. `'repriced'` is the same call re-sent with
 * a higher fee (a wallet's speed-up); `'cancelled'` and `'replaced'` are a
 * different transaction that consumed the nonce.
 */
export type ReplacementReason = 'repriced' | 'cancelled' | 'replaced';

/** The transaction that mined at our nonce instead of ours, and why. */
export type Replacement = { reason: ReplacementReason; hash: Hex };

/**
 * What an adapter's receipt wait observed. Either a receipt arrived
 * (`receipt` is the receipt of the transaction that mined at our nonce;
 * `replacement` is set when that is not the transaction we broadcast), or
 * the library rejected its wait with a final verdict on the transaction
 * (ethers' CALL_EXCEPTION for a mined revert, TRANSACTION_REPLACED for a
 * replacement) and `libraryRejection` is that error, to be rethrown as-is.
 *
 * The adapter makes the call because only it knows its library's codes. A
 * final verdict is memoised; a rejection of `wait` itself is not.
 */
export type WaitOutcome =
  | { receipt: Receipt; replacement?: Replacement }
  | { libraryRejection: unknown };

/**
 * Builds a `TxResult.confirmed()` from an adapter's receipt wait. Every
 * adapter goes through this one function, so all three behave the same way
 * once a receipt arrives.
 *
 * - **A reverted receipt rejects** with `TransactionRevertedError`. The
 *   receipt is in `info.receipt` for callers that need it. If a reverted
 *   receipt resolved instead, a caller that treats "receipt arrived" as
 *   success would record a failed bridge transaction as done.
 * - **A repriced replacement counts as the original.** It is the same
 *   call with a higher fee, so its receipt stands in for ours, revert check
 *   included.
 * - **A cancelled or replaced transaction rejects** with
 *   `TransactionReplacedError`. The other transaction's receipt says nothing
 *   about the bridge call, which will now never execute; resolving with it
 *   would report a transfer that did not happen as done.
 * - **An unexplained receipt for another transaction rejects** with
 *   `TransactionReplacedError` (reason `'replaced'`). If a library hands back a
 *   receipt whose hash is not ours without reporting a replacement, nothing
 *   says it is the same call, so it must never count as success.
 * - **A library's own verdict is rethrown as-is.** When the library rejects
 *   its wait for a mined revert or a replacement (ethers), that error is the
 *   rejection, the same object, unwrapped: it is the consumer's library
 *   error, not an SDK condition.
 * - **Concurrent and repeated calls share one wait.** A revert or a
 *   replacement is final, so that rejection stays memoised: a second call
 *   rejects with the same error and does not ask the chain again.
 * - **A failed wait is not memoised.** An RPC blip or a library timeout
 *   says nothing about the transaction, so the next call starts a fresh
 *   wait. Otherwise one transient failure would poison a transaction that
 *   later mines. The failure itself is rethrown unchanged.
 * - **An SDK condition is a `ConfirmationError`**, with the condition as its
 *   cause. The wrapping happens inside the memo, so a memoised rejection is
 *   the same `ConfirmationError` instance on every call.
 *
 * `wait` must resolve whatever the receipt's status, and reject only when
 * neither a receipt nor the library's verdict could be obtained.
 */
export const memoiseConfirmation = ({
  hash,
  wait
}: {
  hash: Hex;
  wait: () => Promise<WaitOutcome>;
}): (() => Promise<Receipt>) => {
  let memo: Promise<Receipt> | undefined;
  return () => {
    memo ??= withOperation({
      error: ConfirmationError,
      info: { operation: 'confirmed', mode: 'confirm', transactionHash: hash },
      run: () =>
        wait().then(
          (outcome) => settle({ hash, outcome }),
          (err: unknown) => {
            memo = undefined;
            throw err;
          }
        )
    });
    return memo;
  };
};

const settle = ({ hash, outcome }: { hash: Hex; outcome: WaitOutcome }): Receipt => {
  if ('libraryRejection' in outcome) throw outcome.libraryRejection;
  const { receipt, replacement } = outcome;
  if (replacement !== undefined && replacement.reason !== 'repriced') {
    throw new TransactionReplacedError(
      `Transaction ${hash} was ${replacement.reason} by ${replacement.hash} and will not execute.`,
      {
        info: {
          transactionHash: hash,
          replacementHash: replacement.hash,
          reason: replacement.reason,
          receipt
        }
      }
    );
  }
  if (replacement === undefined && receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
    throw new TransactionReplacedError(
      `Transaction ${hash} was not the one that mined: the wait returned the receipt of ${receipt.transactionHash}.`,
      {
        info: {
          transactionHash: hash,
          replacementHash: receipt.transactionHash,
          reason: 'replaced',
          receipt
        }
      }
    );
  }
  if (receipt.status === 'reverted') {
    throw new TransactionRevertedError(
      `Transaction ${receipt.transactionHash} reverted in block ${receipt.blockNumber}.`,
      { info: { transactionHash: receipt.transactionHash, receipt } }
    );
  }
  return receipt;
};
