import type { Deferrable } from 'ethers-v5/lib/utils.js';

import { providers, Signer, utils, Wallet } from 'ethers-v5';
import { describe, expect, it } from 'vitest';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { POSBridgeError } from '../../src/errors.ts';

/**
 * ethers v5's own fee data uses a fixed priority fee (tip) that sits below
 * the minimum some chains enforce, so a v5 write with no fee options was
 * underpriced. The adapter now asks the node (`eth_maxPriorityFeePerGas`)
 * whenever the caller gives no tip.
 *
 * These tests drive the REAL ethers v5 write path — Contract → Wallet
 * populate → local signing → `eth_sendRawTransaction` — against a provider
 * whose JSON-RPC `send` is stubbed, then decode the signed raw transaction.
 * Asserting on what would actually be broadcast (rather than on the
 * overrides the adapter hands ethers) is what makes the "no tip" test fail
 * against the unfixed adapter: there, ethers fills in its fixed tip.
 */

const CHAIN_ID = 137;
const TOKEN = '0x3333333333333333333333333333333333333333';
const RECIPIENT = '0x4444444444444444444444444444444444444444';
// Throwaway fixture key: signs locally, never touches a real network.
const TEST_KEY = `0x${'11'.repeat(32)}`;
const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
const GWEI = 1_000_000_000n;

const toQuantity = (v: bigint): string => `0x${v.toString(16)}`;

interface StubOptions {
  /** `undefined` models a pre-London (legacy, gasPrice-only) chain. */
  baseFeePerGas?: bigint;
  gasPrice: bigint;
  /** A bigint answers the method; an Error is thrown for it. */
  priorityFee: bigint | Error;
}

/**
 * A real ethers v5 JSON-RPC provider with only the transport replaced, so
 * every higher-level ethers code path runs unmodified.
 */
class StubRpcProvider extends providers.StaticJsonRpcProvider {
  readonly calls: string[] = [];
  readonly rawTxs: string[] = [];
  /** `eth_sendTransaction` requests, as a remote wallet would receive them. */
  readonly walletTxs: Array<Record<string, unknown>> = [];
  private readonly opts: StubOptions;

  constructor(opts: StubOptions) {
    super('http://stub.invalid', { chainId: CHAIN_ID, name: 'stub' });
    this.opts = opts;
  }

  override async send(method: string, params: unknown[]): Promise<unknown> {
    this.calls.push(method);
    switch (method) {
      case 'eth_chainId':
        return toQuantity(BigInt(CHAIN_ID));
      case 'eth_blockNumber':
        return '0x64';
      case 'eth_gasPrice':
        return toQuantity(this.opts.gasPrice);
      case 'eth_getTransactionCount':
        return '0x0';
      case 'eth_maxPriorityFeePerGas':
        if (this.opts.priorityFee instanceof Error) throw this.opts.priorityFee;
        return toQuantity(this.opts.priorityFee);
      case 'eth_getBlockByNumber':
        return {
          hash: `0x${'aa'.repeat(32)}`,
          parentHash: `0x${'bb'.repeat(32)}`,
          number: '0x64',
          timestamp: '0x1',
          nonce: '0x0000000000000000',
          difficulty: '0x0',
          gasLimit: '0x1c9c380',
          gasUsed: '0x0',
          miner: '0x0000000000000000000000000000000000000000',
          extraData: '0x',
          transactions: [],
          ...(this.opts.baseFeePerGas === undefined
            ? {}
            : { baseFeePerGas: toQuantity(this.opts.baseFeePerGas) })
        };
      case 'eth_sendRawTransaction': {
        const raw = String(params[0]);
        this.rawTxs.push(raw);
        return utils.keccak256(raw);
      }
      // --- a remote (JSON-RPC / injected) wallet behind the same node ---
      case 'eth_accounts':
        return [WALLET_ACCOUNT];
      case 'eth_sendTransaction': {
        const [request] = params;
        if (typeof request !== 'object' || request === null) {
          throw new Error('stub provider: malformed eth_sendTransaction');
        }
        this.walletTxs.push({ ...request });
        return WALLET_TX_HASH;
      }
      case 'eth_getTransactionByHash':
        return walletTxResponse();
      default:
        throw new Error(`stub provider: unexpected RPC ${method}`);
    }
  }
}

// The account a JSON-RPC wallet signs with, and the hash it reports.
const WALLET_ACCOUNT = '0x5555555555555555555555555555555555555555';
const WALLET_TX_HASH = `0x${'ab'.repeat(32)}`;

