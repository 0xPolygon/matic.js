import { describe, expect, it } from 'vitest';

import type {
  Adapter,
  Hex,
  PreparedTx,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';
import type { Network, NetworkAddresses } from '../../src/networks.ts';
import type { TxOptions } from '../../src/types.ts';

import { MAX_AMOUNT } from '../../src/constant.ts';
import { StakingClient } from '../../src/staking/staking-client.ts';

/**
 * Pins the routing of every staking write and read: the contract
 * address, on-chain function name and argument order that reach the
 * adapter, and the parent-chain id every broadcast is pinned to. Byte
 * equality of the encoded calldata against the 3.x plugin is covered
 * separately; this file catches a wrong function or swapped argument
 * before encoding ever happens.
 */

const ADDRESSES: NetworkAddresses = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666',
  StakeManager: '0x7777777777777777777777777777777777777777',
  MaticToken: '0x8888888888888888888888888888888888888888',
  PolToken: '0x9999999999999999999999999999999999999999'
};
const STAKE_MANAGER: Hex = '0x7777777777777777777777777777777777777777';
const MATIC: Hex = '0x8888888888888888888888888888888888888888';
const POL: Hex = '0x9999999999999999999999999999999999999999';
const SHARE: Hex = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const USER: Hex = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const PUBKEY: Hex = `0x${'ab'.repeat(64)}`;
const R: Hex = `0x${'11'.repeat(32)}`;
const S: Hex = `0x${'22'.repeat(32)}`;

class RecordingAdapter implements Adapter {
  readonly writes: WriteRequest[] = [];
  readonly prepares: WriteRequest[] = [];
  readonly reads: ReadRequest[] = [];
  readResult: unknown = 0n;

  getChainId(): Promise<number> {
    // Deliberately neither 1 nor 11155111: a write that fell back to the
    // adapter's chain id instead of the pinned L1 id would show up as 137.
    return Promise.resolve(137);
  }
  read(req: ReadRequest): Promise<unknown> {
    this.reads.push(req);
    return Promise.resolve(this.readResult);
  }
  write(req: WriteRequest): Promise<TxResult> {
    this.writes.push(req);
    return Promise.resolve({ hash: '0xdead', confirmed: () => Promise.resolve({} as Receipt) });
  }
  prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    this.prepares.push(req);
    return Promise.resolve({ to: req.address, data: '0xfeed' });
  }
  estimateGas(_req: WriteRequest): Promise<bigint> {
    return Promise.resolve(100_000n);
  }
  getTransactionReceipt(_hash: string): Promise<Receipt | null> {
    return Promise.resolve(null);
  }
  keccak256(_data: Uint8Array | string): string {
    return '0x0';
  }
  request<T>(_method: string, _params: readonly unknown[]): Promise<T> {
    return Promise.resolve(undefined as T);
  }
}

async function setup(
  network: Network = 'mainnet'
): Promise<{ adapter: RecordingAdapter; client: StakingClient }> {
  const adapter = new RecordingAdapter();
  const client = await StakingClient.init({ network, parent: adapter, addresses: ADDRESSES });
  return { adapter, client };
}

interface WriteCase {
  name: string;
  to: Hex;
  functionName: string;
  args: readonly unknown[];
  write: (c: StakingClient, o?: TxOptions) => Promise<TxResult>;
  prepare: (c: StakingClient, o?: TxOptions) => Promise<PreparedTx>;
}

const DELEGATE = { amount: 10n ** 18n, minSharesToMint: 5n };
const PERMIT = { ...DELEGATE, deadline: 1_900_000_000n, v: 27, r: R, s: S };
const STAKE_FOR = {
  user: USER,
  amount: 2n * 10n ** 18n,
  heimdallFee: 10n ** 18n,
  acceptDelegation: true,
  signerPubkey: PUBKEY
};

