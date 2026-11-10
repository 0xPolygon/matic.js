/**
 * The delegator cycle on the devnet's validator 1, through all three
 * adapters: approve, delegate, withdraw rewards, restake rewards, undelegate,
 * claim the unbond, and delegate again with a signed permit.
 *
 * Rewards accrue only when heimdall submits a checkpoint (every few tens of
 * seconds on the devnet), and an unbond is claimable only once
 * `withdrawEpoch + withdrawalDelay <= currentEpoch`. The waits below read
 * those conditions through the SDK's own reads, so a stuck devnet times out
 * with the condition named, instead of surfacing as a revert.
 *
 * The adapter rows run concurrently: each signs with its own
 * (suite × adapter) key, so their nonces never race.
 */
import { Wallet as WalletV6 } from 'ethers';
import { Wallet as WalletV5 } from 'ethers-v5';
import { createPublicClient, domainSeparator, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import type { Hex } from '@polygonlabs/maticjs';
import type {
  PermitTypedData,
  StakingClient as StakingClientType,
  ValidatorShare
} from '@polygonlabs/maticjs/staking';

import { PolTokenABI } from '@polygonlabs/maticjs/abi';
import { splitSignature, StakingClient } from '@polygonlabs/maticjs/staking';

import type { AdapterRow } from '../src/adapters.ts';

import { buildAdapters, devnetChains, stakingTxOptions } from '../src/adapters.ts';
import { privateKeyFor } from '../src/keys.ts';
import { getTestEnv } from '../src/test-env.ts';
import { pollUntil } from '../src/wait.ts';

const SUITE = 'staking-delegation';
const VALIDATOR_ID = 1n;
const APPROVAL = parseEther('100');
const DELEGATION = parseEther('10');
const UNDELEGATION = parseEther('5');
// Share/stake conversions go through the validator's exchange rate, which
// can round by a few wei.
const ROUNDING_WEI = 1_000n;
const PERMIT_TTL_SECONDS = 1_800n;
const CHECKPOINT_WAIT_MS = 300_000;
const POLL_MS = 2_000;

/**
 * Chai's range assertions take numbers and dates, not bigints, so token
 * amounts are range-checked here, with both bounds in the failure message.
 */
function expectRange({
  label,
  actual,
  min,
  max
}: {
  label: string;
  actual: bigint;
  min: bigint;
  max?: bigint;
}): void {
  if (actual < min || (max !== undefined && actual > max)) {
    expect.fail(
      `${label}: ${actual.toString()} is outside [${min.toString()}, ${max?.toString() ?? '∞'}]`
    );
  }
}

const log = (line: string) => process.stderr.write(`[staking-delegation] ${line}\n`);

async function stakingClientFor(row: AdapterRow): Promise<StakingClientType> {
  const { StakeManager, MaticToken, PolToken } = getTestEnv().E2E_ADDRESSES_JSON.addresses;
  return StakingClient.init({
    network: 'amoy',
    parent: row.parent,
    addresses: { StakeManager, MaticToken, PolToken }
  });
}

/** Send a write, wait for it, and fail with the step name if it did not succeed. */
async function land(
  label: string,
  send: () => Promise<{ hash: string; confirmed: () => Promise<{ status: string }> }>
): Promise<string> {
  const started = Date.now();
  const tx = await send();
  const receipt = await tx.confirmed();
  expect(receipt, `${label} (${tx.hash})`).property('status').equals('success');
  log(`${label}: ${tx.hash} in ${String(Date.now() - started)} ms`);
  return tx.hash;
}

async function waitForRewards({
  label,
  vs,
  user,
  atLeast
}: {
  label: string;
  vs: ValidatorShare;
  user: Hex;
  atLeast: bigint;
}): Promise<bigint> {
  const started = Date.now();
  const rewards = await pollUntil({
    label: `${label}: liquid rewards >= ${atLeast.toString()}`,
    pollMs: POLL_MS,
    timeoutMs: CHECKPOINT_WAIT_MS,
    fn: async () => {
      const value = await vs.getLiquidRewards({ user });
      return value >= atLeast ? value : undefined;
    }
  });
  log(`${label}: rewards ${rewards.toString()} after ${String(Date.now() - started)} ms`);
  return rewards;
}

/**
 * Sign the permit with the row's own web3 library, as a consumer would:
 * the SDK builds typed data but never signs.
 */
async function signPermit(row: AdapterRow, typed: PermitTypedData): Promise<Hex> {
  const privateKey = privateKeyFor({ suite: SUITE, adapter: row.name });
  switch (row.name) {
    case 'viem':
      return privateKeyToAccount(privateKey).signTypedData(typed);
    case 'ethers-v6': {
      const signature = await new WalletV6(privateKey).signTypedData(
        typed.domain,
        typed.types,
        typed.message
      );
      return toHex(signature);
    }
    case 'ethers-v5': {
      const signature = await new WalletV5(privateKey)._signTypedData(
        typed.domain,
        typed.types,
        typed.message
      );
      return toHex(signature);
    }
  }
}

function toHex(value: string): Hex {
  if (!value.startsWith('0x')) throw new Error(`not a 0x string: ${value}`);
  return `0x${value.slice(2)}`;
}

const ROWS = buildAdapters({ suite: SUITE }).map((row) => [row.name, row] as const);

describe.concurrent('staking delegation cycle (devnet)', { timeout: 900_000 }, () => {
  it.each(ROWS)('via %s', async (_name, row) => {
    const user = row.address;
    const staking = await stakingClientFor(row);
    const vs = staking.validatorShare(
      await staking.stakeManager.getValidatorContract({ validatorId: VALIDATOR_ID })
    );
    const pol = staking.pol;
    const tag = row.name;

    // approveStakeManager + delegate
    await land(`${tag} approveStakeManager`, () =>
      pol.approveStakeManager({ amount: APPROVAL }, stakingTxOptions())
    );
    expect(await pol.getAllowanceForStakeManager({ owner: user })).equals(APPROVAL);

    const stakeBeforeDelegate = (await vs.getTotalStake({ user })).stake;
    await land(`${tag} delegate`, () =>
      vs.delegate({ amount: DELEGATION, minSharesToMint: 0n }, stakingTxOptions())
    );
    const stakeAfterDelegate = (await vs.getTotalStake({ user })).stake;
    expectRange({
      label: `${tag} delegated stake`,
      actual: stakeAfterDelegate - stakeBeforeDelegate,
      min: DELEGATION - ROUNDING_WEI,
      max: DELEGATION
    });

    // withdrawRewards: the contract refuses to pay out less than minAmount.
    const minAmount = await vs.getMinAmount();
    await waitForRewards({ label: `${tag} withdraw`, vs, user, atLeast: minAmount });
    const polBeforeWithdraw = await pol.getBalance({ user });
    await land(`${tag} withdrawRewards`, () => vs.withdrawRewards(stakingTxOptions()));
    expectRange({
      label: `${tag} withdrawn rewards`,
      actual: (await pol.getBalance({ user })) - polBeforeWithdraw,
      min: minAmount
    });

    // restakeRewards: wait for the next checkpoint's rewards, then restake them.
    await waitForRewards({ label: `${tag} restake`, vs, user, atLeast: minAmount });
    const stakeBeforeRestake = (await vs.getTotalStake({ user })).stake;
    await land(`${tag} restakeRewards`, () => vs.restakeRewards(stakingTxOptions()));
    expectRange({
      label: `${tag} restaked rewards`,
      actual: (await vs.getTotalStake({ user })).stake - stakeBeforeRestake,
      min: minAmount - ROUNDING_WEI
    });

    // undelegate: burn at most the shares we hold.
    const shares = await vs.getBalance({ user });
    const nonceBefore = await vs.getUnbondNonce({ user });
    await land(`${tag} undelegate`, () =>
      vs.undelegate({ amount: UNDELEGATION, maxSharesToBurn: shares }, stakingTxOptions())
    );
    const nonce = await vs.getUnbondNonce({ user });
    expect(nonce).equals(nonceBefore + 1n);
    const unbond = await vs.getUnbondNew({ user, nonce });
    expectRange({ label: `${tag} unbond shares`, actual: unbond.shares, min: 1n });

    // claimUndelegated: retry until the withdrawal delay has passed.
    const delay = await staking.stakeManager.getWithdrawalDelay();
    const unbondStarted = Date.now();
    await pollUntil({
      label: `${tag} epoch >= withdrawEpoch ${unbond.withdrawEpoch.toString()} + delay ${delay.toString()}`,
      pollMs: POLL_MS,
      timeoutMs: CHECKPOINT_WAIT_MS,
      fn: async () =>
        (await staking.stakeManager.getCurrentEpoch()) >= unbond.withdrawEpoch + delay
          ? true
          : undefined
    });
    log(`${tag} unbond claimable after ${String(Date.now() - unbondStarted)} ms`);
    const polBeforeClaim = await pol.getBalance({ user });
    await land(`${tag} claimUndelegated`, () => vs.claimUndelegated({ nonce }, stakingTxOptions()));
    expectRange({
      label: `${tag} claimed unbond`,
      actual: (await pol.getBalance({ user })) - polBeforeClaim,
      min: UNDELEGATION - ROUNDING_WEI,
      max: UNDELEGATION
    });

    // delegateWithPermit, signing exactly what preparePermit returns: the
    // domain it read from the token's ERC-5267 `eip712Domain()`. The domain is
    // checked against the token's own DOMAIN_SEPARATOR before anything is signed.
    const polAddress = await pol.getAddress();
    const l1Public = createPublicClient({ chain: devnetChains().l1, transport: http() });

    // Zero the allowance first, so the delegation can only land through the permit.
    await land(`${tag} approveStakeManager(0)`, () =>
      pol.approveStakeManager({ amount: 0n }, stakingTxOptions())
    );
    const block = await l1Public.getBlock({ blockTag: 'latest' });
    const deadline = block.timestamp + PERMIT_TTL_SECONDS;
    const permitNonce = await pol.getNonce({ owner: user });
    const typed: PermitTypedData = await pol.preparePermit({
      owner: user,
      value: DELEGATION,
      deadline
    });
    const onChainSeparator = await l1Public.readContract({
      address: polAddress,
      abi: PolTokenABI,
      functionName: 'DOMAIN_SEPARATOR'
    });
    expect(domainSeparator({ domain: typed.domain })).equals(onChainSeparator);
    expect(typed.message.nonce).equals(permitNonce);
    expect(typed.message.spender.toLowerCase()).equals(
      (await staking.stakeManager.getAddress()).toLowerCase()
    );
    const signature = splitSignature(await signPermit(row, typed));
    const stakeBeforePermit = (await vs.getTotalStake({ user })).stake;
    await land(`${tag} delegateWithPermit`, () =>
      vs.delegateWithPermit(
        { amount: DELEGATION, minSharesToMint: 0n, deadline, ...signature },
        stakingTxOptions()
      )
    );
    expectRange({
      label: `${tag} permit-delegated stake`,
      actual: (await vs.getTotalStake({ user })).stake - stakeBeforePermit,
      min: DELEGATION - ROUNDING_WEI,
      max: DELEGATION
    });
    expect(await pol.getNonce({ owner: user })).equals(permitNonce + 1n);
  });
});
