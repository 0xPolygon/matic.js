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
import { createPublicClient, encodeFunctionData, http, maxUint256 } from 'viem';
import { describe, expect, it } from 'vitest';

import type { Hex } from '@polygonlabs/maticjs';
import type { StakingClient as StakingClientType } from '@polygonlabs/maticjs/staking';

import { POSBridgeError } from '@polygonlabs/maticjs';
import { PolTokenABI } from '@polygonlabs/maticjs/abi';
import { StakingClient } from '@polygonlabs/maticjs/staking';

import type { AdapterRow } from '../src/adapters.ts';

import { buildAdapters, devnetChains, stakingTxOptions } from '../src/adapters.ts';
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
