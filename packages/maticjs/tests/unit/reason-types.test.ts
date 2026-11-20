import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  CheckpointNotReachedReason,
  CheckpointRangeInvalidInfo,
  CheckpointRangeInvalidReason,
  FailedStateSyncRecord,
  ReplacementReason,
  TransactionReplacedInfo,
  WithdrawNotExitedReason
} from '../../src/index.ts';

/**
 * The reason unions are public: consumers switch on them. Each is pinned to
 * its written-out literal union so a composed or renamed alias cannot drift.
 * Checked by `tsc` (test files are in the typecheck project).
 */
describe('reason types', () => {
  it('composes WithdrawNotExitedReason from the checkpoint reasons', () => {
    expectTypeOf<WithdrawNotExitedReason>().toEqualTypeOf<
      'pending' | 'not-checkpointed' | 'not-exited'
    >();
    expectTypeOf<
      Extract<WithdrawNotExitedReason, CheckpointNotReachedReason>
    >().toEqualTypeOf<CheckpointNotReachedReason>();
  });

  it('names the checkpoint range reason', () => {
    expectTypeOf<CheckpointRangeInvalidReason>().toEqualTypeOf<
      'inverted' | 'not-containing' | 'too-large'
    >();
    expectTypeOf<
      CheckpointRangeInvalidInfo['reason']
    >().toEqualTypeOf<CheckpointRangeInvalidReason>();
  });

  it('names the replacement reason and the failed state-sync record', () => {
    expectTypeOf<ReplacementReason>().toEqualTypeOf<'repriced' | 'cancelled' | 'replaced'>();
    expectTypeOf<TransactionReplacedInfo['reason']>().toEqualTypeOf<ReplacementReason>();
    expectTypeOf<FailedStateSyncRecord>().toEqualTypeOf<'payload' | 'hash'>();
  });

  it('keeps the type-only assertions from being an empty file at runtime', () => {
    expect(true).equal(true);
  });
});