/** The pending transaction the wallet's node reports after the send. */
const walletTxResponse = (): Record<string, unknown> => ({
  hash: WALLET_TX_HASH,
  blockHash: null,
  blockNumber: null,
  transactionIndex: null,
  from: WALLET_ACCOUNT,
  to: TOKEN,
  gas: toQuantity(100_000n),
  gasPrice: toQuantity(80n * GWEI),
  input: '0x',
  nonce: '0x0',
  value: '0x0',
  chainId: toQuantity(BigInt(CHAIN_ID)),
  v: '0x1b',
  r: `0x${'01'.repeat(32)}`,
  s: `0x${'01'.repeat(32)}`
});

/** Run one adapter write and decode the transaction that was broadcast. */
async function broadcast(
  stub: StubRpcProvider,
  fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } = {}
): Promise<ReturnType<typeof utils.parseTransaction>> {
  const adapter = ethersV5Adapter({ provider: stub, signer: new Wallet(TEST_KEY, stub) });
  await adapter.write({
    address: TOKEN,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [RECIPIENT, 1n],
    gasLimit: 100_000n,
    ...fees
  });
  const [raw] = stub.rawTxs;
  if (raw === undefined) throw new Error('no transaction was broadcast');
  return utils.parseTransaction(raw);
}

describe('EthersV5Adapter priority fee resolution', () => {
  it('uses the node-suggested tip when the caller gives none', async () => {
    const stub = new StubRpcProvider({
      baseFeePerGas: 50n * GWEI,
      gasPrice: 80n * GWEI,
      priorityFee: 30n * GWEI
    });
    const tx = await broadcast(stub);
    expect(tx.type).equals(2);
    expect(tx.maxPriorityFeePerGas?.toBigInt()).equals(30n * GWEI);
    expect(stub.calls).includes('eth_maxPriorityFeePerGas');
  });

  it('lets a caller-supplied tip win without querying the node', async () => {
    const stub = new StubRpcProvider({
      baseFeePerGas: 50n * GWEI,
      gasPrice: 80n * GWEI,
      priorityFee: 30n * GWEI
    });
    const tx = await broadcast(stub, {
      maxFeePerGas: 200n * GWEI,
      maxPriorityFeePerGas: 45n * GWEI
    });
    expect(tx.maxPriorityFeePerGas?.toBigInt()).equals(45n * GWEI);
    expect(tx.maxFeePerGas?.toBigInt()).equals(200n * GWEI);
    expect(stub.calls).not.includes('eth_maxPriorityFeePerGas');
  });

  it('keeps maxFee >= tip when the node tip exceeds the fee cap ethers would derive', async () => {
    // ethers' own cap would be 2 × baseFee + its fixed tip — far below a
    // 500 gwei node tip on a 1 gwei base fee.
    const baseFee = 1n * GWEI;
    const stub = new StubRpcProvider({
      baseFeePerGas: baseFee,
      gasPrice: 2n * GWEI,
      priorityFee: 500n * GWEI
    });
    const tx = await broadcast(stub);
    const tip = tx.maxPriorityFeePerGas?.toBigInt();
    const maxFee = tx.maxFeePerGas?.toBigInt();
    expect(tip).equals(500n * GWEI);
    // ethers' base-fee headroom (2 × baseFee) is kept and the node tip is
    // added on top, so the cap always covers the tip.
    expect(maxFee).equals(2n * baseFee + 500n * GWEI);
  });

  it('keeps a caller-supplied maxFee and uses the node tip beneath it', async () => {
    const stub = new StubRpcProvider({
      baseFeePerGas: 50n * GWEI,
      gasPrice: 80n * GWEI,
      priorityFee: 30n * GWEI
    });
    const tx = await broadcast(stub, { maxFeePerGas: 150n * GWEI });
    expect(tx.maxFeePerGas?.toBigInt()).equals(150n * GWEI);
    expect(tx.maxPriorityFeePerGas?.toBigInt()).equals(30n * GWEI);
  });

  it('caps the node tip at a caller-supplied maxFee that is lower than it', async () => {
    const stub = new StubRpcProvider({
      baseFeePerGas: 50n * GWEI,
      gasPrice: 80n * GWEI,
      priorityFee: 300n * GWEI
    });
    const tx = await broadcast(stub, { maxFeePerGas: 120n * GWEI });
    expect(tx.maxFeePerGas?.toBigInt()).equals(120n * GWEI);
    expect(tx.maxPriorityFeePerGas?.toBigInt()).equals(120n * GWEI);
  });

  it('leaves the legacy gasPrice path unchanged on a chain without a base fee', async () => {
    const stub = new StubRpcProvider({ gasPrice: 80n * GWEI, priorityFee: 30n * GWEI });
    const tx = await broadcast(stub);
    // ethers v5 decodes a legacy (type-0) envelope with `type: null`.
    expect(tx.type).equals(null);
    expect(tx.gasPrice?.toBigInt()).equals(80n * GWEI);
    expect(tx.maxPriorityFeePerGas).equals(undefined);
    expect(stub.calls).not.includes('eth_maxPriorityFeePerGas');
  });

  it('fails loudly, with the RPC error as cause, when the node cannot suggest a tip', async () => {
    const rpcError = new Error(
      'the method eth_maxPriorityFeePerGas does not exist/is not available'
    );
    const stub = new StubRpcProvider({
      baseFeePerGas: 50n * GWEI,
      gasPrice: 80n * GWEI,
      priorityFee: rpcError
    });
    const err: unknown = await broadcast(stub).catch((e: unknown) => e);
    expect(err).instanceOf(POSBridgeError);
    expect(err).property('code').equals('FEE_ESTIMATION_FAILED');
    expect(err).property('message').contains('maxPriorityFeePerGas');
    expect(err).property('cause').equals(rpcError);
    expect(err).nested.property('info.method').equals('eth_maxPriorityFeePerGas');
    expect(err).nested.property('info.chainId').equals(CHAIN_ID);
    expect(stub.rawTxs).lengthOf(0);
  });
});

