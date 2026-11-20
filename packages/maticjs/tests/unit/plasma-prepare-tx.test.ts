import type { JsonRpcPayload, JsonRpcResult } from 'ethers';

import { JsonRpcProvider, Network, Wallet as V6Wallet } from 'ethers';
import { providers as v5providers, Wallet as V5Wallet } from 'ethers-v5';
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeAbiParameters,
  keccak256,
  parseTransaction,
  toFunctionSelector
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Hex, PreparedTx, TxResult } from '../../src/adapter.ts';
import type { PlasmaAddresses } from '../../src/plasma/addresses.ts';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { ExitProofBuilder } from '../../src/internal/exit-proof.ts';
import { L1_CHAIN_ID, L2_CHAIN_ID } from '../../src/networks.ts';
import { PlasmaClient } from '../../src/plasma/plasma-client.ts';

/**
 * Prepare/write parity for every Plasma write, on all three adapters.
 *
 * `prepareXxx` hands back the unsigned `{ to, data, value? }` a wallet will
 * sign, so a prepared call that differs from the call the SDK itself sends
 * is a funds-moving bug that no other test would see. For each write, the
 * same call is made twice on a fresh client: prepared, and written through a
 * real adapter with a local signer. The signed transaction the chain stub
 * receives is parsed back, and its `to`, `data` and `value` must equal the
 * prepared ones.
 *
 * Only the JSON-RPC transport is stubbed. Encoding, fee and nonce handling
 * and signing are each library's own. The exit payload is a fixed value,
 * because building one is the golden test's job.
 */

const AMOY_PARENT = L1_CHAIN_ID.amoy;
const AMOY_CHILD = L2_CHAIN_ID.amoy;
// Throwaway fixture key: signs locally, never touches a real network.
const TEST_KEY = `0x${'11'.repeat(32)}` as const;
const ACCOUNT = privateKeyToAccount(TEST_KEY);
const GWEI = 1_000_000_000n;
const BLOCK_HASH = `0x${'aa'.repeat(32)}`;
const PAYLOAD: Hex = '0x1234abcd';
const BURN = `0x${'ab'.repeat(32)}`;
const USER: Hex = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const QUEUE: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NATIVE_CHILD: Hex = '0x0000000000000000000000000000000000001010';
const PARENT_TOKEN: Hex = '0x9999999999999999999999999999999999999999';
const CHILD_TOKEN: Hex = '0x8888888888888888888888888888888888888888';

const ADDRESSES: PlasmaAddresses = {
  RootChain: '0x1111111111111111111111111111111111111111',
  DepositManager: '0x2222222222222222222222222222222222222222',
  WithdrawManager: '0x3333333333333333333333333333333333333333',
  PlasmaERC20Predicate: '0x5555555555555555555555555555555555555555',
  ExitNFT: '0x4444444444444444444444444444444444444444',
  MaticToken: '0x6666666666666666666666666666666666666666',
  PolToken: '0x7777777777777777777777777777777777777777'
};

const toQuantity = (v: bigint | number): string => `0x${v.toString(16)}`;
const word = (v: Hex | bigint): Hex =>
  encodeAbiParameters([typeof v === 'bigint' ? { type: 'uint256' } : { type: 'address' }], [v]);

const EXITS_QUEUES = toFunctionSelector('function exitsQueues(address)');
const CURRENT_SIZE = toFunctionSelector('function currentSize()');

const block = (number: bigint): Record<string, unknown> => ({
  hash: BLOCK_HASH,
  parentHash: `0x${'bb'.repeat(32)}`,
  sha3Uncles: `0x${'cc'.repeat(32)}`,
  stateRoot: `0x${'dd'.repeat(32)}`,
  transactionsRoot: `0x${'ee'.repeat(32)}`,
  receiptsRoot: `0x${'ff'.repeat(32)}`,
  mixHash: `0x${'00'.repeat(32)}`,
  logsBloom: `0x${'00'.repeat(256)}`,
  number: toQuantity(number),
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
});

