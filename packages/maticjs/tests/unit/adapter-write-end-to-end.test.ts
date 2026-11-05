import type { JsonRpcPayload, JsonRpcResult } from 'ethers';

import { JsonRpcProvider, Network, Wallet as V6Wallet } from 'ethers';
import { providers as v5providers, Wallet as V5Wallet } from 'ethers-v5';
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  keccak256,
  parseTransaction,
  recoverTransactionAddress
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import type { Adapter, Hex } from '../../src/adapter.ts';
import type { ContractCallerOptions } from '../../src/internal/contract-caller.ts';

import { ChildERC20ABI } from '../../src/abi/index.ts';
import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { ContractCaller } from '../../src/internal/contract-caller.ts';
import { noopLogger } from '../../src/logger.ts';

/**
 * End-to-end SDK writes: `ContractCaller.write` → adapter → the REAL web3
 * library (contract populate, wallet signing) → `eth_sendRawTransaction`.
 * Only the JSON-RPC transport is stubbed; the broadcast raw transaction is
 * decoded and checked.
 *
 * `ContractCaller.write` always hands the adapter a `chainId` (the
 * caller's, or the chain the RPC reports), so these tests exercise exactly
 * what every SDK write sends. Adapter-level tests that call `write()`
 * without a chainId cannot see a library rejecting that field.
 *
 * The wrong-chain wallet case (UNSUPPORTED_NETWORK, nothing broadcast) is
 * covered in `adapter-signer-chain-guard.test.ts`.
 */

const AMOY = 80002;
const TOKEN = '0x3333333333333333333333333333333333333333';
const OTHER = '0x4444444444444444444444444444444444444444';
// Throwaway fixture key: signs locally, never touches a real network.
const TEST_KEY = `0x${'11'.repeat(32)}` as const;
const SIGNER = privateKeyToAccount(TEST_KEY).address;
const AMOUNT = 1234n;
const GWEI = 1_000_000_000n;

const toQuantity = (v: bigint): string => `0x${v.toString(16)}`;

/** One stub chain shared by every library: answers what a write needs. */
class StubChain {
  readonly rawTxs: Hex[] = [];
  readonly methods: string[] = [];

  answer(method: string, params: readonly unknown[]): unknown {
    this.methods.push(method);
    switch (method) {
      case 'eth_chainId':
        return toQuantity(BigInt(AMOY));
      case 'net_version':
        return String(AMOY);
      case 'eth_blockNumber':
        return '0x64';
      case 'eth_gasPrice':
        return toQuantity(40n * GWEI);
      case 'eth_maxPriorityFeePerGas':
        return toQuantity(30n * GWEI);
      case 'eth_getTransactionCount':
        return '0x7';
      case 'eth_estimateGas':
        return toQuantity(50_000n);
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
        const hex = raw as Hex;
        this.rawTxs.push(hex);
        return keccak256(hex);
      }
      default:
        // Answer like a real node (JSON-RPC "method not found") so a library
        // probing an optional method (viem's `eth_fillTransaction`) falls
        // back at once instead of retrying.
        throw Object.assign(new Error(`stub chain: unexpected RPC ${method}`), { code: -32601 });
    }
  }
}

// --- ethers v5: real StaticJsonRpcProvider + Wallet ------------------------

class V5StubProvider extends v5providers.StaticJsonRpcProvider {
  private readonly chain: StubChain;

  constructor(chain: StubChain) {
    super('http://stub.invalid', { chainId: AMOY, name: 'stub' });
    this.chain = chain;
  }

  override async send(method: string, params: unknown[]): Promise<unknown> {
    return this.chain.answer(method, params);
  }
}

// --- ethers v6: real JsonRpcProvider + Wallet -------------------------------

class V6StubProvider extends JsonRpcProvider {
  private readonly chain: StubChain;

