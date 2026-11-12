import type { Hex } from '../adapter.js';

/**
 * Why a burn is not checkpointed yet: `'pending'` means the tx is in no block
 * so there is nothing to checkpoint, `'not-checkpointed'` means it is mined
 * and waiting for the checkpoint to cover its block. A caller polling for the
 * checkpoint needs to tell these apart, and neither is a failure.
 */
export type CheckpointNotReachedReason = 'pending' | 'not-checkpointed';

/** Whether the block holding a burn tx is covered by a checkpoint on the parent chain. */
export type CheckpointStatus =
  | { readonly checkpointed: true }
  | { readonly checkpointed: false; readonly reason: CheckpointNotReachedReason };

/**
 * Why a deposit has not been delivered to the child chain. `'pending'`: the
 * deposit tx is in no block yet; wait for it to mine. `'not-synced'`: it is
 * mined and the child chain's state receiver has not reached its state id;
 * keep polling `POSClient.getDepositStatus`. `'delivery-failed'`: the
 * state receiver reached it and holds a failed record for it, because the
 * child-side call ran out of its per-record gas limit or reverted; the
 * deposit does not land until that record is replayed, which
 * `POSClient.replayDeposit` does (or
 * `POSClient.prepareReplayDeposit` for a Safe or a batch).
 *
 * @see POSClient.replayDeposit
 */
export type DepositNotDeliveredReason = 'pending' | 'not-synced' | 'delivery-failed';

/**
 * Whether a deposit's state-sync has been applied on the child chain.
 *
 * A deposit transaction carrying several `StateSynced` events is reported by
 * its FIRST event only; every deposit this SDK builds emits exactly one.
 */
export type DepositStatus =
  | { readonly deposited: true }
  | {
      readonly deposited: false;
      readonly reason: Exclude<DepositNotDeliveredReason, 'delivery-failed'>;
    }
  | {
      readonly deposited: false;
      /**
       * The state receiver holds a failed record for this deposit. The fix is
       * `POSClient.replayDeposit` with the same `depositTxHash` (or
       * `POSClient.prepareReplayDeposit` to sign elsewhere): it resends the
       * record from the child-chain signer, paying the gas. Do that only while
       * `replayable` is `true`; when it is `false` the record is not this
       * deposit's and the SDK will refuse. The receiving contract may still
       * reject the replay, which reaches you as your client library's own
       * revert error, not as an SDK error.
       *
       * @see POSClient.replayDeposit
       * @see POSClient.prepareReplayDeposit
       */
      readonly reason: 'delivery-failed';
      /** The deposit's state id, from its parent-chain `StateSynced` event. */
      readonly stateId: bigint;
      /** The child-chain contract the state receiver delivers to (`StateSynced.contractAddress`), lowercase. */
      readonly receiver: Hex;
      /**
       * What the state receiver stores for the failed delivery, which decides
       * the replay call `POSClient.replayDeposit` makes: `'payload'` is
       * the full `(receiver, data)`, recorded before the Uburu fork, replayed
       * with `replayFailedStateSync(stateId)`; `'hash'` is only
       * keccak256(abi.encode(receiver, data)), recorded since Uburu, replayed
       * with `replayFailedStateSyncWithData(stateId, receiver, data)`. You do
       * not pass either; the SDK picks.
       */
      readonly record: 'payload' | 'hash';
      /**
       * True when the failed record the state receiver holds is this
       * deposit's own: its stored hash (or the hash of its stored payload)
       * equals keccak256(abi.encode(receiver, data)) of the deposit's own
       * `StateSynced` event, so `POSClient.replayDeposit` can resubmit
       * this deposit's data. It does NOT mean the replay will succeed: the
       * receiving contract may still revert, and a replay it rejects reverts
       * as a whole and leaves the record in place. False when a failed record
       * exists for the state id but with different content; `replayDeposit`
       * then refuses with `DepositNotReplayableError`. A record that has been
       * cleared by a successful replay reads `{ deposited: true }`.
       */
      readonly replayable: boolean;
    };
