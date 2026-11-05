import type {
  FetchRequest as FetchRequestType,
  GetUrlResponse,
  JsonRpcPayload,
  JsonRpcResult
} from 'ethers';

import {
  FetchRequest,
  JsonRpcProvider,
  keccak256,
  Network,
  NonceManager,
  toUtf8Bytes,
  Transaction,
  Wallet
} from 'ethers';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { POSBridgeError } from '../../src/errors.ts';

/**
 * On Polygon PoS mainnet (chain 137) ethers v6 takes its fee data from
 * Polygon's gas station through a built-in network plugin, and
 * `getFeeData()` throws when the station is unreachable. The adapter now
 * also asks the node (`eth_maxPriorityFeePerGas`), uses the higher tip, and
 * falls back to the node alone when the station fails.
 *
 * These tests drive the REAL ethers v6 write path — Contract → Wallet
 * populate → local signing → `eth_sendRawTransaction` — with the real
 * station plugin ethers attaches to chain 137. Only the transports are
 * replaced: the JSON-RPC `_send`, and ethers' global HTTP fetch (which only
 * the station plugin uses here), then the signed raw transaction is decoded.
 */

const MAINNET = 137;
const AMOY = 80002;
const TOKEN = '0x3333333333333333333333333333333333333333';
const RECIPIENT = '0x4444444444444444444444444444444444444444';
// Throwaway fixture key: signs locally, never touches a real network.
const TEST_KEY = `0x${'11'.repeat(32)}`;
const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
const GWEI = 1_000_000_000n;

const toQuantity = (v: bigint): string => `0x${v.toString(16)}`;

// --- gas station: ethers' own HTTP seam --------------------------------------

/** What the station answers: gwei fees, or an Error for an outage. */
let station: { maxFee: bigint; tip: bigint } | Error = new Error('station not configured');
const stationUrls: string[] = [];

const stationGetUrl = async (req: FetchRequestType): Promise<GetUrlResponse> => {
  stationUrls.push(req.url);
  if (station instanceof Error) throw station;
  const body = JSON.stringify({
    standard: {
      maxFee: (station.maxFee / GWEI).toString(),
      maxPriorityFee: (station.tip / GWEI).toString()
    }
  });
  return { statusCode: 200, statusMessage: 'OK', headers: {}, body: toUtf8Bytes(body) };
};

// Global for this file only (vitest isolates each test file), and restored
// so nothing here can reach the real station.
FetchRequest.registerGetUrl(stationGetUrl);
afterAll(() => FetchRequest.registerGetUrl(FetchRequest.createGetUrlFunc()));

beforeEach(() => {
  station = new Error('station not configured');
  stationUrls.length = 0;
});

// --- node: a real JsonRpcProvider with only `_send` replaced ------------------

interface NodeOptions {
  chainId: number;
  /** `undefined` models a pre-London (legacy, gasPrice-only) chain. */
  baseFeePerGas?: bigint;
  gasPrice: bigint;
  /** A bigint answers the method; an Error is thrown for it. */
  priorityFee: bigint | Error;
}

class StubRpcProvider extends JsonRpcProvider {
  readonly calls: string[] = [];
  readonly rawTxs: string[] = [];
  /** `eth_sendTransaction` requests, as a remote wallet would receive them. */
  readonly walletTxs: Array<Record<string, unknown>> = [];
  private readonly opts: NodeOptions;

  constructor(opts: NodeOptions) {
    super('http://stub.invalid', Network.from(opts.chainId), {
      staticNetwork: true,
      batchMaxCount: 1
    });
    this.opts = opts;
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const batch = Array.isArray(payload) ? payload : [payload];
    return batch.map((p) => ({
      id: p.id,
      result: this.answer(p.method, Array.isArray(p.params) ? p.params : [])
    }));
  }

  private answer(method: string, params: readonly unknown[]): unknown {
    this.calls.push(method);
    switch (method) {
      case 'eth_chainId':
        return toQuantity(BigInt(this.opts.chainId));
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
        return keccak256(raw);
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
        return walletTxResponse(this.opts.chainId);
      default:
        throw new Error(`stub provider: unexpected RPC ${method}`);
    }
  }
}

// The account a JSON-RPC wallet signs with, and the hash it reports.
const WALLET_ACCOUNT = '0x5555555555555555555555555555555555555555';
const WALLET_TX_HASH = `0x${'ab'.repeat(32)}`;

