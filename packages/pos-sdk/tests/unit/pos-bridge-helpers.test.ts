/**
 * Unit tests for the restored / changed `POSBridgeHelpers` capabilities:
 *
 * - `buildExitPayloads` (the legacy `buildMultiplePayloadsForExit`): fast
 *   path delegates to the proof API; local path enumerates every matching
 *   log and emits one payload per index.
 * - `isDeposited`: compares the deposit's `StateSynced` state id against
 *   the child `StateReceiver.lastStateId()`; throws when the event is
 *   absent.
 * - `blockTag` threading: the configured root-chain block tag reaches the
 *   adapter's `ReadRequest`.
 *
 * The proof-construction boundary (`ProofUtil.getReceiptProof` /
 * `buildBlockProof`) is the one thing stubbed for the local-enumeration
 * test — it needs an archive node to run. Everything else (index
 * enumeration, payload-per-index fan-out, stateId comparison) is real.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  Adapter,
  Hex,
  PreparedTx,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';
import type {
  IBlockWithTransaction,
  ITransactionReceipt
} from '../../src/interfaces/index.ts';
import type { BridgeChildClient } from '../../src/internal/pos-bridge-helpers.ts';

import { RootChainABI } from '../../src/abi/index.ts';
import { LogEventSignature } from '../../src/constant.ts';
import { ContractCaller } from '../../src/internal/contract-caller.ts';
import { POSBridgeHelpers } from '../../src/internal/pos-bridge-helpers.ts';
import { noopLogger } from '../../src/logger.ts';
import { ProofUtil } from '../../src/utils/proof_util.ts';

const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';
const ERC20_SIG = LogEventSignature.Erc20Transfer;

/**
 * A configurable fake adapter. `reads` returns canned values keyed by the
 * read's `functionName`; `readRequests` captures every ReadRequest so a
 * test can assert the block tag threaded through.
 */
class FakeAdapter implements Adapter {
  readonly readRequests: ReadRequest[] = [];
  #reads: Record<string, unknown>;
  #receipt: Receipt | null;

  constructor(reads: Record<string, unknown> = {}, receipt: Receipt | null = null) {
    this.#reads = reads;
    this.#receipt = receipt;
  }

