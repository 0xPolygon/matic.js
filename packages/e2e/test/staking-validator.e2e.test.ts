/**
 * Validator-owner staking writes on the devnet's validator 1, through all
 * three adapters, plus the validator writes that stay GATED.
 *
 * RUNS: `restake`, `withdrawValidatorRewards` and `updateCommissionRate`.
 * Each is `onlyStaker`: only the owner of the validator NFT may call it.
 * They sign with validator 1's owner key, which `scripts/up.ts` reads from
 * the enclave (see `readValidatorOwner` in `src/kurtosis.ts`). None of them
 * changes the validator set, but `restake` changes validator 1's stake, and
 * the devnet has only that one validator to produce blocks. So after each
 * write the test watches L2 for {@link LIVENESS_WINDOW_MS} and fails if
 * block production stalls. This file runs last, so a halt cannot fail the
 * files before it.
 *
 * The three adapter rows share one key, and so one nonce stream: they run
 * one after another, never concurrently.
 *
 * GATED, never run: `stakeFor` registers a second validator with no node
 * behind it. On a cold-start kurtosis-pos v1.4.8 devnet that halted block
 * production: heimdall's producer selection failed ("no candidates found"),
 * bor stopped about 60 s after `stakeFor` and did not recover in 6 minutes.
 * `stakeForMatic` is the same registration. `unstake` (and `claimUnstaked`
 * after it) would deactivate the only validator, and `updateSigner` would
 * rotate the key heimdall signs with; both stop the devnet, and a validator
 * the test owns instead needs `stakeFor`. `migrateDelegation` needs two
 * validators that accept delegation. These writes are covered by calldata
 * ground truth in `packages/maticjs/tests/unit/staking-calldata-ground-truth.test.ts`;
 * the per-write record is `STAKING-COVERAGE.md`.
 */
import { createPublicClient, http, parseEther, parseEventLogs } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Hex } from '@polygonlabs/maticjs';
import type { StakingClient as StakingClientType } from '@polygonlabs/maticjs/staking';

import { StakingClient } from '@polygonlabs/maticjs/staking';

import type { AdapterRow } from '../src/adapters.ts';

import { buildAdaptersForKey, devnetChains, stakingTxOptions } from '../src/adapters.ts';
import { dummyErc721Abi, erc20Abi, stakeManagerAbi, stakingInfoAbi } from '../src/devnet-abis.ts';
import { getTestEnv } from '../src/test-env.ts';
import { pollUntil } from '../src/wait.ts';

const VALIDATOR_ID = 1n;
const RESTAKE = parseEther('1');
/** How long L2 must keep producing blocks after each write. */
const LIVENESS_WINDOW_MS = 60_000;
/** The longest gap between two new L2 blocks that still counts as live. Devnet blocks are 1 to 2 s. */
const MAX_STALL_MS = 20_000;
const LIVENESS_POLL_MS = 5_000;
const EPOCH_WAIT_MS = 300_000;
const POLL_MS = 2_000;
/** Commission rates the viem and ethers v5 rows set; the ethers v6 row restores the original. */
const COMMISSION_RATES = [5n, 6n] as const;

const log = (line: string) => process.stderr.write(`[staking-validator] ${line}\n`);

const GATED_REASON =
  'stakeFor adds a node-less validator and halts the single-validator devnet; ' +
  'unstake and updateSigner would stop its only validator';

function readers() {
  const { l1, l2 } = devnetChains();
  return {
    l1: createPublicClient({ chain: l1, transport: http() }),
    l2: createPublicClient({ chain: l2, transport: http() })
  };
}

/** `validators(1)` at a block, read with plain viem rather than the SDK. */
function validatorAt(blockNumber?: bigint) {
  return readers().l1.readContract({
    address: getTestEnv().E2E_ADDRESSES_JSON.addresses.StakeManager,
    abi: stakeManagerAbi,
    functionName: 'validators',
    args: [VALIDATOR_ID],
    blockNumber
  });
}

function polBalanceAt({ owner, blockNumber }: { owner: Hex; blockNumber: bigint }) {
  return readers().l1.readContract({
    address: getTestEnv().E2E_ADDRESSES_JSON.addresses.PolToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
    blockNumber
  });
}

