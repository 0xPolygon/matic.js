/**
 * Validator-owner staking writes through all three adapters, on a devnet
 * with two node-backed validators (see `kurtosis-params.yml`).
 *
 * Validator 1: `restake`, `withdrawValidatorRewards` and
 * `updateCommissionRate`. Each is `onlyStaker`: only the owner of the
 * validator NFT may call it. They sign with validator 1's owner key, which
 * `scripts/up.ts` reads from the enclave (see `readValidatorOwner` in
 * `src/kurtosis.ts`). None of them changes the validator set.
 *
 * Node-less validators the test registers itself: `stakeFor` (POL),
 * `stakeForMatic`, `migrateDelegation` between two of them,
 * `topUpHeimdallFee` as the new owner, `unstake` and `claimUnstaked`. Each adapter row stakes a validator with a key derived
 * fresh for this run, with no node behind it, and every later write on that
 * validator signs with that key. A second validator is what makes this safe:
 * on a one-validator devnet a node-less registration halted block
 * production. Validators 1 and 2 are never the target of these writes.
 * Unstaking a node-backed validator froze checkpoints for good on a
 * two-validator devnet, because L1 keeps counting its stake until its exit
 * epoch and the survivor alone cannot reach two thirds of it.
 *
 * Every write group is followed by a liveness watch: L2 must advance while
 * the writes land, keep advancing for {@link LIVENESS_WINDOW_MS}, and
 * heimdall must acknowledge a new checkpoint after them. A stalled devnet
 * fails the test with the stalled height or checkpoint count, never hangs.
 * This file runs last, so a halt cannot fail the files before it.
 *
 * GATED, never run: `updateSigner`, for the contract rule in
 * {@link GATED_REASON}. Calldata ground truth in
 * `packages/maticjs/tests/unit/staking-calldata-ground-truth.test.ts`
 * covers it; the per-write record is `STAKING-COVERAGE.md`.
 */
import type { PublicClient } from 'viem';

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  toHex
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Hex, PreparedTx, TxOptions, TxResult } from '@polygonlabs/maticjs';
import type { StakingClient as StakingClientType } from '@polygonlabs/maticjs/staking';

import { StakingClient } from '@polygonlabs/maticjs/staking';

import type { AdapterRow } from '../src/adapters.ts';

import { buildAdaptersForKey, devnetChains, stakingTxOptions } from '../src/adapters.ts';
import { dummyErc721Abi, erc20Abi, stakeManagerAbi, stakingInfoAbi } from '../src/devnet-abis.ts';
import { getTestEnv } from '../src/test-env.ts';
import { pollUntil } from '../src/wait.ts';

const VALIDATOR_ID = 1n;
/** Validators 1 and 2 run the devnet's nodes. No test write may unstake or re-key them. */
const NODE_BACKED_VALIDATORS = 2n;
const RESTAKE = parseEther('1');
/** How long L2 must keep producing blocks after each group of writes. */
const LIVENESS_WINDOW_MS = 60_000;
/** The longest gap between two new L2 blocks that still counts as live. Devnet blocks are 1 to 2 s. */
const MAX_STALL_MS = 20_000;
/**
 * How long after a group of writes heimdall may take to acknowledge a new
 * checkpoint. The devnet acknowledges one about every 25 s.
 */
const CHECKPOINT_WAIT_MS = 180_000;
const LIVENESS_POLL_MS = 5_000;
const EPOCH_WAIT_MS = 300_000;
const POLL_MS = 2_000;
/** Commission rates the viem and ethers v5 rows set; the ethers v6 row restores the original. */
const COMMISSION_RATES = [5n, 6n] as const;
/** ETH each fresh node-less validator key gets for gas. */
const NODELESS_GAS = parseEther('1');
/** POL each POL validator's owner delegates to its own validator, then migrates. */
const MIGRATED = parseEther('1');
/**
 * StakeManager's `migrateDelegation` moves stake only to a validator id
 * above this ("allow to move to any non-foundation node").
 */
const LAST_FOUNDATION_VALIDATOR = 7n;
/** Validator status `Active` in StakeManager's `Status` enum. */
const STATUS_ACTIVE = 1;
/** Validator status `Unstaked` in StakeManager's `Status` enum. */
const STATUS_UNSTAKED = 3;
/**
 * Mixed into the node-less keys, so each run registers validators with
 * signers no earlier run on the same devnet has used.
 */
const RUN_ID = Date.now().toString();

const log = (line: string) => process.stderr.write(`[staking-validator] ${line}\n`);

