/**
 * Exit-status reads: `isWithdrawnOnIndex` / `isWithdrawExitedOnIndex`, the
 * multi-token `isWithdrawExitedOnIndices`, and the removal of ERC-721's
 * `isWithdrawExitedMany`.
 *
 * The exit hash `RootChainManager.processedExits` is keyed by is
 * `keccak(blockNumber, nibbles(path), logIndex)`, where `path` is
 * `RLP.encode(transactionIndex)`. It needs the burn receipt and nothing
 * else from the block, so these tests pin that the status reads fetch one
 * receipt — not every receipt in the block — and that the hash they derive
 * is byte-identical both to the old receipt-trie route and to the key the
 * real mainnet exit payloads in `tests/fixtures/exits` are processed under.
 *
 * Only the RPC boundary is faked: the parent adapter's contract reads and
 * the child client's receipt/block fetches. Keccak, RLP, log selection and
 * the exit-hash packing are the real code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MerklePatriciaTrie } from '@ethereumjs/mpt';
import { RLP } from '@ethereumjs/rlp';
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
  ILog,
  ITransactionReceipt
} from '../../src/interfaces/index.ts';
import type { BridgeChildClient } from '../../src/internal/pos-bridge-helpers.ts';

import { RootChainManagerABI } from '../../src/abi/index.ts';
import { LogEventSignature } from '../../src/constant.ts';
import {
  BatchSizeLimitExceededError,
  IndexOutOfBoundsError,
  InvalidNumericValueError,
  NegativeIndexError
} from '../../src/errors.ts';
import { createBridgeChildClient } from '../../src/internal/bridge-child-client.ts';
import { ContractCaller } from '../../src/internal/contract-caller.ts';
import { POSBridgeHelpers } from '../../src/internal/pos-bridge-helpers.ts';
import { noopLogger } from '../../src/logger.ts';
import { ERC721 } from '../../src/pos/erc721.ts';
import { ERC1155 } from '../../src/pos/erc1155.ts';
import { RootChainManager } from '../../src/pos/root_chain_manager.ts';
import { BufferUtil } from '../../src/utils/buffer-utils.ts';
import { Keccak } from '../../src/utils/keccak.ts';
import { ProofUtil } from '../../src/utils/proof_util.ts';

const ZERO_TOPIC = `0x${'00'.repeat(32)}`;
const TRANSFER_SIG = LogEventSignature.Erc721Transfer;
const CONTRACT: Hex = '0x1111111111111111111111111111111111111111';

/**
 * Parent-chain adapter: answers the two contract reads the status path
 * makes, records every read, and tracks how many `processedExits` reads
 * are in flight at once.
 */
class ParentAdapter implements Adapter {
  readonly reads: ReadRequest[] = [];
  readonly exited = new Set<string>();
  inFlight = 0;
  maxInFlight = 0;
  readDelayMs = 0;

  getChainId(): Promise<number> {
    return Promise.resolve(1);
  }
  async read(req: ReadRequest): Promise<unknown> {
    this.reads.push(req);
    if (req.functionName === 'getLastChildBlock') return 1_000_000_000n;
    // Checkpoint lookup for the exit-payload path.
    if (req.functionName === 'currentHeaderBlock') return 10_000n;
    if (req.functionName === 'headerBlocks') return { start: 1n, end: 1_000_000_000n };
    if (req.functionName !== 'processedExits') return undefined;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, this.readDelayMs));
    this.inFlight--;
    return this.exited.has(String(req.args?.[0]));
  }
  write(_req: WriteRequest): Promise<TxResult> {
    return Promise.reject(new Error('not used'));
  }
  prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    return Promise.resolve({ to: req.address, data: '0x' });
  }
  estimateGas(_req: WriteRequest): Promise<bigint> {
    return Promise.resolve(0n);
  }
  getTransactionReceipt(_hash: string): Promise<Receipt | null> {
    return Promise.resolve(null);
  }
  keccak256(data: Uint8Array | string): string {
    return BufferUtil.bufferToHex(Keccak.keccak256(BufferUtil.toBuffer(data)));
  }
  request<T>(_method: string, _params: readonly unknown[]): Promise<T> {
    return Promise.reject(new Error('not used'));
  }

  processedExitKeys(): string[] {
    return this.reads
      .filter((r) => r.functionName === 'processedExits')
      .map((r) => String(r.args?.[0]));
  }
}