/**
 * Fail unless L2 keeps producing blocks for {@link LIVENESS_WINDOW_MS}, with
 * no gap longer than {@link MAX_STALL_MS} between new blocks.
 */
async function expectL2Live(label: string): Promise<void> {
  const { l2 } = readers();
  const start = await l2.getBlockNumber({ cacheTime: 0 });
  let last = start;
  let lastAdvanceAt = Date.now();
  const endAt = Date.now() + LIVENESS_WINDOW_MS;
  while (Date.now() < endAt) {
    await new Promise((resolve) => setTimeout(resolve, LIVENESS_POLL_MS));
    const height = await l2.getBlockNumber({ cacheTime: 0 });
    if (height > last) {
      last = height;
      lastAdvanceAt = Date.now();
    } else if (Date.now() - lastAdvanceAt > MAX_STALL_MS) {
      expect.fail(
        `${label}: L2 stalled at block ${last.toString()} for ${String(Date.now() - lastAdvanceAt)} ms`
      );
    }
  }
  log(
    `${label}: L2 live, block ${start.toString()} -> ${last.toString()} in ${String(LIVENESS_WINDOW_MS)} ms`
  );
}

/** Send a write, wait for it, and fail with the step name if it did not succeed. */
async function land(
  label: string,
  send: () => Promise<{
    hash: Hex;
    confirmed: () => Promise<{ status: string; blockNumber: bigint }>;
  }>
): Promise<{ hash: Hex; blockNumber: bigint }> {
  const tx = await send();
  const receipt = await tx.confirmed();
  expect(receipt, `${label} (${tx.hash})`).property('status').equals('success');
  log(`${label}: ${tx.hash}`);
  return { hash: tx.hash, blockNumber: receipt.blockNumber };
}

async function stakingClientFor(row: AdapterRow): Promise<StakingClientType> {
  const { StakeManager, MaticToken, PolToken } = getTestEnv().E2E_ADDRESSES_JSON.addresses;
  return StakingClient.init({
    network: 'amoy',
    parent: row.parent,
    addresses: { StakeManager, MaticToken, PolToken }
  });
}

/** Wait until StakeManager's epoch is past `epoch`, so a checkpoint has landed since. */
async function waitForEpochAfter({
  staking,
  epoch,
  label
}: {
  staking: StakingClientType;
  epoch: bigint;
  label: string;
}): Promise<void> {
  await pollUntil({
    label: `${label}: epoch > ${epoch.toString()}`,
    pollMs: POLL_MS,
    timeoutMs: EPOCH_WAIT_MS,
    fn: async () => ((await staking.stakeManager.getCurrentEpoch()) > epoch ? true : undefined)
  });
}

const validatorOwner = getTestEnv().E2E_ADDRESSES_JSON.validatorOwner;

