import type { JsonRpcPayload, JsonRpcResult } from 'ethers';

import { JsonRpcProvider, Network, Wallet as V6Wallet } from 'ethers';
import { providers as v5providers, Wallet as V5Wallet } from 'ethers-v5';
import { createPublicClient, createWalletClient, custom, keccak256, parseTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Adapter, Hex } from '../../src/adapter.ts';
import type { NetworkAddresses } from '../../src/networks.ts';
import type { TxOptions } from '../../src/types.ts';

import { ChildERC20ABI } from '../../src/abi/index.ts';
import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { ContractCaller } from '../../src/internal/contract-caller.ts';
import { noopLogger } from '../../src/logger.ts';
import { StakingClient } from '../../src/staking/staking-client.ts';

/**
 * Pins where the epoch-race gas headroom applies: `stakeManager.unstake`
 * adds a fixed 250,000 to floor(estimate × 1.15), an explicit `gasLimit`
 * wins untouched, and no other write changes its limit. Real libraries sign
 * the transactions; only the JSON-RPC transport is stubbed, and the gas
 * is read from the broadcast raw transaction.
 */

const SEPOLIA = 11155111;
// 60_000 × 1.15 is exactly 69_000 in floating point (50_000 × 1.15 is not),
// so the expected limits below are not hostage to float rounding.
const ESTIMATE = 60_000n;
const MULTIPLIED = 69_000n;
const HEADROOM = 250_000n;
const TEST_KEY = `0x${'11'.repeat(32)}` as const;
const GWEI = 1_000_000_000n;
const SHARE: Hex = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const TOKEN: Hex = '0x3333333333333333333333333333333333333333';
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

const toQuantity = (v: bigint): string => `0x${v.toString(16)}`;

class StubChain {
  readonly rawTxs: Hex[] = [];
  readonly methods: string[] = [];

  answer(method: string, params: readonly unknown[]): unknown {
    this.methods.push(method);
    switch (method) {
      case 'eth_chainId':
        return toQuantity(BigInt(SEPOLIA));
      case 'net_version':
        return String(SEPOLIA);
      case 'eth_blockNumber':
        return '0x64';
      case 'eth_gasPrice':
        return toQuantity(40n * GWEI);
      case 'eth_maxPriorityFeePerGas':
        return toQuantity(30n * GWEI);
      case 'eth_getTransactionCount':
        return '0x7';
      case 'eth_estimateGas':
        return toQuantity(ESTIMATE);
      case 'eth_getBlockByNumber':
        return {
          hash: `0x${'aa'.repeat(32)}`,
          parentHash: `0x${'bb'.repeat(32)}`,
          sha3Uncles: `0x${'cc'.repeat(32)}`,
          stateRoot: `0x${'dd'.repeat(32)}`,
          transactionsRoot: `0x${'ee'.repeat(32)}`,
          receiptsRoot: `0x${'ff'.repeat(32)}`,
          mixHash: `0x${'00'.repeat(32)}`,
          logsBloom: `0x${'00'.repeat(256)}`,
          number: '0x64',
          timestamp: '0x1',
          nonce: '0x0000000000000000',
          difficulty: '0x0',
          totalDifficulty: '0x0',
          size: '0x1',
          gasLimit: '0x1c9c380',
          gasUsed: '0x0',
          miner: '0x0000000000000000000000000000000000000000',
          extraData: '0x',
          uncles: [],
          transactions: [],
          baseFeePerGas: toQuantity(10n * GWEI)
        };
      case 'eth_sendRawTransaction': {
        const raw = params[0];
        if (typeof raw !== 'string' || !raw.startsWith('0x')) {
          throw new Error('stub chain: malformed raw transaction');
        }
        this.rawTxs.push(raw as Hex);
        return keccak256(raw as Hex);
      }
      default:
        throw Object.assign(new Error(`stub chain: unexpected RPC ${method}`), { code: -32601 });
    }
  }

  get estimateCalls(): number {
    return this.methods.filter((m) => m === 'eth_estimateGas').length;
  }

  /** Gas limit of the single broadcast transaction. */
  broadcastGas(): bigint {
    expect(this.rawTxs).lengthOf(1);
    const [raw] = this.rawTxs;
    if (raw === undefined) throw new Error('nothing broadcast');
    const { gas } = parseTransaction(raw as `0x02${string}`);
    if (gas === undefined) throw new Error('broadcast transaction has no gas limit');
    return gas;
  }
}

class V5StubProvider extends v5providers.StaticJsonRpcProvider {
  private readonly chain: StubChain;
  constructor(chain: StubChain) {
    super('http://stub.invalid', { chainId: SEPOLIA, name: 'stub' });
    this.chain = chain;
  }
  override async send(method: string, params: unknown[]): Promise<unknown> {
    return this.chain.answer(method, params);
  }
}

class V6StubProvider extends JsonRpcProvider {
  private readonly chain: StubChain;
  constructor(chain: StubChain) {
    super('http://stub.invalid', Network.from(SEPOLIA), { staticNetwork: true, batchMaxCount: 1 });
    this.chain = chain;
  }
  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const batch = Array.isArray(payload) ? payload : [payload];
    return batch.map((p) => ({
      id: p.id,
      result: this.chain.answer(p.method, Array.isArray(p.params) ? p.params : [])
    }));
  }
}

