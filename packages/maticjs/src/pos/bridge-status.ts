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
 * Why a deposit has not been delivered to the child chain: `'pending'` means
 * the deposit tx is in no block, `'not-synced'` means it is mined and the
 * child chain's state receiver has not reached its state id, and
 * `'delivery-failed'` means the state receiver reached it and holds a failed
 * record for it: the child-side call ran out of its per-record gas limit or
 * reverted, so the deposit does not land until that record is replayed on the
 * child chain.
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
      readonly reason: 'delivery-failed';
      /** The deposit's state id, from its parent-chain `StateSynced` event. */
      readonly stateId: bigint;
      /** The child-chain contract the state receiver delivers to (`StateSynced.contractAddress`), lowercase. */
      readonly receiver: Hex;
      /**
       * What the state receiver stores for the failed delivery, which decides
       * the replay call: `'payload'` is the full `(receiver, data)`, recorded
       * before the Uburu fork; replay with `replayFailedStateSync(stateId)`.
       * `'hash'` is only keccak256(abi.encode(receiver, data)), recorded since
       * Uburu; replay with `replayFailedStateSyncWithData(stateId, receiver,
       * data)`.
       */
      readonly record: 'payload' | 'hash';
      /**
       * True when the failed record the state receiver holds is this
       * deposit's own: its stored hash (or the hash of its stored payload)
       * equals keccak256(abi.encode(receiver, data)) of the deposit's own
       * `StateSynced` event, so a replay can be attempted with this deposit's
       * data. It does NOT mean the replay will succeed: the receiving
       * contract may still revert. False when a failed record exists for the
       * state id but with different content.
       *
       * One corner is not verified: the post-Uburu state receiver's source
       * is unpublished, so whether a FAILED replay attempt could clear the
       * stored hash is unknown. The SDK reports the stored value as the
       * contract leaves it; a record that has been cleared reads
       * `{ deposited: true }`.
       */
      readonly replayable: boolean;
    };
