/**
 * Staking token writes on the devnet, through all three adapters.
 *
 * These rows replace the Sepolia staking-write tier, which needed a funded
 * private key and so never ran. On the devnet they show what calldata ground
 * truth cannot: a staking write reaches a real StakeManager deployment and
 * lands, the SDK's prepare path encodes what each adapter library encodes,
 * and the parent-chain pin refuses a write from a wallet on another chain
 * before anything is broadcast.
 *
 * Every write passes `stakingTxOptions()` (the devnet's L1 chain id), except
 * the wrong-chain row, which relies on the SDK's default pin on purpose.
 */
import { Interface } from 'ethers';
import { utils as utilsV5 } from 'ethers-v5';
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  maxUint256,
  parseEther,
  parseEventLogs
} from 'viem';
import { describe, expect, it } from 'vitest';

import type { Hex } from '@polygonlabs/maticjs';
import type { StakingClient as StakingClientType } from '@polygonlabs/maticjs/staking';

import { POSBridgeError } from '@polygonlabs/maticjs';
import { PolTokenABI } from '@polygonlabs/maticjs/abi';
import { StakingClient } from '@polygonlabs/maticjs/staking';

import type { AdapterRow } from '../src/adapters.ts';

import { buildAdapters, devnetChains, stakingTxOptions } from '../src/adapters.ts';
import { dummyErc721Abi, erc20Abi, stakeManagerAbi, stakingInfoAbi } from '../src/devnet-abis.ts';
import { getTestEnv } from '../src/test-env.ts';

const encodeApproveV6 = new Interface(PolTokenABI);
const encodeApproveV5 = new utilsV5.Interface(PolTokenABI);

/** The adapter library's own `approve` encoding, independent of the SDK's prepare path. */
function libraryEncodeApprove(row: AdapterRow, args: { spender: Hex; amount: bigint }): string {
  switch (row.name) {
    case 'viem':
      return encodeFunctionData({
        abi: PolTokenABI,
        functionName: 'approve',
        args: [args.spender, args.amount]
      });
    case 'ethers-v6':
      return encodeApproveV6.encodeFunctionData('approve', [args.spender, args.amount]);
    case 'ethers-v5':
      return encodeApproveV5.encodeFunctionData('approve', [args.spender, args.amount]);
  }
}

async function stakingClientFor(row: AdapterRow): Promise<StakingClientType> {
  const { StakeManager, MaticToken, PolToken } = getTestEnv().E2E_ADDRESSES_JSON.addresses;
  return StakingClient.init({
    network: 'amoy',
    parent: row.parent,
    addresses: { StakeManager, MaticToken, PolToken }
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (err: unknown) => err
  );
}

const log = (line: string) => process.stderr.write(`[staking-writes] ${line}\n`);

const VALIDATOR_ID = 1n;
const MATIC_DELEGATION = parseEther('1');
// Share/stake conversions go through the validator's exchange rate, which
// can round by a few wei.
const ROUNDING_WEI = 1_000n;

/** A plain viem L1 reader, so the SDK's writes are never checked with the SDK. */
function l1Reader() {
  return createPublicClient({ chain: devnetChains().l1, transport: http() });
}

/** An ERC-20 balance at a block, read with plain viem. */
function balanceAt({ token, owner, blockNumber }: { token: Hex; owner: Hex; blockNumber: bigint }) {
  return l1Reader().readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
    blockNumber
  });
}

const ROWS = buildAdapters({ suite: 'staking' }).map((row) => [row.name, row] as const);