const WRITES: readonly WriteCase[] = [
  {
    name: 'validatorShare.delegateMatic',
    to: SHARE,
    functionName: 'buyVoucher',
    args: [DELEGATE.amount, DELEGATE.minSharesToMint],
    write: (c, o) => c.validatorShare(SHARE).delegateMatic(DELEGATE, o),
    prepare: (c, o) => c.validatorShare(SHARE).prepareDelegateMatic(DELEGATE, o)
  },
  {
    name: 'validatorShare.delegate',
    to: SHARE,
    functionName: 'buyVoucherPOL',
    args: [DELEGATE.amount, DELEGATE.minSharesToMint],
    write: (c, o) => c.validatorShare(SHARE).delegate(DELEGATE, o),
    prepare: (c, o) => c.validatorShare(SHARE).prepareDelegate(DELEGATE, o)
  },
  {
    name: 'validatorShare.delegateWithPermit',
    to: SHARE,
    functionName: 'buyVoucherWithPermit',
    args: [PERMIT.amount, PERMIT.minSharesToMint, PERMIT.deadline, 27, R, S],
    write: (c, o) => c.validatorShare(SHARE).delegateWithPermit(PERMIT, o),
    prepare: (c, o) => c.validatorShare(SHARE).prepareDelegateWithPermit(PERMIT, o)
  },
  {
    name: 'validatorShare.claimUndelegated',
    to: SHARE,
    functionName: 'unstakeClaimTokens_newPOL',
    args: [3n],
    write: (c, o) => c.validatorShare(SHARE).claimUndelegated({ nonce: 3n }, o),
    prepare: (c, o) => c.validatorShare(SHARE).prepareClaimUndelegated({ nonce: 3n }, o)
  },
  {
    name: 'validatorShare.undelegate',
    to: SHARE,
    functionName: 'sellVoucher_newPOL',
    args: [7n, 9n],
    write: (c, o) => c.validatorShare(SHARE).undelegate({ amount: 7n, maxSharesToBurn: 9n }, o),
    prepare: (c, o) =>
      c.validatorShare(SHARE).prepareUndelegate({ amount: 7n, maxSharesToBurn: 9n }, o)
  },
  {
    name: 'validatorShare.restakeRewards',
    to: SHARE,
    functionName: 'restakePOL',
    args: [],
    write: (c, o) => c.validatorShare(SHARE).restakeRewards(o),
    prepare: (c, o) => c.validatorShare(SHARE).prepareRestakeRewards(o)
  },
  {
    name: 'validatorShare.withdrawRewards',
    to: SHARE,
    functionName: 'withdrawRewardsPOL',
    args: [],
    write: (c, o) => c.validatorShare(SHARE).withdrawRewards(o),
    prepare: (c, o) => c.validatorShare(SHARE).prepareWithdrawRewards(o)
  },
  {
    name: 'stakeManager.migrateDelegation',
    to: STAKE_MANAGER,
    functionName: 'migrateDelegation',
    args: [1n, 2n, 3n],
    write: (c, o) =>
      c.stakeManager.migrateDelegation({ fromValidatorId: 1n, toValidatorId: 2n, amount: 3n }, o),
    prepare: (c, o) =>
      c.stakeManager.prepareMigrateDelegation(
        { fromValidatorId: 1n, toValidatorId: 2n, amount: 3n },
        o
      )
  },
  {
    name: 'stakeManager.restake',
    to: STAKE_MANAGER,
    functionName: 'restakePOL',
    args: [4n, 5n, true],
    write: (c, o) => c.stakeManager.restake({ validatorId: 4n, amount: 5n, stakeRewards: true }, o),
    prepare: (c, o) =>
      c.stakeManager.prepareRestake({ validatorId: 4n, amount: 5n, stakeRewards: true }, o)
  },
  {
    name: 'stakeManager.withdrawValidatorRewards',
    to: STAKE_MANAGER,
    functionName: 'withdrawRewardsPOL',
    args: [4n],
    write: (c, o) => c.stakeManager.withdrawValidatorRewards({ validatorId: 4n }, o),
    prepare: (c, o) => c.stakeManager.prepareWithdrawValidatorRewards({ validatorId: 4n }, o)
  },
  {
    name: 'stakeManager.topUpHeimdallFee',
    to: STAKE_MANAGER,
    functionName: 'topUpForFee',
    args: [USER, 6n],
    write: (c, o) => c.stakeManager.topUpHeimdallFee({ user: USER, amount: 6n }, o),
    prepare: (c, o) => c.stakeManager.prepareTopUpHeimdallFee({ user: USER, amount: 6n }, o)
  },
  {
    name: 'stakeManager.unstake',
    to: STAKE_MANAGER,
    functionName: 'unstakePOL',
    args: [4n],
    write: (c, o) => c.stakeManager.unstake({ validatorId: 4n }, o),
    prepare: (c, o) => c.stakeManager.prepareUnstake({ validatorId: 4n }, o)
  },
  {
    name: 'stakeManager.claimUnstaked',
    to: STAKE_MANAGER,
    functionName: 'unstakeClaimPOL',
    args: [4n],
    write: (c, o) => c.stakeManager.claimUnstaked({ validatorId: 4n }, o),
    prepare: (c, o) => c.stakeManager.prepareClaimUnstaked({ validatorId: 4n }, o)
  },
  {
    name: 'stakeManager.stakeForMatic',
    to: STAKE_MANAGER,
    functionName: 'stakeFor',
    args: [USER, STAKE_FOR.amount, STAKE_FOR.heimdallFee, true, PUBKEY],
    write: (c, o) => c.stakeManager.stakeForMatic(STAKE_FOR, o),
    prepare: (c, o) => c.stakeManager.prepareStakeForMatic(STAKE_FOR, o)
  },
  {
    name: 'stakeManager.stakeFor',
    to: STAKE_MANAGER,
    functionName: 'stakeForPOL',
    args: [USER, STAKE_FOR.amount, STAKE_FOR.heimdallFee, true, PUBKEY],
    write: (c, o) => c.stakeManager.stakeFor(STAKE_FOR, o),
    prepare: (c, o) => c.stakeManager.prepareStakeFor(STAKE_FOR, o)
  },
  {
    name: 'stakeManager.updateCommissionRate',
    to: STAKE_MANAGER,
    functionName: 'updateCommissionRate',
    args: [4n, 10n],
    write: (c, o) =>
      c.stakeManager.updateCommissionRate({ validatorId: 4n, commissionRate: 10n }, o),
    prepare: (c, o) =>
      c.stakeManager.prepareUpdateCommissionRate({ validatorId: 4n, commissionRate: 10n }, o)
  },
  {
    name: 'stakeManager.updateSigner',
    to: STAKE_MANAGER,
    functionName: 'updateSigner',
    args: [4n, PUBKEY],
    write: (c, o) => c.stakeManager.updateSigner({ validatorId: 4n, signerPubkey: PUBKEY }, o),
    prepare: (c, o) =>
      c.stakeManager.prepareUpdateSigner({ validatorId: 4n, signerPubkey: PUBKEY }, o)
  },
  {
    name: 'pol.approveStakeManager',
    to: POL,
    functionName: 'approve',
    args: [STAKE_MANAGER, 42n],
    write: (c, o) => c.pol.approveStakeManager({ amount: 42n }, o),
    prepare: (c, o) => c.pol.prepareApproveStakeManager({ amount: 42n }, o)
  },
  {
    name: 'matic.approveMaxForStakeManager',
    to: MATIC,
    functionName: 'approve',
    args: [STAKE_MANAGER, MAX_AMOUNT],
    write: (c, o) => c.matic.approveMaxForStakeManager(o),
    prepare: (c, o) => c.matic.prepareApproveMaxForStakeManager(o)
  }
];