/** The pending transaction the wallet's node reports after the send. */
const walletTxResponse = (chainId: number): Record<string, unknown> => ({
  hash: WALLET_TX_HASH,
  blockHash: null,
  blockNumber: null,
  transactionIndex: null,
  type: '0x2',
  from: WALLET_ACCOUNT,
  to: TOKEN,
  gas: toQuantity(100_000n),
  maxFeePerGas: toQuantity(140n * GWEI),
  maxPriorityFeePerGas: toQuantity(40n * GWEI),
  input: '0x',
  nonce: '0x0',
  value: '0x0',
  chainId: toQuantity(BigInt(chainId)),
  yParity: '0x0',
  r: `0x${'01'.repeat(32)}`,
  s: `0x${'01'.repeat(32)}`
});

const countOf = (calls: readonly string[], method: string): number =>
  calls.filter((c) => c === method).length;

/** Run one adapter write and decode the transaction that was broadcast. */
async function broadcast(
  node: StubRpcProvider,
  fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } = {}
): Promise<Transaction> {
  const adapter = ethersV6Adapter({ provider: node, signer: new Wallet(TEST_KEY, node) });
  await adapter.write({
    address: TOKEN,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [RECIPIENT, 1n],
    gasLimit: 100_000n,
    ...fees
  });
  expect(node.rawTxs).lengthOf(1);
  const [raw] = node.rawTxs;
  if (raw === undefined) throw new Error('no transaction was broadcast');
  return Transaction.from(raw);
}

const mainnetNode = (priorityFee: bigint | Error): StubRpcProvider =>
  new StubRpcProvider({
    chainId: MAINNET,
    baseFeePerGas: 50n * GWEI,
    gasPrice: 80n * GWEI,
    priorityFee
  });

