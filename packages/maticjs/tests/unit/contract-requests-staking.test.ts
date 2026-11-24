import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Hex } from '../../src/adapter.ts';
import type { CoveredPair, RequestRow, StakingWorld } from './contract-call-harness.ts';

import { __resetAddressCacheForTesting } from '../../src/services/address-service.ts';
import {
  loadFixture,
  OTHER,
  READ,
  rowsOf,
  stakingWorld,
  uncoveredPairs,
  USER,
  VALIDATOR_SHARE,
  WRITE,
  WRITE_FIXTURES_FLAG
} from './contract-call-harness.ts';

/**
 * Request snapshots for the staking client: what each public method that
 * reaches a contract asks the adapter for, compared with
 * `tests/fixtures/contract-calls/requests-staking.json`. See the fixtures
 * README for how the file is generated and why.
 */

const FIXTURE = 'requests-staking.json';

const SIGNER_PUBKEY: Hex = `0x${'ab'.repeat(64)}`;
const R: Hex = `0x${'01'.repeat(32)}`;
const S: Hex = `0x${'02'.repeat(32)}`;
const OPTIONS = { from: USER, gasLimit: 400_000n, maxFeePerGas: 30n, nonce: 4 };

interface Scenario {
  name: string;
  run: (w: StakingWorld) => Promise<unknown>;
}

const sm = (w: StakingWorld) => w.staking.stakeManager;
const share = (w: StakingWorld) => w.staking.validatorShare(VALIDATOR_SHARE);

const STAKE_FOR = {
  user: USER,
  amount: 10n,
  heimdallFee: 2n,
  acceptDelegation: true,
  signerPubkey: SIGNER_PUBKEY
};

