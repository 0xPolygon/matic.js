/**
 * Where a Plasma withdrawal stands, as data.
 *
 * The status is read from the chain, not remembered: the contracts keep no
 * index from a burn to its exit, so the caller supplies the confirm
 * transaction and the exit is found from that transaction's log (see
 * `exit-id.ts`).
 */
import type { Adapter, Hex } from '../adapter.js';
import type {
  CheckpointNotReachedReason,
  CheckpointStatus
} from '../internal/checkpoint-status.js';
import type { Logger } from '../logger.js';
import type { PlasmaAddresses } from './addresses.js';

import { PlasmaExitNFTABI } from '../abi/plasma/ExitNFT.js';
import {
  ExitNotStartedError,
  InvalidHexStringError,
  InvalidNumericValueError,
  TransactionHashRequiredError
} from '../errors.js';
import { ContractCaller } from '../internal/contract-caller.js';
import { noopLogger } from '../logger.js';
import { PlasmaEventSignature } from './events.js';
import {
  branchMaskForTransactionIndex,
  branchMaskOf,
  burnBlockOf,
  exitableAtOf,
  startedExitFromReceipt
} from './exit-id.js';

/**
 * Why a burn has not been exited yet.
 *
 * - `'pending'`: the burn is in no block yet; wait for it to mine.
 * - `'not-checkpointed'`: mined, waiting for a checkpoint to cover its
 *   block; keep polling.
 * - `'not-confirmed'`: checkpointed, but no confirmed exit is known for it:
 *   either `confirmTxHash` was not given, or that transaction is missing or
 *   reverted. Without `confirmTxHash` the answer cannot tell 'never
 *   confirmed' from 'confirmed, hash not supplied', and an exit already
 *   processed reads the same. If you have not confirmed, call
 *   `confirmWithdraw` (or `confirmWithdrawFast`). If you may have, supply the
 *   confirm transaction's hash as `confirmTxHash`; a new confirm for an exit
 *   that already exists reverts.
 * - `'in-exit-window'`: the exit is queued and its waiting period has not
 *   ended; keep polling.
 * - `'ready-to-process'`: the waiting period has ended; call
 *   `completeWithdraw` to pay it out.
 */
export type PlasmaWithdrawNotExitedReason =
  | CheckpointNotReachedReason
  | 'not-confirmed'
  | 'in-exit-window'
  | 'ready-to-process';

/**
 * Where a Plasma burn stands on the exit path. `exited: true` means the
 * exit has been processed: its exit token is gone. It does not say the
 * payout succeeded in full. Otherwise `reason` says what the withdrawal is
 * waiting for.
 *
 * Known limit: a chain reorganisation on the parent chain in the short window
 * between the exit's processing and the read can make the answer briefly
 * stale. A node that is behind the block of the confirm transaction answers
 * `'in-exit-window'` from its own view, even when the exit is already
 * processed or its waiting period has ended; a later read from a node that has
 * caught up answers correctly.
 */
export type PlasmaWithdrawStatus =
  | { readonly exited: true }
  | { readonly exited: false; readonly reason: PlasmaWithdrawNotExitedReason };

/**
 * What the status read needs to know about the burn on the child chain.
 * It is an interface so the read compiles and is testable apart from the
 * exit-proof builder that implements it.
 */
export interface PlasmaBurnReader {
  /** Whether the burn's block is covered by a checkpoint, or why not. */
  getCheckpointStatus(burnTxHash: string): Promise<CheckpointStatus>;
  /**
   * Where the burn sits on the child chain and who it burned for. Asked only
   * after `getCheckpointStatus` reported the burn as checkpointed, when the
   * receipt exists, and only once a confirm has started an exit to compare
   * it with.
   */
  getBurn(burnTxHash: string): Promise<PlasmaBurn>;
}

/**
 * The facts of a burn that its exit id records: the block it is in, its
 * position in that block, and the account the exit is started for.
 */