describe('EthersV6Adapter fee resolution on Polygon PoS mainnet (gas station)', () => {
  it('uses the station tip when it is above the node tip, keeping the station headroom', async () => {
    station = { maxFee: 140n * GWEI, tip: 40n * GWEI };
    const node = mainnetNode(30n * GWEI);
    const tx = await broadcast(node);
    expect(tx).property('type').equals(2);
    expect(tx)
      .property('maxPriorityFeePerGas')
      .equals(40n * GWEI);
    expect(tx)
      .property('maxFeePerGas')
      .equals(140n * GWEI);
    expect(stationUrls.length).least(1);
  });

  it('uses the node tip when it is above the station tip, on top of the station headroom', async () => {
    station = { maxFee: 140n * GWEI, tip: 40n * GWEI };
    const node = mainnetNode(60n * GWEI);
    const tx = await broadcast(node);
    expect(tx)
      .property('maxPriorityFeePerGas')
      .equals(60n * GWEI);
    // Station headroom (140 − 40) is kept, so the cap still covers the tip.
    expect(tx)
      .property('maxFeePerGas')
      .equals(100n * GWEI + 60n * GWEI);
  });

  it('keeps the station tip when the node cannot suggest one', async () => {
    station = { maxFee: 140n * GWEI, tip: 40n * GWEI };
    const node = mainnetNode(new Error('the method eth_maxPriorityFeePerGas does not exist'));
    const tx = await broadcast(node);
    expect(tx)
      .property('maxPriorityFeePerGas')
      .equals(40n * GWEI);
    expect(tx)
      .property('maxFeePerGas')
      .equals(140n * GWEI);
  });

  it('falls back to the node when the station is unreachable, and broadcasts', async () => {
    station = new Error('getaddrinfo ENOTFOUND gas station');
    const node = mainnetNode(30n * GWEI);
    const tx = await broadcast(node);
    expect(stationUrls.length).least(1);
    expect(tx).property('type').equals(2);
    expect(tx)
      .property('maxPriorityFeePerGas')
      .equals(30n * GWEI);
    // ethers' own heuristic on the latest block: 2 × baseFee + tip.
    expect(tx)
      .property('maxFeePerGas')
      .equals(2n * 50n * GWEI + 30n * GWEI);
  });

  it('fails loudly, broadcasting nothing, when both the station and the node fail', async () => {
    station = new Error('getaddrinfo ENOTFOUND gas station');
    const rpcError = new Error('the method eth_maxPriorityFeePerGas does not exist');
    const node = mainnetNode(rpcError);
    const err: unknown = await broadcast(node).catch((e: unknown) => e);
    expect(err).instanceOf(POSBridgeError);
    expect(err).property('code').equals('FEE_ESTIMATION_FAILED');
    expect(err).property('message').contains('maxPriorityFeePerGas');
    expect(err).property('cause').equals(rpcError);
    expect(err).nested.property('info.method').equals('eth_maxPriorityFeePerGas');
    expect(err).nested.property('info.chainId').equals(MAINNET);
    expect(err).nested.property('info.feeDataError').contains('polygon gas station');
    expect(node.rawTxs).lengthOf(0);
  });

  it('never lets a station maxFee below its tip shrink the cap below the tip', async () => {
    // External data: the station can report a cap under its own tip. The
    // negative headroom must clamp to zero, so maxFee still covers the tip.
    station = { maxFee: 30n * GWEI, tip: 40n * GWEI };
    const tx = await broadcast(mainnetNode(20n * GWEI));
    expect(tx)
      .property('maxPriorityFeePerGas')
      .equals(40n * GWEI);
    expect(tx)
      .property('maxFeePerGas')
      .equals(40n * GWEI);
  });

  it('lets a caller-supplied tip win, querying neither the station nor the node', async () => {
    station = new Error('station must not be queried');
    const node = mainnetNode(new Error('node must not be queried'));
    const tx = await broadcast(node, {
      maxFeePerGas: 200n * GWEI,
      maxPriorityFeePerGas: 45n * GWEI
    });
    expect(tx)
      .property('maxPriorityFeePerGas')
      .equals(45n * GWEI);
    expect(tx)
      .property('maxFeePerGas')
      .equals(200n * GWEI);
    expect(stationUrls).lengthOf(0);
    expect(node.calls).not.includes('eth_maxPriorityFeePerGas');
  });

  it('keeps a caller-supplied maxFee and puts the higher tip beneath it', async () => {
    station = { maxFee: 140n * GWEI, tip: 40n * GWEI };
    const node = mainnetNode(30n * GWEI);
    const tx = await broadcast(node, { maxFeePerGas: 150n * GWEI });
    expect(tx)
      .property('maxFeePerGas')
      .equals(150n * GWEI);
    expect(tx)
      .property('maxPriorityFeePerGas')
      .equals(40n * GWEI);
  });

  it('caps the tip at a lower caller-supplied maxFee, also on the node fallback', async () => {
    station = new Error('getaddrinfo ENOTFOUND gas station');
    const node = mainnetNode(300n * GWEI);
    const tx = await broadcast(node, { maxFeePerGas: 120n * GWEI });
    expect(tx)
      .property('maxFeePerGas')
      .equals(120n * GWEI);
    expect(tx)
      .property('maxPriorityFeePerGas')
      .equals(120n * GWEI);
  });
});

describe('EthersV6Adapter fee resolution on chains without a gas station', () => {
  it('prices from the node tip exactly as ethers does, never touching the station', async () => {
    const node = new StubRpcProvider({
      chainId: AMOY,
      baseFeePerGas: 50n * GWEI,
      gasPrice: 80n * GWEI,
      priorityFee: 30n * GWEI
    });
    const tx = await broadcast(node);
    expect(tx).property('chainId').equals(BigInt(AMOY));
    expect(tx)
      .property('maxPriorityFeePerGas')
      .equals(30n * GWEI);
    expect(tx)
      .property('maxFeePerGas')
      .equals(2n * 50n * GWEI + 30n * GWEI);
    expect(stationUrls).lengthOf(0);
  });

  it('leaves the legacy gasPrice path unchanged on a chain without a base fee', async () => {
    const node = new StubRpcProvider({
      chainId: AMOY,
      gasPrice: 80n * GWEI,
      priorityFee: 30n * GWEI
    });
    const tx = await broadcast(node);
    expect(tx).property('type').equals(0);
    expect(tx)
      .property('gasPrice')
      .equals(80n * GWEI);
    expect(tx).property('maxPriorityFeePerGas').equals(null);
    // Only ethers' own fee-data reads ask for a tip; the adapter adds none.
    expect(countOf(node.calls, 'eth_maxPriorityFeePerGas')).equals(
      countOf(node.calls, 'eth_gasPrice')
    );
    expect(stationUrls).lengthOf(0);
  });
});

