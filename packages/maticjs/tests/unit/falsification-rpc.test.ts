import type { JsonRpcError, JsonRpcPayload, JsonRpcResult } from 'ethers';

import { createServer } from 'node:http';

import { JsonRpcApiProvider, Network, Wallet as V6Wallet } from 'ethers';
import { providers as v5providers, Wallet as V5Wallet } from 'ethers-v5';
import { BaseError, createPublicClient, createWalletClient, custom, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, describe, expect, it } from 'vitest';

import type { Adapter, Hex } from '../../src/adapter.ts';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { FeeEstimationFailedError, rootCause } from '../../src/errors.ts';
import { noopLogger } from '../../src/logger.ts';
import { ERC20 } from '../../src/pos/erc20.ts';
import { RootChainManager } from '../../src/pos/root_chain_manager.ts';
import {
  expectLibraryErrorByIdentity,
  expectNoLibraryCause,
  recordingAdapter
} from './library-errors.ts';

/**
 * Falsification matrix, node-failure row: a JSON-RPC node rejects a call a
 * write depends on, and the consumer calls `erc20.approve(1n)`.
 *
 * The REAL adapter and the REAL web3 library do everything (fee lookup,
 * gas estimation, signing, broadcast); only the JSON-RPC transport is
 * stubbed. The error the library raised for the node's answer must reach
 * the consumer as the same object, with nothing of the SDK's around it, so
 * the node's text and code are where that library documents them. Only a
 * node answer the SDK itself cannot parse (a malformed fee quantity) is an
 * SDK condition.
 *
 * Part of the enforcement of AGENTS.md, "Error ownership (mandatory)": the
 * rows asserting the thrown object IS the library's must stay green and
 * must not be weakened.
 */

const AMOY = 80002;
const TOKEN = '0x3333333333333333333333333333333333333333';
const SPENDER = '0x2222222222222222222222222222222222222222';
const ROOT_CHAIN_MANAGER = '0x1111111111111111111111111111111111111111';
// Throwaway fixture key: signs locally, never touches a real network.
const TEST_KEY = `0x${'11'.repeat(32)}` as const;
const ACCOUNT = privateKeyToAccount(TEST_KEY);
const GWEI = 1_000_000_000n;

const NO_TIP_METHOD = 'the method eth_maxPriorityFeePerGas does not exist/is not available';
const EXCEEDS_BALANCE =
  'insufficient funds for gas * price + value: tx cost 1000000000000000 exceeds balance 0';
const NO_GAS_PRICE = 'gas price unavailable';
const NONCE_TOO_LOW = 'nonce too low';
const UNDERPRICED = 'transaction underpriced';

const toQuantity = (v: bigint | number): string => `0x${v.toString(16)}`;

/** A node's JSON-RPC error: what the stub transport answers with. */
type NodeError = { code: number; message: string };

/** A chain that answers every call a write needs, except those told to fail. */
class StubChain {
  readonly rawTxs: Hex[] = [];
  private readonly failures: Readonly<Record<string, NodeError>>;
  private readonly overrides: Readonly<Record<string, unknown>>;

  constructor(
    failures: Readonly<Record<string, NodeError>> = {},
    overrides: Readonly<Record<string, unknown>> = {}
  ) {
    this.failures = failures;
    this.overrides = overrides;
  }

  /** The failure configured for `method`, if any. */
  failureFor(method: string): NodeError | undefined {
    return this.failures[method];
  }

  answer(method: string, params: readonly unknown[]): unknown {
    if (method in this.overrides) return this.overrides[method];
    switch (method) {
      case 'eth_chainId':
        return toQuantity(AMOY);
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
        // Answer like a real node ("method not found") so a library probing
        // an optional method (viem's `eth_fillTransaction`) falls back.
        throw thrown({ code: -32601, message: `stub chain: unexpected RPC ${method}` });
    }
  }
}