const harnesses: Array<[string, (chain: StubChain) => Adapter]> = [
  [
    'ethers v5',
    (chain) => {
      const provider = new V5StubProvider(chain);
      return ethersV5Adapter({ provider, signer: new V5Wallet(TEST_KEY, provider) });
    }
  ],
  [
    'ethers v6',
    (chain) => {
      const provider = new V6StubProvider(chain);
      return ethersV6Adapter({ provider, signer: new V6Wallet(TEST_KEY, provider) });
    }
  ],
  [
    'viem',
    (chain) => {
      const transport = custom({
        request: async ({ method, params }: { method: string; params?: unknown }) =>
          chain.answer(method, Array.isArray(params) ? params : [])
      });
      return viemAdapter({
        public: createPublicClient({ transport }),
        wallet: createWalletClient({ account: privateKeyToAccount(TEST_KEY), transport })
      });
    }
  ]
];

const stakingFor = (adapter: Adapter): Promise<StakingClient> =>
  StakingClient.init({ network: 'amoy', parent: adapter, addresses: ADDRESSES });

describe.each(harnesses)('%s — gas headroom scope', (_name, build) => {
  it('unstake broadcasts floor(estimate × 1.15) + 250_000', async () => {
    const chain = new StubChain();
    const staking = await stakingFor(build(chain));
    await staking.stakeManager.unstake({ validatorId: 1n });
    expect(chain.broadcastGas()).equals(MULTIPLIED + HEADROOM);
  });

  it('unstake with an explicit gasLimit broadcasts exactly it, with no estimate', async () => {
    const chain = new StubChain();
    const staking = await stakingFor(build(chain));
    await staking.stakeManager.unstake({ validatorId: 1n }, { gasLimit: 123_456n });
    expect(chain.broadcastGas()).equals(123_456n);
    expect(chain.estimateCalls).equals(0);
  });

  it('claimUnstaked broadcasts floor(estimate × 1.15) only', async () => {
    const chain = new StubChain();
    const staking = await stakingFor(build(chain));
    await staking.stakeManager.claimUnstaked({ validatorId: 1n });
    expect(chain.broadcastGas()).equals(MULTIPLIED);
  });

  it('restake broadcasts floor(estimate × 1.15) only', async () => {
    const chain = new StubChain();
    const staking = await stakingFor(build(chain));
    await staking.stakeManager.restake({ validatorId: 1n, amount: 1n, stakeRewards: false });
    expect(chain.broadcastGas()).equals(MULTIPLIED);
  });

  it('validatorShare.undelegate broadcasts floor(estimate × 1.15) only', async () => {
    const chain = new StubChain();
    const staking = await stakingFor(build(chain));
    await staking.validatorShare(SHARE).undelegate({ amount: 1n, maxSharesToBurn: 1n });
    expect(chain.broadcastGas()).equals(MULTIPLIED);
  });

  it('a bridge write broadcasts floor(estimate × 1.15) only', async () => {
    const chain = new StubChain();
    await new ContractCaller({
      adapter: build(chain),
      getAddress: () => Promise.resolve(TOKEN),
      abi: ChildERC20ABI,
      isParent: false,
      logger: noopLogger,
      chainId: SEPOLIA
    }).write('withdraw', [1n]);
    expect(chain.broadcastGas()).equals(MULTIPLIED);
  });

  // gasHeadroom is not an option at all, so a plain-JS caller passing one is
  // ignored on every write path: StakeManager, ValidatorShare and a bridge
  // ContractCaller write.
  it('a gasHeadroom passed in options is ignored on every write path', async () => {
    const smuggled = { gasHeadroom: 999_999n } as object;
    const stakeChain = new StubChain();
    const staking = await stakingFor(build(stakeChain));
    await staking.stakeManager.claimUnstaked({ validatorId: 1n }, smuggled);
    expect(stakeChain.broadcastGas()).equals(MULTIPLIED);

    const shareChain = new StubChain();
    const shareStaking = await stakingFor(build(shareChain));
    await shareStaking
      .validatorShare(SHARE)
      .undelegate({ amount: 1n, maxSharesToBurn: 1n }, smuggled);
    expect(shareChain.broadcastGas()).equals(MULTIPLIED);

    const bridgeChain = new StubChain();
    await new ContractCaller({
      adapter: build(bridgeChain),
      getAddress: () => Promise.resolve(TOKEN),
      abi: ChildERC20ABI,
      isParent: false,
      logger: noopLogger,
      chainId: SEPOLIA
    }).write('withdraw', [1n], smuggled);
    expect(bridgeChain.broadcastGas()).equals(MULTIPLIED);
  });

  it('TxOptions has no gasHeadroom field', () => {
    expectTypeOf<TxOptions>().not.toHaveProperty('gasHeadroom');
  });

  it('prepareUnstake returns calldata only, with no gas field', async () => {
    const chain = new StubChain();
    const staking = await stakingFor(build(chain));
    const prepared = await staking.stakeManager.prepareUnstake({ validatorId: 1n });
    expect(Object.keys(prepared).sort()).deep.equals(['data', 'to']);
    expect(chain.estimateCalls).equals(0);
  });
});