export interface PlasmaBurn {
  /** Child-chain block number of the burn's receipt. */
  readonly blockNumber: bigint;
  /** Position of the burn's receipt in its block. */
  readonly transactionIndex: number;
  /**
   * Lower-case address the burn's `Withdraw` log names as the withdrawer.
   * The predicate starts an exit only for that account, so a genuine confirm
   * names it as the exitor.
   */
  readonly exitor: Hex;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x[0-9a-fA-F]+$/;

/**
 * Throws for an empty or malformed hash, which is invalid input rather than
 * a status.
 */
const requireHash = ({ name, value }: { name: string; value: string }): void => {
  if (value === '') {
    throw new TransactionHashRequiredError(`${name} not provided for getWithdrawStatus`, {
      info: { eventSignature: PlasmaEventSignature.Erc20Withdraw }
    });
  }
  if (!HASH.test(value)) {
    throw new InvalidHexStringError(`${name} must be a 0x-prefixed 32-byte hex string`, {
      info: { arg: name, value: value.slice(0, 80), length: value.length }
    });
  }
};

/** A hex quantity from a block, or a typed error naming the missing field. */
const requireQuantity = ({ field, value }: { field: string; value: unknown }): bigint => {
  if (typeof value !== 'string' || !QUANTITY.test(value)) {
    throw new InvalidNumericValueError(`the latest parent block carries no valid ${field}`, {
      info: { method: 'eth_getBlockByNumber', response: String(value).slice(0, 80) }
    });
  }
  return BigInt(value);
};

/** Height and timestamp (seconds) of the parent chain's latest block, as one node sees it. */
const readParentHead = async (adapter: Adapter): Promise<{ number: bigint; timestamp: bigint }> => {
  const block = await adapter.request<{ number?: string; timestamp?: string } | null>(
    'eth_getBlockByNumber',
    ['latest', false]
  );
  return {
    timestamp: requireQuantity({ field: 'timestamp', value: block?.timestamp }),
    number: requireQuantity({ field: 'number', value: block?.number })
  };
};

/**
 * Read the status of a Plasma withdrawal.
 *
 * The answer is a status with a reason and is never thrown. The throws are
 * invalid input (an empty or malformed hash), a burn the node does not know,
 * the chain clients' own errors, and `ExitNotStartedError` when
 * `confirmTxHash` is not this burn's confirm: its receipt has no
 * `ExitStarted` log from the withdraw manager, or the exit it started
 * belongs to a burn in another block, to another account, or to another
 * transaction in the burn's block.
 *
 * `confirmTxHash` is how the exit is found. When it is omitted the read
 * answers `'not-confirmed'` for a checkpointed burn, because nothing on
 * chain maps a burn to its exit, even when the exit was already processed.
 */
export const readPlasmaWithdrawStatus = async ({
  burnTxHash,
  confirmTxHash,
  proof,
  parentAdapter,
  addresses,
  logger = noopLogger
}: {
  burnTxHash: string;
  confirmTxHash?: string;
  proof: PlasmaBurnReader;
  parentAdapter: Adapter;
  addresses: Pick<PlasmaAddresses, 'WithdrawManager' | 'ExitNFT'>;
  logger?: Logger;
}): Promise<PlasmaWithdrawStatus> => {
  requireHash({ name: 'burnTxHash', value: burnTxHash });
  if (confirmTxHash !== undefined) requireHash({ name: 'confirmTxHash', value: confirmTxHash });

  const checkpoint = await proof.getCheckpointStatus(burnTxHash);
  if (!checkpoint.checkpointed) return { exited: false, reason: checkpoint.reason };

  if (confirmTxHash === undefined) return { exited: false, reason: 'not-confirmed' };
  const receipt = await parentAdapter.getTransactionReceipt(confirmTxHash);
  if (receipt === null || receipt.status !== 'success') {
    return { exited: false, reason: 'not-confirmed' };
  }

  const started = startedExitFromReceipt({ receipt, withdrawManager: addresses.WithdrawManager });
  if (started === undefined) {
    throw new ExitNotStartedError(
      'confirmTxHash did not start an exit: its receipt has no ExitStarted log from the withdraw manager. Pass the transaction confirmWithdraw returned for this burn.',
      { info: { burnTxHash, confirmTxHash, reason: 'no-exit-started-log' } }
    );
  }
  const { exitId, exitor } = started;

  // The exit id carries the burn block and the receipt's position in it, and
  // the log carries who the exit is for. Two burns can share a block, so the
  // block alone would let one burn's confirm answer for the other; the
  // position and the exitor tell them apart.
  const burn = await proof.getBurn(burnTxHash);
  if (burnBlockOf(exitId) !== burn.blockNumber) {
    throw new ExitNotStartedError(
      'confirmTxHash started an exit for a burn in a different block, so it is not this burn’s confirm. Pass the transaction confirmWithdraw returned for this burn.',
      { info: { burnTxHash, confirmTxHash, reason: 'burn-block-mismatch' } }
    );
  }
  if (exitor !== burn.exitor) {
    throw new ExitNotStartedError(
      'confirmTxHash started an exit for a different account than the one that burned, so it is not this burn’s confirm. Pass the transaction confirmWithdraw returned for this burn.',
      { info: { burnTxHash, confirmTxHash, reason: 'exitor-mismatch' } }
    );
  }
  if (branchMaskOf(exitId) !== branchMaskForTransactionIndex(burn.transactionIndex)) {
    throw new ExitNotStartedError(
      'confirmTxHash started an exit for a different transaction in the burn’s block, so it is not this burn’s confirm. Pass the transaction confirmWithdraw returned for this burn.',
      { info: { burnTxHash, confirmTxHash, reason: 'branch-mask-mismatch' } }
    );
  }

  // "The exit token does not exist" is true of a processed exit and equally
  // of state from before the confirm, where it is not minted yet. A
  // load-balanced RPC can serve the confirm's receipt from one node and the
  // next call from a node a block behind, so the token is read at one named
  // block, and its absence counts only when that block is not older than the
  // confirm's.
  const head = await readParentHead(parentAdapter);
  // A node behind the confirm's block cannot say whether the exit was processed
  // and cannot act on it either, so it never answers 'ready-to-process' from
  // its own lagging clock; the next read, from a node that has caught up, heals
  // the answer.
  if (head.number < receipt.blockNumber) return { exited: false, reason: 'in-exit-window' };

  const exitNft = new ContractCaller({
    adapter: parentAdapter,
    getAddress: () => Promise.resolve(addresses.ExitNFT),
    abi: PlasmaExitNFTABI,
    isParent: true,
    logger
  });
  const exists = await exitNft.read('exists', [exitId], { blockTag: head.number });
  // A burn exit has no inputs and so cannot be challenged: an exit token
  // that no longer exists was processed.
  if (exists === false) return { exited: true };

  return {
    exited: false,
    reason: head.timestamp >= exitableAtOf(exitId) ? 'ready-to-process' : 'in-exit-window'
  };
};