/** A thrown node error, as an EIP-1193 / ethers v5 transport raises it. */
const thrown = ({ code, message }: NodeError): Error => Object.assign(new Error(message), { code });

// --- transports: the only stubbed layer --------------------------------------

/** ethers v5 raises a JSON-RPC error body as an `Error` with its `code` from `send`. */
class V5StubProvider extends v5providers.StaticJsonRpcProvider {
  private readonly chain: StubChain;

  constructor(chain: StubChain) {
    super('http://stub.invalid', { chainId: AMOY, name: 'stub' });
    this.chain = chain;
  }

  override async send(method: string, params: unknown[]): Promise<unknown> {
    const failure = this.chain.failureFor(method);
    if (failure !== undefined) throw thrown(failure);
    return this.chain.answer(method, params);
  }
}

/** ethers v6 gets the JSON-RPC error body itself and classifies it. */
class V6StubProvider extends JsonRpcApiProvider {
  private readonly chain: StubChain;

  constructor(chain: StubChain) {
    super(Network.from(AMOY), { staticNetwork: true, batchMaxCount: 1 });
    this.chain = chain;
  }

  override async _send(
    payload: JsonRpcPayload | JsonRpcPayload[]
  ): Promise<Array<JsonRpcResult | JsonRpcError>> {
    const batch = Array.isArray(payload) ? payload : [payload];
    return batch.map((p) => {
      const failure = this.chain.failureFor(p.method);
      if (failure !== undefined) return { id: p.id, error: { ...failure } };
      try {
        return {
          id: p.id,
          result: this.chain.answer(p.method, Array.isArray(p.params) ? p.params : [])
        };
      } catch (err) {
        return { id: p.id, error: { code: -32601, message: String(err) } };
      }
    });
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
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      const failure = chain.failureFor(method);
      if (failure !== undefined) throw thrown(failure);
      return chain.answer(method, Array.isArray(params) ? params : []);
    }
  });
  return viemAdapter({
    public: createPublicClient({ transport }),
    wallet: createWalletClient({ account: ACCOUNT, transport })
  });
};

type Library = 'ethers v5' | 'ethers v6' | 'viem';

const harnesses: Array<[Library, (chain: StubChain) => Adapter]> = [
  ['ethers v5', v5Adapter],
  ['ethers v6', v6Adapter],
  ['viem', viemStubAdapter]
];

const parentToken = (adapter: Adapter): ERC20 =>
  new ERC20({
    tokenAddress: TOKEN,
    isParent: true,
    adapter,
    parentAdapter: adapter,
    // `approve` with an explicit spender never reaches the bridge. `as never`
    // is the one cast: the bridge is a test seam, not what is falsified.
    bridge: {} as never,
    rootChainManager: new RootChainManager({
      adapter,
      getAddress: () => Promise.resolve(ROOT_CHAIN_MANAGER),
      logger: noopLogger
    }),
    encodeParameters: () => '0x',
    logger: noopLogger
  });

const approveOn = async (
  chain: StubChain,
  build: (chain: StubChain) => Adapter
): Promise<{ err: unknown; thrown: readonly unknown[] }> => {
  const { adapter, thrown } = recordingAdapter(build(chain));
  const err = await parentToken(adapter)
    .approve(1n, { spenderAddress: SPENDER })
    .then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e
    );
  return { err, thrown };
};

