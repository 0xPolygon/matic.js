import type { Hex, Receipt } from '../adapter.js';

import { POSBridgeError } from '../errors.js';

/**
 * Why the transaction at our nonce is not the one we broadcast, as every
 * supported library reports it. `'repriced'` is the same call re-sent with
 * a higher fee (a wallet's speed-up); `'cancelled'` and `'replaced'` are a
 * different transaction that consumed the nonce.
 */
export type ReplacementReason = 'repriced' | 'cancelled' | 'replaced';

/**
 * What an adapter's receipt wait observed. `receipt` is the receipt of the
 * transaction that mined at our nonce; `replacement` is set when that is
 * not the transaction we broadcast.
 */
export interface WaitOutcome {
  receipt: Receipt;
  replacement?: { reason: ReplacementReason; hash: Hex };
}

/**
 * Builds a `TxResult.confirmed()` from an adapter's receipt wait. Every
 * adapter goes through this one function, so all three behave the same way
 * once a receipt arrives.
 *
 * - **A reverted receipt rejects** with `TRANSACTION_REVERTED`. The
 *   receipt is in `info.receipt` for callers that need it. If a reverted
 *   receipt resolved instead, a caller that treats "receipt arrived" as
 *   success would record a failed bridge transaction as done.
 * - **A repriced replacement counts as the original.** It is the same
 *   call with a higher fee, so its receipt stands in for ours, revert check
 *   included.
 * - **A cancelled or replaced transaction rejects** with
 *   `TRANSACTION_REPLACED`. The other transaction's receipt says nothing
 *   about the bridge call, which will now never execute; resolving with it
 *   would report a transfer that did not happen as done.
 * - **An unexplained receipt for another transaction rejects** with
 *   `TRANSACTION_REPLACED` (reason `'replaced'`). If a library hands back a
 *   receipt whose hash is not ours without reporting a replacement, nothing
 *   says it is the same call, so it must never count as success.
 * - **Concurrent and repeated calls share one wait.** A revert or a
 *   replacement is final, so that rejection stays memoised: a second call
 *   rejects with the same error and does not ask the chain again.
 * - **A failed wait is not memoised.** An RPC blip or a library timeout
 *   says nothing about the transaction, so the next call starts a fresh
 *   wait. Otherwise one transient failure would poison a transaction that
 *   later mines.
 *
 * `wait` must resolve whatever the receipt's status, and reject only when
 * no receipt could be obtained.
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
    memo ??= wait().then(
      (outcome) => settle({ hash, outcome }),
      (err: unknown) => {
        memo = undefined;
        throw err;
      }
    );
    return memo;
  };
};

const settle = ({ hash, outcome }: { hash: Hex; outcome: WaitOutcome }): Receipt => {
  const { receipt, replacement } = outcome;
  if (replacement !== undefined && replacement.reason !== 'repriced') {
    throw new POSBridgeError(
      'TRANSACTION_REPLACED',
      `Transaction ${hash} was ${replacement.reason} by ${replacement.hash} and will not execute.`,
      {
        transactionHash: hash,
        replacementHash: replacement.hash,
        reason: replacement.reason,
        receipt
      }
    );
  }
  if (replacement === undefined && receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
    throw new POSBridgeError(
      'TRANSACTION_REPLACED',
      `Transaction ${hash} was not the one that mined: the wait returned the receipt of ${receipt.transactionHash}.`,
      {
        transactionHash: hash,
        replacementHash: receipt.transactionHash,
        reason: 'replaced',
        receipt
      }
    );
  }
  if (receipt.status === 'reverted') {
    throw new POSBridgeError(
      'TRANSACTION_REVERTED',
      `Transaction ${receipt.transactionHash} reverted in block ${receipt.blockNumber}.`,
      { transactionHash: receipt.transactionHash, receipt }
    );
  }
  return receipt;
};