/** The real solidity-packed keccak the production child client uses. */
const soliditySha3 = createBridgeChildClient(new ParentAdapter()).soliditySha3;

/** A child client serving one block's receipts, counting each fetch. */
function childClientFor(block: IBlockWithTransaction, receipts: ITransactionReceipt[]) {
  const counts = { receipts: 0, blocks: 0 };
  const byHash = new Map(receipts.map((r) => [r.transactionHash, r]));
  const client: BridgeChildClient = {
    getTransactionReceipt: (hash) => {
      counts.receipts++;
      const r = byHash.get(hash);
      return r ? Promise.resolve(r) : Promise.reject(new Error(`no receipt ${hash}`));
    },
    getTransaction: () => Promise.resolve({ blockNumber: block.number }),
    getBlockWithTransaction: () => {
      counts.blocks++;
      return Promise.resolve(block);
    },
    getRootHash: () => Promise.resolve(''),
    encodeParameters: () => '0x',
    soliditySha3
  };
  return { client, counts };
}

function helpersOn(
  parent: ParentAdapter,
  child: BridgeChildClient,
  proofConcurrency = 4
): POSBridgeHelpers {
  const caller = new ContractCaller({
    adapter: parent,
    getAddress: () => Promise.resolve(CONTRACT),
    abi: RootChainManagerABI,
    isParent: true,
    logger: noopLogger
  });
  return new POSBridgeHelpers({
    rootChainManagerCaller: caller,
    rootChainCaller: caller,
    childClient: child,
    childAdapter: parent,
    parentAdapter: parent,
    logger: noopLogger,
    proofConcurrency
  });
}

function erc721On(parent: ParentAdapter, bridge: POSBridgeHelpers): ERC721 {
  return new ERC721({
    tokenAddress: CONTRACT,
    isParent: true,
    adapter: parent,
    bridge,
    rootChainManager: new RootChainManager({
      adapter: parent,
      getAddress: () => Promise.resolve(CONTRACT),
      logger: noopLogger
    }),
    parentAdapter: parent,
    encodeParameters: () => '0x',
    logger: noopLogger
  });
}

const hex32 = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;

function log(topics: string[], index: number, receipt: ITransactionReceipt): ILog {
  return {
    address: CONTRACT,
    data: '0x',
    topics,
    logIndex: index,
    transactionHash: receipt.transactionHash,
    transactionIndex: receipt.transactionIndex,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber
  };
}

/**
 * getReceiptProof rejects a block whose receiptsRoot its receipts do not
 * reproduce, so every synthetic block carries the root of its own receipts.
 */
async function receiptsRootOf(receipts: ITransactionReceipt[]): Promise<string> {
  const trie = new MerklePatriciaTrie();
  for (const r of receipts) {
    await trie.put(RLP.encode(r.transactionIndex), ProofUtil.getReceiptBytes(r));
  }
  return BufferUtil.bufferToHex(trie.root());
}

/**
 * A synthetic block of `txCount` receipts. The burn sits at `burnIndex`
 * and carries `burns` ERC-721 burn logs, each preceded by an unrelated
 * log so the matching log indices are not simply 0..n-1.
 */