describe('fee path: the node cannot price the transaction', () => {
  it('ethers v5: eth_maxPriorityFeePerGas rejects → the library error as-is', async () => {
    const chain = new StubChain({
      eth_maxPriorityFeePerGas: { code: -32601, message: NO_TIP_METHOD }
    });

    const { err, thrown } = await approveOn(chain, v5Adapter);

    expectLibraryErrorByIdentity({ err, thrown });
    expect(FeeEstimationFailedError.has(err)).equals(false);
    const root = rootCause(err);
    expect(root).property('code').equals(-32601);
    expect(root).property('message').equals(NO_TIP_METHOD);
    expect(chain.rawTxs).lengthOf(0);
  });

  it('ethers v6: getFeeData and then eth_maxPriorityFeePerGas reject → the node error as-is', async () => {
    // ethers v6's getFeeData fails only when the latest block cannot be read.
    const chain = new StubChain({
      eth_getBlockByNumber: { code: -32000, message: 'header not found' },
      eth_maxPriorityFeePerGas: { code: -32601, message: NO_TIP_METHOD }
    });

    const { err, thrown } = await approveOn(chain, v6Adapter);

    expectLibraryErrorByIdentity({ err, thrown });
    expect(FeeEstimationFailedError.has(err)).equals(false);
    // ethers v6 classifies the body as UNSUPPORTED_OPERATION and keeps the
    // node's error at `info.error`, where rootCause's hop finds it.
    const root = rootCause(err);
    expect(root).property('code').equals(-32601);
    expect(root).property('message').equals(NO_TIP_METHOD);
    expect(chain.rawTxs).lengthOf(0);
  });

  it('viem: eth_maxPriorityFeePerGas and then eth_gasPrice reject → the library error as-is', async () => {
    // viem prices the transaction while estimating its gas, falling back
    // from eth_maxPriorityFeePerGas to eth_gasPrice: the fee lookup fails
    // only when the node answers neither.
    const chain = new StubChain({
      eth_maxPriorityFeePerGas: { code: -32601, message: NO_TIP_METHOD },
      eth_gasPrice: { code: -32000, message: NO_GAS_PRICE }
    });

    const { err, thrown } = await approveOn(chain, viemStubAdapter);

    expectLibraryErrorByIdentity({ err, thrown });
    expect(err).instanceOf(BaseError);
    expect(FeeEstimationFailedError.has(err)).equals(false);
    const root = rootCause(err);
    expect(root).property('code').equals(-32000);
    expect(root).property('message').equals(NO_GAS_PRICE);
    expect(chain.rawTxs).lengthOf(0);
  });

  it('viem: eth_estimateGas rejects -32000 "… exceeds balance" → the library error as-is', async () => {
    const chain = new StubChain({ eth_estimateGas: { code: -32000, message: EXCEEDS_BALANCE } });

    const { err, thrown } = await approveOn(chain, viemStubAdapter);

    expectLibraryErrorByIdentity({ err, thrown });
    expect(err).property('name').equals('ContractFunctionExecutionError');
    const root = rootCause(err);
    expect(root).property('code').equals(-32000);
    expect(root).property('message').equals(EXCEEDS_BALANCE);
    expect(chain.rawTxs).lengthOf(0);
  });

  it.each([
    ['ethers v5', v5Adapter],
    ['ethers v6', v6Adapter]
  ] as const)(
    '%s: a malformed eth_maxPriorityFeePerGas answer → ApproveError ∋ FeeEstimationFailedError',
    async (_library, build) => {
      // v6 asks the node only once ethers' own fee data has failed.
      const chain = new StubChain(
        build === v6Adapter ? { eth_getBlockByNumber: { code: -32000, message: 'no head' } } : {},
        { eth_maxPriorityFeePerGas: 'not a quantity' }
      );

      const { err } = await approveOn(chain, build);

      expect(err).property('name').equals('ApproveError');
      expect(FeeEstimationFailedError.find(err))
        .nested.property('info.response')
        .equals('not a quantity');
      expectNoLibraryCause(err);
      expect(chain.rawTxs).lengthOf(0);
    }
  );
});

describe.each(harnesses)(
  '%s — eth_sendRawTransaction rejects (local signer)',
  (_library, build) => {
    it.each([NONCE_TOO_LOW, UNDERPRICED])(
      '"%s": the library error as-is, the node error at its root',
      async (text) => {
        const chain = new StubChain({ eth_sendRawTransaction: { code: -32000, message: text } });

        const { err, thrown } = await approveOn(chain, build);

        expectLibraryErrorByIdentity({ err, thrown });
        const root = rootCause(err);
        expect(root).property('message').contains(text);
        expect(root).property('code').equals(-32000);
      }
    );
  }
);