describe('staking token writes (devnet)', () => {
  describe.each(ROWS)('via %s', (_name, row) => {
    it('pol.approveStakeManager lands and the allowance reads back', async () => {
      const staking = await stakingClientFor(row);
      const tx = await staking.pol.approveStakeManager({ amount: 1n }, stakingTxOptions());
      log(`${row.name} pol.approveStakeManager: ${tx.hash}`);
      expect(tx)
        .property('hash')
        .match(/^0x[0-9a-f]{64}$/i);
      expect(await tx.confirmed())
        .property('status')
        .equals('success');
      expect(await staking.pol.getAllowanceForStakeManager({ owner: row.address })).equals(1n);
    });

    it('pol.prepareApproveStakeManager encodes what the adapter library encodes', async () => {
      const staking = await stakingClientFor(row);
      const spender = await staking.stakeManager.getAddress();
      const prepared = await staking.pol.prepareApproveStakeManager(
        { amount: 1n },
        stakingTxOptions()
      );
      expect(prepared)
        .property('to')
        .equals(await staking.pol.getAddress());
      expect(prepared)
        .property('data')
        .equals(libraryEncodeApprove(row, { spender, amount: 1n }));
    });

    it('a write without a chainId is refused on the devnet wallet and broadcasts nothing', async () => {
      // The SDK pins staking writes to the network's L1 (`amoy` → 11155111);
      // the wallet is on the devnet L1, so the adapter must refuse pre-flight.
      const { l1 } = devnetChains();
      const l1Public = createPublicClient({ chain: l1, transport: http() });
      const nonceBefore = await l1Public.getTransactionCount({
        address: row.address,
        blockTag: 'pending'
      });

      const staking = await stakingClientFor(row);
      const err = await rejectionOf(staking.pol.approveStakeManager({ amount: 1n }));
      expect(err).instanceOf(POSBridgeError);
      expect(err).property('code').equals('UNSUPPORTED_NETWORK');

      const nonceAfter = await l1Public.getTransactionCount({
        address: row.address,
        blockTag: 'pending'
      });
      expect(nonceAfter).equals(nonceBefore);
    });

    it('pol.approveMaxForStakeManager lands and the allowance is 2^256 - 1', async () => {
      const staking = await stakingClientFor(row);
      const tx = await staking.pol.approveMaxForStakeManager(stakingTxOptions());
      log(`${row.name} pol.approveMaxForStakeManager: ${tx.hash}`);
      expect(await tx.confirmed())
        .property('status')
        .equals('success');
      expect(await staking.pol.getAllowanceForStakeManager({ owner: row.address })).equals(
        maxUint256
      );
    });

    it('matic.approveStakeManager lands and matic.preparePermit is refused', async () => {
      const staking = await stakingClientFor(row);
      const tx = await staking.matic.approveStakeManager({ amount: 1n }, stakingTxOptions());
      log(`${row.name} matic.approveStakeManager: ${tx.hash}`);
      expect(await tx.confirmed())
        .property('status')
        .equals('success');
      expect(await staking.matic.getAllowanceForStakeManager({ owner: row.address })).equals(1n);

      const err = await rejectionOf(staking.matic.preparePermit({ owner: row.address, value: 1n }));
      expect(err).instanceOf(POSBridgeError);
      expect(err).property('code').equals('PERMIT_NOT_SUPPORTED');
    });

    it('stakeManager.topUpHeimdallFee lands from a key that owns no validator', async () => {
      // `topUpForFee(user, heimdallFee)` has no staker check: any account
      // that approved the fee in POL can top up any user's heimdall fee.
      const staking = await stakingClientFor(row);
      const { PolToken, StakeManager } = getTestEnv().E2E_ADDRESSES_JSON.addresses;
      const fee = await staking.stakeManager.getMinHeimdallFee();
      // The key owns no validator NFT. (`getValidatorId` reverts for such a key.)
      const reader = l1Reader();
      const nft = await reader.readContract({
        address: StakeManager,
        abi: stakeManagerAbi,
        functionName: 'NFTContract'
      });
      expect(
        await reader.readContract({
          address: nft,
          abi: dummyErc721Abi,
          functionName: 'balanceOf',
          args: [row.address]
        })
      ).equals(0n);

      const approve = await staking.pol.approveStakeManager({ amount: fee }, stakingTxOptions());
      expect(await approve.confirmed())
        .property('status')
        .equals('success');

      const tx = await staking.stakeManager.topUpHeimdallFee(
        { user: row.address, heimdallFee: fee },
        stakingTxOptions()
      );
      log(`${row.name} stakeManager.topUpHeimdallFee: ${tx.hash}`);
      const receipt = await tx.confirmed();
      expect(receipt).property('status').equals('success');

      const { blockNumber } = receipt;
      const [before, after] = await Promise.all([
        balanceAt({ token: PolToken, owner: row.address, blockNumber: blockNumber - 1n }),
        balanceAt({ token: PolToken, owner: row.address, blockNumber })
      ]);
      expect(before - after).equals(fee);
      const [feesBefore, feesAfter] = await Promise.all(
        [blockNumber - 1n, blockNumber].map((at) =>
          reader.readContract({
            address: StakeManager,
            abi: stakeManagerAbi,
            functionName: 'totalHeimdallFee',
            blockNumber: at
          })
        )
      );
      expect(feesAfter - feesBefore).equals(fee);

      const logger = await reader.readContract({
        address: StakeManager,
        abi: stakeManagerAbi,
        functionName: 'logger'
      });
      const events = parseEventLogs({
        abi: stakingInfoAbi,
        eventName: 'TopUpFee',
        logs: (await reader.getTransactionReceipt({ hash: tx.hash })).logs
      });
      expect(events).length(1);
      const [event] = events;
      if (!event) return expect.fail('no TopUpFee event');
      expect(getAddress(event.address)).equals(logger);
      expect(event.args).property('user').equals(row.address);
      expect(event.args).property('fee').equals(fee);
    });

    it('validatorShare.delegateMatic lands and moves MATIC into stake', async () => {
      // `buyVoucher` takes legacy MATIC; StakeManager converts it to POL
      // through the migration contract, so this is the MATIC path on a
      // StakeManager that was migrated to POL.
      const staking = await stakingClientFor(row);
      const { MaticToken, StakeManager } = getTestEnv().E2E_ADDRESSES_JSON.addresses;
      const vs = staking.validatorShare(
        await staking.stakeManager.getValidatorContract({ validatorId: VALIDATOR_ID })
      );

      const approve = await staking.matic.approveStakeManager(
        { amount: MATIC_DELEGATION },
        stakingTxOptions()
      );
      expect(await approve.confirmed())
        .property('status')
        .equals('success');

      const stakeBefore = (await vs.getTotalStake({ user: row.address })).stake;
      const tx = await vs.delegateMatic(
        { amount: MATIC_DELEGATION, minSharesToMint: 0n },
        stakingTxOptions()
      );
      log(`${row.name} validatorShare.delegateMatic: ${tx.hash}`);
      const receipt = await tx.confirmed();
      expect(receipt).property('status').equals('success');

      // buyVoucher first pays out any rewards the key has accrued, in MATIC,
      // so the balance delta is not the delegation. The MATIC Transfer out
      // of the key is: exactly the delegated amount, to StakeManager.
      const transfersOut = parseEventLogs({
        abi: erc20Abi,
        eventName: 'Transfer',
        args: { from: row.address },
        logs: (await l1Reader().getTransactionReceipt({ hash: tx.hash })).logs
      }).filter((entry) => getAddress(entry.address) === MaticToken);
      expect(transfersOut).length(1);
      expect(transfersOut[0]?.args).property('to').equals(StakeManager);
      expect(transfersOut[0]?.args).property('value').equals(MATIC_DELEGATION);
      const staked = (await vs.getTotalStake({ user: row.address })).stake - stakeBefore;
      if (staked < MATIC_DELEGATION - ROUNDING_WEI || staked > MATIC_DELEGATION) {
        expect.fail(
          `delegated stake ${staked.toString()} is outside ` +
            `[${(MATIC_DELEGATION - ROUNDING_WEI).toString()}, ${MATIC_DELEGATION.toString()}]`
        );
      }
    });

    // GATED on this devnet: kurtosis-pos deploys POL as a generic
    // ERC20Permit without ERC-5267 `eip712Domain()`, and `preparePermit`
    // reads the domain only from that function, so it reverts here. The
    // domain read is proven against mainnet POL by the live-read tier
    // (`packages/maticjs`), and the permit itself by `delegateWithPermit`
    // in staking-delegation.e2e.test.ts with a harness-built domain.
    it.skip('pol.preparePermit — GATED: devnet POL has no ERC-5267 eip712Domain()', () => {
      expect.fail('gated on this devnet; see STAKING-COVERAGE.md');
    });
  });
});