describe.skipIf(!validatorOwner)(
  'validator-owner staking writes on validator 1 (devnet)',
  { timeout: 900_000 },
  () => {
    const owner = validatorOwner?.address ?? '0x';
    const rows = validatorOwner
      ? buildAdaptersForKey({ privateKey: validatorOwner.privateKey })
      : [];

    beforeAll(async () => {
      // The key read from the enclave must own validator 1's NFT, checked
      // with plain viem and through the SDK.
      const { l1 } = readers();
      const nft = await l1.readContract({
        address: getTestEnv().E2E_ADDRESSES_JSON.addresses.StakeManager,
        abi: stakeManagerAbi,
        functionName: 'NFTContract'
      });
      expect(
        await l1.readContract({
          address: nft,
          abi: dummyErc721Abi,
          functionName: 'ownerOf',
          args: [VALIDATOR_ID]
        })
      ).equals(owner);
      for (const row of rows) {
        const staking = await stakingClientFor(row);
        expect(await staking.stakeManager.getValidatorId({ user: owner })).equals(VALIDATOR_ID);
      }
    });

    it('stakeManager.restake adds the restaked POL to validator 1, and L2 stays live', async () => {
      for (const row of rows) {
        const staking = await stakingClientFor(row);
        await land(`${row.name} pol.approveStakeManager`, () =>
          staking.pol.approveStakeManager({ amount: RESTAKE }, stakingTxOptions())
        );
        const { blockNumber } = await land(`${row.name} stakeManager.restake`, () =>
          staking.stakeManager.restake(
            { validatorId: VALIDATOR_ID, amount: RESTAKE, stakeRewards: false },
            stakingTxOptions()
          )
        );
        const [before, after] = await Promise.all([
          validatorAt(blockNumber - 1n),
          validatorAt(blockNumber)
        ]);
        expect(after[0] - before[0]).equals(RESTAKE);
        const [polBefore, polAfter] = await Promise.all([
          polBalanceAt({ owner, blockNumber: blockNumber - 1n }),
          polBalanceAt({ owner, blockNumber })
        ]);
        expect(polBefore - polAfter).equals(RESTAKE);
        // The SDK's own read agrees with the plain one.
        expect(
          (await staking.stakeManager.getValidator({ validatorId: VALIDATOR_ID })).amount
        ).equals((await validatorAt())[0]);
      }
      await expectL2Live('restake');
    });

    it('stakeManager.withdrawValidatorRewards pays validator 1 its rewards, and L2 stays live', async () => {
      let lastEpoch = 0n;
      for (const row of rows) {
        const staking = await stakingClientFor(row);
        // Rewards accrue per checkpoint: wait for one since the last withdrawal.
        await waitForEpochAfter({ staking, epoch: lastEpoch, label: `${row.name} withdraw` });
        const { hash, blockNumber } = await land(
          `${row.name} stakeManager.withdrawValidatorRewards`,
          () =>
            staking.stakeManager.withdrawValidatorRewards(
              { validatorId: VALIDATOR_ID },
              stakingTxOptions()
            )
        );
        lastEpoch = await staking.stakeManager.getCurrentEpoch();

        const claims = parseEventLogs({
          abi: stakingInfoAbi,
          eventName: 'ClaimRewards',
          args: { validatorId: VALIDATOR_ID },
          logs: (await readers().l1.getTransactionReceipt({ hash })).logs
        });
        expect(claims).length(1);
        const amount = claims[0]?.args.amount ?? 0n;
        if (amount <= 0n) expect.fail(`${row.name}: ClaimRewards paid ${amount.toString()}`);
        const [polBefore, polAfter] = await Promise.all([
          polBalanceAt({ owner, blockNumber: blockNumber - 1n }),
          polBalanceAt({ owner, blockNumber })
        ]);
        expect(polAfter - polBefore).equals(amount);
        // The contract resets the stored reward to its 1-wei initial value.
        expect((await validatorAt(blockNumber))[1]).equals(1n);
        log(`${row.name} withdrawValidatorRewards paid ${amount.toString()}`);
      }
      await expectL2Live('withdrawValidatorRewards');
    });

    it('stakeManager.updateCommissionRate sets validator 1 commission, and L2 stays live', async () => {
      const original = (await validatorAt())[8];
      const targets = [...COMMISSION_RATES, original];
      for (const [index, row] of rows.entries()) {
        const rate = targets[index] ?? original;
        const staking = await stakingClientFor(row);
        // The contract allows one change per WITHDRAWAL_DELAY epochs.
        const delay = await staking.stakeManager.getWithdrawalDelay();
        const lastUpdate = (await validatorAt())[9];
        if (lastUpdate !== 0n) {
          await waitForEpochAfter({
            staking,
            epoch: lastUpdate + delay - 1n,
            label: `${row.name} commission cooldown`
          });
        }
        const { blockNumber } = await land(
          `${row.name} stakeManager.updateCommissionRate(${rate.toString()})`,
          () =>
            staking.stakeManager.updateCommissionRate(
              { validatorId: VALIDATOR_ID, commissionRate: rate },
              stakingTxOptions()
            )
        );
        const after = await validatorAt(blockNumber);
        expect(after[8]).equals(rate);
        expect(
          (await staking.stakeManager.getValidator({ validatorId: VALIDATOR_ID })).commissionRate
        ).equals(rate);
      }
      expect((await validatorAt())[8]).equals(original);
      await expectL2Live('updateCommissionRate');
    });
  }
);

describe.skip(`validator staking writes — GATED: ${GATED_REASON}`, () => {
  it('stakeFor, stakeForMatic, unstake, claimUnstaked, updateSigner, migrateDelegation', () => {
    expect.fail(`gated: ${GATED_REASON}; see STAKING-COVERAGE.md`);
  });
});