async function syntheticBlock(opts: { txCount: number; burnIndex: number; burns: number }) {
  const blockNumber = 5_000_000;
  const blockHash = hex32(0xb10c);
  const receipts: ITransactionReceipt[] = [];
  for (let i = 0; i < opts.txCount; i++) {
    const r: ITransactionReceipt = {
      transactionHash: hex32(0x1000 + i),
      transactionIndex: i,
      blockHash,
      blockNumber,
      from: CONTRACT,
      to: CONTRACT,
      contractAddress: '',
      cumulativeGasUsed: 21_000 * (i + 1),
      gasUsed: 21_000,
      status: true,
      logsBloom: `0x${'00'.repeat(256)}`,
      root: '',
      type: '0x2',
      logs: []
    };
    if (i === opts.burnIndex) {
      const logs: ILog[] = [];
      for (let b = 0; b < opts.burns; b++) {
        logs.push(log([hex32(0xdead), hex32(b)], logs.length, r));
        logs.push(log([TRANSFER_SIG, hex32(0xa11ce), ZERO_TOPIC, hex32(100 + b)], logs.length, r));
      }
      r.logs = logs;
    }
    receipts.push(r);
  }
  const block: IBlockWithTransaction = {
    size: 0,
    difficulty: 0,
    uncles: [],
    number: blockNumber,
    hash: blockHash,
    parentHash: hex32(0),
    nonce: '0x0',
    sha3Uncles: hex32(0),
    logsBloom: `0x${'00'.repeat(256)}`,
    transactionsRoot: hex32(0),
    stateRoot: hex32(0),
    receiptsRoot: await receiptsRootOf(receipts),
    miner: CONTRACT,
    extraData: '0x',
    gasLimit: 0,
    gasUsed: 0,
    timestamp: 0,
    transactions: receipts.map((r) => ({
      transactionHash: r.transactionHash,
      nonce: 0,
      blockHash,
      blockNumber,
      transactionIndex: r.transactionIndex,
      from: CONTRACT,
      to: CONTRACT,
      value: '0x0',
      gasPrice: '0x0',
      gas: 0,
      input: '0x'
    }))
  };
  const burn = receipts[opts.burnIndex];
  if (burn === undefined) throw new Error('burnIndex out of range');
  return { block, receipts, burn };
}

/**
 * The exit-hash route this release replaced, kept verbatim as the
 * reference: rebuild the block's receipts trie (one receipt fetch per tx)
 * and take the proof's path.
 */
async function legacyExitHash(
  receipt: ITransactionReceipt,
  block: IBlockWithTransaction,
  client: BridgeChildClient,
  logIndex: number
): Promise<string> {
  const proof = await ProofUtil.getReceiptProof(receipt, block, client, 4);
  const nibbles: number[] = [];
  proof.path.forEach((byte: number) => {
    nibbles.push(byte >> 4, byte & 0x0f);
  });
  return soliditySha3(
    receipt.blockNumber,
    BufferUtil.bufferToHex(Uint8Array.from(nibbles)),
    logIndex
  );
}

const caught = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e
  );

describe('isWithdrawnOnIndex — the exit hash needs only the burn receipt', () => {
  it('fetches one receipt and no block, however many txs the block holds', async () => {
    const { block, receipts, burn } = await syntheticBlock({
      txCount: 50,
      burnIndex: 17,
      burns: 3
    });
    const { client, counts } = childClientFor(block, receipts);
    const parent = new ParentAdapter();

    await helpersOn(parent, client).isWithdrawnOnIndex(burn.transactionHash, 2, TRANSFER_SIG);

    expect(counts).deep.equal({ receipts: 1, blocks: 0 });
    // getLastChildBlock + processedExits on the parent chain.
    expect(parent.reads.map((r) => r.functionName)).deep.equal([
      'getLastChildBlock',
      'processedExits'
    ]);
  });

  it('derives the same exit hash as the receipt-trie route for every index', async () => {
    // Indices either side of the RLP single-byte boundary (0 encodes as
    // 0x80, 1..127 as one byte, 128+ with a length prefix).
    for (const burnIndex of [0, 1, 127, 128, 200]) {
      const { block, receipts, burn } = await syntheticBlock({ txCount: 201, burnIndex, burns: 3 });
      for (const index of [0, 1, 2]) {
        const { client } = childClientFor(block, receipts);
        const parent = new ParentAdapter();
        await helpersOn(parent, client).isWithdrawnOnIndex(
          burn.transactionHash,
          index,
          TRANSFER_SIG
        );
        const expected = await legacyExitHash(burn, block, client, 2 * index + 1);
        expect(parent.processedExitKeys(), `tx ${burnIndex} log ${index}`).deep.equal([expected]);
      }
    }
  });
});

