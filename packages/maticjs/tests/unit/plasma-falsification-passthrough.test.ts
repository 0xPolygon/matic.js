import type { JsonRpcError, JsonRpcPayload, JsonRpcResult } from 'ethers';

import { JsonRpcApiProvider, Network, Wallet as V6Wallet } from 'ethers';
import { providers as v5providers, Wallet as V5Wallet } from 'ethers-v5';
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeAbiParameters,
  toFunctionSelector
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Hex } from '../../src/adapter.ts';
import type { PlasmaAddresses } from '../../src/plasma/addresses.ts';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { rootCause } from '../../src/errors.ts';
import { ExitProofBuilder } from '../../src/internal/exit-proof.ts';
import { L1_CHAIN_ID, L2_CHAIN_ID } from '../../src/networks.ts';
import { PlasmaClient } from '../../src/plasma/plasma-client.ts';
import { expectLibraryErrorByIdentity, recordingAdapter } from './library-errors.ts';

/**
 * Falsification row for the error contract on the Plasma writes that run
 * Plasma code before the write: `confirmWithdraw` builds an exit payload and
 * `completeWithdraw` reads the exit queue, each ahead of its gas estimate. An
 * error thrown by the consumer's node or client library at that estimate is
 * not the SDK's, so both rethrow it as the very object that was thrown.
 * Nothing wraps it, clones it or rewrites its message.
 *
 * The node rejects the gas estimate with a revert, on each of viem, ethers v5
 * and ethers v6. The assertion is identity with what the adapter call
 * rejected with; the node's text and numeric code stay at the root of it.
 * Only the JSON-RPC transport is stubbed. How each adapter passes errors
 * through for every other write is proven by the falsification files that
 * drive the adapters directly.
 *
 * Part of the enforcement of AGENTS.md, "Error ownership (mandatory)": the
 * rows asserting the thrown object IS the library's must stay green and must
 * not be weakened.
 */

const PARENT = L1_CHAIN_ID.amoy;
const CHILD = L2_CHAIN_ID.amoy;
// Throwaway fixture key: signs locally, never touches a real network.
const TEST_KEY = `0x${'11'.repeat(32)}` as const;
const ACCOUNT = privateKeyToAccount(TEST_KEY);
const GWEI = 1_000_000_000n;
const BLOCK_HASH = `0x${'aa'.repeat(32)}`;
const TOKEN: Hex = '0x9999999999999999999999999999999999999999';
const QUEUE: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BURN = `0x${'ab'.repeat(32)}`;

const COOLDOWN = 'execution reverted: Cooldown';

const ADDRESSES: PlasmaAddresses = {
  RootChain: '0x1111111111111111111111111111111111111111',
  DepositManager: '0x2222222222222222222222222222222222222223',
  WithdrawManager: '0x3333333333333333333333333333333333333333',
  PlasmaERC20Predicate: '0x5555555555555555555555555555555555555556',
  ExitNFT: '0x4444444444444444444444444444444444444444',
  MaticToken: '0x6666666666666666666666666666666666666666',
  PolToken: '0x7777777777777777777777777777777777777777'
};

const toQuantity = (v: bigint | number): string => `0x${v.toString(16)}`;
const word = (v: Hex | bigint): Hex =>
  encodeAbiParameters([typeof v === 'bigint' ? { type: 'uint256' } : { type: 'address' }], [v]);

const READS: Record<string, Hex> = {
  [toFunctionSelector('function exitsQueues(address)')]: word(QUEUE),
  [toFunctionSelector('function currentSize()')]: word(1n)
};

/** A node or wallet error as a JSON-RPC transport raises it: message plus numeric code. */
type RpcFailure = { code: number; message: string };

const failure = ({ code, message }: RpcFailure): Error =>
  Object.assign(new Error(message), { code });

const codeAndMessage = (err: unknown): RpcFailure => {
  const code: unknown = err instanceof Error ? Reflect.get(err, 'code') : undefined;
  return {
    code: typeof code === 'number' ? code : -32603,
    message: err instanceof Error ? err.message : String(err)
  };
};

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

/** What goes wrong on a chain. */
interface Fault {
  /** What `eth_estimateGas` rejects with. */
  estimateGas?: RpcFailure;
}

