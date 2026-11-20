/**
 * The checkpoint status shared by every bridge that proves a child-chain
 * burn. It lives here, not in a bridge's own folder, because the proof
 * builder and both bridges' withdrawal statuses are built from it: the PoS
 * bridge re-exports it from `../pos/bridge-status.js`, the Plasma bridge
 * composes its own reason from it.
 */

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
