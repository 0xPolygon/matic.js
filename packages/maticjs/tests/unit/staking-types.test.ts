import { describe, expectTypeOf, it } from 'vitest';

import type { Hex, PreparedTx, TxResult } from '../../src/adapter.ts';
import type {
  ResolvedStakingAddresses,
  StakeForParams,
  StakeManager,
  StakingClient,
  ValidatorShare
} from '../../src/staking/index.ts';

/**
 * Type-level guarantees. `stakeFor` takes five on-chain arguments, and
 * a hand-written 3.x type shim once declared it with four, so the MATIC
 * onboarding path sent the signer key in the `acceptDelegation` slot.
 * A params object with every field required turns that whole class of
 * mistake into a compile error; these assertions keep it that way.
 * Checked by `tsc` (the test files are in the typecheck project), so an
 * unused `@ts-expect-error` below fails typecheck.
 */

type StakeForKeys = 'user' | 'amount' | 'heimdallFee' | 'acceptDelegation' | 'signerPubkey';

type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];

declare const stakeManager: StakeManager;
declare const user: Hex;
declare const signerPubkey: Hex;

describe('staking method types', () => {
  it('stakeFor and stakeForMatic take one params object with exactly the five on-chain fields, all required', () => {
    expectTypeOf<Parameters<StakeManager['stakeFor']>[0]>().toEqualTypeOf<StakeForParams>();
    expectTypeOf<Parameters<StakeManager['stakeForMatic']>[0]>().toEqualTypeOf<StakeForParams>();
    expectTypeOf<keyof StakeForParams>().toEqualTypeOf<StakeForKeys>();
    expectTypeOf<RequiredKeys<StakeForParams>>().toEqualTypeOf<StakeForKeys>();
  });

  it('rejects the four-field call shape and positional calls at compile time', () => {
    const reject = (): void => {
      // @ts-expect-error — acceptDelegation missing (the production bug shape)
      void stakeManager.stakeForMatic({ user, amount: 1n, heimdallFee: 1n, signerPubkey });
      // @ts-expect-error — positional arguments are not accepted
      void stakeManager.stakeForMatic(user, 1n, 1n, signerPubkey);
      // @ts-expect-error — the POL variant has the same guard
      void stakeManager.stakeFor({ user, amount: 1n, heimdallFee: 1n, signerPubkey });
    };
    expectTypeOf(reject).toBeFunction();
  });

  it('writes resolve to TxResult and their prepare siblings to PreparedTx', () => {
    expectTypeOf<ReturnType<ValidatorShare['delegate']>>().toEqualTypeOf<Promise<TxResult>>();
    expectTypeOf<ReturnType<ValidatorShare['prepareDelegate']>>().toEqualTypeOf<
      Promise<PreparedTx>
    >();
    expectTypeOf<ReturnType<StakeManager['stakeFor']>>().toEqualTypeOf<Promise<TxResult>>();
    expectTypeOf<ReturnType<StakeManager['prepareStakeFor']>>().toEqualTypeOf<
      Promise<PreparedTx>
    >();
  });

  it('amounts are bigint, not number or string', () => {
    expectTypeOf<StakeForParams['amount']>().toEqualTypeOf<bigint>();
    expectTypeOf<Parameters<ValidatorShare['delegate']>[0]['amount']>().toEqualTypeOf<bigint>();
  });

  it('getAddresses() guarantees the three staking keys (init refuses an index without them)', () => {
    type Resolved = Awaited<ReturnType<StakingClient['getAddresses']>>;
    expectTypeOf<Resolved>().toEqualTypeOf<ResolvedStakingAddresses>();
    expectTypeOf<Resolved['StakeManager']>().toEqualTypeOf<Hex>();
    expectTypeOf<Resolved['MaticToken']>().toEqualTypeOf<Hex>();
    expectTypeOf<Resolved['PolToken']>().toEqualTypeOf<Hex>();
  });
});
