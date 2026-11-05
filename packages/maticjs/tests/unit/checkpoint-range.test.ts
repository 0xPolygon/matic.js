import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, ReadRequest, Receipt, TxResult, WriteRequest } from '../../src/adapter.ts';
import type { IBlockWithTransaction, ITransactionReceipt } from '../../src/interfaces/index.ts';
import type { BridgeChildClient } from '../../src/internal/pos-bridge-helpers.ts';

import { RootChainABI } from '../../src/abi/index.ts';
import { LogEventSignature } from '../../src/constant.ts';
import {
  CheckpointRangeInvalidError,
  MerkleTreeDepthExceededError
} from '../../src/errors.ts';
import { ContractCaller } from '../../src/internal/contract-caller.ts';
import {
  assertCheckpointRange,
  MAX_CHECKPOINT_BLOCKS,
  POSBridgeHelpers
} from '../../src/internal/pos-bridge-helpers.ts';
import { noopLogger } from '../../src/logger.ts';
import { ProofUtil } from '../../src/utils/proof_util.ts';

const TX_BLOCK = 100;
const HUGE_END = 2 ** 26 + 1;

describe('assertCheckpointRange', () => {
  it('passes a legitimate range, including the exact edges', () => {
    expect(() => assertCheckpointRange({ start: 1n, end: 256n, txBlockNumber: 100 })).not.throw();
    expect(() => assertCheckpointRange({ start: 100n, end: 100n, txBlockNumber: 100 })).not.throw();
    expect(() =>
      assertCheckpointRange({
        start: 0n,
        end: BigInt(MAX_CHECKPOINT_BLOCKS) - 1n,
        txBlockNumber: 0
      })
    ).not.throw();
  });

  it('rejects an inverted range, a range missing the burn block, and an oversized range', () => {
    const reasonOf = (args: { start: bigint; end: bigint; txBlockNumber: number }): unknown => {
      try {
        assertCheckpointRange(args);
      } catch (err) {
        return CheckpointRangeInvalidError.find(err)?.info.reason;
      }
      return undefined;
    };
    expect(reasonOf({ start: 10n, end: 5n, txBlockNumber: 7 })).equals('inverted');
    expect(reasonOf({ start: 101n, end: 200n, txBlockNumber: 100 })).equals('not-containing');
    expect(reasonOf({ start: 1n, end: 99n, txBlockNumber: 100 })).equals('not-containing');
    expect(reasonOf({ start: 0n, end: BigInt(HUGE_END), txBlockNumber: 5 })).equals('too-large');
    expect(reasonOf({ start: 0n, end: BigInt(MAX_CHECKPOINT_BLOCKS), txBlockNumber: 5 })).equals(
      'too-large'
    );
  });

  it('rejects the 2^26 range quickly', () => {
    const t0 = performance.now();
    expect(() =>
      assertCheckpointRange({ start: 0n, end: BigInt(HUGE_END), txBlockNumber: TX_BLOCK })
    ).throw(/too-large/);
    expect(performance.now() - t0).below(50);
  });
});

describe('ProofUtil.getFastMerkleProof depth cap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses a deep range before any RPC call or large allocation', async () => {
    const getRootHash = vi.fn().mockResolvedValue('00'.repeat(32));
    const arrayFrom = vi.spyOn(Array, 'from');
    const t0 = performance.now();
    const err = await ProofUtil.getFastMerkleProof(
      { getTransactionReceipt: vi.fn(), getRootHash, encodeParameters: vi.fn() },
      TX_BLOCK,
      0,
      HUGE_END
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(performance.now() - t0).below(50);
    expect(MerkleTreeDepthExceededError.find(err)).not.equals(null);
    expect(getRootHash).toHaveBeenCalledTimes(0);
    expect(arrayFrom).toHaveBeenCalledTimes(0);
  });
});

// --- through POSBridgeHelpers ---------------------------------------------

type Range = { start: bigint; end: bigint };

