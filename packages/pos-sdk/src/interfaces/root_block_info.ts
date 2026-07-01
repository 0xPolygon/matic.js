/**
 * Snapshot of a single checkpoint slot on the parent chain.
 *
 * Each entry maps a `headerBlockNumber` (the parent-side slot id) to
 * the `[start, end]` range of child-chain blocks that the slot
 * checkpoints. The bridge looks this up to build the exit-payload.
 *
 * `start` / `end` are kept as decimal strings rather than `bigint` so
 * the legacy callers that hand-rolled big-number arithmetic on these
 * values continue to work; the only consumer that survives Stage 2
 * (`POSBridgeHelpers.#getRootBlockInfo`) coerces back to `bigint` at
 * the boundary.
 */
export interface IRootBlockInfo {
  start: string;
  end: string;
  headerBlockNumber: bigint;
}