/**
 * A JSON-RPC wallet (an injected browser wallet, or any `getSigner()`
 * signer) prices the transaction itself, and ethers' JSON-RPC signer never
 * reads ethers' fee data, so the SDK leaves pricing to the wallet. These
 * drive the real ethers JSON-RPC signer and capture the
 * `eth_sendTransaction` request the wallet would receive.
 */
const transferRequest = {
  address: TOKEN,
  abi: ERC20_ABI,
  functionName: 'transfer',
  args: [RECIPIENT, 1n],
  gasLimit: 100_000n,
  chainId: CHAIN_ID
} as const;

const mainnetStub = (): StubRpcProvider =>
  new StubRpcProvider({ baseFeePerGas: 50n * GWEI, gasPrice: 80n * GWEI, priorityFee: 30n * GWEI });

/** The single `eth_sendTransaction` request the wallet received. */
const walletRequest = (stub: StubRpcProvider): Record<string, unknown> => {
  expect(stub.walletTxs).lengthOf(1);
  const [request] = stub.walletTxs;
  if (request === undefined) throw new Error('nothing was sent to the wallet');
  return request;
};

/**
 * Forwards every send to the signer it wraps without populating it first —
 * the shape of a nonce-managing wrapper. The adapter cannot recognise it,
 * so it must not assume the wrapped signer prices its own fees.
 */
class ForwardingSigner extends Signer {
  readonly inner: Signer;

  constructor(inner: Signer) {
    super();
    this.inner = inner;
    utils.defineReadOnly(this, 'provider', inner.provider);
  }

  getAddress(): Promise<string> {
    return this.inner.getAddress();
  }

  connect(): ForwardingSigner {
    throw new Error('stub signer: connect not supported');
  }

  signMessage(message: string | utils.Bytes): Promise<string> {
    return this.inner.signMessage(message);
  }

  signTransaction(tx: Deferrable<providers.TransactionRequest>): Promise<string> {
    return this.inner.signTransaction(tx);
  }

  override sendTransaction(
    tx: Deferrable<providers.TransactionRequest>
  ): Promise<providers.TransactionResponse> {
    return this.inner.sendTransaction(tx);
  }
}