/** One chain that records every transaction a signer broadcasts to it. */
class Chain {
  readonly rawTxs: Hex[] = [];
  private readonly chainId: number;

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  answer(method: string, params: readonly unknown[]): unknown {
    switch (method) {
      case 'eth_chainId':
        return toQuantity(this.chainId);
      case 'net_version':
        return String(this.chainId);
      case 'eth_blockNumber':
        return toQuantity(100);
      case 'eth_gasPrice':
        return toQuantity(40n * GWEI);
      case 'eth_maxPriorityFeePerGas':
        return toQuantity(30n * GWEI);
      case 'eth_getTransactionCount':
        return toQuantity(7);
      case 'eth_estimateGas':
        return toQuantity(100_000n);
      case 'eth_getBlockByNumber':
        return block(100n);
      case 'eth_call': {
        const call = params[0];
        const data: unknown =
          typeof call === 'object' && call !== null ? Reflect.get(call, 'data') : undefined;
        if (typeof data === 'string' && data.startsWith(EXITS_QUEUES)) return word(QUEUE);
        if (typeof data === 'string' && data.startsWith(CURRENT_SIZE)) return word(1n);
        throw new Error(`stub chain: unscripted eth_call ${String(data)}`);
      }
      case 'eth_sendRawTransaction': {
        const sent = params[0];
        if (typeof sent !== 'string' || !sent.startsWith('0x')) {
          throw new Error('stub chain: malformed raw transaction');
        }
        const raw: Hex = `0x${sent.slice(2)}`;
        this.rawTxs.push(raw);
        return keccak256(raw);
      }
      case 'eth_getTransactionByHash':
        // The broadcast transaction is known and mined; nothing here waits for it.
        return {
          hash: params[0],
          blockHash: BLOCK_HASH,
          blockNumber: '0x64',
          transactionIndex: '0x0'
        };
      default:
        // -32601 is "method not found": viem does not retry it, and falls back
        // from `eth_fillTransaction` to filling the fields itself.
        throw Object.assign(new Error(`stub chain: unexpected RPC ${method}`), { code: -32601 });
    }
  }
}

class V5StubProvider extends v5providers.StaticJsonRpcProvider {
  private readonly chain: Chain;
  constructor({ chain, chainId }: { chain: Chain; chainId: number }) {
    super('http://stub.invalid', { chainId, name: 'stub' });
    this.chain = chain;
  }
  override async send(method: string, params: unknown[]): Promise<unknown> {
    return this.chain.answer(method, params);
  }
}

