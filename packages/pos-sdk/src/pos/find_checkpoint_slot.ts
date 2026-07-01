/**
 * Pure binary-search helper for locating the checkpoint slot that contains a
 * given child-chain block. Extracted from `RootChain.findRootBlockFromChild`
 * so the algorithm can be unit-tested without instantiating any class.
 *
 * Stage 2 narrows the working type from a pluggable `BaseBigNumber` to
 * native `bigint` — the legacy SDK had to support pluggable BN implementations
 * across web3.js, ethers v5 (`BigNumber`), and bn.js, but the rewrite owns
 * its own arithmetic. `findCheckpointSlot` is the only call site that
 * needed mid-magnitude arithmetic outside the adapter layer.
 *
 * Two correctness properties this helper enforces — both broken in earlier
 * inline versions of the algorithm:
 *
 *  1. The single-candidate early exit (`start === end`) verifies that the
 *     candidate's range actually contains the child block. Without this
 *     check, a child block past every existing checkpoint causes the search
 *     to converge on `currentHeaderBlock / 10000` and falsely accept it,
 *     producing a proof that embeds a non-existent or unrelated checkpoint.
 *
 *  2. The two contract reads (`currentHeaderBlock`, `headerBlocks(slot)`) are
 *     parameterised on a single block tag — the caller wires both reads to
 *     the same L1 block tag as the upstream existence check, so the search
 *     and the existence check observe a consistent chain view.
 */

import { POSBridgeError } from '../errors.js';

export interface CheckpointSlotInputs {
  /** Child-chain block number whose containing checkpoint we want. */
  childBlockNumber: bigint;
  /** Reads the RootChain `currentHeaderBlock()` storage value. */
  readCurrentHeaderBlock: () => Promise<bigint>;
  /** Reads `headerBlocks(headerId)` for `headerId = slot * CHECKPOINT_INTERVAL`. */
  readHeaderBlocks: (headerId: bigint) => Promise<{ start: bigint; end: bigint }>;
}

const ONE = 1n;
const TWO = 2n;
const CHECKPOINT_INTERVAL = 10000n;

/**
 * @returns the header id (`slot * CHECKPOINT_INTERVAL`) of the checkpoint
 * containing the child block.
 * @throws POSBridgeError('BURN_TX_NOT_CHECKPOINTED') if the child block
 * is not contained in any submitted checkpoint.
 */
export async function findCheckpointSlot(opts: CheckpointSlotInputs): Promise<bigint> {
  const { childBlockNumber, readCurrentHeaderBlock, readHeaderBlocks } = opts;

  const currentHeaderBlock = await readCurrentHeaderBlock();
  let start = ONE;
  let end = currentHeaderBlock / CHECKPOINT_INTERVAL;

  while (start <= end) {
    if (start === end) {
      // The search collapsed to a single candidate, but that does not by
      // itself prove the candidate contains the child block. If the child
      // block sits past every existing checkpoint, the loop converges on
      // `currentHeaderBlock / CHECKPOINT_INTERVAL` and would otherwise be
      // returned as a false positive. Verify against the candidate's range.
      const headerBlock = await readHeaderBlocks(start * CHECKPOINT_INTERVAL);
      if (headerBlock.start <= childBlockNumber && childBlockNumber <= headerBlock.end) {
        return start * CHECKPOINT_INTERVAL;
      }
      throw new POSBridgeError(
        'BURN_TX_NOT_CHECKPOINTED',
        'Burn transaction has not been checkpointed as yet',
        { childBlockNumber: childBlockNumber.toString() }
      );
    }
    const mid = (start + end) / TWO;
    const headerBlock = await readHeaderBlocks(mid * CHECKPOINT_INTERVAL);
    if (headerBlock.start <= childBlockNumber && childBlockNumber <= headerBlock.end) {
      return mid * CHECKPOINT_INTERVAL;
    } else if (headerBlock.start > childBlockNumber) {
      end = mid - ONE;
    } else if (headerBlock.end < childBlockNumber) {
      start = mid + ONE;
    }
  }
  // Loop exited without converging (e.g. currentHeaderBlock = 0 before any
  // checkpoint has ever been submitted, so end < start on entry).
  throw new POSBridgeError(
    'BURN_TX_NOT_CHECKPOINTED',
    'Burn transaction has not been checkpointed as yet',
    { childBlockNumber: childBlockNumber.toString() }
  );
}
