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
 * Why a deposit has not landed on the child chain yet: `'pending'` means the
 * deposit tx is in no block, `'not-synced'` means it is mined and the child
 * chain's state receiver has not caught up to its state id.
 */
export type DepositNotSyncedReason = 'pending' | 'not-synced';

/** Whether a deposit's state-sync has been applied on the child chain. */
export type DepositStatus =
  | { readonly deposited: true }
  | { readonly deposited: false; readonly reason: DepositNotSyncedReason };