const SCENARIOS: Scenario[] = [
  // StakeManager writes
  {
    name: 'stakeManager.migrateDelegation',
    run: (w) => sm(w).migrateDelegation({ fromValidatorId: 1n, toValidatorId: 2n, amount: 3n })
  },
  {
    name: 'stakeManager.prepareMigrateDelegation',
    run: (w) =>
      sm(w).prepareMigrateDelegation({ fromValidatorId: 1n, toValidatorId: 2n, amount: 3n })
  },
  {
    name: 'stakeManager.restake',
    run: (w) => sm(w).restake({ validatorId: 1n, amount: 3n, stakeRewards: true })
  },
  {
    name: 'stakeManager.prepareRestake',
    run: (w) => sm(w).prepareRestake({ validatorId: 1n, amount: 3n, stakeRewards: true })
  },
  {
    name: 'stakeManager.withdrawValidatorRewards',
    run: (w) => sm(w).withdrawValidatorRewards({ validatorId: 1n })
  },
  {
    name: 'stakeManager.prepareWithdrawValidatorRewards',
    run: (w) => sm(w).prepareWithdrawValidatorRewards({ validatorId: 1n })
  },
  {
    name: 'stakeManager.topUpHeimdallFee',
    run: (w) => sm(w).topUpHeimdallFee({ user: USER, heimdallFee: 5n })
  },
  {
    name: 'stakeManager.prepareTopUpHeimdallFee',
    run: (w) => sm(w).prepareTopUpHeimdallFee({ user: USER, heimdallFee: 5n })
  },
  { name: 'stakeManager.unstake', run: (w) => sm(w).unstake({ validatorId: 1n }) },
  {
    name: 'stakeManager.unstake (every option)',
    run: (w) => sm(w).unstake({ validatorId: 1n }, { ...OPTIONS, gasLimit: undefined })
  },
  { name: 'stakeManager.prepareUnstake', run: (w) => sm(w).prepareUnstake({ validatorId: 1n }) },
  { name: 'stakeManager.claimUnstaked', run: (w) => sm(w).claimUnstaked({ validatorId: 1n }) },
  {
    name: 'stakeManager.prepareClaimUnstaked',
    run: (w) => sm(w).prepareClaimUnstaked({ validatorId: 1n })
  },
  { name: 'stakeManager.stakeForMatic', run: (w) => sm(w).stakeForMatic(STAKE_FOR) },
  { name: 'stakeManager.prepareStakeForMatic', run: (w) => sm(w).prepareStakeForMatic(STAKE_FOR) },
  { name: 'stakeManager.stakeFor', run: (w) => sm(w).stakeFor(STAKE_FOR) },
  { name: 'stakeManager.prepareStakeFor', run: (w) => sm(w).prepareStakeFor(STAKE_FOR) },
  {
    name: 'stakeManager.updateCommissionRate',
    run: (w) => sm(w).updateCommissionRate({ validatorId: 1n, commissionRate: 7n })
  },
  {
    name: 'stakeManager.prepareUpdateCommissionRate',
    run: (w) => sm(w).prepareUpdateCommissionRate({ validatorId: 1n, commissionRate: 7n })
  },
  {
    name: 'stakeManager.updateSigner',
    run: (w) => sm(w).updateSigner({ validatorId: 1n, signerPubkey: SIGNER_PUBKEY })
  },
  {
    name: 'stakeManager.prepareUpdateSigner',
    run: (w) => sm(w).prepareUpdateSigner({ validatorId: 1n, signerPubkey: SIGNER_PUBKEY })
  },
  // StakeManager reads
  { name: 'stakeManager.getValidator', run: (w) => sm(w).getValidator({ validatorId: 1n }) },
  {
    name: 'stakeManager.getValidator (pinned block)',
    run: (w) => sm(w).getValidator({ validatorId: 1n }, { blockTag: 'safe' })
  },
  {
    name: 'stakeManager.getValidatorContract',
    run: (w) => sm(w).getValidatorContract({ validatorId: 1n })
  },
  { name: 'stakeManager.getValidatorId', run: (w) => sm(w).getValidatorId({ user: USER }) },
  {
    name: 'stakeManager.getDelegatedAmount',
    run: (w) => sm(w).getDelegatedAmount({ validatorId: 1n })
  },
  {
    name: 'stakeManager.getValidatorStake',
    run: (w) => sm(w).getValidatorStake({ validatorId: 1n })
  },
  { name: 'stakeManager.getMinDeposit', run: (w) => sm(w).getMinDeposit() },
  { name: 'stakeManager.getMinHeimdallFee', run: (w) => sm(w).getMinHeimdallFee() },
  { name: 'stakeManager.getWithdrawalDelay', run: (w) => sm(w).getWithdrawalDelay() },
  { name: 'stakeManager.getCheckpointReward', run: (w) => sm(w).getCheckpointReward() },
  { name: 'stakeManager.isLocked', run: (w) => sm(w).isLocked() },
  { name: 'stakeManager.getCurrentEpoch', run: (w) => sm(w).getCurrentEpoch() },
  { name: 'stakeManager.getTotalStaked', run: (w) => sm(w).getTotalStaked() },
  // ValidatorShare writes
  {
    name: 'validatorShare.delegateMatic',
    run: (w) => share(w).delegateMatic({ amount: 5n, minSharesToMint: 4n })
  },
  {
    name: 'validatorShare.prepareDelegateMatic',
    run: (w) => share(w).prepareDelegateMatic({ amount: 5n, minSharesToMint: 4n })
  },
  {
    name: 'validatorShare.delegate',
    run: (w) => share(w).delegate({ amount: 5n, minSharesToMint: 4n })
  },
  {
    name: 'validatorShare.prepareDelegate',
    run: (w) => share(w).prepareDelegate({ amount: 5n, minSharesToMint: 4n })
  },
  {
    name: 'validatorShare.delegateWithPermit',
    run: (w) =>
      share(w).delegateWithPermit({
        amount: 5n,
        minSharesToMint: 4n,
        deadline: 1_900_000_000n,
        v: 27,
        r: R,
        s: S
      })
  },
  {
    name: 'validatorShare.prepareDelegateWithPermit',
    run: (w) =>
      share(w).prepareDelegateWithPermit({
        amount: 5n,
        minSharesToMint: 4n,
        deadline: 1_900_000_000n,
        v: 27,
        r: R,
        s: S
      })
  },
  { name: 'validatorShare.claimUndelegated', run: (w) => share(w).claimUndelegated({ nonce: 2n }) },
  {
    name: 'validatorShare.prepareClaimUndelegated',
    run: (w) => share(w).prepareClaimUndelegated({ nonce: 2n })
  },
  {
    name: 'validatorShare.undelegate',
    run: (w) => share(w).undelegate({ amount: 5n, maxSharesToBurn: 6n })
  },
  {
    name: 'validatorShare.prepareUndelegate',
    run: (w) => share(w).prepareUndelegate({ amount: 5n, maxSharesToBurn: 6n })
  },
  { name: 'validatorShare.restakeRewards', run: (w) => share(w).restakeRewards() },
  { name: 'validatorShare.prepareRestakeRewards', run: (w) => share(w).prepareRestakeRewards() },
  { name: 'validatorShare.withdrawRewards', run: (w) => share(w).withdrawRewards() },
  { name: 'validatorShare.prepareWithdrawRewards', run: (w) => share(w).prepareWithdrawRewards() },
  // ValidatorShare reads
  { name: 'validatorShare.getExchangeRate', run: (w) => share(w).getExchangeRate() },
  {
    name: 'validatorShare.getLiquidRewards',
    run: (w) => share(w).getLiquidRewards({ user: USER })
  },
  { name: 'validatorShare.getMinAmount', run: (w) => share(w).getMinAmount() },
  { name: 'validatorShare.getBalance', run: (w) => share(w).getBalance({ user: USER }) },
  { name: 'validatorShare.getTotalStake', run: (w) => share(w).getTotalStake({ user: USER }) },
  { name: 'validatorShare.getUnbond', run: (w) => share(w).getUnbond({ user: USER }) },
  {
    name: 'validatorShare.getUnbondNew',
    run: (w) => share(w).getUnbondNew({ user: USER, nonce: 2n })
  },
  { name: 'validatorShare.getUnbondNonce', run: (w) => share(w).getUnbondNonce({ user: USER }) },
  { name: 'validatorShare.getValidatorId', run: (w) => share(w).getValidatorId() },
  // Staking tokens
  ...(['matic', 'pol'] as const).flatMap((token): Scenario[] => [
    {
      name: `${token}.approveStakeManager`,
      run: (w) => w.staking[token].approveStakeManager({ amount: 5n })
    },
    {
      name: `${token}.approveStakeManager (every option)`,
      run: (w) => w.staking[token].approveStakeManager({ amount: 5n }, { ...OPTIONS, value: 1n })
    },
    {
      name: `${token}.prepareApproveStakeManager`,
      run: (w) => w.staking[token].prepareApproveStakeManager({ amount: 5n })
    },
    {
      name: `${token}.approveMaxForStakeManager`,
      run: (w) => w.staking[token].approveMaxForStakeManager()
    },
    {
      name: `${token}.prepareApproveMaxForStakeManager`,
      run: (w) => w.staking[token].prepareApproveMaxForStakeManager()
    },
    { name: `${token}.getBalance`, run: (w) => w.staking[token].getBalance({ user: USER }) },
    {
      name: `${token}.getAllowanceForStakeManager`,
      run: (w) => w.staking[token].getAllowanceForStakeManager({ owner: OTHER })
    }
  ]),
  { name: 'pol.getNonce', run: (w) => w.staking.pol.getNonce({ owner: USER }) },
  {
    name: 'pol.preparePermit',
    run: (w) => w.staking.pol.preparePermit({ owner: USER, value: 5n, deadline: 1_900_000_000n })
  }
];