  constructor(chain: StubChain) {
    super('http://stub.invalid', Network.from(AMOY), { staticNetwork: true, batchMaxCount: 1 });
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

// --- harnesses ---------------------------------------------------------------

const v5Adapter = (chain: StubChain): Adapter => {
  const provider = new V5StubProvider(chain);
  return ethersV5Adapter({ provider, signer: new V5Wallet(TEST_KEY, provider) });
};

const v6Adapter = (chain: StubChain): Adapter => {
  const provider = new V6StubProvider(chain);
  return ethersV6Adapter({ provider, signer: new V6Wallet(TEST_KEY, provider) });
};

const viemStubAdapter = (chain: StubChain): Adapter => {
  const transport = custom({
    request: async ({ method, params }: { method: string; params?: unknown }) =>
      chain.answer(method, Array.isArray(params) ? params : [])
  });
  return viemAdapter({
    public: createPublicClient({ transport }),
    wallet: createWalletClient({ account: privateKeyToAccount(TEST_KEY), transport })
  });
};

const harnesses: Array<[string, (chain: StubChain) => Adapter]> = [
  ['ethers v5', v5Adapter],
  ['ethers v6', v6Adapter],
  ['viem', viemStubAdapter]
];

const withdrawVia = (adapter: Adapter, options: ContractCallerOptions) =>
  new ContractCaller({
    adapter,
    getAddress: () => Promise.resolve(TOKEN),
    abi: ChildERC20ABI,
    isParent: false,
    logger: noopLogger
  }).write('withdraw', [AMOUNT], options);

const settle = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e
  );

const isEip1559Raw = (raw: Hex): raw is `0x02${string}` => raw.startsWith('0x02');

/** Decode the single broadcast transaction and check what was signed. */
const expectOneWithdrawBroadcast = async (chain: StubChain): Promise<void> => {
  expect(chain.rawTxs).lengthOf(1);
  const [raw] = chain.rawTxs;
  if (raw === undefined || !isEip1559Raw(raw)) {
    throw new Error(`expected one EIP-1559 raw transaction, got ${String(raw)}`);
  }
  const tx = parseTransaction(raw);
  expect(tx).property('chainId').equals(AMOY);
  expect(tx).property('to').equals(TOKEN);
  expect(tx).property('type').equals('eip1559');
  expect(await recoverTransactionAddress({ serializedTransaction: raw })).equals(SIGNER);
  if (tx.data === undefined) throw new Error('broadcast transaction has no calldata');
  const call = decodeFunctionData({ abi: ChildERC20ABI, data: tx.data });
  expect(call).property('functionName').equals('withdraw');
  expect(call).nested.property('args[0]').equals(AMOUNT);
};

describe.each(harnesses)('%s adapter — end-to-end SDK write', (_name, build) => {
  it('broadcasts once on the default path (no chainId option, gas estimated)', async () => {
    const chain = new StubChain();
    const result = await withdrawVia(build(chain), {});
    await expectOneWithdrawBroadcast(chain);
    expect(result)
      .property('hash')
      .equals(chain.rawTxs.map((r) => keccak256(r))[0]);
  });

  it('broadcasts once with an explicit chainId option', async () => {
    const chain = new StubChain();
    await withdrawVia(build(chain), { chainId: AMOY, gasLimit: 100_000n });
    await expectOneWithdrawBroadcast(chain);
  });

  it('broadcasts once when `from` is the signing wallet address (any casing)', async () => {
    const chain = new StubChain();
    await withdrawVia(build(chain), { from: SIGNER.toLowerCase() as Hex, gasLimit: 100_000n });
    await expectOneWithdrawBroadcast(chain);
  });
});

// ethers signers only ever send as themselves: a different `from` is
// rejected by the library before anything is signed.
describe.each(harnesses.filter(([name]) => name !== 'viem'))(
  '%s adapter — `from` that is not the signer',
  (_name, build) => {
    it('refuses, with nothing broadcast', async () => {
      const chain = new StubChain();
      const err = await settle(withdrawVia(build(chain), { from: OTHER, gasLimit: 100_000n }));
      expect(err).instanceOf(Error);
      expect(chain.rawTxs).lengthOf(0);
      expect(chain.methods).not.include('eth_sendTransaction');
    });
  }
);

describe('ethers v5 adapter — estimateGas with a pinned chainId', () => {
  it('estimates through the real contract path without rejecting the chainId', async () => {
    const chain = new StubChain();
    const gas = await v5Adapter(chain).estimateGas({
      address: TOKEN,
      abi: ChildERC20ABI,
      functionName: 'withdraw',
      args: [AMOUNT],
      chainId: AMOY
    });
    expect(gas).equals(50_000n);
  });
});