/**
 * The SDK's fixed `unstake` gas headroom (`UNSTAKE_GAS_HEADROOM` in
 * `packages/maticjs/src/staking/stake-manager.ts`, deliberately not a public
 * export). It covers the epoch race: `unstake` adds the validator's stake to
 * `validatorStateChanges[currentEpoch + 1]`, and if a checkpoint advances the
 * epoch between the estimate and inclusion, two fresh storage slots are
 * written from zero (195,840 more gas measured here, on an Amsterdam L1). The
 * gate sends with the SDK's default options and asserts that headroom is on
 * the transaction, so a regression in the SDK's margin fails here.
 */
const SDK_UNSTAKE_GAS_HEADROOM = 250_000n;

/** The SDK's default gas multiplier, `1.15`, truncated the way `ContractCaller` does. */
const sdkGasLimit = ({ estimate, headroom }: { estimate: bigint; headroom: bigint }): bigint =>
  BigInt(Math.trunc(Number(estimate) * 1.15)) + headroom;

/**
 * Slack for the SDK's own estimate differing from this test's, which is taken
 * a few hundred milliseconds earlier. 5,000 gas is under 2% of a ~300,000-gas
 * unstake: enough for a warm/cold access shift, far below the 250,000
 * headroom a regression would drop.
 */
const ESTIMATE_DRIFT_TOLERANCE = 5_000n;

const GATED_REASON =
  'updateSigner reverts "Not allowed" until signerUpdateLimit (100 epochs, about 40 min on the ' +
  'devnet) after the stake';

let cachedReaders: { l1: PublicClient; l2: PublicClient } | undefined;

function readers(): { l1: PublicClient; l2: PublicClient } {
  if (!cachedReaders) {
    const { l1, l2 } = devnetChains();
    cachedReaders = {
      l1: createPublicClient({ chain: l1, transport: http() }),
      l2: createPublicClient({ chain: l2, transport: http() })
    };
  }
  return cachedReaders;
}

/** `validators(id)` at a block, read with plain viem rather than the SDK. */
function validatorAt({
  validatorId = VALIDATOR_ID,
  blockNumber
}: { validatorId?: bigint; blockNumber?: bigint } = {}) {
  return readers().l1.readContract({
    address: getTestEnv().E2E_ADDRESSES_JSON.addresses.StakeManager,
    abi: stakeManagerAbi,
    functionName: 'validators',
    args: [validatorId],
    blockNumber
  });
}

function tokenBalanceAt({
  token,
  owner,
  blockNumber
}: {
  token: Hex;
  owner: Hex;
  blockNumber: bigint;
}) {
  return readers().l1.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
    blockNumber
  });
}

function polBalanceAt({ owner, blockNumber }: { owner: Hex; blockNumber: bigint }) {
  return tokenBalanceAt({
    token: getTestEnv().E2E_ADDRESSES_JSON.addresses.PolToken,
    owner,
    blockNumber
  });
}

const CheckpointCountSchema = z.object({ ack_count: z.coerce.number().int() });

/** Checkpoints heimdall has acknowledged so far. */
async function checkpointAcks(): Promise<number> {
  const response = await fetch(`${getTestEnv().E2E_HEIMDALL_REST_URL}/checkpoints/count`);
  if (!response.ok) {
    expect.fail(`heimdall /checkpoints/count answered HTTP ${String(response.status)}`);
  }
  return CheckpointCountSchema.parse(await response.json()).ack_count;
}

interface LivenessMark {
  block: bigint;
  acks: number;
}

async function markLiveness(): Promise<LivenessMark> {
  const [block, acks] = await Promise.all([
    readers().l2.getBlockNumber({ cacheTime: 0 }),
    checkpointAcks()
  ]);
  return { block, acks };
}

/**
 * Fail unless the devnet stayed live through a group of writes and after
 * it. `before` is the mark taken before the first write. L2 must have
 * advanced while the writes landed, must keep producing blocks for
 * {@link LIVENESS_WINDOW_MS} with no gap over {@link MAX_STALL_MS}, and
 * heimdall must acknowledge a checkpoint after the writes within
 * {@link CHECKPOINT_WAIT_MS}. Block production alone is not enough: an
 * unstaked node-backed validator left blocks flowing while every checkpoint
 * reverted.
 */