describe('trie skip — the safety argument', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes the path from the receipt transactionIndex and never invokes the proof builder', async () => {
    const proofBuilder = vi
      .spyOn(ProofUtil, 'getReceiptProof')
      .mockRejectedValue(new Error('exit-status reads must not build a receipt proof'));
    const { block, receipts, burn } = await syntheticBlock({
      txCount: 300,
      burnIndex: 130,
      burns: 2
    });
    const { client } = childClientFor(block, receipts);
    const parent = new ParentAdapter();
    const bridge = helpersOn(parent, client);

    await bridge.isWithdrawnOnIndex(burn.transactionHash, 1, TRANSFER_SIG);
    await bridge.isWithdrawn(burn.transactionHash, TRANSFER_SIG);
    await erc721On(parent, bridge).isWithdrawExitedOnIndices(burn.transactionHash, [0, 1]);

    expect(proofBuilder).not.toHaveBeenCalled();
    // keccak(blockNumber, nibbles(RLP.encode(130)), logIndex): 130 RLP-encodes
    // as 0x8182, whose nibbles are 08 01 08 02.
    const fromTxIndex = (logIndex: number): string =>
      soliditySha3(burn.blockNumber, '0x08010802', logIndex);
    expect(parent.processedExitKeys()).deep.equal([
      fromTxIndex(3),
      fromTxIndex(1),
      fromTxIndex(1),
      fromTxIndex(3)
    ]);
  });

  it('a different transactionIndex gives a different exit hash', async () => {
    const { block, receipts, burn } = await syntheticBlock({ txCount: 3, burnIndex: 1, burns: 1 });
    const moved: ITransactionReceipt = { ...burn, transactionIndex: 2 };
    const keyFor = async (receipt: ITransactionReceipt): Promise<string[]> => {
      const { client } = childClientFor(block, [receipt]);
      const parent = new ParentAdapter();
      await helpersOn(parent, client).isWithdrawnOnIndex(receipt.transactionHash, 0, TRANSFER_SIG);
      return parent.processedExitKeys();
    };
    expect(receipts).length(3);
    expect(await keyFor(burn)).not.deep.equal(await keyFor(moved));
  });

  it('buildExitPayload still builds the full receipt proof', async () => {
    const { block, receipts, burn } = await syntheticBlock({ txCount: 5, burnIndex: 2, burns: 1 });
    const { client } = childClientFor(block, receipts);
    const proofBuilder = vi.spyOn(ProofUtil, 'getReceiptProof');
    vi.spyOn(ProofUtil, 'buildBlockProof').mockResolvedValue(`0x${'ab'.repeat(32)}`);

    const payload = await helpersOn(new ParentAdapter(), client).buildExitPayload(
      burn.transactionHash,
      TRANSFER_SIG,
      false
    );

    expect(payload.startsWith('0x')).equal(true);
    expect(proofBuilder).toHaveBeenCalledTimes(1);
  });
});

// --- real mainnet exits ---------------------------------------------------

interface BurnFixture {
  burnTxHash: string;
  eventSignature: string;
  expectedPayloadHex: string;
}

function asList(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected an RLP list');
  return value;
}

function asBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error('expected RLP bytes');
  return value;
}

const toInt = (bytes: Uint8Array): number => bytes.reduce((acc, b) => acc * 256 + b, 0);

/**
 * Rebuild the burn receipt from the receipt bytes inside a recorded exit
 * payload. The test asserts the rebuild re-encodes to exactly those bytes,
 * so it IS the receipt the payload was proven against.
 */
