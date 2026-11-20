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
import type {
  ExitNotStartedInfo,
  ExitNotStartedReason,
  PlasmaWithdrawNotExitedReason
} from '../../src/plasma/index.ts';

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

  it('names the Plasma reasons', () => {
    expectTypeOf<PlasmaWithdrawNotExitedReason>().toEqualTypeOf<
      'pending' | 'not-checkpointed' | 'not-confirmed' | 'in-exit-window' | 'ready-to-process'
    >();
    expectTypeOf<
      Extract<PlasmaWithdrawNotExitedReason, CheckpointNotReachedReason>
    >().toEqualTypeOf<CheckpointNotReachedReason>();
    expectTypeOf<ExitNotStartedReason>().toEqualTypeOf<
      'no-exit-started-log' | 'burn-block-mismatch' | 'exitor-mismatch' | 'branch-mask-mismatch'
    >();
    expectTypeOf<ExitNotStartedInfo['reason']>().toEqualTypeOf<ExitNotStartedReason>();
  });

  it('keeps the type-only assertions from being an empty file at runtime', () => {
    expect(true).equal(true);
  });
});
