/**
 * Why a burn has not been exited yet, as data. A caller that polls a
 * withdrawal needs to tell "not mined yet" and "wait for the checkpoint"
 * from "ready to exit",
 * and a thrown error is the wrong carrier for that: neither is a failure.
 */
export type WithdrawNotExitedReason = 'pending' | 'not-checkpointed' | 'not-exited';

/**
 * Where a burn stands on the exit path. `exited: true` means the parent
 * chain has processed the exit. Otherwise `reason` says whether the burn is
 * in no block yet (`'pending'`), is mined and waiting for its checkpoint
 * (`'not-checkpointed'`), or is checkpointed and ready to exit
 * (`'not-exited'`).
 */
export type WithdrawStatus =
  | { readonly exited: true }
  | { readonly exited: false; readonly reason: WithdrawNotExitedReason };