class V6StubProvider extends JsonRpcProvider {
  private readonly chain: Chain;
  constructor({ chain, chainId }: { chain: Chain; chainId: number }) {
    super('http://stub.invalid', Network.from(chainId), { staticNetwork: true, batchMaxCount: 1 });
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

const LIBRARIES: ReadonlyArray<{
  name: string;
  build: (args: { chain: Chain; chainId: number }) => Adapter;
}> = [
  {
    name: 'viem',
    build: ({ chain }) => {
      const transport = custom({
        request: async ({ method, params }: { method: string; params?: unknown }) =>
          chain.answer(method, Array.isArray(params) ? params : [])
      });
      return viemAdapter({
        public: createPublicClient({ transport }),
        wallet: createWalletClient({ account: ACCOUNT, transport })
      });
    }
  },
  {
    name: 'ethers v5',
    build: ({ chain, chainId }) => {
      const provider = new V5StubProvider({ chain, chainId });
      return ethersV5Adapter({ provider, signer: new V5Wallet(TEST_KEY, provider) });
    }
  },
  {
    name: 'ethers v6',
    build: ({ chain, chainId }) => {
      const provider = new V6StubProvider({ chain, chainId });
      return ethersV6Adapter({ provider, signer: new V6Wallet(TEST_KEY, provider) });
    }
  }
];

interface Operation {
  name: string;
  /** The chain the transaction is signed for. */
  side: 'parent' | 'child';
  write: (plasma: PlasmaClient) => Promise<TxResult>;
  prepare: (plasma: PlasmaClient) => Promise<PreparedTx>;
  /** The client is built with a proof API URL (the fast confirm needs one). */
  fast?: boolean;
  /** `value` the transaction must carry. */
  value?: bigint;
}

const parentToken = (plasma: PlasmaClient, token: Hex = PARENT_TOKEN) => plasma.parent.erc20(token);
const childToken = (plasma: PlasmaClient, token: Hex = CHILD_TOKEN) => plasma.child.erc20(token);

const OPERATIONS: Operation[] = [
  {
    name: 'approve',
    side: 'parent',
    write: (p) => parentToken(p).approve(5n),
    prepare: (p) => parentToken(p).prepareApprove(5n)
  },
  {
    name: 'approveMax',
    side: 'parent',
    write: (p) => parentToken(p).approveMax(),
    prepare: (p) => parentToken(p).prepareApproveMax()
  },
  {
    name: 'deposit',
    side: 'parent',
    write: (p) => parentToken(p).deposit(5n, USER),
    prepare: (p) => parentToken(p).prepareDeposit(5n, USER)
  },
  {
    name: 'startWithdraw (child ERC-20)',
    side: 'child',
    write: (p) => childToken(p).startWithdraw(5n),
    prepare: (p) => childToken(p).prepareStartWithdraw(5n)
  },
  {
    name: 'startWithdraw (native token, value = amount)',
    side: 'child',
    value: 5n,
    write: (p) => childToken(p, NATIVE_CHILD).startWithdraw(5n),
    prepare: (p) => childToken(p, NATIVE_CHILD).prepareStartWithdraw(5n)
  },
  {
    name: 'confirmWithdraw',
    side: 'parent',
    write: (p) => parentToken(p).confirmWithdraw(BURN),
    prepare: (p) => parentToken(p).prepareConfirmWithdraw(BURN)
  },
  {
    name: 'confirmWithdrawFast',
    side: 'parent',
    fast: true,
    write: (p) => parentToken(p).confirmWithdrawFast(BURN),
    prepare: (p) => parentToken(p).prepareConfirmWithdrawFast(BURN)
  },
  {
    name: 'completeWithdraw',
    side: 'parent',
    write: (p) => parentToken(p).completeWithdraw(),
    prepare: (p) => parentToken(p).prepareCompleteWithdraw()
  },
  {
    name: 'processExits (one token)',
    side: 'parent',
    write: (p) => p.processExits({ tokens: [PARENT_TOKEN] }),
    prepare: (p) => p.prepareProcessExits({ tokens: [PARENT_TOKEN] })
  },
  {
    name: 'processExits (two tokens)',
    side: 'parent',
    write: (p) => p.processExits({ tokens: [PARENT_TOKEN, CHILD_TOKEN] }),
    prepare: (p) => p.prepareProcessExits({ tokens: [PARENT_TOKEN, CHILD_TOKEN] })
  }
];

describe('plasma prepare/write parity', { timeout: 20_000 }, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const library of LIBRARIES) {
    describe(`under ${library.name}`, () => {
      for (const operation of OPERATIONS) {
        it(`${operation.name}: the prepared call is the call that is signed and sent`, async () => {
          vi.spyOn(ExitProofBuilder.prototype, 'buildExitPayload').mockResolvedValue(PAYLOAD);
          const parentChain = new Chain(AMOY_PARENT);
          const childChain = new Chain(AMOY_CHILD);
          const plasma = await PlasmaClient.init({
            network: 'amoy',
            parent: library.build({ chain: parentChain, chainId: AMOY_PARENT }),
            child: library.build({ chain: childChain, chainId: AMOY_CHILD }),
            addresses: ADDRESSES,
            ...(operation.fast === true
              ? { proofGenerationApiUrl: 'https://proof.example.test' }
              : {})
          });

          const prepared = await operation.prepare(plasma);
          const sentOn = operation.side === 'parent' ? parentChain : childChain;
          const other = operation.side === 'parent' ? childChain : parentChain;
          expect(sentOn.rawTxs, 'preparing must not broadcast').lengthOf(0);

          await operation.write(plasma);

          const raw = sentOn.rawTxs[0];
          if (raw === undefined) throw new Error('the write broadcast nothing');
          expect(sentOn.rawTxs).lengthOf(1);
          expect(other.rawTxs, 'the write went to the other chain').lengthOf(0);
          const sent = parseTransaction(raw);
          expect(sent.data).equals(prepared.data);
          expect(sent.to?.toLowerCase()).equals(prepared.to.toLowerCase());
          expect(sent.value ?? 0n).equals(prepared.value ?? 0n);
          expect(prepared.value ?? 0n).equals(operation.value ?? 0n);
          expect(sent.chainId).equals(operation.side === 'parent' ? AMOY_PARENT : AMOY_CHILD);
        });
      }
    });
  }
});
