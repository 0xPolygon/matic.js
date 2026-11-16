import type { JsonRpcPayload, JsonRpcResult, PerformActionRequest } from 'ethers';

import {
  AbstractProvider,
  JsonRpcProvider,
  keccak256,
  Network,
  NonceManager,
  Transaction,
  Wallet
} from 'ethers';
import { describe, expect, it } from 'vitest';

import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';

/**
 * ethers v6 caches every provider read for 250 ms (`cacheTimeout`), and a
 * local signer fills the nonce through that cache. Two SDK writes from one
 * signer inside that window used to reuse a nonce, so the second failed as
 * NONCE_EXPIRED or replaced the first. The adapter now reads the pending
 * nonce with a raw `eth_getTransactionCount`, which skips the cache.
 *
 * These drive the real ethers v6 write path — Contract → Wallet populate →
 * local signing → `eth_sendRawTransaction` — against a node stub whose
 * pending count advances with every broadcast, as a real node's does.
 */

const AMOY = 80002;
const TOKEN = '0x3333333333333333333333333333333333333333';
const RECIPIENT = '0x4444444444444444444444444444444444444444';
// Throwaway fixture key: signs locally, never touches a real network.
const TEST_KEY = `0x${'11'.repeat(32)}`;
const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
const GWEI = 1_000_000_000n;
const WALLET_ACCOUNT = '0x5555555555555555555555555555555555555555';
const WALLET_TX_HASH = `0x${'ab'.repeat(32)}`;

const toQuantity = (v: bigint | number): string => `0x${v.toString(16)}`;

const transfer = {
  address: TOKEN,
  abi: ERC20_ABI,
  functionName: 'transfer',
  args: [RECIPIENT, 1n],
  gasLimit: 100_000n
} as const;

/** A real JsonRpcProvider (default 250 ms cache) with only `_send` replaced. */
class NodeStub extends JsonRpcProvider {
  readonly calls: string[] = [];
  readonly rawTxs: string[] = [];
  readonly walletTxs: Array<Record<string, unknown>> = [];
  /** The node's pending transaction count for every sender. */
  private pending = 5;

  constructor() {
    super('http://stub.invalid', Network.from(AMOY), { staticNetwork: true, batchMaxCount: 1 });
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
        return toQuantity(AMOY);
      case 'eth_blockNumber':
        return '0x64';
      case 'eth_gasPrice':
        return toQuantity(80n * GWEI);
      case 'eth_maxPriorityFeePerGas':
        return toQuantity(30n * GWEI);
      case 'eth_getTransactionCount':
        return toQuantity(this.pending);
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
          baseFeePerGas: toQuantity(50n * GWEI)
        };
      case 'eth_sendRawTransaction': {
        const raw = String(params[0]);
        this.rawTxs.push(raw);
        this.pending += 1;
        return keccak256(raw);
      }
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
        return {
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
          nonce: '0x5',
          value: '0x0',
          chainId: toQuantity(AMOY),
          yParity: '0x0',
          r: `0x${'01'.repeat(32)}`,
          s: `0x${'01'.repeat(32)}`
        };
      default:
        throw new Error(`stub provider: unexpected RPC ${method}`);
    }
  }
}

/**
 * A custom provider with no raw JSON-RPC `send`: only ethers' high-level
 * `_perform` actions. Fees and gas are passed explicitly, so it needs no
 * fee data.
 */
class PerformOnlyProvider extends AbstractProvider {
  readonly performed: string[] = [];
  readonly rawTxs: string[] = [];

  constructor() {
    super(Network.from(AMOY));
  }

  override async _detectNetwork(): Promise<Network> {
    return Network.from(AMOY);
  }

  override async _perform<T>(req: PerformActionRequest): Promise<T> {
    this.performed.push(req.method);
    return this.perform(req);
  }

  private perform<T>(req: PerformActionRequest): T {
    switch (req.method) {
      case 'getBlockNumber':
        return 100 as T;
      case 'getTransactionCount':
        return '0x9' as T;
      case 'broadcastTransaction':
        this.rawTxs.push(req.signedTransaction);
        return keccak256(req.signedTransaction) as T;
      default:
        throw new Error(`perform-only provider: unexpected action ${req.method}`);
    }
  }
}

const nonces = (rawTxs: readonly string[]): number[] =>
  rawTxs.map((raw) => Transaction.from(raw).nonce);

describe('EthersV6Adapter nonce for a local signer', () => {
  it('gives back-to-back writes consecutive nonces inside the provider cache window', async () => {
    const node = new NodeStub();
    const adapter = ethersV6Adapter({ provider: node, signer: new Wallet(TEST_KEY, node) });
    const started = Date.now();
    await adapter.write(transfer);
    await adapter.write(transfer);
    // Both writes ran inside ethers' 250 ms cache, where the old path
    // reused the first write's nonce.
    expect(Date.now() - started).below(250);
    expect(nonces(node.rawTxs)).deep.equals([5, 6]);
  });

  it('lets a caller-supplied nonce win without asking the node', async () => {
    const node = new NodeStub();
    const adapter = ethersV6Adapter({ provider: node, signer: new Wallet(TEST_KEY, node) });
    await adapter.write({ ...transfer, nonce: 42 });
    expect(nonces(node.rawTxs)).deep.equals([42]);
    expect(node.calls).not.includes('eth_getTransactionCount');
  });

  it('leaves the nonce to a NonceManager, which overwrites any nonce it is given', async () => {
    const node = new NodeStub();
    const signer = new NonceManager(new Wallet(TEST_KEY, node));
    const adapter = ethersV6Adapter({ provider: node, signer });
    await adapter.write(transfer);
    await adapter.write(transfer);
    expect(nonces(node.rawTxs)).deep.equals([5, 6]);
    // Only the NonceManager's own first read reaches the node.
    expect(node.calls.filter((c) => c === 'eth_getTransactionCount')).lengthOf(1);
  });

  it('leaves the nonce to ethers on a provider without send', async () => {
    const provider = new PerformOnlyProvider();
    const adapter = ethersV6Adapter({ provider, signer: new Wallet(TEST_KEY, provider) });
    await adapter.write({
      ...transfer,
      chainId: AMOY,
      maxFeePerGas: 200n * GWEI,
      maxPriorityFeePerGas: 45n * GWEI
    });
    expect(nonces(provider.rawTxs)).deep.equals([9]);
    expect(provider.performed).includes('getTransactionCount');
  });
});

describe('EthersV6Adapter nonce for a JSON-RPC wallet signer', () => {
  it('lets the wallet assign the nonce', async () => {
    const node = new NodeStub();
    const adapter = ethersV6Adapter({ provider: node, signer: await node.getSigner() });
    await adapter.write({ ...transfer, chainId: AMOY });
    expect(node.walletTxs).lengthOf(1);
    expect(node.walletTxs[0]).not.property('nonce');
    expect(node.calls).not.includes('eth_getTransactionCount');
  });
});