class Chain {
  readonly methods: string[] = [];
  private readonly chainId: number;
  private readonly fault: Fault;

  constructor({ chainId, fault }: { chainId: number; fault: Fault }) {
    this.chainId = chainId;
    this.fault = fault;
  }

  answer(method: string, params: readonly unknown[]): unknown {
    this.methods.push(method);
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
        if (this.fault.estimateGas !== undefined) throw failure(this.fault.estimateGas);
        return toQuantity(100_000n);
      case 'eth_getBlockByNumber':
        return block(100n);
      case 'eth_call': {
        const call = params[0];
        const data: unknown =
          typeof call === 'object' && call !== null ? Reflect.get(call, 'data') : undefined;
        const answer = typeof data === 'string' ? READS[data.slice(0, 10)] : undefined;
        if (answer !== undefined) return answer;
        throw failure({ code: -32601, message: `stub chain: unscripted eth_call ${String(data)}` });
      }
      case 'eth_sendRawTransaction':
      case 'eth_sendTransaction':
        throw failure({ code: -32601, message: 'stub chain: nothing is expected to broadcast' });
      default:
        // -32601 is "method not found": viem does not retry it, and falls back
        // from `eth_fillTransaction` to filling the fields itself.
        throw failure({ code: -32601, message: `stub chain: unexpected RPC ${method}` });
    }
  }
}

// --- transports: the only stubbed layer --------------------------------------

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

class V6StubProvider extends JsonRpcApiProvider {
  private readonly chain: Chain;
  constructor({ chain, chainId }: { chain: Chain; chainId: number }) {
    super(Network.from(chainId), { staticNetwork: true, batchMaxCount: 1 });
    this.chain = chain;
  }
  override async _send(
    payload: JsonRpcPayload | JsonRpcPayload[]
  ): Promise<Array<JsonRpcResult | JsonRpcError>> {
    const batch = Array.isArray(payload) ? payload : [payload];
    return batch.map((p) => {
      try {
        return {
          id: p.id,
          result: this.chain.answer(p.method, Array.isArray(p.params) ? p.params : [])
        };
      } catch (err) {
        return { id: p.id, error: codeAndMessage(err) };
      }
    });
  }
}

interface Library {
  name: string;
  build: (args: { chain: Chain; chainId: number }) => Adapter;
}

const LIBRARIES: readonly Library[] = [
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

interface Write {
  name: string;
  run: (plasma: PlasmaClient) => Promise<unknown>;
}

const WRITES: readonly Write[] = [
  {
    name: 'confirmWithdraw',
    run: (p) => p.parent.erc20(TOKEN).confirmWithdraw(BURN)
  },
  { name: 'completeWithdraw', run: (p) => p.parent.erc20(TOKEN).completeWithdraw() }
];

/** The text and numeric code that must survive at the root of the error. */
const ESTIMATE_REVERT: RpcFailure = { code: 3, message: COOLDOWN };

const rejectionOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e
  );

// viem retries a node revert before giving it up, about a second per write.
describe.each(LIBRARIES)(
  '$name: Plasma writes pass the gas estimate revert through',
  { timeout: 15_000 },
  (library) => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each(WRITES)('$name rejects with the very error the library threw', async (write) => {
      // Building a payload is the golden test's job; here it only has to exist.
      vi.spyOn(ExitProofBuilder.prototype, 'buildExitPayload').mockResolvedValue('0x01');
      const parent = recordingAdapter(
        library.build({
          chain: new Chain({ chainId: PARENT, fault: { estimateGas: ESTIMATE_REVERT } }),
          chainId: PARENT
        })
      );
      const child = recordingAdapter(
        library.build({ chain: new Chain({ chainId: CHILD, fault: {} }), chainId: CHILD })
      );
      const plasma = await PlasmaClient.init({
        network: 'amoy',
        parent: parent.adapter,
        child: child.adapter,
        addresses: ADDRESSES
      });

      const err = await rejectionOf(write.run(plasma));

      expectLibraryErrorByIdentity({ err, thrown: [...parent.thrown, ...child.thrown] });
      const root = rootCause(err);
      expect(root).property('message').contains(ESTIMATE_REVERT.message);
      expect(root).property('code').equals(ESTIMATE_REVERT.code);
    });
  }
);
