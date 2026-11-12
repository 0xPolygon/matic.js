import type { JsonRpcError, JsonRpcPayload, JsonRpcResult } from 'ethers';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JsonRpcApiProvider, Network, Wallet as V6Wallet } from 'ethers';
import { providers as v5providers, Wallet as V5Wallet } from 'ethers-v5';
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseTransaction
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import type { Adapter, Hex } from '../../src/adapter.ts';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import {
  DepositError,
  DepositNotReplayableError,
  TransactionNotFoundError,
  UnsupportedNetworkError
} from '../../src/errors.ts';
import { encodeAbiParameters } from '../../src/internal/abi-encode.ts';
import { POSClient } from '../../src/pos-client.ts';
import { expectLibraryErrorByIdentity, recordingAdapter } from './library-errors.ts';

/**
 * `replayDeposit` / `prepareReplayDeposit` through each of the three real
 * adapters over a stubbed JSON-RPC transport, against the two committed
 * mainnet failed-delivery records: 3212421 (a hash record) and 3192364 (a
 * payload record kept from before the Uburu fork). The stub chain answers the
 * status reads and what a write needs, and records every method, so the tests
 * can assert both what was broadcast and what was never asked of the wallet.
 *
 * The expected calldata is built here with viem from values decoded by the
 * test itself, not from the SDK's own decoder.
 */

interface Fixture {
  transactionHash: string;
  blockNumber: string;
  stateSyncedLog: { address: Hex; topics: Hex[]; data: Hex; logIndex: string };
}
interface HashFixture extends Fixture {
  childFailedStateSyncHash: Hex;
}
interface PayloadFixture extends Fixture {
  childFailedStateSyncPayload: Hex;
}

const readFixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8')) as T;
const HASH_RECORD = readFixture<HashFixture>('mainnet-state-sync-3212421.json');
const PAYLOAD_RECORD = readFixture<PayloadFixture>('mainnet-state-sync-3192364.json');

const HASH_STATE_ID = 3212421n;
const PAYLOAD_STATE_ID = 3192364n;
const PARENT_CHAIN = 1;
const CHILD_CHAIN = 137;
const OTHER_CHAIN = 80002;
const ADDR = '0x1111111111111111111111111111111111111111';
const STATE_RECEIVER = '0x0000000000000000000000000000000000001001';
const TEST_KEY = `0x${'11'.repeat(32)}` as const;
const GWEI = 1_000_000_000n;
const ESTIMATE = 300_000n;
const LAST_STATE_ID_SELECTOR = '0x5407ca67';
const FAILED_HASH_SELECTOR = '0x8c828b8a';
const FAILED_PAYLOAD_SELECTOR = '0x6757e5d9';

const replayAbi = parseAbi([
  'function replayFailedStateSync(uint256 stateId)',
  'function replayFailedStateSyncWithData(uint256 stateId, address receiver, bytes data)'
]);

const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const quantity = (n: bigint): string => `0x${n.toString(16)}`;

/** What the test itself reads off a fixture's `StateSynced` log. */
const independentArgs = (log: Fixture['stateSyncedLog']) => ({
  receiver: `0x${(log.topics[2] ?? '').slice(-40)}` as Hex,
  data: decodeAbiParameters([{ type: 'bytes' }], log.data)[0]
});
const HASH_CALLDATA = (() => {
  const { receiver, data } = independentArgs(HASH_RECORD.stateSyncedLog);
  return encodeFunctionData({
    abi: replayAbi,
    functionName: 'replayFailedStateSyncWithData',
    args: [HASH_STATE_ID, receiver, data]
  });
})();
const PAYLOAD_CALLDATA = encodeFunctionData({
  abi: replayAbi,
  functionName: 'replayFailedStateSync',
  args: [PAYLOAD_STATE_ID]
});

type NodeError = { code: number; message: string; data?: string };

const REVERT_DATA = (() => {
  // Error(string) "EVENT_ALREADY_PROCESSED", as a node returns it.
  const text = Buffer.from('EVENT_ALREADY_PROCESSED').toString('hex').padEnd(64, '0');
  return `0x08c379a0${word(32n).slice(2)}${word(23n).slice(2)}${text}`;
})();