function receiptFromPayload(opts: {
  receiptBytes: Uint8Array;
  burnTxHash: string;
  blockNumber: number;
  transactionIndex: number;
}): ITransactionReceipt {
  const { receiptBytes } = opts;
  const typed = (receiptBytes[0] ?? 0xff) < 0x7f;
  const body = asList(RLP.decode(typed ? receiptBytes.subarray(1) : receiptBytes));
  const receipt: ITransactionReceipt = {
    transactionHash: opts.burnTxHash,
    transactionIndex: opts.transactionIndex,
    blockHash: hex32(0xb10c),
    blockNumber: opts.blockNumber,
    from: CONTRACT,
    to: CONTRACT,
    contractAddress: '',
    cumulativeGasUsed: toInt(asBytes(body[1])),
    gasUsed: 0,
    status: asBytes(body[0]).length > 0,
    logsBloom: BufferUtil.bufferToHex(asBytes(body[2])),
    root: '',
    type: typed ? `0x${(receiptBytes[0] ?? 0).toString(16)}` : '0x0',
    logs: []
  };
  receipt.logs = asList(body[3]).map((raw, index) => {
    const [address, topics, data] = asList(raw);
    return {
      ...log(
        asList(topics).map((t) => BufferUtil.bufferToHex(asBytes(t))),
        index,
        receipt
      ),
      address: BufferUtil.bufferToHex(asBytes(address)),
      data: BufferUtil.bufferToHex(asBytes(data))
    };
  });
  return receipt;
}

describe('isWithdrawnOnIndex — byte-identical exit hash on real mainnet burns', () => {
  for (const name of ['erc20-burn-1.json', 'erc721-burn-1.json', 'erc1155-burn-1.json']) {
    it(name, async () => {
      const fixture: BurnFixture = JSON.parse(
        readFileSync(join(__dirname, '..', 'fixtures', 'exits', name), 'utf8')
      );
      // [headerNumber, blockProof, blockNumber, timestamp, txRoot,
      //  receiptsRoot, receipt, parentNodes, path, logIndex]
      const payload = asList(RLP.decode(BufferUtil.toBuffer(fixture.expectedPayloadHex)));
      const blockNumber = toInt(asBytes(payload[2]));
      const receiptBytes = asBytes(payload[6]);
      // The payload carries the path as a hex-prefix branch mask: one 0x00
      // byte, then the path. RootChainManager.exit drops that byte's two
      // nibbles (`_getNibbleArray`) before hashing.
      const branchMask = asBytes(payload[8]);
      expect(branchMask[0]).equal(0);
      const path = branchMask.subarray(1);
      const logIndex = toInt(asBytes(payload[9]));
      const transactionIndex = toInt(asBytes(RLP.decode(path)));

      const receipt = receiptFromPayload({
        receiptBytes,
        burnTxHash: fixture.burnTxHash,
        blockNumber,
        transactionIndex
      });
      expect(BufferUtil.bufferToHex(ProofUtil.getReceiptBytes(receipt))).equal(
        BufferUtil.bufferToHex(receiptBytes)
      );

      // The key RootChainManager.exit marks for this payload.
      const nibbles: number[] = [];
      path.forEach((byte) => nibbles.push(byte >> 4, byte & 0x0f));
      const onChainKey = soliditySha3(
        blockNumber,
        BufferUtil.bufferToHex(Uint8Array.from(nibbles)),
        logIndex
      );

      const { block } = await syntheticBlock({ txCount: 1, burnIndex: 0, burns: 0 });
      const [tx] = block.transactions;
      if (tx === undefined) throw new Error('synthetic block has no tx');
      const burnBlock: IBlockWithTransaction = {
        ...block,
        number: blockNumber,
        receiptsRoot: await receiptsRootOf([receipt]),
        transactions: [{ ...tx, transactionHash: fixture.burnTxHash, transactionIndex }]
      };
      const { client, counts } = childClientFor(burnBlock, [receipt]);
      const parent = new ParentAdapter();
      parent.exited.add(onChainKey);

      const exited = await helpersOn(parent, client).isWithdrawnOnIndex(
        fixture.burnTxHash,
        0,
        fixture.eventSignature
      );

      expect(exited).equal(true);
      expect(parent.processedExitKeys()).deep.equal([onChainKey]);
      expect(counts.receipts).equal(1);
      expect(await legacyExitHash(receipt, burnBlock, client, logIndex)).equal(onChainKey);
    });
  }
});

// --- isWithdrawExitedOnIndices ----------------------------------------------