  getChainId(): Promise<number> {
    return Promise.resolve(1);
  }
  read(req: ReadRequest): Promise<unknown> {
    this.readRequests.push(req);
    return Promise.resolve(this.#reads[req.functionName]);
  }
  write(_req: WriteRequest): Promise<TxResult> {
    return Promise.resolve({ hash: '0x0', confirmed: () => Promise.resolve({} as Receipt) });
  }
  prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    return Promise.resolve({ to: req.address, data: '0x' });
  }
  estimateGas(_req: WriteRequest): Promise<bigint> {
    return Promise.resolve(21_000n);
  }
  getTransactionReceipt(_hash: string): Promise<Receipt | null> {
    return Promise.resolve(this.#receipt);
  }
  keccak256(_data: Uint8Array | string): string {
    return '0x0';
  }
  request<T>(_method: string, _params: readonly unknown[]): Promise<T> {
    return Promise.resolve(undefined as T);
  }
}

/** Minimal child-bridge-client fake; only the methods a test path hits. */
function fakeChildClient(over: Partial<BridgeChildClient> = {}): BridgeChildClient {
  return {
    getTransactionReceipt: () => Promise.reject(new Error('not stubbed')),
    getTransaction: () => Promise.resolve({ blockNumber: 100 }),
    getBlockWithTransaction: () => Promise.reject(new Error('not stubbed')),
    getRootHash: () => Promise.resolve(''),
    encodeParameters: () => '0x',
    soliditySha3: () => '0x',
    ...over
  };
}

function makeHelpers(opts: {
  rootCaller: ContractCaller;
  childClient?: BridgeChildClient;
  childAdapter?: Adapter;
  parentAdapter?: Adapter;
  rootChainDefaultBlock?: 'safe' | 'latest';
}): POSBridgeHelpers {
  return new POSBridgeHelpers({
    rootChainManagerCaller: opts.rootCaller,
    rootChainCaller: opts.rootCaller,
    childClient: opts.childClient ?? fakeChildClient(),
    childAdapter: opts.childAdapter ?? new FakeAdapter(),
    parentAdapter: opts.parentAdapter ?? new FakeAdapter(),
    ...(opts.rootChainDefaultBlock !== undefined
      ? { rootChainDefaultBlock: opts.rootChainDefaultBlock }
      : {}),
    logger: noopLogger,
    proofConcurrency: 4
  });
}

function rootCallerOn(adapter: Adapter): ContractCaller {
  return new ContractCaller({
    adapter,
    getAddress: () => Promise.resolve('0x1111111111111111111111111111111111111111'),
    abi: RootChainABI,
    isParent: true,
    logger: noopLogger
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POSBridgeHelpers.buildExitPayloads — fast path', () => {
  it('throws PROOF_API_NOT_SET when fast and no proof client is configured', async () => {
    const helpers = makeHelpers({ rootCaller: rootCallerOn(new FakeAdapter()) });
    await expect(helpers.buildExitPayloads('0xburn', ERC20_SIG, true)).rejects.toMatchObject({
      code: 'PROOF_API_NOT_SET'
    });
  });
});

describe('POSBridgeHelpers.buildExitPayloads — local multi-index enumeration', () => {
  it('emits one payload per matching log index in the burn receipt', async () => {
    // Three logs, two of which are burn-marked ERC-20 transfers (topic[2]
    // === address(0)). The enumeration must pick exactly those two.
    const receipt: ITransactionReceipt = {
      transactionHash: '0xburn',
      transactionIndex: 0,
      blockHash: '0xblock',
      blockNumber: 100,
      from: '0xfrom',
      to: '0xto',
      contractAddress: '',
      cumulativeGasUsed: 0,
      gasUsed: 0,
      status: true,
      logsBloom: '0x',
      root: '',
      type: '0x0',
      logs: [
        { address: '0x' + 'aa'.repeat(20), data: '0x', topics: [ERC20_SIG, ZERO_TOPIC, ZERO_TOPIC], logIndex: 0, transactionHash: '0xburn', transactionIndex: 0, blockHash: '0xblock', blockNumber: 100 },
        { address: '0x' + 'bb'.repeat(20), data: '0x', topics: [ERC20_SIG, ZERO_TOPIC, '0x' + '11'.repeat(32)], logIndex: 1, transactionHash: '0xburn', transactionIndex: 0, blockHash: '0xblock', blockNumber: 100 },
        { address: '0x' + 'cc'.repeat(20), data: '0x', topics: [ERC20_SIG, ZERO_TOPIC, ZERO_TOPIC], logIndex: 2, transactionHash: '0xburn', transactionIndex: 0, blockHash: '0xblock', blockNumber: 100 }
      ]
    };
    const block = {
      number: 100,
      hash: '0xblock',
      timestamp: 1700000000,
      transactionsRoot: '0x' + '11'.repeat(32),
      receiptsRoot: '0x' + '22'.repeat(32),
      transactions: []
    } as unknown as IBlockWithTransaction;

    // Root chain reports the burn block as checkpointed; headerBlocks gives
    // a covering range so findCheckpointSlot resolves slot 1.
    const adapter = new FakeAdapter({
      getLastChildBlock: 1_000_000n,
      currentHeaderBlock: 10000n,
      headerBlocks: { start: 1n, end: 1_000_000n }
    });

    // Stub the proof-construction boundary (needs an archive node).
    vi.spyOn(ProofUtil, 'getReceiptProof').mockResolvedValue({
      blockHash: new Uint8Array(0),
      parentNodes: [],
      root: new Uint8Array(0),
      path: Uint8Array.of(0x80),
      value: new Uint8Array(0)
    });
    vi.spyOn(ProofUtil, 'buildBlockProof').mockResolvedValue('0x' + 'ab'.repeat(32));

    const helpers = makeHelpers({
      rootCaller: rootCallerOn(adapter),
      childClient: fakeChildClient({
        getTransaction: () => Promise.resolve({ blockNumber: 100 }),
        getTransactionReceipt: () => Promise.resolve(receipt),
        getBlockWithTransaction: () => Promise.resolve(block)
      })
    });

    const payloads = await helpers.buildExitPayloads('0xburn', ERC20_SIG, false);
    expect(payloads).to.have.length(2);
    for (const p of payloads) {
      expect(p.startsWith('0x')).to.equal(true);
    }
  });
});

describe('POSBridgeHelpers.isDeposited', () => {
  const STATE_SYNCED = LogEventSignature.StateSynced as Hex;
  // state id 5, encoded as a 32-byte topic.
  const stateIdTopic = ('0x' + (5).toString(16).padStart(64, '0')) as Hex;

  function depositReceipt(includeStateSynced: boolean): Receipt {
    return {
      transactionHash: '0xdeposit',
      status: 'success',
      blockNumber: 1n,
      logs: includeStateSynced
        ? [{ address: '0xsender' as Hex, topics: [STATE_SYNCED, stateIdTopic], data: '0x', logIndex: 0 }]
        : [{ address: '0xsender' as Hex, topics: ['0xother' as Hex], data: '0x', logIndex: 0 }]
    };
  }

  it('returns true when lastStateId has reached the deposit state id', async () => {
    const helpers = makeHelpers({
      rootCaller: rootCallerOn(new FakeAdapter()),
      childAdapter: new FakeAdapter({ lastStateId: 9n }),
      parentAdapter: new FakeAdapter({}, depositReceipt(true))
    });
    expect(await helpers.isDeposited('0xdeposit')).to.equal(true);
  });

  it('returns false when lastStateId is behind the deposit state id', async () => {
    const helpers = makeHelpers({
      rootCaller: rootCallerOn(new FakeAdapter()),
      childAdapter: new FakeAdapter({ lastStateId: 3n }),
      parentAdapter: new FakeAdapter({}, depositReceipt(true))
    });
    expect(await helpers.isDeposited('0xdeposit')).to.equal(false);
  });

  it('throws STATE_SYNCED_EVENT_NOT_FOUND when the deposit receipt has no StateSynced log', async () => {
    const helpers = makeHelpers({
      rootCaller: rootCallerOn(new FakeAdapter()),
      childAdapter: new FakeAdapter({ lastStateId: 9n }),
      parentAdapter: new FakeAdapter({}, depositReceipt(false))
    });
    await expect(helpers.isDeposited('0xdeposit')).rejects.toMatchObject({
      code: 'STATE_SYNCED_EVENT_NOT_FOUND'
    });
  });
});

describe('POSBridgeHelpers — blockTag threading', () => {
  it("pins root-chain reads to 'safe' by default", async () => {
    const adapter = new FakeAdapter({ getLastChildBlock: 1_000_000n });
    const helpers = makeHelpers({ rootCaller: rootCallerOn(adapter) });
    // isCheckpointed reads getLastChildBlock through the root caller.
    await helpers.isCheckpointed('0xburn');
    const lastChildRead = adapter.readRequests.find((r) => r.functionName === 'getLastChildBlock');
    expect(lastChildRead?.blockTag).to.equal('safe');
  });

  it('honours an explicit rootChainDefaultBlock override', async () => {
    const adapter = new FakeAdapter({ getLastChildBlock: 1_000_000n });
    const helpers = makeHelpers({
      rootCaller: rootCallerOn(adapter),
      rootChainDefaultBlock: 'latest'
    });
    await helpers.isCheckpointed('0xburn');
    const lastChildRead = adapter.readRequests.find((r) => r.functionName === 'getLastChildBlock');
    expect(lastChildRead?.blockTag).to.equal('latest');
  });
});