/** One stub chain; the parent role serves the deposit receipt, the child role the receiver. */
class StubChain {
  readonly methods: string[] = [];
  readonly rawTxs: Hex[] = [];
  lastStateId = HASH_STATE_ID;
  failedHash: Hex = HASH_RECORD.childFailedStateSyncHash;
  failedPayload: Hex = '0x';
  deposit: Fixture = HASH_RECORD;
  /** `'unmined'`: a tx in no block; `'unknown'`: no such tx at all. */
  receiptMode: 'mined' | 'unmined' | 'unknown' = 'mined';
  estimateFailure: NodeError | undefined;

  readonly chainId: number;

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  failureFor(method: string): NodeError | undefined {
    return method === 'eth_estimateGas' ? this.estimateFailure : undefined;
  }

  private selectorOf(params: readonly unknown[]): string {
    const call = params[0] as { data?: string; input?: string };
    return (call.data ?? call.input ?? '').slice(0, 10).toLowerCase();
  }

  answer(method: string, params: readonly unknown[]): unknown {
    this.methods.push(method);
    switch (method) {
      case 'eth_chainId':
        return quantity(BigInt(this.chainId));
      case 'net_version':
        return String(this.chainId);
      case 'eth_blockNumber':
        return '0x64';
      case 'eth_gasPrice':
        return quantity(40n * GWEI);
      case 'eth_maxPriorityFeePerGas':
        return quantity(30n * GWEI);
      case 'eth_getTransactionCount':
        return '0x7';
      case 'eth_estimateGas':
        return quantity(ESTIMATE);
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
          baseFeePerGas: quantity(10n * GWEI)
        };
      case 'eth_sendRawTransaction': {
        const raw = params[0];
        if (typeof raw !== 'string' || !raw.startsWith('0x')) {
          throw new Error('stub chain: malformed raw transaction');
        }
        this.rawTxs.push(raw as Hex);
        return keccak256(raw as Hex);
      }
      case 'eth_getTransactionByHash':
        return this.receiptMode === 'unmined' ? { blockNumber: null } : null;
      case 'eth_getTransactionReceipt': {
        if (this.receiptMode !== 'mined') return null;
        const deposit = this.deposit;
        const log = deposit.stateSyncedLog;
        return {
          transactionHash: deposit.transactionHash,
          transactionIndex: '0x0',
          blockHash: `0x${'b1'.repeat(32)}`,
          blockNumber: deposit.blockNumber,
          from: ADDR,
          to: log.address,
          contractAddress: null,
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          effectiveGasPrice: '0x1',
          type: '0x2',
          status: '0x1',
          logsBloom: `0x${'00'.repeat(256)}`,
          logs: [
            {
              ...log,
              transactionHash: deposit.transactionHash,
              transactionIndex: '0x0',
              blockHash: `0x${'b1'.repeat(32)}`,
              blockNumber: deposit.blockNumber,
              removed: false
            }
          ]
        };
      }
      case 'eth_call': {
        const selector = this.selectorOf(params);
        if (selector === LAST_STATE_ID_SELECTOR) return word(this.lastStateId);
        if (selector === FAILED_HASH_SELECTOR) return this.failedHash;
        if (selector === FAILED_PAYLOAD_SELECTOR) {
          return encodeAbiParameters([this.failedPayload], ['bytes']);
        }
        throw Object.assign(new Error(`stub chain: unexpected eth_call ${selector}`), {
          code: -32601
        });
      }
      default:
        throw Object.assign(new Error(`stub chain: unexpected RPC ${method}`), { code: -32601 });
    }
  }
}

const thrown = ({ code, message, data }: NodeError): Error =>
  Object.assign(new Error(message), { code, data });

class V5Stub extends v5providers.StaticJsonRpcProvider {
  private readonly chain: StubChain;
  constructor(chain: StubChain) {
    super('http://stub.invalid', { chainId: chain.chainId, name: 'stub' });
    this.chain = chain;
  }
  override async send(method: string, params: unknown[]): Promise<unknown> {
    const failure = this.chain.failureFor(method);
    if (failure !== undefined) throw thrown(failure);
    return this.chain.answer(method, params);
  }
}

