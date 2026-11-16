import type { JsonRpcPayload, JsonRpcResult } from 'ethers';

import { JsonRpcProvider, Network, Wallet as V6Wallet } from 'ethers';
import { providers as v5providers, Wallet as V5Wallet } from 'ethers-v5';
import { createPublicClient, createWalletClient, custom, keccak256, parseTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import type { Adapter, Hex } from '../../src/adapter.ts';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { rootCause, TransactionReplacedError, TransactionRevertedError } from '../../src/errors.ts';
import { noopLogger } from '../../src/logger.ts';
import { ERC20 } from '../../src/pos/erc20.ts';
import { RootChainManager } from '../../src/pos/root_chain_manager.ts';
import {
  expectLibraryErrorByIdentity,
  expectNoLibraryCause,
  recordingAdapter
} from './library-errors.ts';

/**
 * Falsification matrix, revert row: a withdrawal exit that reverts, seen
 * by a consumer through the public API only.
 *
 * `ERC20.completeWithdraw` runs over a REAL `RootChainManager`, the REAL
 * adapter and the REAL web3 library (contract encoding, local signing,
 * receipt waiting). Only the JSON-RPC transport is stubbed, and the exit
 * payload is a fixed `'0x1234'` from a stub bridge, because building one is
 * the proof row's job, not this one's.
 *
 * Who reports the revert decides what the consumer gets. ethers rejects
 * its wait (CALL_EXCEPTION) and a node rejects estimateGas: those library
 * errors reach the consumer as the same object, unwrapped. viem resolves a
 * mined revert as a receipt and says nothing, so the SDK detects it and
 * raises ConfirmationError over TransactionRevertedError, with no library
 * error anywhere below it.
 *
 * SDK errors are recognised the way a consumer is told to: by name, through
 * the finder. This file never uses `instanceof` on them, so it passes
 * against a second copy of the package as well as against this one.
 *
 * The same holds for a replacement (a cancel mined at the exit's nonce):
 * ethers rejects its wait with TRANSACTION_REPLACED, passed through as-is;
 * viem reports it only through `onReplaced`, so the SDK raises
 * TransactionReplacedError.
 *
 * Part of the enforcement of AGENTS.md, "Error ownership (mandatory)": the
 * rows asserting the thrown object IS the library's must stay green and
 * must not be weakened.
 */

const AMOY = 80002;
const TOKEN = '0x3333333333333333333333333333333333333333';
const ROOT_CHAIN_MANAGER = '0x1111111111111111111111111111111111111111';
const BURN_TX = `0x${'ab'.repeat(32)}`;
// Throwaway fixture key: signs locally, never touches a real network.
const TEST_KEY = `0x${'11'.repeat(32)}` as const;
const ACCOUNT = privateKeyToAccount(TEST_KEY);
const SIGNER = ACCOUNT.address;
const GWEI = 1_000_000_000n;
const BLOCK_HASH = `0x${'aa'.repeat(32)}`;
const POLL_MS = 20;
const COOLDOWN = 'execution reverted: Cooldown';

const toQuantity = (v: bigint | number): string => `0x${v.toString(16)}`;

/** A node error as a JSON-RPC transport raises it: message plus numeric code. */
const rpcError = (code: number, message: string): Error =>
  Object.assign(new Error(message), { code });

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

/**
 * A chain that mines every broadcast transaction in block 100 with
 * status 0. `estimateGasError`, when set, is what `eth_estimateGas`
 * rejects with instead (a pre-send revert).
 */
class RevertingChain {
  readonly rawTxs: Hex[] = [];
  receiptCalls = 0;
  private readonly estimateGasError: Error | undefined;

  constructor({ estimateGasError }: { estimateGasError?: Error } = {}) {
    this.estimateGasError = estimateGasError;
  }

  answer(method: string, params: readonly unknown[]): unknown {
    const raw = this.rawTxs[0];
    const hash = raw === undefined ? undefined : keccak256(raw);
    switch (method) {
      case 'eth_chainId':
        return toQuantity(AMOY);
      case 'net_version':
        return String(AMOY);
      case 'eth_blockNumber':
        return toQuantity(100);
      case 'eth_gasPrice':
        return toQuantity(40n * GWEI);
      case 'eth_maxPriorityFeePerGas':
        return toQuantity(30n * GWEI);
      case 'eth_getTransactionCount':
        return toQuantity(7);
      case 'eth_estimateGas':
        if (this.estimateGasError !== undefined) throw this.estimateGasError;
        return toQuantity(100_000n);
      case 'eth_getBlockByNumber':
        return block(100n);
      case 'eth_sendRawTransaction': {
        const sent = params[0];
        if (typeof sent !== 'string' || !sent.startsWith('0x')) {
          throw new Error('stub chain: malformed raw transaction');
        }
        const hex = sent as Hex;
        this.rawTxs.push(hex);
        return keccak256(hex);
      }
      case 'eth_getTransactionByHash':
        // ethers only needs to know the transaction is mined; the receipt
        // carries the outcome.
        return hash !== undefined && params[0] === hash
          ? { hash, blockHash: BLOCK_HASH, blockNumber: '0x64', transactionIndex: '0x0' }
          : null;
      case 'eth_getTransactionReceipt':
        if (hash === undefined || params[0] !== hash) return null;
        this.receiptCalls++;
        return {
          transactionHash: hash,
          transactionIndex: '0x0',
          blockHash: BLOCK_HASH,
          blockNumber: '0x64',
          from: SIGNER.toLowerCase(),
          to: ROOT_CHAIN_MANAGER,
          cumulativeGasUsed: '0xc350',
          gasUsed: '0xc350',
          effectiveGasPrice: toQuantity(40n * GWEI),
          contractAddress: null,
          logs: [],
          logsBloom: `0x${'00'.repeat(256)}`,
          status: '0x0',
          type: '0x2'
        };
      default:
        throw rpcError(-32601, `stub chain: unexpected RPC ${method}`);
    }
  }
}

/** The nonce the stub chain reports for the signer before anything mines. */
const NONCE = 7;

/** JSON-RPC transaction object for a signed raw transaction. */
const txJson = (raw: Hex, mined: boolean): Record<string, unknown> => {
  const tx = parseTransaction(raw);
  const yParity = toQuantity(tx.yParity ?? 0);
  return {
    hash: keccak256(raw),
    type: '0x2',
    chainId: toQuantity(AMOY),
    nonce: toQuantity(tx.nonce ?? 0),
    from: SIGNER.toLowerCase(),
    to: tx.to?.toLowerCase() ?? null,
    value: toQuantity(tx.value ?? 0n),
    input: tx.data ?? '0x',
    gas: toQuantity(tx.gas ?? 0n),
    gasPrice: toQuantity(tx.maxFeePerGas ?? 0n),
    maxFeePerGas: toQuantity(tx.maxFeePerGas ?? 0n),
    maxPriorityFeePerGas: toQuantity(tx.maxPriorityFeePerGas ?? 0n),
    accessList: [],
    r: tx.r,
    s: tx.s,
    v: yParity,
    yParity,
    blockHash: mined ? BLOCK_HASH : null,
    blockNumber: mined ? '0x64' : null,
    transactionIndex: mined ? '0x0' : null
  };
};

/** A wallet's "cancel": a 0-value self-send at the broadcast transaction's nonce. */
const signCancel = (): Promise<Hex> =>
  ACCOUNT.signTransaction({
    chainId: AMOY,
    type: 'eip1559',
    nonce: NONCE,
    to: SIGNER,
    data: '0x',
    value: 0n,
    gas: 21_000n,
    maxFeePerGas: 200n * GWEI,
    maxPriorityFeePerGas: 100n * GWEI
  });

/**
 * A chain on which, once the exit is broadcast, a cancel at the same nonce
 * mines in block 100 instead: the exit itself never mines.
 */
class ReplacedChain extends RevertingChain {
  private readonly cancel: Hex;

  constructor(cancel: Hex) {
    super();
    this.cancel = cancel;
  }

  override answer(method: string, params: readonly unknown[]): unknown {
    const broadcast = this.rawTxs[0];
    if (broadcast === undefined) return super.answer(method, params);
    const cancelHash = keccak256(this.cancel);
    switch (method) {
      case 'eth_getTransactionCount':
        return toQuantity(NONCE + 1);
      case 'eth_getBlockByNumber': {
        const tag = params[0];
        const number = typeof tag === 'string' && tag.startsWith('0x') ? BigInt(tag) : 100n;
        const full = params[1] === true;
        return {
          ...block(number),
          transactions: number === 100n ? [full ? txJson(this.cancel, true) : cancelHash] : []
        };
      }
      case 'eth_getTransactionByHash':
        if (params[0] === keccak256(broadcast)) return txJson(broadcast, false);
        return params[0] === cancelHash ? txJson(this.cancel, true) : null;
      case 'eth_getTransactionReceipt':
        if (params[0] !== cancelHash) return null;
        return {
          transactionHash: cancelHash,
          transactionIndex: '0x0',
          blockHash: BLOCK_HASH,
          blockNumber: '0x64',
          from: SIGNER.toLowerCase(),
          to: SIGNER.toLowerCase(),
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          effectiveGasPrice: toQuantity(40n * GWEI),
          contractAddress: null,
          logs: [],
          logsBloom: `0x${'00'.repeat(256)}`,
          status: '0x1',
          type: '0x2'
        };
      default:
        return super.answer(method, params);
    }
  }
}

// --- transports: the only stubbed layer --------------------------------------

class V5StubProvider extends v5providers.StaticJsonRpcProvider {
  private readonly chain: RevertingChain;

  constructor(chain: RevertingChain) {
    super('http://stub.invalid', { chainId: AMOY, name: 'stub' });
    this.chain = chain;
    this.pollingInterval = POLL_MS;
  }

  override async send(method: string, params: unknown[]): Promise<unknown> {
    return this.chain.answer(method, params);
  }
}

class V6StubProvider extends JsonRpcProvider {
  private readonly chain: RevertingChain;

  constructor(chain: RevertingChain) {
    super('http://stub.invalid', Network.from(AMOY), {
      staticNetwork: true,
      batchMaxCount: 1,
      pollingInterval: POLL_MS
    });
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

const v5Adapter = (chain: RevertingChain): Adapter => {
  const provider = new V5StubProvider(chain);
  return ethersV5Adapter({ provider, signer: new V5Wallet(TEST_KEY, provider) });
};

const v6Adapter = (chain: RevertingChain): Adapter => {
  const provider = new V6StubProvider(chain);
  return ethersV6Adapter({ provider, signer: new V6Wallet(TEST_KEY, provider) });
};

const viemStubAdapter = (chain: RevertingChain): Adapter => {
  const transport = custom({
    request: async ({ method, params }: { method: string; params?: unknown }) =>
      chain.answer(method, Array.isArray(params) ? params : [])
  });
  return viemAdapter({
    public: createPublicClient({ transport, pollingInterval: POLL_MS }),
    wallet: createWalletClient({ account: ACCOUNT, transport })
  });
};

type Library = 'ethers v5' | 'ethers v6' | 'viem';

const harnesses: Array<[Library, (chain: RevertingChain) => Adapter]> = [
  ['ethers v5', v5Adapter],
  ['ethers v6', v6Adapter],
  ['viem', viemStubAdapter]
];

/** An ERC20 on the parent chain whose exit goes through the real RootChainManager. */
const parentToken = (adapter: Adapter): ERC20 =>
  new ERC20({
    tokenAddress: TOKEN,
    isParent: true,
    adapter,
    parentAdapter: adapter,
    // Only `buildExitPayload` is reached on this path. `as never` is the
    // one cast: the bridge is a test seam, not part of what is falsified.
    bridge: { buildExitPayload: () => Promise.resolve('0x1234') } as never,
    rootChainManager: new RootChainManager({
      adapter,
      getAddress: () => Promise.resolve(ROOT_CHAIN_MANAGER),
      logger: noopLogger
    }),
    encodeParameters: () => '0x',
    logger: noopLogger
  });

/**
 * Structural, not `instanceof`: an error from another copy of a library
 * (or of this package) is still an error with a message and a stack.
 */
const isErrorLike = (value: unknown): value is Error =>
  typeof value === 'object' &&
  value !== null &&
  typeof Reflect.get(value, 'message') === 'string' &&
  typeof Reflect.get(value, 'stack') === 'string';

const settle = (p: Promise<unknown>): Promise<Error> =>
  p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => {
      if (!isErrorLike(e)) throw new Error('expected an Error-shaped rejection');
      return e;
    }
  );

describe.each(harnesses)('%s — completeWithdraw mined with status 0', (library, build) => {
  it('confirmed() rejects: the library error as-is for ethers, TransactionRevertedError for viem', async () => {
    const chain = new RevertingChain();
    const { adapter, thrown } = recordingAdapter(build(chain));
    const result = await parentToken(adapter).completeWithdraw(BURN_TX);
    expect(chain.rawTxs).lengthOf(1);

    const err = await settle(result.confirmed());

    if (library !== 'viem') {
      // ethers rejects its wait with CALL_EXCEPTION: that object is what
      // the consumer gets, carrying the receipt.
      expectLibraryErrorByIdentity({ err, thrown });
      expect(err).property('code').equals('CALL_EXCEPTION');
      expect(err).nested.property('receipt.status').equals(0);
      return;
    }
    expect(err).property('name').equals('ConfirmationError');
    expect(err).nested.property('info.operation').equals('confirmed');
    expect(err).nested.property('info.transactionHash').equals(result.hash);
    const reverted = TransactionRevertedError.find(err);
    if (reverted === null) throw new Error('TransactionRevertedError not found by name');
    expect(reverted).property('name').equals('TransactionRevertedError');
    expect(reverted).nested.property('info.transactionHash').equals(result.hash);
    expect(reverted).nested.property('info.receipt.status').equals('reverted');
    // viem resolves a mined revert as a receipt; it raises no error of its
    // own, so the receipt in `info` is the whole record.
    expect(reverted.cause).equals(undefined);
    expect(rootCause(err)).property('name').equals('TransactionRevertedError');
    expectNoLibraryCause(err);
  });

  it('a second confirmed() rejects with the same error, without waiting again', async () => {
    const chain = new RevertingChain();
    const result = await parentToken(build(chain)).completeWithdraw(BURN_TX);

    const first = await settle(result.confirmed());
    const callsAfterFirst = chain.receiptCalls;
    const second = await settle(result.confirmed());

    expect(second).equals(first);
    expect(callsAfterFirst).greaterThan(0);
    expect(chain.receiptCalls).equals(callsAfterFirst);
  });
});

describe('viem — the SDK-detected revert survives a JSON round-trip', () => {
  it('is still found by name', async () => {
    const chain = new RevertingChain();
    const result = await parentToken(viemStubAdapter(chain)).completeWithdraw(BURN_TX);
    const err = await settle(result.confirmed());

    const parsed: unknown = JSON.parse(JSON.stringify(err));

    expect(parsed).property('name').equals('ConfirmationError');
    const reverted = TransactionRevertedError.find(parsed);
    if (reverted === null) throw new Error('TransactionRevertedError not found after JSON');
    expect(reverted).nested.property('info.transactionHash').equals(result.hash);
    expect(reverted).nested.property('info.receipt.status').equals('reverted');
    // JSON has no bigint: the block number reads back as its decimal string.
    expect(reverted).nested.property('info.receipt.blockNumber').equals('100');
  });
});

describe.each(harnesses)('%s — a pre-send revert (eth_estimateGas rejects)', (_library, build) => {
  it('rejects completeWithdraw with the library error as-is, the node revert text at its root', async () => {
    const chain = new RevertingChain({ estimateGasError: rpcError(3, COOLDOWN) });
    const { adapter, thrown } = recordingAdapter(build(chain));

    const err = await settle(parentToken(adapter).completeWithdraw(BURN_TX));

    expectLibraryErrorByIdentity({ err, thrown });
    expect(rootCause(err)).property('message').contains(COOLDOWN);
    expect(chain.rawTxs).lengthOf(0);
  });
});

describe.each(harnesses)(
  '%s — error ownership: the exit is replaced by a cancel before it mines',
  (library, build) => {
    it(
      'confirmed() rejects: the library error as-is for ethers, TransactionReplacedError for viem',
      { timeout: 10_000 },
      async () => {
        const cancel = await signCancel();
        const chain = new ReplacedChain(cancel);
        const { adapter, thrown } = recordingAdapter(build(chain));
        const result = await parentToken(adapter).completeWithdraw(BURN_TX);
        expect(chain.rawTxs).lengthOf(1);

        const err = await settle(result.confirmed());

        if (library !== 'viem') {
          // ethers rejects its wait with TRANSACTION_REPLACED: that object is
          // what the consumer gets.
          expectLibraryErrorByIdentity({ err, thrown });
          expect(err).property('code').equals('TRANSACTION_REPLACED');
          expect(err).property('reason').equals('cancelled');
          // What only ethers' own object carries: the transaction that mined.
          expect(err).nested.property('replacement.hash').equals(keccak256(cancel));
          return;
        }
        // An SDK condition by design: viem resolves the cancel's receipt and
        // reports the replacement only through `onReplaced`, raising no error
        // of its own, so the SDK detects it and owns the error.
        expect(err).property('name').equals('ConfirmationError');
        const replaced = TransactionReplacedError.find(err);
        if (replaced === null) throw new Error('TransactionReplacedError not found by name');
        expect(replaced).nested.property('info.transactionHash').equals(result.hash);
        expect(replaced).nested.property('info.reason').equals('cancelled');
        expect(replaced.cause).equals(undefined);
        expectNoLibraryCause(err);
      }
    );
  }
);
