/**
 * Validator-owner staking writes: GATED on this devnet, never run.
 *
 * The devnet has one validator node. `stakeFor` registers a second validator
 * with no node behind it, and that halts block production: after the
 * registration heimdall's producer selection fails ("failed to select
 * producer: no candidates found"), bor stops at its current block, and
 * checkpoints stop. This was observed on a cold-start kurtosis-pos v1.4.8
 * devnet: L2 stopped about 60 s after `stakeFor` and did not recover in the
 * following 6 minutes. A halted devnet fails every other file sharing it, so
 * `stakeFor` must never run in a suite, and every write that needs a
 * validator the test owns (`topUpHeimdallFee`, `updateCommissionRate`,
 * `withdrawValidatorRewards`, `restake`, `unstake`, `claimUnstaked`,
 * `updateSigner`) is gated with it. `migrateDelegation` needs two validators
 * that accept delegation; the devnet has one.
 *
 * These writes are covered by calldata ground truth in
 * `packages/maticjs/tests/unit/staking-calldata-ground-truth.test.ts`. The
 * per-write record is `STAKING-COVERAGE.md`. Running them needs a devnet with
 * a second validator node, which this tier does not boot.
 */
import { describe, expect, it } from 'vitest';

const GATED_REASON = 'stakeFor adds a node-less validator and halts the single-validator devnet';

describe.skip(`validator-owner staking writes — GATED: ${GATED_REASON}`, () => {
  it('stakeFor, topUpHeimdallFee, updateCommissionRate, withdrawValidatorRewards, restake, unstake, claimUnstaked', () => {
    expect.fail(`gated: ${GATED_REASON}; see STAKING-COVERAGE.md`);
  });
});
