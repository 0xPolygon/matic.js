import type { JsonRpcPayload, JsonRpcResult } from 'ethers';

import { JsonRpcProvider, Network, TransactionResponse, Wallet as V6Wallet } from 'ethers';
import { providers as v5providers, Wallet as V5Wallet } from 'ethers-v5';
import { createPublicClient, createWalletClient, custom, keccak256, parseTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Hex } from '../../src/adapter.ts';

import { ChildERC20ABI } from '../../src/abi/index.ts';
import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import {
  ConfirmationError,
  isMaticjsError,
  TransactionNotFoundError,
  TransactionReplacedError,
  TransactionRevertedError,
  Web3ClientNotInitializedError
} from '../../src/errors.ts';
import { expectNoLibraryCause } from './library-errors.ts';

/**
 * What `TxResult.confirmed()` does once the transaction is mined (or
 * replaced), for every adapter. The real web3 libraries do all of it:
 * contract populate, signing, receipt waiting, replacement scanning. Only
 * the JSON-RPC transport is stubbed.
 *
 * A reverted transaction must REJECT. Resolving with `status: 'reverted'`
 * meant a consumer treating "receipt arrived" as success silently recorded
 * a failed bridge transaction as done.
 *
 * Who reports the revert or replacement decides what the rejection is.
 * ethers rejects its own wait with CALL_EXCEPTION / TRANSACTION_REPLACED:
 * that library error is rethrown as-is. viem resolves the receipt and says
 * nothing, so the SDK detects the condition itself and raises
 * ConfirmationError over TransactionRevertedError / TransactionReplacedError.
 */

const AMOY = 80002;
const TOKEN = '0x3333333333333333333333333333333333333333';
// Throwaway fixture key: signs locally, never touches a real network.
const TEST_KEY = `0x${'11'.repeat(32)}` as const;
const ACCOUNT = privateKeyToAccount(TEST_KEY);
const SIGNER = ACCOUNT.address;
const GWEI = 1_000_000_000n;
const BLOCK_HASH = `0x${'aa'.repeat(32)}`;
const NONCE = 7;
// Fast polling so the libraries' replacement watchers tick quickly.
const POLL_MS = 20;

const toQuantity = (v: bigint | number): string => `0x${v.toString(16)}`;

type Outcome = 'success' | 'reverted' | 'replaced';