describe('staking write routing', () => {
  it('covers all 19 writes', () => {
    expect(WRITES).lengthOf(19);
  });

  for (const w of WRITES) {
    describe(w.name, () => {
      it(`prepare routes to ${w.functionName} on the expected contract without broadcasting`, async () => {
        const { adapter, client } = await setup();
        const tx = await w.prepare(client);
        expect(adapter.writes).lengthOf(0);
        expect(adapter.prepares).lengthOf(1);
        expect(adapter.prepares[0]).property('address').equals(w.to);
        expect(adapter.prepares[0]).property('functionName').equals(w.functionName);
        expect(adapter.prepares[0]).property('args').deep.equals(w.args);
        expect(tx).property('to').equals(w.to);
      });

      it('write pins chainId to the network parent chain (mainnet 1, amoy 11155111)', async () => {
        const main = await setup('mainnet');
        await w.write(main.client);
        expect(main.adapter.writes).lengthOf(1);
        expect(main.adapter.writes[0]).property('functionName').equals(w.functionName);
        expect(main.adapter.writes[0]).property('args').deep.equals(w.args);
        expect(main.adapter.writes[0]).property('address').equals(w.to);
        expect(main.adapter.writes[0]).property('chainId').equals(1);

        const amoy = await setup('amoy');
        await w.write(amoy.client);
        expect(amoy.adapter.writes[0]).property('chainId').equals(11155111);
      });

      it('a consumer options.chainId override wins', async () => {
        const { adapter, client } = await setup();
        await w.write(client, { chainId: 31337 });
        expect(adapter.writes[0]).property('chainId').equals(31337);
      });
    });
  }

  it('matic.approveStakeManager and pol.approveMaxForStakeManager use the StakeManager proxy as spender', async () => {
    const { adapter, client } = await setup();
    await client.matic.prepareApproveStakeManager({ amount: 1n });
    await client.pol.prepareApproveMaxForStakeManager();
    expect(adapter.prepares[0]).property('address').equals(MATIC);
    expect(adapter.prepares[0]).property('args').deep.equals([STAKE_MANAGER, 1n]);
    expect(adapter.prepares[1]).property('address').equals(POL);
    expect(adapter.prepares[1]).property('args').deep.equals([STAKE_MANAGER, MAX_AMOUNT]);
  });
});

