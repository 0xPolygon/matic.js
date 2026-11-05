/**
 * Pure binary-search helper for locating the checkpoint slot that contains a
 * given child-chain block. Extracted from `RootChain.findRootBlockFromChild`
 * so the algorithm can be unit-tested without instantiating any class.
 *
 * The working type is narrowed from a pluggable `BaseBigNumber` to
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

import { BridgeEventDecodeFailedError, BurnTxNotCheckpointedError } from '../errors.js';

/**
 * Normalise a `headerBlocks(headerId)` contract-read result to
 * `{ start, end }`.
 *
 * The RootChain `headerBlocks` getter has five outputs
 * (`root, start, end, createdAt, proposer`) and the three adapter
 * libraries decode multi-output functions differently: viem returns a
 * plain POSITIONAL array with no named properties, while ethers v5/v6
 * return a `Result` — an array subclass that also carries named
 * properties (v5's `BigNumber` values coerce through `BigInt()` via
 * `toString`). Positional access is the one shape all three share, so
 * indices 1/2 are authoritative; a plain named-property object is
 * accepted as a fallback. Reading `.start`/`.end` directly is NOT safe
 * — on viem those are `undefined` and `BigInt(undefined)` throws.
 */
export function parseHeaderBlocksResult(result: unknown): { start: bigint; end: bigint } {
  const coerce = (v: unknown, field: string): bigint => {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'string' || typeof v === 'number') return BigInt(v);
    // ethers v5 BigNumber (and anything else stringifying to a decimal
    // or 0x-hex quantity) coerces through its string form.
    if (typeof v === 'object' && v !== null) return BigInt(String(v));
    throw new BridgeEventDecodeFailedError(
      `headerBlocks result field '${field}' is not a numeric value`,
      { info: { field, valueType: typeof v } }
    );
  };
  if (Array.isArray(result)) {
    // Outputs: [root, start, end, createdAt, proposer]
    if (result.length < 3) {
      throw new BridgeEventDecodeFailedError(
        `headerBlocks result has ${result.length} elements; expected at least 3 (root, start, end)`,
        { info: { length: result.length } }
      );
    }
    return { start: coerce(result[1], 'start'), end: coerce(result[2], 'end') };
  }
  if (typeof result === 'object' && result !== null && 'start' in result && 'end' in result) {
    const r = result as { start: unknown; end: unknown };
    return { start: coerce(r.start, 'start'), end: coerce(r.end, 'end') };
  }
  throw new BridgeEventDecodeFailedError(
    'headerBlocks result is neither a positional array nor a { start, end } object',
    { info: { resultType: typeof result } }
  );
}

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
 * @throws BurnTxNotCheckpointedError if the child block
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
      throw new BurnTxNotCheckpointedError('Burn transaction has not been checkpointed as yet', {
        info: { childBlockNumber: childBlockNumber.toString() }
      });
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
  throw new BurnTxNotCheckpointedError('Burn transaction has not been checkpointed as yet', {
    info: { childBlockNumber: childBlockNumber.toString() }
  });
}