/**
 * `headerBlocks` answers come from `ranges` in order, the last one
 * repeating: the slot search reads once and the range read follows, and a
 * hostile node can answer those two reads differently.
 */
class RootAdapter implements Adapter {
  readonly #ranges: Range[];
  #reads = 0;
  /** `currentHeaderBlock` reads: one per `findCheckpointSlot` run. */
  slotSearches = 0;
  constructor(ranges: Range[]) {
    this.#ranges = ranges;
  }
  getChainId(): Promise<number> {
    return Promise.resolve(1);
  }
  read(req: ReadRequest): Promise<unknown> {
    if (req.functionName === 'getLastChildBlock') return Promise.resolve(1_000_000_000n);
    if (req.functionName === 'currentHeaderBlock') {
      this.slotSearches += 1;
      return Promise.resolve(10_000n);
    }
    if (req.functionName === 'headerBlocks') {
      const range = this.#ranges[Math.min(this.#reads, this.#ranges.length - 1)] ?? {
        start: 0n,
        end: 0n
      };
      this.#reads += 1;
      return Promise.resolve({
        ...range,
        createdAt: 0n,
        proposer: '0x0000000000000000000000000000000000000000'
      });
    }
    return Promise.resolve(undefined);
  }
  write(_req: WriteRequest): Promise<TxResult> {
    return Promise.reject(new Error('unexpected write'));
  }
  prepareWrite(): Promise<never> {
    return Promise.reject(new Error('unexpected prepareWrite'));
  }
  estimateGas(): Promise<bigint> {
    return Promise.resolve(21_000n);
  }
  getTransactionReceipt(): Promise<Receipt | null> {
    return Promise.resolve(null);
  }
  keccak256(): string {
    return '0x0';
  }
  request<T>(): Promise<T> {
    return Promise.resolve(undefined as T);
  }
}

const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';
const receipt: ITransactionReceipt = {
  transactionHash: '0xburn',
  transactionIndex: 0,
  blockHash: '0xblock',
  blockNumber: TX_BLOCK,
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
    {
      address: '0x' + 'aa'.repeat(20),
      data: '0x',
      topics: [LogEventSignature.Erc20Transfer, ZERO_TOPIC, ZERO_TOPIC],
      logIndex: 0,
      transactionHash: '0xburn',
      transactionIndex: 0,
      blockHash: '0xblock',
      blockNumber: TX_BLOCK
    }
  ]
};
const block = {
  number: TX_BLOCK,
  hash: '0xblock',
  timestamp: 1700000000,
  transactionsRoot: '0x' + '11'.repeat(32),
  receiptsRoot: '0x' + '22'.repeat(32),
  transactions: []
} as unknown as IBlockWithTransaction;

const childClient = (): BridgeChildClient => ({
  getTransactionReceipt: () => Promise.resolve(receipt),
  getTransaction: () => Promise.resolve({ blockNumber: TX_BLOCK }),
  getBlockWithTransaction: () => Promise.resolve(block),
  getRootHash: () => Promise.resolve('00'.repeat(32)),
  encodeParameters: () => '0x',
  soliditySha3: () => '0x'
});

let lastAdapter: RootAdapter | undefined;

const helpers = ({
  headerBlocks,
  proofApiClient
}: {
  headerBlocks: Range[];
  proofApiClient?: ConstructorParameters<typeof POSBridgeHelpers>[0]['proofApiClient'];
}): POSBridgeHelpers => {
  const adapter = new RootAdapter(headerBlocks);
  lastAdapter = adapter;
  const caller = new ContractCaller({
    adapter,
    getAddress: () => Promise.resolve('0x1111111111111111111111111111111111111111'),
    abi: RootChainABI,
    isParent: true,
    logger: noopLogger
  });
  return new POSBridgeHelpers({
    rootChainManagerCaller: caller,
    rootChainCaller: caller,
    childClient: childClient(),
    childAdapter: adapter,
    parentAdapter: adapter,
    logger: noopLogger,
    proofConcurrency: 4,
    getTrustedPredicates: () => Promise.resolve([]),
    ...(proofApiClient !== undefined ? { proofApiClient } : {})
  });
};