interface ReadCase {
  name: string;
  to: Hex;
  functionName: string;
  args: readonly unknown[];
  read: (c: StakingClient) => Promise<bigint>;
}

const BIGINT_READS: readonly ReadCase[] = [
  {
    name: 'stakeManager.getValidatorId',
    to: STAKE_MANAGER,
    functionName: 'getValidatorId',
    args: [USER],
    read: (c) => c.stakeManager.getValidatorId({ user: USER })
  },
  {
    name: 'stakeManager.getDelegatedAmount',
    to: STAKE_MANAGER,
    functionName: 'delegatedAmount',
    args: [4n],
    read: (c) => c.stakeManager.getDelegatedAmount({ validatorId: 4n })
  },
  {
    name: 'stakeManager.getValidatorStake',
    to: STAKE_MANAGER,
    functionName: 'validatorStake',
    args: [4n],
    read: (c) => c.stakeManager.getValidatorStake({ validatorId: 4n })
  },
  {
    name: 'stakeManager.getMinDeposit',
    to: STAKE_MANAGER,
    functionName: 'minDeposit',
    args: [],
    read: (c) => c.stakeManager.getMinDeposit()
  },
  {
    name: 'stakeManager.getMinHeimdallFee',
    to: STAKE_MANAGER,
    functionName: 'minHeimdallFee',
    args: [],
    read: (c) => c.stakeManager.getMinHeimdallFee()
  },
  {
    name: 'stakeManager.getWithdrawalDelay',
    to: STAKE_MANAGER,
    functionName: 'WITHDRAWAL_DELAY',
    args: [],
    read: (c) => c.stakeManager.getWithdrawalDelay()
  },
  {
    name: 'stakeManager.getCheckpointReward',
    to: STAKE_MANAGER,
    functionName: 'CHECKPOINT_REWARD',
    args: [],
    read: (c) => c.stakeManager.getCheckpointReward()
  },
  {
    name: 'stakeManager.getCurrentEpoch',
    to: STAKE_MANAGER,
    functionName: 'currentEpoch',
    args: [],
    read: (c) => c.stakeManager.getCurrentEpoch()
  },
  {
    name: 'stakeManager.getTotalStaked',
    to: STAKE_MANAGER,
    functionName: 'currentValidatorSetTotalStake',
    args: [],
    read: (c) => c.stakeManager.getTotalStaked()
  },
  {
    name: 'validatorShare.getExchangeRate',
    to: SHARE,
    functionName: 'exchangeRate',
    args: [],
    read: (c) => c.validatorShare(SHARE).getExchangeRate()
  },
  {
    name: 'validatorShare.getLiquidRewards',
    to: SHARE,
    functionName: 'getLiquidRewards',
    args: [USER],
    read: (c) => c.validatorShare(SHARE).getLiquidRewards({ user: USER })
  },
  {
    name: 'validatorShare.getMinAmount',
    to: SHARE,
    functionName: 'minAmount',
    args: [],
    read: (c) => c.validatorShare(SHARE).getMinAmount()
  },
  {
    name: 'validatorShare.getBalance',
    to: SHARE,
    functionName: 'balanceOf',
    args: [USER],
    read: (c) => c.validatorShare(SHARE).getBalance({ user: USER })
  },
  {
    name: 'validatorShare.getUnbondNonce',
    to: SHARE,
    functionName: 'unbondNonces',
    args: [USER],
    read: (c) => c.validatorShare(SHARE).getUnbondNonce({ user: USER })
  },
  {
    name: 'validatorShare.getValidatorId',
    to: SHARE,
    functionName: 'validatorId',
    args: [],
    read: (c) => c.validatorShare(SHARE).getValidatorId()
  },
  {
    name: 'pol.getBalance',
    to: POL,
    functionName: 'balanceOf',
    args: [USER],
    read: (c) => c.pol.getBalance({ user: USER })
  },
  {
    name: 'matic.getAllowanceForStakeManager',
    to: MATIC,
    functionName: 'allowance',
    args: [USER, STAKE_MANAGER],
    read: (c) => c.matic.getAllowanceForStakeManager({ owner: USER })
  },
  {
    name: 'pol.getNonce',
    to: POL,
    functionName: 'nonces',
    args: [USER],
    read: (c) => c.pol.getNonce({ owner: USER })
  }
];