const STAKE_MANAGER_WRITES = [
  'migrateDelegation',
  'restakePOL',
  'withdrawRewardsPOL',
  'topUpForFee',
  'unstakePOL',
  'unstakeClaimPOL',
  'stakeFor',
  'stakeForPOL',
  'updateCommissionRate',
  'updateSigner'
] as const;

const STAKE_MANAGER_READS = [
  'validators',
  'getValidatorContract',
  'getValidatorId',
  'delegatedAmount',
  'validatorStake',
  'minDeposit',
  'minHeimdallFee',
  'WITHDRAWAL_DELAY',
  'CHECKPOINT_REWARD',
  'locked',
  'currentEpoch',
  'currentValidatorSetTotalStake'
] as const;

const VALIDATOR_SHARE_WRITES = [
  'buyVoucher',
  'buyVoucherPOL',
  'buyVoucherWithPermit',
  'unstakeClaimTokens_newPOL',
  'sellVoucher_newPOL',
  'restakePOL',
  'withdrawRewardsPOL'
] as const;

const VALIDATOR_SHARE_READS = [
  'exchangeRate',
  'getLiquidRewards',
  'minAmount',
  'balanceOf',
  'getTotalStake',
  'unbonds',
  'unbonds_new',
  'unbondNonces',
  'validatorId'
] as const;

/** Every contract method the staking client calls, and how. */
const PAIRS: readonly CoveredPair[] = [
  ...STAKE_MANAGER_WRITES.map((m): CoveredPair => ['StakeManagerABI', m, WRITE]),
  ...STAKE_MANAGER_READS.map((m): CoveredPair => ['StakeManagerABI', m, READ]),
  ...VALIDATOR_SHARE_WRITES.map((m): CoveredPair => ['ValidatorShareABI', m, WRITE]),
  ...VALIDATOR_SHARE_READS.map((m): CoveredPair => ['ValidatorShareABI', m, READ]),
  ['PolTokenABI', 'approve', WRITE],
  ['PolTokenABI', 'allowance', READ],
  ['PolTokenABI', 'balanceOf', READ],
  ['PolTokenABI', 'nonces', READ],
  ['PolTokenABI', 'eip712Domain', READ]
];

let actual: Record<string, RequestRow[]> = {};
let fixture: Record<string, RequestRow[]> = {};

describe('staking contract requests', { timeout: 60_000 }, () => {
  afterEach(() => {
    __resetAddressCacheForTesting();
  });

  beforeAll(async () => {
    const collected: Record<string, RequestRow[]> = {};
    for (const scenario of SCENARIOS) {
      const w = await stakingWorld();
      await scenario.run(w);
      collected[scenario.name] = rowsOf(w.log);
    }
    actual = collected;
    fixture = loadFixture({ name: FIXTURE, actual });
  });

  it('has a scenario for every fixture entry and a fixture entry for every scenario', () => {
    expect(Object.keys(actual).sort()).deep.equals(Object.keys(fixture).sort());
  });

  it('records every scenario with at least one request', () => {
    for (const [name, rows] of Object.entries(actual)) {
      expect(rows.length, name).greaterThan(0);
    }
  });

  it('covers every contract method the staking client calls', () => {
    expect(uncoveredPairs({ pairs: PAIRS, fixture })).deep.equals([]);
  });

  it.each(SCENARIOS.map((s) => s.name))('%s sends the recorded requests', (name) => {
    expect(
      actual[name],
      `${name} (regenerate with ${WRITE_FIXTURES_FLAG}=1 on a clean base)`
    ).deep.equals(fixture[name]);
  });
});