describe('local checkpoint lookup validates the on-chain range', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects the 2^26 range with CheckpointRangeInvalidError, quickly and without allocating', async () => {
    vi.spyOn(ProofUtil, 'getReceiptProof').mockResolvedValue({
      blockHash: new Uint8Array(0),
      parentNodes: [],
      root: new Uint8Array(0),
      path: Uint8Array.of(0x80),
      value: new Uint8Array(0)
    });
    const arrayFrom = vi.spyOn(Array, 'from');
    const bridge = helpers({ headerBlocks: [{ start: 0n, end: BigInt(HUGE_END) }] });

    const t0 = performance.now();
    const err = await bridge
      .buildExitPayload('0x' + 'ab'.repeat(32), LogEventSignature.Erc20Transfer, false)
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(performance.now() - t0).below(50);
    expect(CheckpointRangeInvalidError.find(err)).not.equals(null);
    expect(arrayFrom).toHaveBeenCalledTimes(0);
  });

  it('rejects an on-chain range that does not contain the burn block', async () => {
    const bridge = helpers({
      headerBlocks: [
        { start: 1n, end: 256n },
        { start: 500n, end: 600n }
      ]
    });
    const err = await bridge
      .buildExitPayload('0x' + 'ab'.repeat(32), LogEventSignature.Erc20Transfer, false)
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(CheckpointRangeInvalidError.find(err)?.info.reason).equals('not-containing');
  });
});

describe('proof API block-included range', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const apiClient = (range: { start: bigint; end: bigint }) => ({
    getBlockIncluded: vi.fn().mockResolvedValue({ headerBlockNumber: 10_000n, ...range }),
    getFastMerkleProof: vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32))
  });

  const build = async (api: ReturnType<typeof apiClient>) => {
    vi.spyOn(ProofUtil, 'getReceiptProof').mockResolvedValue({
      blockHash: new Uint8Array(0),
      parentNodes: [],
      root: new Uint8Array(0),
      path: Uint8Array.of(0x80),
      value: new Uint8Array(0)
    });
    // The on-chain slot holds the real checkpoint, which contains the burn.
    const bridge = helpers({
      headerBlocks: [{ start: 1n, end: 256n }],
      proofApiClient: api as unknown as ConstructorParameters<
        typeof POSBridgeHelpers
      >[0]['proofApiClient']
    });
    return bridge.buildExitPayload('0x' + 'ab'.repeat(32), LogEventSignature.Erc20Transfer, false);
  };

  it('a range that does not contain the burn falls back to the on-chain slot', async () => {
    const api = apiClient({ start: 5_000n, end: 5_100n });
    await build(api);
    expect(api.getBlockIncluded).toHaveBeenCalledTimes(1);
    expect(lastAdapter?.slotSearches).equals(1);
    // The proof is requested over the on-chain range 1-256, not the API's.
    expect(api.getFastMerkleProof).toHaveBeenCalledTimes(1);
    expect(api.getFastMerkleProof).toHaveBeenCalledWith(1, 256, TX_BLOCK);
  });

  it('an oversized range falls back to the on-chain slot', async () => {
    const api = apiClient({ start: 0n, end: BigInt(HUGE_END) });
    await build(api);
    expect(lastAdapter?.slotSearches).equals(1);
    expect(api.getFastMerkleProof).toHaveBeenCalledTimes(1);
    expect(api.getFastMerkleProof).toHaveBeenCalledWith(1, 256, TX_BLOCK);
  });

  it('a legitimate API range is used', async () => {
    const api = apiClient({ start: 1n, end: 256n });
    const result = await build(api);
    expect(lastAdapter?.slotSearches).equals(0);
    expect(api.getFastMerkleProof).toHaveBeenCalledWith(1, 256, TX_BLOCK);
    expect(result).a('string');
  });
});