/**
 * A JSON-RPC wallet (an injected browser wallet, or any `getSigner()`
 * signer) prices the transaction itself, and ethers' JSON-RPC signer never
 * reads ethers' fee data, so the SDK leaves pricing to the wallet — and the
 * gas station is never consulted. These drive the real ethers JSON-RPC
 * signer on the station-backed mainnet and capture the
 * `eth_sendTransaction` request the wallet would receive.
 */
describe('EthersV6Adapter with a JSON-RPC wallet signer', () => {
  const transferRequest = {
    address: TOKEN,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [RECIPIENT, 1n],
    gasLimit: 100_000n,
    chainId: MAINNET
  } as const;

  /** The single `eth_sendTransaction` request the wallet received. */
  const walletRequest = (node: StubRpcProvider): Record<string, unknown> => {
    expect(node.walletTxs).lengthOf(1);
    const [request] = node.walletTxs;
    if (request === undefined) throw new Error('nothing was sent to the wallet');
    return request;
  };

  it('leaves fee pricing to the wallet, querying neither the station nor the node', async () => {
    station = { maxFee: 140n * GWEI, tip: 40n * GWEI };
    const node = mainnetNode(30n * GWEI);
    const adapter = ethersV6Adapter({ provider: node, signer: await node.getSigner() });
    const result = await adapter.write(transferRequest);
    expect(result).property('hash').equals(WALLET_TX_HASH);
    const request = walletRequest(node);
    expect(request).not.property('maxFeePerGas');
    expect(request).not.property('maxPriorityFeePerGas');
    expect(request).not.property('gasPrice');
    expect(stationUrls).lengthOf(0);
    expect(node.calls).not.includes('eth_maxPriorityFeePerGas');
    expect(node.rawTxs).lengthOf(0);
  });

  it('sends even while the gas station is down', async () => {
    station = new Error('getaddrinfo ENOTFOUND gas station');
    const node = mainnetNode(new Error('node must not be queried'));
    const adapter = ethersV6Adapter({ provider: node, signer: await node.getSigner() });
    await adapter.write(transferRequest);
    expect(walletRequest(node)).not.property('maxPriorityFeePerGas');
    expect(stationUrls).lengthOf(0);
  });

  it('passes a caller-supplied tip and cap through to the wallet', async () => {
    const node = mainnetNode(new Error('node must not be queried'));
    const adapter = ethersV6Adapter({ provider: node, signer: await node.getSigner() });
    await adapter.write({
      ...transferRequest,
      maxFeePerGas: 200n * GWEI,
      maxPriorityFeePerGas: 45n * GWEI
    });
    const request = walletRequest(node);
    expect(request)
      .property('maxFeePerGas')
      .equals(toQuantity(200n * GWEI));
    expect(request)
      .property('maxPriorityFeePerGas')
      .equals(toQuantity(45n * GWEI));
    expect(stationUrls).lengthOf(0);
    expect(node.calls).not.includes('eth_maxPriorityFeePerGas');
  });

  it('classifies a NonceManager by the JSON-RPC signer it wraps', async () => {
    // NonceManager populates through, then sends through, the wrapped
    // signer; ethers' JSON-RPC signer populates no fees, so the wallet
    // still prices the transaction.
    station = { maxFee: 140n * GWEI, tip: 40n * GWEI };
    const node = mainnetNode(30n * GWEI);
    const signer = new NonceManager(await node.getSigner());
    await ethersV6Adapter({ provider: node, signer }).write(transferRequest);
    const request = walletRequest(node);
    expect(request).property('nonce').equals('0x0');
    expect(request).not.property('maxFeePerGas');
    expect(request).not.property('maxPriorityFeePerGas');
    expect(stationUrls).lengthOf(0);
    expect(node.calls).not.includes('eth_maxPriorityFeePerGas');
  });

  it('classifies a NonceManager by the local wallet it wraps', async () => {
    station = { maxFee: 140n * GWEI, tip: 40n * GWEI };
    const node = mainnetNode(60n * GWEI);
    const signer = new NonceManager(new Wallet(TEST_KEY, node));
    await ethersV6Adapter({ provider: node, signer }).write(transferRequest);
    expect(node.rawTxs).lengthOf(1);
    const [raw] = node.rawTxs;
    if (raw === undefined) throw new Error('no transaction was broadcast');
    expect(Transaction.from(raw))
      .property('maxPriorityFeePerGas')
      .equals(60n * GWEI);
  });
});