async function expectDevnetLive({
  label,
  before
}: {
  label: string;
  before: LivenessMark;
}): Promise<void> {
  const { l2 } = readers();
  const afterWrites = await markLiveness();
  if (afterWrites.block <= before.block) {
    expect.fail(
      `${label}: L2 did not advance while the writes landed (block ${before.block.toString()})`
    );
  }
  const startedAt = Date.now();
  let last = afterWrites.block;
  let lastAdvanceAt = startedAt;
  let acks = afterWrites.acks;
  while (Date.now() - startedAt < LIVENESS_WINDOW_MS || acks <= afterWrites.acks) {
    if (Date.now() - startedAt > CHECKPOINT_WAIT_MS) {
      expect.fail(
        `${label}: no checkpoint acknowledged in ${String(CHECKPOINT_WAIT_MS)} ms after the ` +
          `writes (heimdall ack count stayed at ${String(afterWrites.acks)})`
      );
    }
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
    acks = await checkpointAcks();
  }
  log(
    `${label}: devnet live. Before the writes: block ${before.block.toString()}, ` +
      `${String(before.acks)} acks. After them: block ${afterWrites.block.toString()}, ` +
      `${String(afterWrites.acks)} acks. End of watch (${String(Date.now() - startedAt)} ms): ` +
      `block ${last.toString()}, ${String(acks)} acks.`
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

/**
 * {@link land} for a StakeManager or ValidatorShare write, logging its gas
 * evidence: the estimate taken just before sending, the gas limit the
 * transaction carried, the gas it used, and its block and position. A
 * revert from gas is otherwise indistinguishable from a logic revert once
 * the devnet is gone. Sends with the SDK's default options, so the gas limit
 * on chain is the SDK's own. `naturalRace` is evidence only: whether the
 * epoch changed between this estimate and the inclusion block.
 */
async function landStakingWrite({
  label,
  from,
  prepare,
  send
}: {
  label: string;
  from: Hex;
  prepare: (options: TxOptions) => Promise<PreparedTx>;
  send: (options: TxOptions) => Promise<TxResult>;
}): Promise<{ hash: Hex; blockNumber: bigint; gasUsed: bigint; estimate: bigint; gasLimit: bigint }> {
  const { l1 } = readers();
  const stakeManager = getTestEnv().E2E_ADDRESSES_JSON.addresses.StakeManager;
  const estimateBlock = await l1.getBlockNumber();
  const epochAtEstimate = await l1.readContract({
    address: stakeManager,
    abi: stakeManagerAbi,
    functionName: 'currentEpoch',
    blockNumber: estimateBlock
  });
  const prepared = await prepare(stakingTxOptions());
  const estimate = await l1.estimateGas({
    account: from,
    to: prepared.to,
    data: prepared.data,
    value: prepared.value
  });
  const tx = await send(stakingTxOptions());
  const [sent, mined] = await Promise.all([
    l1.getTransaction({ hash: tx.hash }),
    l1.waitForTransactionReceipt({ hash: tx.hash, timeout: 120_000 })
  ]);
  const epochAtInclusion = await l1.readContract({
    address: stakeManager,
    abi: stakeManagerAbi,
    functionName: 'currentEpoch',
    blockNumber: mined.blockNumber
  });
  log(
    `${label} gas: ${JSON.stringify({
      estimate: estimate.toString(),
      gasLimit: sent.gas.toString(),
      gasUsed: mined.gasUsed.toString(),
      status: mined.status,
      blockNumber: mined.blockNumber.toString(),
      txIndex: mined.transactionIndex,
      naturalRace: epochAtInclusion !== epochAtEstimate
    })}`
  );
  const receipt = await tx.confirmed();
  expect(receipt, `${label} (${tx.hash})`).property('status').equals('success');
  log(`${label}: ${tx.hash}`);
  return {
    hash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: mined.gasUsed,
    estimate,
    gasLimit: sent.gas
  };
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

async function receiptLogs(hash: Hex) {
  return (await readers().l1.getTransactionReceipt({ hash })).logs;
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

    it('stakeManager.restake adds the restaked POL to validator 1, and the devnet stays live', async () => {
      const before = await markLiveness();
      for (const row of rows) {
        const staking = await stakingClientFor(row);
        await land(`${row.name} pol.approveStakeManager`, () =>
          staking.pol.approveStakeManager({ amount: RESTAKE }, stakingTxOptions())
        );
        const restakeParams = { validatorId: VALIDATOR_ID, amount: RESTAKE, stakeRewards: false };
        const { blockNumber } = await landStakingWrite({
          label: `${row.name} stakeManager.restake`,
          from: owner,
          prepare: (options) => staking.stakeManager.prepareRestake(restakeParams, options),
          send: (options) => staking.stakeManager.restake(restakeParams, options)
        });
        const [validatorBefore, validatorAfter] = await Promise.all([
          validatorAt({ blockNumber: blockNumber - 1n }),
          validatorAt({ blockNumber })
        ]);
        expect(validatorAfter[0] - validatorBefore[0]).equals(RESTAKE);
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
      await expectDevnetLive({ label: 'restake', before });
    });

    it('stakeManager.withdrawValidatorRewards pays validator 1 its rewards, and the devnet stays live', async () => {
      const before = await markLiveness();
      let lastEpoch = 0n;
      for (const row of rows) {
        const staking = await stakingClientFor(row);
        // Rewards accrue per checkpoint: wait for one since the last withdrawal.
        await waitForEpochAfter({ staking, epoch: lastEpoch, label: `${row.name} withdraw` });
        const { hash, blockNumber } = await landStakingWrite({
          label: `${row.name} stakeManager.withdrawValidatorRewards`,
          from: owner,
          prepare: (options) =>
            staking.stakeManager.prepareWithdrawValidatorRewards(
              { validatorId: VALIDATOR_ID },
              options
            ),
          send: (options) =>
            staking.stakeManager.withdrawValidatorRewards({ validatorId: VALIDATOR_ID }, options)
        });
        lastEpoch = await staking.stakeManager.getCurrentEpoch();

        const claims = parseEventLogs({
          abi: stakingInfoAbi,
          eventName: 'ClaimRewards',
          args: { validatorId: VALIDATOR_ID },
          logs: await receiptLogs(hash)
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
        expect((await validatorAt({ blockNumber }))[1]).equals(1n);
        log(`${row.name} withdrawValidatorRewards paid ${amount.toString()}`);
      }
      await expectDevnetLive({ label: 'withdrawValidatorRewards', before });
    });

    it('stakeManager.updateCommissionRate sets validator 1 commission, and the devnet stays live', async () => {
      const before = await markLiveness();
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
        const commissionParams = { validatorId: VALIDATOR_ID, commissionRate: rate };
        const { blockNumber } = await landStakingWrite({
          label: `${row.name} stakeManager.updateCommissionRate(${rate.toString()})`,
          from: owner,
          prepare: (options) =>
            staking.stakeManager.prepareUpdateCommissionRate(commissionParams, options),
          send: (options) => staking.stakeManager.updateCommissionRate(commissionParams, options)
        });
        const after = await validatorAt({ blockNumber });
        expect(after[8]).equals(rate);
        expect(
          (await staking.stakeManager.getValidator({ validatorId: VALIDATOR_ID })).commissionRate
        ).equals(rate);
      }
      expect((await validatorAt())[8]).equals(original);
      await expectDevnetLive({ label: 'updateCommissionRate', before });
    });
  }
);

type StakeVariant = 'pol' | 'matic';

/** A validator this file registers, with no node behind it, and the key that owns and signs for it. */
interface NodelessValidator {
  label: string;
  variant: StakeVariant;
  row: AdapterRow;
  owner: Hex;
  /** The uncompressed secp256k1 public key without its `04` prefix, as `stakeFor` takes it. */
  signerPubkey: Hex;
  validatorId?: bigint;
  stake?: bigint;
}

function nodelessValidator({
  variant,
  adapterIndex
}: {
  variant: StakeVariant;
  adapterIndex: number;
}): NodelessValidator {
  const privateKey = keccak256(
    toHex(`maticjs-e2e:nodeless-validator:${variant}:${String(adapterIndex)}:${RUN_ID}`)
  );
  const account = privateKeyToAccount(privateKey);
  const row = buildAdaptersForKey({ privateKey })[adapterIndex];
  if (!row) throw new Error(`no adapter row ${String(adapterIndex)}`);
  return {
    label: `${row.name} ${variant}`,
    variant,
    row,
    owner: account.address,
    signerPubkey: `0x${account.publicKey.slice(4)}`
  };
}

/**
 * Refuse any owner write aimed at a node-backed validator. Unstaking one
 * (or rotating its signer) would stop checkpoints for the rest of the run.
 */
function nodelessIdOf(validator: NodelessValidator): bigint {
  const id = validator.validatorId;
  if (id === undefined) expect.fail(`${validator.label}: was never registered`);
  if (id <= NODE_BACKED_VALIDATORS) {
    expect.fail(
      `${validator.label}: refusing an owner write on node-backed validator ${String(id)}`
    );
  }
  return id;
}

describe.skipIf(!validatorOwner)(
  'validator lifecycle on node-less validators the test registers (devnet)',
  { timeout: 900_000 },
  () => {
    const adapterIndexes = [0, 1, 2];
    const validators = (['pol', 'matic'] as const).flatMap((variant) =>
      adapterIndexes.map((adapterIndex) => nodelessValidator({ variant, adapterIndex }))
    );
    const ofVariant = (variant: StakeVariant) => validators.filter((v) => v.variant === variant);
    let minDeposit = 0n;
    let minHeimdallFee = 0n;

    beforeAll(async () => {
      const { l1 } = readers();
      const { addresses, admin } = getTestEnv().E2E_ADDRESSES_JSON;

      // Without a second node-backed validator, a node-less registration
      // halts the devnet; fail here instead of stalling every write after it.
      for (const id of [1n, 2n]) {
        const validator = await validatorAt({ validatorId: id });
        if (validator[7] !== STATUS_ACTIVE || validator[3] !== 0n) {
          expect.fail(
            `validator ${String(id)} is not active: this file needs the two-validator devnet ` +
              'of kurtosis-params.yml'
          );
        }
      }
      const [threshold, setSize] = await Promise.all([
        l1.readContract({
          address: addresses.StakeManager,
          abi: stakeManagerAbi,
          functionName: 'validatorThreshold'
        }),
        l1.readContract({
          address: addresses.StakeManager,
          abi: stakeManagerAbi,
          functionName: 'currentValidatorSetSize'
        })
      ]);
      if (threshold - setSize < BigInt(validators.length)) {
        expect.fail(
          `StakeManager has ${(threshold - setSize).toString()} free validator slots ` +
            `(threshold ${threshold.toString()}, ${setSize.toString()} staked); ` +
            `this file registers ${String(validators.length)}`
        );
      }

      const staking = await stakingClientFor(validators[0]?.row ?? expect.fail('no rows'));
      [minDeposit, minHeimdallFee] = await Promise.all([
        staking.stakeManager.getMinDeposit(),
        staking.stakeManager.getMinHeimdallFee()
      ]);

      // Fund the fresh keys from the admin with plain viem, one nonce stream.
      const { l1: l1Chain } = devnetChains();
      const adminWallet = createWalletClient({
        account: privateKeyToAccount(admin.privateKey),
        chain: l1Chain,
        transport: http()
      });
      let nonce = await l1.getTransactionCount({
        address: adminWallet.account.address,
        blockTag: 'pending'
      });
      const hashes: Hex[] = [];
      for (const validator of validators) {
        hashes.push(
          await adminWallet.sendTransaction({
            to: validator.owner,
            value: NODELESS_GAS,
            nonce: nonce++
          })
        );
        const stakeToken = validator.variant === 'pol' ? addresses.PolToken : addresses.MaticToken;
        // POL validators also top up their own fee once more and delegate MIGRATED.
        const stakeCost =
          minDeposit +
          minHeimdallFee +
          (validator.variant === 'pol' ? minHeimdallFee + MIGRATED : 0n);
        hashes.push(
          await adminWallet.writeContract({
            address: stakeToken,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [validator.owner, stakeCost],
            nonce: nonce++
          })
        );
      }
      const receipts = await Promise.all(
        hashes.map((hash) => l1.waitForTransactionReceipt({ hash, timeout: 120_000 }))
      );
      expect(receipts.filter((r) => r.status !== 'success')).length(0);
    });

    async function stakeEach(variant: StakeVariant): Promise<void> {
      const before = await markLiveness();
      for (const validator of ofVariant(variant)) {
        const staking = await stakingClientFor(validator.row);
        const token = variant === 'pol' ? staking.pol : staking.matic;
        const { PolToken, MaticToken } = getTestEnv().E2E_ADDRESSES_JSON.addresses;
        const tokenAddress = variant === 'pol' ? PolToken : MaticToken;
        const amount = minDeposit;
        await land(`${validator.label} approveStakeManager`, () =>
          token.approveStakeManager({ amount: amount + minHeimdallFee }, stakingTxOptions())
        );
        const params = {
          user: validator.owner,
          amount,
          heimdallFee: minHeimdallFee,
          acceptDelegation: true,
          signerPubkey: validator.signerPubkey
        };
        const { hash, blockNumber } = await landStakingWrite({
          label: `${validator.label} stakeManager.${variant === 'pol' ? 'stakeFor' : 'stakeForMatic'}`,
          from: validator.owner,
          prepare: (options) =>
            variant === 'pol'
              ? staking.stakeManager.prepareStakeFor(params, options)
              : staking.stakeManager.prepareStakeForMatic(params, options),
          send: (options) =>
            variant === 'pol'
              ? staking.stakeManager.stakeFor(params, options)
              : staking.stakeManager.stakeForMatic(params, options)
        });

        const staked = parseEventLogs({
          abi: stakingInfoAbi,
          eventName: 'Staked',
          logs: await receiptLogs(hash)
        });
        expect(staked).length(1);
        const validatorId = staked[0]?.args.validatorId ?? 0n;
        validator.validatorId = validatorId;
        validator.stake = amount;
        nodelessIdOf(validator);
        expect(staked[0]?.args.signer).equals(validator.owner);
        expect(await staking.stakeManager.getValidatorId({ user: validator.owner })).equals(
          validatorId
        );
        const onChain = await validatorAt({ validatorId, blockNumber });
        expect(onChain[0]).equals(amount);
        expect(onChain[5]).equals(validator.owner);
        expect(onChain[7]).equals(STATUS_ACTIVE);
        // acceptDelegation: true deploys the validator's ValidatorShare.
        expect(onChain[6]).not.equals('0x0000000000000000000000000000000000000000');
        // The owner paid stake plus fee, in the token of the variant.
        const [paidBefore, paidAfter] = await Promise.all([
          tokenBalanceAt({
            token: tokenAddress,
            owner: validator.owner,
            blockNumber: blockNumber - 1n
          }),
          tokenBalanceAt({ token: tokenAddress, owner: validator.owner, blockNumber })
        ]);
        expect(paidBefore - paidAfter).equals(amount + minHeimdallFee);
        log(`${validator.label}: registered node-less validator ${validatorId.toString()}`);
      }
      await expectDevnetLive({
        label: `${variant === 'pol' ? 'stakeFor' : 'stakeForMatic'}`,
        before
      });
    }

    it('stakeManager.stakeFor registers a node-less validator in POL per adapter, and the devnet stays live', async () => {
      await stakeEach('pol');
    });

    it('stakeManager.stakeForMatic registers a node-less validator in MATIC per adapter, and the devnet stays live', async () => {
      await stakeEach('matic');
    });

    it('stakeManager.migrateDelegation moves a delegation between two node-less validators, and the devnet stays live', async () => {
      // The destination must be above the foundation ids. On a fresh devnet
      // the test's validators are 3 to 8, so only the last one qualifies.
      const destination = validators
        .filter((v) => (v.validatorId ?? 0n) > LAST_FOUNDATION_VALIDATOR)
        .at(-1);
      if (!destination) {
        expect.fail(
          `no node-less validator above id ${LAST_FOUNDATION_VALIDATOR.toString()} to migrate to`
        );
      }
      const toValidatorId = nodelessIdOf(destination);
      const before = await markLiveness();
      for (const validator of ofVariant('pol')) {
        const fromValidatorId = nodelessIdOf(validator);
        const staking = await stakingClientFor(validator.row);
        const share = staking.validatorShare(
          await staking.stakeManager.getValidatorContract({ validatorId: fromValidatorId })
        );
        await land(`${validator.label} pol.approveStakeManager (delegation)`, () =>
          staking.pol.approveStakeManager({ amount: MIGRATED }, stakingTxOptions())
        );
        const delegateParams = { amount: MIGRATED, minSharesToMint: 0n };
        await landStakingWrite({
          label: `${validator.label} validatorShare.delegate`,
          from: validator.owner,
          prepare: (options) => share.prepareDelegate(delegateParams, options),
          send: (options) => share.delegate(delegateParams, options)
        });
        const migrateParams = { fromValidatorId, toValidatorId, amount: MIGRATED };
        const { blockNumber } = await landStakingWrite({
          label: `${validator.label} stakeManager.migrateDelegation(${fromValidatorId.toString()} -> ${toValidatorId.toString()})`,
          from: validator.owner,
          prepare: (options) =>
            staking.stakeManager.prepareMigrateDelegation(migrateParams, options),
          send: (options) => staking.stakeManager.migrateDelegation(migrateParams, options)
        });
        // validators(id).delegatedAmount, read with plain viem at the receipt's block and the one before.
        const [fromBefore, fromAfter, toBefore, toAfter] = await Promise.all([
          validatorAt({ validatorId: fromValidatorId, blockNumber: blockNumber - 1n }),
          validatorAt({ validatorId: fromValidatorId, blockNumber }),
          validatorAt({ validatorId: toValidatorId, blockNumber: blockNumber - 1n }),
          validatorAt({ validatorId: toValidatorId, blockNumber })
        ]);
        expect(fromBefore[11] - fromAfter[11]).equals(MIGRATED);
        expect(toAfter[11] - toBefore[11]).equals(MIGRATED);
        expect(
          await staking.stakeManager.getDelegatedAmount({ validatorId: toValidatorId })
        ).equals((await validatorAt({ validatorId: toValidatorId }))[11]);
      }
      await expectDevnetLive({ label: 'migrateDelegation', before });
    });

    it('stakeManager.topUpHeimdallFee from a new validator owner tops up its own fee', async () => {
      const { addresses } = getTestEnv().E2E_ADDRESSES_JSON;
      for (const validator of ofVariant('pol')) {
        nodelessIdOf(validator);
        const staking = await stakingClientFor(validator.row);
        await land(`${validator.label} pol.approveStakeManager (fee)`, () =>
          staking.pol.approveStakeManager({ amount: minHeimdallFee }, stakingTxOptions())
        );
        const topUpParams = { user: validator.owner, heimdallFee: minHeimdallFee };
        const { hash, blockNumber } = await landStakingWrite({
          label: `${validator.label} stakeManager.topUpHeimdallFee`,
          from: validator.owner,
          prepare: (options) => staking.stakeManager.prepareTopUpHeimdallFee(topUpParams, options),
          send: (options) => staking.stakeManager.topUpHeimdallFee(topUpParams, options)
        });
        const topUps = parseEventLogs({
          abi: stakingInfoAbi,
          eventName: 'TopUpFee',
          args: { user: validator.owner },
          logs: await receiptLogs(hash)
        });
        expect(topUps).length(1);
        expect(topUps[0]?.args.fee).equals(minHeimdallFee);
        const [feeBefore, feeAfter] = await Promise.all(
          [blockNumber - 1n, blockNumber].map((at) =>
            readers().l1.readContract({
              address: addresses.StakeManager,
              abi: stakeManagerAbi,
              functionName: 'totalHeimdallFee',
              blockNumber: at
            })
          )
        );
        expect((feeAfter ?? 0n) - (feeBefore ?? 0n)).equals(minHeimdallFee);
      }
    });

    it('stakeManager.unstake deactivates each node-less validator, and the devnet stays live', async () => {
      const before = await markLiveness();
      let previous: { blockNumber: bigint; epoch: bigint } | undefined;
      for (const [index, validator] of validators.entries()) {
        const validatorId = nodelessIdOf(validator);
        const staking = await stakingClientFor(validator.row);
        // The last row reproduces the race the SDK's unstake headroom covers: price its
        // unstake in the state right after the previous row's, then wait for a
        // checkpoint to move the epoch on before sending it.
        let racedEstimate: bigint | undefined;
        if (index === validators.length - 1) {
          const prior = previous ?? expect.fail('the race needs an earlier unstake');
          const call = await staking.stakeManager.prepareUnstake(
            { validatorId },
            stakingTxOptions()
          );
          racedEstimate = await readers().l1.estimateGas({
            account: validator.owner,
            to: call.to,
            data: call.data,
            blockNumber: prior.blockNumber
          });
          await waitForEpochAfter({
            staking,
            epoch: prior.epoch,
            label: `${validator.label} unstake race`
          });
        }
        const { hash, blockNumber, gasUsed, estimate, gasLimit } = await landStakingWrite({
          label: `${validator.label} stakeManager.unstake`,
          from: validator.owner,
          prepare: (options) => staking.stakeManager.prepareUnstake({ validatorId }, options),
          send: (options) => staking.stakeManager.unstake({ validatorId }, options)
        });
        // The SDK, not the test, supplied this limit.
        const expectedMinLimit =
          sdkGasLimit({ estimate, headroom: SDK_UNSTAKE_GAS_HEADROOM }) - ESTIMATE_DRIFT_TOLERANCE;
        expect(
          gasLimit >= expectedMinLimit,
          `${validator.label}: unstake gas limit ${gasLimit.toString()} is below the SDK's ` +
            `estimate x 1.15 + ${SDK_UNSTAKE_GAS_HEADROOM.toString()} (minus tolerance): ${expectedMinLimit.toString()}`
        ).equals(true);
        const epoch = await readers().l1.readContract({
          address: getTestEnv().E2E_ADDRESSES_JSON.addresses.StakeManager,
          abi: stakeManagerAbi,
          functionName: 'currentEpoch',
          blockNumber
        });
        const inits = parseEventLogs({
          abi: stakingInfoAbi,
          eventName: 'UnstakeInit',
          args: { validatorId },
          logs: await receiptLogs(hash)
        });
        expect(inits).length(1);
        // The notice period is one epoch.
        expect(inits[0]?.args.deactivationEpoch).equals(epoch + 1n);
        expect((await validatorAt({ validatorId, blockNumber }))[3]).equals(epoch + 1n);

        if (racedEstimate !== undefined && previous) {
          const sdkLimitFromStaleEstimate = sdkGasLimit({
            estimate: racedEstimate,
            headroom: SDK_UNSTAKE_GAS_HEADROOM
          });
          log(
            `${validator.label} unstake race: ${JSON.stringify({
              estimateEpoch: previous.epoch.toString(),
              sentEpoch: epoch.toString(),
              racedEstimate: racedEstimate.toString(),
              sdkLimitFromStaleEstimate: sdkLimitFromStaleEstimate.toString(),
              gasUsed: gasUsed.toString()
            })}`
          );
          // Deterministic proof the SDK's margin covers the race.
          expect(
            sdkLimitFromStaleEstimate >= gasUsed,
            `${validator.label}: the SDK limit from the stale estimate ` +
              `(${sdkLimitFromStaleEstimate.toString()}) is below the raced gas used (${gasUsed.toString()})`
          ).equals(true);
          if (gasUsed <= racedEstimate) {
            expect.fail(
              `${validator.label}: unstake after the epoch moved used ${gasUsed.toString()} gas, ` +
                `no more than its estimate in epoch ${previous.epoch.toString()} ` +
                `(${racedEstimate.toString()})`
            );
          }
        }
        previous = { blockNumber, epoch };
      }
      await expectDevnetLive({ label: 'unstake', before });
    });

    it('stakeManager.claimUnstaked returns each stake after the withdrawal delay, and the devnet stays live', async () => {
      const before = await markLiveness();
      const staking = await stakingClientFor(validators[0]?.row ?? expect.fail('no rows'));
      const delay = await staking.stakeManager.getWithdrawalDelay();
      for (const validator of validators) {
        const validatorId = nodelessIdOf(validator);
        const deactivationEpoch = (await validatorAt({ validatorId }))[3];
        const claimableAt = deactivationEpoch + delay;
        // Only a checkpoint advances the epoch, so this also proves checkpoints still land.
        await pollUntil({
          label:
            `${validator.label}: StakeManager epoch >= ${claimableAt.toString()} ` +
            `(deactivation epoch ${deactivationEpoch.toString()} + withdrawal delay ${delay.toString()}), ` +
            'which needs new checkpoints',
          pollMs: POLL_MS,
          timeoutMs: EPOCH_WAIT_MS,
          fn: async () =>
            (await staking.stakeManager.getCurrentEpoch()) >= claimableAt ? true : undefined
        });
        const ownStaking = await stakingClientFor(validator.row);
        const { hash, blockNumber } = await landStakingWrite({
          label: `${validator.label} stakeManager.claimUnstaked`,
          from: validator.owner,
          prepare: (options) =>
            ownStaking.stakeManager.prepareClaimUnstaked({ validatorId }, options),
          send: (options) => ownStaking.stakeManager.claimUnstaked({ validatorId }, options)
        });
        const unstaked = parseEventLogs({
          abi: stakingInfoAbi,
          eventName: 'Unstaked',
          args: { validatorId },
          logs: await receiptLogs(hash)
        });
        expect(unstaked).length(1);
        expect(unstaked[0]?.args.amount).equals(validator.stake);
        // `claimUnstaked` pays out in POL, whichever token the stake came in.
        const [polBefore, polAfter] = await Promise.all([
          polBalanceAt({ owner: validator.owner, blockNumber: blockNumber - 1n }),
          polBalanceAt({ owner: validator.owner, blockNumber })
        ]);
        expect(polAfter - polBefore).equals(validator.stake);
        const after = await validatorAt({ validatorId, blockNumber });
        expect(after[0]).equals(0n);
        expect(after[7]).equals(STATUS_UNSTAKED);
        // The claim burns the validator NFT. `getValidatorId` reverts for an
        // owner with no NFT, so read the NFT balance with plain viem instead.
        const nft = await readers().l1.readContract({
          address: getTestEnv().E2E_ADDRESSES_JSON.addresses.StakeManager,
          abi: stakeManagerAbi,
          functionName: 'NFTContract'
        });
        expect(
          await readers().l1.readContract({
            address: nft,
            abi: dummyErc721Abi,
            functionName: 'balanceOf',
            args: [validator.owner],
            blockNumber
          })
        ).equals(0n);
      }
      await expectDevnetLive({ label: 'claimUnstaked', before });
    });
  }
);

describe.skip(`validator staking writes — GATED: ${GATED_REASON}`, () => {
  it('updateSigner', () => {
    expect.fail(`gated: ${GATED_REASON}; see STAKING-COVERAGE.md`);
  });
});