describe('EthersV5Adapter with a JSON-RPC wallet signer', () => {
  it('leaves fee pricing to the wallet and queries no fee data', async () => {
    const stub = mainnetStub();
    const adapter = ethersV5Adapter({ provider: stub, signer: stub.getSigner() });
    const result = await adapter.write(transferRequest);
    expect(result).property('hash').equals(WALLET_TX_HASH);
    const request = walletRequest(stub);
    expect(request).not.property('maxFeePerGas');
    expect(request).not.property('maxPriorityFeePerGas');
    expect(request).not.property('gasPrice');
    expect(stub.calls).not.includes('eth_maxPriorityFeePerGas');
    expect(stub.calls).not.includes('eth_gasPrice');
    expect(stub.rawTxs).lengthOf(0);
  });

  it('treats the unchecked JSON-RPC signer the same way', async () => {
    const stub = mainnetStub();
    const adapter = ethersV5Adapter({ provider: stub, signer: stub.getUncheckedSigner() });
    await adapter.write(transferRequest);
    const request = walletRequest(stub);
    expect(request).not.property('maxFeePerGas');
    expect(request).not.property('maxPriorityFeePerGas');
    expect(stub.calls).not.includes('eth_maxPriorityFeePerGas');
  });

  it('passes a caller-supplied tip and cap through to the wallet', async () => {
    const stub = mainnetStub();
    const adapter = ethersV5Adapter({ provider: stub, signer: stub.getSigner() });
    await adapter.write({
      ...transferRequest,
      maxFeePerGas: 200n * GWEI,
      maxPriorityFeePerGas: 45n * GWEI
    });
    const request = walletRequest(stub);
    expect(request)
      .property('maxFeePerGas')
      .equals(toQuantity(200n * GWEI));
    expect(request)
      .property('maxPriorityFeePerGas')
      .equals(toQuantity(45n * GWEI));
    expect(stub.calls).not.includes('eth_maxPriorityFeePerGas');
  });

  it('resolves fees for an unrecognised wrapper, even around a JSON-RPC signer', async () => {
    // Safe default: the adapter cannot tell whether a wrapper populates fees
    // from ethers' fixed tip before forwarding, so it prices the write.
    const stub = mainnetStub();
    const signer = new ForwardingSigner(stub.getSigner());
    await ethersV5Adapter({ provider: stub, signer }).write(transferRequest);
    const request = walletRequest(stub);
    expect(request)
      .property('maxPriorityFeePerGas')
      .equals(toQuantity(30n * GWEI));
    expect(stub.calls).includes('eth_maxPriorityFeePerGas');
  });

  it('resolves fees for an unrecognised wrapper around a local wallet', async () => {
    const stub = mainnetStub();
    const signer = new ForwardingSigner(new Wallet(TEST_KEY, stub));
    await ethersV5Adapter({ provider: stub, signer }).write(transferRequest);
    const [raw] = stub.rawTxs;
    if (raw === undefined) throw new Error('no transaction was broadcast');
    expect(utils.parseTransaction(raw).maxPriorityFeePerGas?.toBigInt()).equals(30n * GWEI);
  });
});

/**
 * A read provider need not speak JSON-RPC: a `FallbackProvider` (what
 * `getDefaultProvider` returns) has no `send`, so it cannot answer
 * `eth_maxPriorityFeePerGas`. A local signer connected to a JSON-RPC
 * provider can, and the adapter asks it instead.
 */
describe('EthersV5Adapter priority fee with a read provider that has no send', () => {
  const fallbackOver = (node: StubRpcProvider): providers.FallbackProvider =>
    new providers.FallbackProvider([node], 1);

  it("asks the signer's JSON-RPC provider for the tip and broadcasts", async () => {
    const readNode = mainnetStub();
    const signerNode = new StubRpcProvider({
      baseFeePerGas: 50n * GWEI,
      gasPrice: 80n * GWEI,
      priorityFee: 35n * GWEI
    });
    const adapter = ethersV5Adapter({
      provider: fallbackOver(readNode),
      signer: new Wallet(TEST_KEY, signerNode)
    });
    await adapter.write(transferRequest);
    const [raw] = signerNode.rawTxs;
    if (raw === undefined) throw new Error('no transaction was broadcast');
    expect(utils.parseTransaction(raw).maxPriorityFeePerGas?.toBigInt()).equals(35n * GWEI);
    expect(signerNode.calls).includes('eth_maxPriorityFeePerGas');
  });

  it('fails with FEE_ESTIMATION_FAILED naming the escape hatch when no provider has send', async () => {
    const node = mainnetStub();
    const adapter = ethersV5Adapter({
      provider: fallbackOver(node),
      signer: new Wallet(TEST_KEY, fallbackOver(node))
    });
    const err: unknown = await adapter.write(transferRequest).catch((e: unknown) => e);
    expect(err).instanceOf(POSBridgeError);
    expect(err).property('code').equals('FEE_ESTIMATION_FAILED');
    expect(err).property('message').contains('pass maxPriorityFeePerGas explicitly');
    expect(node.rawTxs).lengthOf(0);
  });
});