describe('staking read routing', () => {
  for (const r of BIGINT_READS) {
    it(`${r.name} reads ${r.functionName} and coerces to bigint`, async () => {
      const { adapter, client } = await setup();
      // A decimal string stands in for an ethers v5 BigNumber's string form.
      adapter.readResult = '12345';
      const value = await r.read(client);
      expect(value).equals(12345n);
      expect(adapter.reads).lengthOf(1);
      expect(adapter.reads[0]).property('address').equals(r.to);
      expect(adapter.reads[0]).property('functionName').equals(r.functionName);
      expect(adapter.reads[0]).property('args').deep.equals(r.args);
    });
  }

  it('stakeManager.getValidator decodes the validators(uint256) tuple', async () => {
    const { adapter, client } = await setup();
    adapter.readResult = [1n, 2n, 3n, 4n, 5n, USER, SHARE, 1, 9n, 10n, 11n, 12n, 13n];
    const v = await client.stakeManager.getValidator({ validatorId: 4n });
    expect(adapter.reads[0]).property('functionName').equals('validators');
    expect(adapter.reads[0]).property('args').deep.equals([4n]);
    expect(v).deep.equals({
      amount: 1n,
      reward: 2n,
      activationEpoch: 3n,
      deactivationEpoch: 4n,
      jailTime: 5n,
      signer: USER,
      contractAddress: SHARE,
      status: 1n,
      commissionRate: 9n,
      lastCommissionUpdate: 10n,
      delegatorsReward: 11n,
      delegatedAmount: 12n,
      initialRewardPerStake: 13n
    });
  });

  it('stakeManager.getValidatorContract returns the share proxy address', async () => {
    const { adapter, client } = await setup();
    adapter.readResult = SHARE;
    expect(await client.stakeManager.getValidatorContract({ validatorId: 4n })).equals(SHARE);
    expect(adapter.reads[0]).property('functionName').equals('getValidatorContract');
  });

  it('stakeManager.isLocked reads locked()', async () => {
    const { adapter, client } = await setup();
    adapter.readResult = true;
    expect(await client.stakeManager.isLocked()).equals(true);
    expect(adapter.reads[0]).property('functionName').equals('locked');
  });

  it('validatorShare.getTotalStake decodes (stake, rate)', async () => {
    const { adapter, client } = await setup();
    adapter.readResult = [100n, '200'];
    expect(await client.validatorShare(SHARE).getTotalStake({ user: USER })).deep.equals({
      stake: 100n,
      rate: 200n
    });
    expect(adapter.reads[0]).property('functionName').equals('getTotalStake');
  });

  it('validatorShare.getUnbond and getUnbondNew decode (shares, withdrawEpoch)', async () => {
    const { adapter, client } = await setup();
    adapter.readResult = [5n, 6n];
    const share = client.validatorShare(SHARE);
    expect(await share.getUnbond({ user: USER })).deep.equals({ shares: 5n, withdrawEpoch: 6n });
    expect(await share.getUnbondNew({ user: USER, nonce: 2n })).deep.equals({
      shares: 5n,
      withdrawEpoch: 6n
    });
    expect(adapter.reads[0]).property('functionName').equals('unbonds');
    expect(adapter.reads[1]).property('functionName').equals('unbonds_new');
    expect(adapter.reads[1]).property('args').deep.equals([USER, 2n]);
  });

  it('a read forwards blockTag', async () => {
    const { adapter, client } = await setup();
    await client.stakeManager.getCurrentEpoch({ blockTag: 'safe' });
    expect(adapter.reads[0]).property('blockTag').equals('safe');
  });

  it('a malformed tuple fails with BRIDGE_EVENT_DECODE_FAILED', async () => {
    const { adapter, client } = await setup();
    adapter.readResult = [1n];
    await expect(client.validatorShare(SHARE).getTotalStake({ user: USER })).rejects.property(
      'code',
      'BRIDGE_EVENT_DECODE_FAILED'
    );
  });
});