class V6Stub extends JsonRpcApiProvider {
  private readonly chain: StubChain;
  constructor(chain: StubChain) {
    super(Network.from(chain.chainId), { staticNetwork: true, batchMaxCount: 1 });
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

/**
 * `reads` answers the read RPC; `wallet` is the chain the signing wallet is on
 * (the same chain unless a test says the wallet sits elsewhere). `signed:
 * false` builds a read-only adapter.
 */
interface Build {
  reads: StubChain;
  wallet?: StubChain;
  signed: boolean;
}

const viemTransport = (chain: StubChain) =>
  custom({
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      const failure = chain.failureFor(method);
      if (failure !== undefined) throw thrown(failure);
      return chain.answer(method, Array.isArray(params) ? params : []);
    }
  });

const harnesses: Array<[string, (build: Build) => Adapter]> = [
  [
    'ethers v5',
    ({ reads, wallet, signed }) => {
      const provider = new V5Stub(reads);
      return ethersV5Adapter({
        provider,
        ...(signed ? { signer: new V5Wallet(TEST_KEY, new V5Stub(wallet ?? reads)) } : {})
      });
    }
  ],
  [
    'ethers v6',
    ({ reads, wallet, signed }) => {
      const provider = new V6Stub(reads);
      return ethersV6Adapter({
        provider,
        ...(signed ? { signer: new V6Wallet(TEST_KEY, new V6Stub(wallet ?? reads)) } : {})
      });
    }
  ],
  [
    'viem',
    ({ reads, wallet, signed }) =>
      viemAdapter({
        public: createPublicClient({ transport: viemTransport(reads) }),
        ...(signed
          ? {
              wallet: createWalletClient({
                account: privateKeyToAccount(TEST_KEY),
                transport: viemTransport(wallet ?? reads)
              })
            }
          : {})
      })
  ]
];

const initClient = async ({
  parent,
  child,
  childAdapter
}: {
  parent: StubChain;
  child: StubChain;
  childAdapter: Adapter;
}): Promise<POSClient> => {
  parent.deposit = child.deposit;
  parent.receiptMode = child.receiptMode;
  return POSClient.init({
    network: 'mainnet',
    parent: harnesses[2]?.[1]({ reads: parent, signed: false }) ?? childAdapter,
    child: childAdapter,
    addresses: {
      RootChainManager: ADDR,
      ERC20Predicate: ADDR,
      ERC721Predicate: ADDR,
      ERC1155Predicate: ADDR,
      EtherPredicate: ADDR,
      RootChain: ADDR,
      GasSwapper: ADDR
    }
  });
};

const hashChain = (): StubChain => new StubChain(CHILD_CHAIN);
const payloadChain = (): StubChain => {
  const child = new StubChain(CHILD_CHAIN);
  child.deposit = PAYLOAD_RECORD;
  child.lastStateId = PAYLOAD_STATE_ID;
  child.failedHash = word(0n);
  child.failedPayload = PAYLOAD_RECORD.childFailedStateSyncPayload;
  return child;
};

const settle = <T>(p: Promise<T>): Promise<{ value?: T; err?: unknown }> =>
  p.then(
    (value) => ({ value }),
    (err: unknown) => ({ err })
  );

/** What a refused replay must not have asked of the chain or the wallet. */
const expectNothingSent = (chain: StubChain): void => {
  expect(chain.methods).not.include('eth_estimateGas');
  expect(chain.methods).not.include('eth_sendRawTransaction');
  expect(chain.methods).not.include('eth_getTransactionCount');
};

const expectOneReplayBroadcast = ({
  chain,
  data,
  gas
}: {
  chain: StubChain;
  data: Hex;
  gas: bigint;
}): Hex => {
  expect(chain.rawTxs).lengthOf(1);
  const [raw] = chain.rawTxs;
  if (raw === undefined) throw new Error('no raw transaction');
  const tx = parseTransaction(raw);
  expect(tx).property('chainId').equals(CHILD_CHAIN);
  expect(tx).property('to').equals(STATE_RECEIVER);
  expect(tx).property('data').equals(data);
  expect(tx).property('gas').equals(gas);
  return raw;
};

describe.each(harnesses)('replayDeposit / prepareReplayDeposit through %s', (_name, build) => {
  const clientFor = async ({
    child,
    wallet,
    signed = true,
    wrapChild = false
  }: {
    child: StubChain;
    wallet?: StubChain;
    signed?: boolean;
    wrapChild?: boolean;
  }) => {
    const adapter = build({ reads: child, signed, ...(wallet !== undefined ? { wallet } : {}) });
    const recorded = recordingAdapter(adapter);
    const pos = await initClient({
      parent: new StubChain(PARENT_CHAIN),
      child,
      childAdapter: wrapChild ? recorded.adapter : adapter
    });
    return { pos, recorded };
  };

  describe('prepare', () => {
    it('prepare, hash record (3212421): the same calldata viem encodes', async () => {
      const child = hashChain();
      const { pos } = await clientFor({ child });
      const tx = await pos.prepareReplayDeposit(HASH_RECORD.transactionHash);
      expect(tx).property('to').equals(STATE_RECEIVER);
      expect(tx).property('data').equals(HASH_CALLDATA);
      expect(tx.data.slice(0, 10)).equals('0x94453fd3');
      expect(tx).not.property('value');
      expectNothingSent(child);
    });

    it('prepare, payload record (3192364): the same calldata viem encodes', async () => {
      const child = payloadChain();
      const { pos } = await clientFor({ child });
      const tx = await pos.prepareReplayDeposit(PAYLOAD_RECORD.transactionHash);
      expect(tx).property('to').equals(STATE_RECEIVER);
      expect(tx).property('data').equals(PAYLOAD_CALLDATA);
      expect(tx.data.slice(0, 10)).equals('0x03112a17');
      expectNothingSent(child);
    });
  });

  describe('write', () => {
    it('write, hash record: one raw tx whose calldata is the prepared calldata', async () => {
      const child = hashChain();
      const { pos } = await clientFor({ child });
      const prepared = await pos.prepareReplayDeposit(HASH_RECORD.transactionHash);
      const result = await pos.replayDeposit(HASH_RECORD.transactionHash);
      const raw = expectOneReplayBroadcast({
        chain: child,
        data: prepared.data as Hex,
        gas: BigInt(Math.trunc(Number(ESTIMATE) * 1.15))
      });
      expect(result).property('hash').equals(keccak256(raw));
    });

    it('write, payload record: one raw tx whose calldata is the prepared calldata', async () => {
      const child = payloadChain();
      const { pos } = await clientFor({ child });
      const prepared = await pos.prepareReplayDeposit(PAYLOAD_RECORD.transactionHash);
      const result = await pos.replayDeposit(PAYLOAD_RECORD.transactionHash);
      const raw = expectOneReplayBroadcast({
        chain: child,
        data: prepared.data as Hex,
        gas: BigInt(Math.trunc(Number(ESTIMATE) * 1.15))
      });
      expect(prepared).property('data').equals(PAYLOAD_CALLDATA);
      expect(result).property('hash').equals(keccak256(raw));
    });

    it('write with options.gasLimit: no estimate, the option is the gas limit', async () => {
      const child = hashChain();
      const { pos } = await clientFor({ child });
      await pos.replayDeposit(HASH_RECORD.transactionHash, { gasLimit: 777_000n });
      expect(child.methods).not.include('eth_estimateGas');
      expectOneReplayBroadcast({ chain: child, data: HASH_CALLDATA, gas: 777_000n });
    });
  });

  describe('pre-send conditions', () => {
    const cases: Array<{
      name: string;
      setup: (child: StubChain) => void;
      status: Record<string, unknown>;
      hint: string;
    }> = [
      {
        name: 'not-synced',
        setup: (child) => {
          child.lastStateId = HASH_STATE_ID - 1n;
        },
        status: { deposited: false, reason: 'not-synced' },
        hint: 'Poll getDepositStatus until it answers deposited or delivery-failed'
      },
      {
        name: 'delivered (both records empty)',
        setup: (child) => {
          child.failedHash = word(0n);
        },
        status: { deposited: true },
        hint: 'has been delivered on the child chain; there is nothing to replay'
      },
      {
        name: 'foreign record (a different hash)',
        setup: (child) => {
          child.failedHash = `0x${'de'.repeat(32)}`;
        },
        status: {
          deposited: false,
          reason: 'delivery-failed',
          stateId: HASH_STATE_ID,
          record: 'hash',
          replayable: false
        },
        hint: 'Check the deposit transaction hash: the record belongs to a different state sync'
      },
      {
        name: 'pending (no receipt, tx in no block)',
        setup: (child) => {
          child.receiptMode = 'unmined';
        },
        status: { deposited: false, reason: 'pending' },
        hint: 'Wait for it to mine, then poll getDepositStatus'
      }
    ];

    it.each(cases)('write refuses: $name', async ({ setup, status, hint }) => {
      const child = hashChain();
      setup(child);
      const { pos } = await clientFor({ child });
      const { err } = await settle(pos.replayDeposit(HASH_RECORD.transactionHash));
      const op = DepositError.find(err);
      expect(op).property('info').property('operation').equals('replayDeposit');
      expect(op).property('info').property('mode').equals('write');
      const condition = DepositNotReplayableError.find(err);
      expect(condition).property('message').include(hint);
      expect(condition).nested.property('info.transactionHash').equals(HASH_RECORD.transactionHash);
      expect(condition?.info.status).deep.include(status);
      expectNothingSent(child);
    });

    it.each(cases)('prepare refuses the same: $name', async ({ setup, status, hint }) => {
      const child = hashChain();
      setup(child);
      const { pos } = await clientFor({ child });
      const { err } = await settle(pos.prepareReplayDeposit(HASH_RECORD.transactionHash));
      const op = DepositError.find(err);
      expect(op).property('info').property('operation').equals('prepareReplayDeposit');
      expect(op).property('info').property('mode').equals('prepare');
      const condition = DepositNotReplayableError.find(err);
      expect(condition).property('message').include(hint);
      expect(condition?.info.status).deep.include(status);
      expectNothingSent(child);
    });

    it('a payload record of different content is refused as a foreign record', async () => {
      const child = payloadChain();
      child.failedPayload = encodeAbiParameters(
        [independentArgs(PAYLOAD_RECORD.stateSyncedLog).receiver, '0xdead'],
        ['address', 'bytes']
      );
      const { pos } = await clientFor({ child });
      const { err } = await settle(pos.replayDeposit(PAYLOAD_RECORD.transactionHash));
      expect(DepositNotReplayableError.find(err)?.info.status).deep.include({
        reason: 'delivery-failed',
        record: 'payload',
        replayable: false
      });
      expectNothingSent(child);
    });

    it('an unknown hash is the SDK own TransactionNotFoundError under DepositError', async () => {
      const child = hashChain();
      child.receiptMode = 'unknown';
      const { pos } = await clientFor({ child });
      const { err } = await settle(pos.replayDeposit(HASH_RECORD.transactionHash));
      expect(DepositError.find(err)).property('info').property('mode').equals('write');
      expect(TransactionNotFoundError.find(err)).instanceOf(TransactionNotFoundError);
      expect(DepositNotReplayableError.find(err)).equals(null);
      expectNothingSent(child);
    });
  });

  describe('errors that are not the SDK own', () => {
    it('a receiver revert at estimation is the library own error, nothing broadcast', async () => {
      const child = hashChain();
      child.estimateFailure = {
        code: 3,
        message: 'execution reverted: EVENT_ALREADY_PROCESSED',
        data: REVERT_DATA
      };
      const { pos, recorded } = await clientFor({ child, wrapChild: true });
      const { err } = await settle(pos.replayDeposit(HASH_RECORD.transactionHash));
      expectLibraryErrorByIdentity({ err, thrown: recorded.thrown });
      expect(child.rawTxs).lengthOf(0);
    });

    it('a wallet on another chain is refused with UnsupportedNetworkError, nothing broadcast', async () => {
      const child = hashChain();
      const wallet = new StubChain(OTHER_CHAIN);
      const { pos } = await clientFor({ child, wallet });
      const { err } = await settle(pos.replayDeposit(HASH_RECORD.transactionHash));
      expect(DepositError.find(err)).property('info').property('mode').equals('write');
      expect(UnsupportedNetworkError.find(err)).instanceOf(UnsupportedNetworkError);
      expect(child.rawTxs).lengthOf(0);
      expect(wallet.rawTxs).lengthOf(0);
    });
  });
});