/** JSON-RPC transaction object for a signed raw transaction. */
const txJson = (raw: Hex, mined: boolean): Record<string, unknown> => {
  const tx = parseTransaction(raw);
  const yParity = toQuantity(tx.yParity ?? 0);
  return {
    hash: keccak256(raw),
    type: '0x2',
    chainId: toQuantity(AMOY),
    nonce: toQuantity(tx.nonce ?? 0),
    // Lowercase, as a node returns addresses.
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

const receiptJson = (hash: string, status: '0x0' | '0x1'): Record<string, unknown> => ({
  transactionHash: hash,
  transactionIndex: '0x0',
  blockHash: BLOCK_HASH,
  blockNumber: '0x64',
  from: SIGNER.toLowerCase(),
  to: TOKEN,
  cumulativeGasUsed: '0xc350',
  gasUsed: '0xc350',
  effectiveGasPrice: toQuantity(40n * GWEI),
  contractAddress: null,
  logs: [],
  logsBloom: `0x${'00'.repeat(256)}`,
  status,
  type: '0x2'
});

const signAtNonce = async (fields: {
  to: Hex;
  data: Hex;
  value: bigint;
  gas: bigint;
}): Promise<Hex> =>
  ACCOUNT.signTransaction({
    chainId: AMOY,
    type: 'eip1559',
    nonce: NONCE,
    ...fields,
    maxFeePerGas: 200n * GWEI,
    maxPriorityFeePerGas: 100n * GWEI
  });

/** A 0-value self-send at the same nonce: what a wallet's "cancel" sends. */
const signCancel = (): Promise<Hex> =>
  signAtNonce({ to: SIGNER, data: '0x', value: 0n, gas: 21_000n });

/** A different call at the same nonce: the sender replaced the transaction. */
const signOther = (): Promise<Hex> =>
  signAtNonce({ to: TOKEN, data: '0xdeadbeef', value: 0n, gas: 50_000n });

/** The same call re-sent at the same nonce with higher fees: a speed-up. */
const signRepriced = (sentRaw: Hex): Promise<Hex> => {
  const sent = parseTransaction(sentRaw);
  if (sent.to === undefined || sent.to === null || sent.gas === undefined) {
    throw new Error('stub chain: broadcast transaction is missing to/gas');
  }
  return signAtNonce({
    to: sent.to,
    data: sent.data ?? '0x',
    value: sent.value ?? 0n,
    gas: sent.gas
  });
};

/**
 * One stub chain shared by every library. The broadcast transaction is
 * mined with the configured outcome — or, for `'replaced'`, never mined
 * because the transaction given to {@link replaceWith} landed in block 100
 * at the same nonce instead. `head` is the block number the chain reports;
 * only block 100 holds a transaction.
 */
class StubChain {
  readonly rawTxs: Hex[] = [];
  /** `eth_getTransactionReceipt` calls for the broadcast transaction. */
  receiptCalls = 0;
  private readonly outcome: Outcome;
  private replacementRaw: Hex | undefined;
  private replacementStatus: '0x0' | '0x1' = '0x1';
  private readonly head: bigint;

  constructor(outcome: Outcome, { head = 100n }: { head?: bigint } = {}) {
    this.outcome = outcome;
    this.head = head;
  }

  /** Mine `raw` at the broadcast transaction's nonce, with `status`. */
  replaceWith(raw: Hex, status: '0x0' | '0x1' = '0x1'): void {
    this.replacementRaw = raw;
    this.replacementStatus = status;
  }

  /** The raw transaction the adapter broadcast. */
  get broadcastRaw(): Hex {
    const raw = this.rawTxs[0];
    if (raw === undefined) throw new Error('stub chain: nothing was broadcast');
    return raw;
  }

  private get sent(): { raw: Hex; hash: Hex } | undefined {
    const raw = this.rawTxs[0];
    return raw === undefined ? undefined : { raw, hash: keccak256(raw) };
  }

  private get replacement(): Hex | undefined {
    return this.outcome === 'replaced' && this.sent !== undefined ? this.replacementRaw : undefined;
  }

  answer(method: string, params: readonly unknown[]): unknown {
    const sent = this.sent;
    switch (method) {
      case 'eth_chainId':
        return toQuantity(AMOY);
      case 'net_version':
        return String(AMOY);
      case 'eth_blockNumber':
        return toQuantity(this.head);
      case 'eth_gasPrice':
        return toQuantity(40n * GWEI);
      case 'eth_maxPriorityFeePerGas':
        return toQuantity(30n * GWEI);
      case 'eth_getTransactionCount':
        // Once the cancel has mined, the sender's nonce has moved past ours.
        return toQuantity(this.replacement === undefined ? NONCE : NONCE + 1);
      case 'eth_estimateGas':
        return toQuantity(50_000n);
      case 'eth_getBlockByNumber': {
        const tag = params[0];
        const number = typeof tag === 'string' && tag.startsWith('0x') ? BigInt(tag) : this.head;
        const replacement = number === 100n ? this.replacement : undefined;
        const full = params[1] === true;
        const txs =
          replacement === undefined
            ? []
            : [full ? txJson(replacement, true) : keccak256(replacement)];
        return {
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
          transactions: txs,
          baseFeePerGas: toQuantity(10n * GWEI)
        };
      }
      case 'eth_sendRawTransaction': {
        const raw = params[0];
        if (typeof raw !== 'string' || !raw.startsWith('0x')) {
          throw new Error('stub chain: malformed raw transaction');
        }
        const hex = raw as Hex;
        this.rawTxs.push(hex);
        return keccak256(hex);
      }
      case 'eth_getTransactionByHash': {
        const replacement = this.replacement;
        if (sent !== undefined && params[0] === sent.hash) {
          // Replaced: ours is still "pending" as far as the node knows.
          return txJson(sent.raw, this.outcome !== 'replaced');
        }
        if (replacement !== undefined && params[0] === keccak256(replacement)) {
          return txJson(replacement, true);
        }
        return null;
      }
      case 'eth_getTransactionReceipt': {
        const replacement = this.replacement;
        if (sent !== undefined && params[0] === sent.hash) {
          this.receiptCalls++;
          if (this.outcome === 'replaced') return null;
          return receiptJson(sent.hash, this.outcome === 'success' ? '0x1' : '0x0');
        }
        if (replacement !== undefined && params[0] === keccak256(replacement)) {
          return receiptJson(keccak256(replacement), this.replacementStatus);
        }
        return null;
      }
      default:
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
    this.pollingInterval = POLL_MS;
  }

  override async send(method: string, params: unknown[]): Promise<unknown> {
    return this.chain.answer(method, params);
  }
}

// --- ethers v6: real JsonRpcProvider + Wallet -------------------------------

class V6StubProvider extends JsonRpcProvider {
  private readonly chain: StubChain;

  constructor(chain: StubChain) {
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
    public: createPublicClient({ transport, pollingInterval: POLL_MS }),
    wallet: createWalletClient({ account: ACCOUNT, transport })
  });
};

const harnesses: Array<[string, (chain: StubChain) => Adapter]> = [
  ['ethers v5', v5Adapter],
  ['ethers v6', v6Adapter],
  ['viem', viemStubAdapter]
];

const withdraw = (adapter: Adapter) =>
  adapter.write({
    address: TOKEN,
    abi: ChildERC20ABI,
    functionName: 'withdraw',
    args: [1234n],
    gasLimit: 100_000n,
    chainId: AMOY
  });

const settle = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e
  );

/** ethers' own wait() rejection, rethrown as the library built it. */
const expectLibraryRejection = ({ err, code }: { err: unknown; code: string }): void => {
  expect(err).instanceOf(Error);
  expect(err).property('code').equals(code);
  expect(isMaticjsError(err)).equals(false);
};

/** The hash of a receipt in either ethers major (v5 `transactionHash`, v6 `hash`). */
const receiptHashOf = (err: unknown): unknown => {
  const receipt: unknown = Reflect.get(Object(err), 'receipt');
  return Reflect.get(Object(receipt), 'transactionHash') ?? Reflect.get(Object(receipt), 'hash');
};

describe.each(harnesses)('%s adapter — confirmed() outcome', (name, build) => {
  it('rejects a reverted transaction: the library error for ethers, TransactionRevertedError for viem', async () => {
    const chain = new StubChain('reverted');
    const result = await withdraw(build(chain));

    const err = await settle(result.confirmed());

    if (name !== 'viem') {
      expectLibraryRejection({ err, code: 'CALL_EXCEPTION' });
      expect(receiptHashOf(err)).equals(result.hash);
      return;
    }
    expect(err).property('name').equals('ConfirmationError');
    expect(ConfirmationError.find(err)).nested.property('info.operation').equals('confirmed');
    expect(ConfirmationError.find(err)).nested.property('info.mode').equals('confirm');
    expect(ConfirmationError.find(err)).nested.property('info.transactionHash').equals(result.hash);
    expect(TransactionRevertedError.has(err)).equals(true);
    expect(TransactionRevertedError.find(err))
      .nested.property('info.transactionHash')
      .equals(result.hash);
    expect(TransactionRevertedError.find(err))
      .nested.property('info.receipt.status')
      .equals('reverted');
    expect(TransactionRevertedError.find(err))
      .nested.property('info.receipt.transactionHash')
      .equals(result.hash);
    expect(TransactionRevertedError.find(err))
      .nested.property('info.receipt.blockNumber')
      .equals(100n);
    expect(TransactionRevertedError.find(err)?.cause).equals(undefined);
    expectNoLibraryCause(err);
  });

  it('resolves a successful transaction with its receipt', async () => {
    const chain = new StubChain('success');
    const result = await withdraw(build(chain));

    const receipt = await result.confirmed();

    expect(receipt).property('status').equals('success');
    expect(receipt).property('transactionHash').equals(result.hash);
    expect(receipt).property('blockNumber').equals(100n);
  });

  it('a second confirmed() on a reverted tx rejects with the same error and does not wait again', async () => {
    const chain = new StubChain('reverted');
    const result = await withdraw(build(chain));

    const first = await settle(result.confirmed());
    const callsAfterFirst = chain.receiptCalls;
    const second = await settle(result.confirmed());

    expect(first).instanceOf(Error);
    expect(second).equals(first);
    expect(callsAfterFirst).greaterThan(0);
    expect(chain.receiptCalls).equals(callsAfterFirst);
  });
});

/**
 * A transaction can be replaced at its nonce before it mines. A fee bump of
 * the same call ("repriced", a wallet's speed-up) is the same transfer and
 * counts as the original. Anything else at that nonce (a wallet's cancel, or
 * a different call) means the bridge transaction will never happen, so
 * `confirmed()` must reject rather than resolve with the other
 * transaction's successful receipt.
 */
describe.each(harnesses)('%s adapter — confirmed() on a replaced transaction', (name, build) => {
  /** ethers: its TRANSACTION_REPLACED as-is; viem: the SDK's TransactionReplacedError. */
  const expectReplaced = ({
    err,
    hash,
    replacementHash,
    reason
  }: {
    err: unknown;
    hash: Hex;
    replacementHash: Hex;
    reason: 'cancelled' | 'replaced';
  }): void => {
    if (name !== 'viem') {
      expectLibraryRejection({ err, code: 'TRANSACTION_REPLACED' });
      expect(err).property('reason').equals(reason);
      expect(err).nested.property('replacement.hash').equals(replacementHash);
      expect(receiptHashOf(err)).equals(replacementHash);
      return;
    }
    expect(err).property('name').equals('ConfirmationError');
    const found = TransactionReplacedError.find(err);
    if (found === null) throw new Error('expected TransactionReplacedError');
    expect(found).nested.property('info.transactionHash').equals(hash);
    expect(found).nested.property('info.replacementHash').equals(replacementHash);
    expect(found).nested.property('info.reason').equals(reason);
    expect(found).nested.property('info.receipt.transactionHash').equals(replacementHash);
    expect(found.cause).equals(undefined);
  };

  it('rejects a cancelled transaction', { timeout: 10_000 }, async () => {
    const chain = new StubChain('replaced');
    const result = await withdraw(build(chain));
    const cancel = await signCancel();
    chain.replaceWith(cancel);

    const err = await settle(result.confirmed());

    expectReplaced({
      err,
      hash: result.hash,
      replacementHash: keccak256(cancel),
      reason: 'cancelled'
    });
  });

  it('rejects a transaction replaced by a different call', { timeout: 10_000 }, async () => {
    const chain = new StubChain('replaced');
    const result = await withdraw(build(chain));
    const other = await signOther();
    chain.replaceWith(other);

    const err = await settle(result.confirmed());

    expectReplaced({
      err,
      hash: result.hash,
      replacementHash: keccak256(other),
      reason: 'replaced'
    });
  });

  it('keeps a replacement rejection memoised', { timeout: 10_000 }, async () => {
    const chain = new StubChain('replaced');
    const result = await withdraw(build(chain));
    chain.replaceWith(await signCancel());

    const first = await settle(result.confirmed());
    const callsAfterFirst = chain.receiptCalls;
    const second = await settle(result.confirmed());

    expect(first).instanceOf(Error);
    expect(second).equals(first);
    expect(chain.receiptCalls).equals(callsAfterFirst);
  });

  it(
    'resolves a repriced (fee-bumped) transaction with the replacement receipt',
    { timeout: 10_000 },
    async () => {
      const chain = new StubChain('replaced');
      const result = await withdraw(build(chain));
      const repriced = await signRepriced(chain.broadcastRaw);
      chain.replaceWith(repriced);

      const receipt = await result.confirmed();

      expect(receipt).property('status').equals('success');
      expect(receipt).property('transactionHash').equals(keccak256(repriced));
    }
  );

  it('rejects a repriced transaction that reverted', { timeout: 10_000 }, async () => {
    const chain = new StubChain('replaced');
    const result = await withdraw(build(chain));
    const repriced = await signRepriced(chain.broadcastRaw);
    chain.replaceWith(repriced, '0x0');

    const err = await settle(result.confirmed());

    if (name !== 'viem') {
      // ethers reports it as a replacement whose receipt failed.
      expect(isMaticjsError(err)).equals(false);
      expect(err).property('code').oneOf(['TRANSACTION_REPLACED', 'CALL_EXCEPTION']);
      expect(receiptHashOf(err)).equals(keccak256(repriced));
      return;
    }
    expect(TransactionRevertedError.has(err)).equals(true);
    expect(TransactionRevertedError.find(err))
      .nested.property('info.receipt.transactionHash')
      .equals(keccak256(repriced));
  });
});

/**
 * ethers v5's `wait()` rejects a revert with a CALL_EXCEPTION that carries
 * the receipt. The adapter must use that receipt, not depend on re-reading
 * it through its own read provider, which may lag the signer's node.
 */
class NullReceiptV5Provider extends V5StubProvider {
  override async send(method: string, params: unknown[]): Promise<unknown> {
    if (method === 'eth_getTransactionReceipt') return null;
    return await super.send(method, params);
  }
}

describe("ethers v5 adapter — revert seen only by the signer's provider", () => {
  it("rethrows ethers' CALL_EXCEPTION, which carries the receipt", async () => {
    const chain = new StubChain('reverted');
    const signerProvider = new V5StubProvider(chain);
    const adapter = ethersV5Adapter({
      provider: new NullReceiptV5Provider(chain),
      signer: new V5Wallet(TEST_KEY, signerProvider)
    });
    const result = await withdraw(adapter);

    const err = await settle(result.confirmed());
    const callsAfterFirst = chain.receiptCalls;

    expectLibraryRejection({ err, code: 'CALL_EXCEPTION' });
    expect(receiptHashOf(err)).equals(result.hash);
    // A final verdict, memoised: the same error again, with no new wait.
    expect(await settle(result.confirmed())).equals(err);
    expect(chain.receiptCalls).equals(callsAfterFirst);
  });
});

/**
 * Behind a load-balanced RPC, the head the adapter reads before broadcasting
 * can be ahead of the block where a replacement already mined. ethers v6
 * never scans below the block passed to `replaceableTransaction()`, so the
 * adapter must pass a floor below that head or `confirmed()` waits forever.
 */
describe('ethers v6 adapter — replacement mined below the pre-broadcast head', () => {
  it('finds a replacement a few blocks below the head it read', { timeout: 5_000 }, async () => {
    // The replacement is in block 100; the head read before broadcast is 104.
    const chain = new StubChain('replaced', { head: 104n });
    const result = await withdraw(v6Adapter(chain));
    const cancel = await signCancel();
    chain.replaceWith(cancel);

    const err = await settle(result.confirmed());

    expectLibraryRejection({ err, code: 'TRANSACTION_REPLACED' });
    expect(err).nested.property('replacement.hash').equals(keccak256(cancel));
  });
});

/**
 * ethers v6's wait() resolves null instead of a receipt only for a
 * zero-confirmation wait on a transaction that is not mined. The adapter
 * waits for one confirmation, so this is forced by stubbing wait().
 */
describe('ethers v6 adapter — wait() resolves no receipt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects with a TransactionNotFoundError carrying the hash', async () => {
    const chain = new StubChain('success');
    const result = await withdraw(v6Adapter(chain));
    vi.spyOn(TransactionResponse.prototype, 'wait').mockResolvedValue(null);

    const err = await settle(result.confirmed());

    expect(err).property('name').equals('ConfirmationError');
    expect(TransactionNotFoundError.has(err)).equals(true);
    expect(TransactionNotFoundError.find(err))
      .nested.property('info.transactionHash')
      .equals(result.hash);
    expect(Web3ClientNotInitializedError.has(err)).equals(false);
    expectNoLibraryCause(err);
  });
});