// --- ethers v5 over a real HTTP JsonRpcProvider ------------------------------
//
// The stubs above override `send`, which skips ethers v5's `fetchJson`. Over
// real HTTP, v5 wraps the node's error body in its own SERVER_ERROR, and its
// UNPREDICTABLE_GAS_LIMIT / NONCE_EXPIRED errors keep that SERVER_ERROR at
// `.error`, so the node's numeric code sits one `.error` further down. Only
// the node is stubbed here: a JSON-RPC server on a loopback port.

const HTTP_SECRET = 'S9HTTPSECRET';
const COOLDOWN = 'execution reverted: Cooldown';

type RpcRequest = { id?: unknown; method?: unknown; params?: unknown };

/** One JSON-RPC response from `chain`, as a node would send it. */
const respond = (chain: StubChain, request: RpcRequest): unknown => {
  const method = typeof request.method === 'string' ? request.method : '';
  const failure = chain.failureFor(method);
  if (failure !== undefined) return { jsonrpc: '2.0', id: request.id, error: failure };
  try {
    const params = Array.isArray(request.params) ? request.params : [];
    return { jsonrpc: '2.0', id: request.id, result: chain.answer(method, params) };
  } catch {
    return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } };
  }
};

type Node = { url: string; close: () => Promise<void> };

/** Serves `chain` as JSON-RPC over HTTP on a free loopback port. */
const serveChain = async (chain: StubChain): Promise<Node> => {
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
      const reply = Array.isArray(body)
        ? body.map((entry: RpcRequest) => respond(chain, entry))
        : respond(chain, typeof body === 'object' && body !== null ? body : {});
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/?token=${HTTP_SECRET}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
};

describe("ethers v5 over a real HTTP provider — the node code is below v5's own SERVER_ERROR", () => {
  const nodes: Node[] = [];
  afterAll(async () => {
    await Promise.all(nodes.map((node) => node.close()));
  });

  const approveOverHttp = async (
    chain: StubChain
  ): Promise<{ err: unknown; thrown: readonly unknown[] }> => {
    const node = await serveChain(chain);
    nodes.push(node);
    const provider = new v5providers.StaticJsonRpcProvider(node.url, {
      chainId: AMOY,
      name: 'stub'
    });
    const adapter = ethersV5Adapter({ provider, signer: new V5Wallet(TEST_KEY, provider) });
    return approveOn(chain, () => adapter);
  };

  it('eth_estimateGas reverts {3, "execution reverted: Cooldown"} → the ethers error as-is, the node error at its root', async () => {
    const chain = new StubChain({ eth_estimateGas: { code: 3, message: COOLDOWN } });

    const { err, thrown } = await approveOverHttp(chain);

    expectLibraryErrorByIdentity({ err, thrown });
    expect(err).property('code').equals('UNPREDICTABLE_GAS_LIMIT');
    const root = rootCause(err);
    expect(root).property('code').equals(3);
    expect(root).property('message').equals(COOLDOWN);
    expect(chain.rawTxs).lengthOf(0);
  });

  it('eth_sendRawTransaction rejects {-32003, "nonce too low"} → the ethers error as-is, the node error at its root', async () => {
    const chain = new StubChain({
      eth_sendRawTransaction: { code: -32003, message: NONCE_TOO_LOW }
    });

    const { err, thrown } = await approveOverHttp(chain);

    expectLibraryErrorByIdentity({ err, thrown });
    expect(err).property('code').equals('NONCE_EXPIRED');
    const root = rootCause(err);
    expect(root).property('code').equals(-32003);
    expect(root).property('message').equals(NONCE_TOO_LOW);
  });
});