describe('ERC721.isWithdrawExitedOnIndices', () => {
  const setup = async (opts: { burns: number; proofConcurrency?: number }) => {
    const { block, receipts, burn } = await syntheticBlock({
      txCount: 30,
      burnIndex: 9,
      burns: opts.burns
    });
    const { client, counts } = childClientFor(block, receipts);
    const parent = new ParentAdapter();
    const bridge = helpersOn(parent, client, opts.proofConcurrency);
    return { burn, block, client, counts, parent, bridge, erc721: erc721On(parent, bridge) };
  };

  it('answers exactly what isWithdrawExitedOnIndex answers for each index, in order', async () => {
    const s = await setup({ burns: 5 });
    for (const index of [1, 3]) {
      s.parent.exited.add(await legacyExitHash(s.burn, s.block, s.client, 2 * index + 1));
    }
    const indices = [4, 0, 3, 1, 2];

    const many = await s.erc721.isWithdrawExitedOnIndices(s.burn.transactionHash, indices);
    const each: boolean[] = [];
    for (const index of indices) {
      each.push(await s.erc721.isWithdrawExitedOnIndex(s.burn.transactionHash, index));
    }

    expect(many).deep.equal([false, false, true, true, false]);
    expect(many).deep.equal(each);
  });

  it('reads the receipt once and one processedExits per index', async () => {
    const s = await setup({ burns: 20 });
    const indices = Array.from({ length: 20 }, (_, i) => i);

    await s.erc721.isWithdrawExitedOnIndices(s.burn.transactionHash, indices);

    expect(s.counts).deep.equal({ receipts: 1, blocks: 0 });
    expect(s.parent.processedExitKeys()).length(20);
    expect(s.parent.reads.filter((r) => r.functionName === 'getLastChildBlock')).length(1);
  });

  it('bounds the processedExits fan-out by proofConcurrency', async () => {
    const s = await setup({ burns: 12, proofConcurrency: 3 });
    s.parent.readDelayMs = 5;

    await s.erc721.isWithdrawExitedOnIndices(
      s.burn.transactionHash,
      Array.from({ length: 12 }, (_, i) => i)
    );

    expect(s.parent.maxInFlight).equal(3);
  });

  // The public method rejects with its operation error; the validation
  // failure is the condition found in the cause chain.
  const rejects = async ({
    indices,
    condition,
    burns = 3
  }: {
    indices: number[];
    condition: { has: (err: unknown) => boolean };
    burns?: number;
  }): Promise<void> => {
    const s = await setup({ burns });
    const pending = s.erc721.isWithdrawExitedOnIndices(s.burn.transactionHash, indices);
    expect(pending).instanceOf(Promise);
    const err = await caught(pending);
    expect(err).property('name', 'BridgeStatusError');
    expect(condition.has(err)).equal(true);
    expect(s.parent.processedExitKeys()).length(0);
  };

  it('rejects an empty list', () =>
    rejects({ indices: [], condition: BatchSizeLimitExceededError }));
  it('rejects more than 20 indices', () =>
    rejects({
      indices: Array.from({ length: 21 }, (_, i) => i),
      condition: BatchSizeLimitExceededError,
      burns: 21
    }));
  it('rejects a negative index', () =>
    rejects({ indices: [0, -1], condition: NegativeIndexError }));
  it('rejects a repeated index', () =>
    rejects({ indices: [1, 0, 1], condition: InvalidNumericValueError }));
  it('rejects a non-integer index', () =>
    rejects({ indices: [0.5], condition: InvalidNumericValueError }));
  it('rejects an index past the last token before reading any exit', () =>
    rejects({ indices: [0, 3], condition: IndexOutOfBoundsError }));
});

describe('ERC-721 isWithdrawExitedMany is removed', () => {
  it('is absent from ERC721 and still present on ERC1155', () => {
    expect(ERC721.prototype).not.property('isWithdrawExitedMany');
    expect(ERC1155.prototype).property('isWithdrawExitedMany').a('function');
  });

  it('is absent from the ERC721 type', () => {
    // @ts-expect-error — removed in 4.0; a reintroduction fails typecheck here
    const removed: ERC721['isWithdrawExitedMany'] | undefined = undefined;
    expect(removed).equal(undefined);
  });
});
