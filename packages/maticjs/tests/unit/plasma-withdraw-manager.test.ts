import type { JsonRpcError, JsonRpcPayload, JsonRpcResult } from 'ethers';

import { JsonRpcApiProvider, Network } from 'ethers';
import { providers as v5providers } from 'ethers-v5';
import { createPublicClient, custom, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';

import type {
  Adapter,
  Hex,
  PreparedTx,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';
import type { PlasmaBurn, PlasmaBurnReader } from '../../src/plasma/withdraw-status.ts';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import {
  ExitError,
  ExitGasLimitTooLowError,
  ExitNotStartedError,
  ExitQueueEmptyError,
  InvalidHexStringError,
  isMaticjsError,
  TransactionHashRequiredError
} from '../../src/errors.ts';
import { noopLogger } from '../../src/logger.ts';
import { PlasmaEventSignature } from '../../src/plasma/events.ts';
import {
  MAX_PROCESS_EXITS_GAS_LIMIT,
  PlasmaWithdrawManager,
  PRE_LOOP_GAS_ALLOWANCE
} from '../../src/plasma/withdraw-manager.ts';
import { readPlasmaWithdrawStatus } from '../../src/plasma/withdraw-status.ts';
import { recordingAdapter } from './library-errors.ts';

const MANAGER: Hex = '0x32Ac76FdbF38b50D584DD943daCDA4b07FdcBFC7';
const EXIT_NFT: Hex = '0x39b4be5aB437239B853F73873D2b07DE9d3b0768';
const TOKEN_A: Hex = '0x8E1700577B7aE261753c67e1B93Fe60Dd3e205fa';
const TOKEN_B: Hex = '0x40cb9fd0ab94bd96a17614c0f94706a0f6080e5d';
const QUEUE_A: Hex = '0xAf95eD2163905569Caa28977F0b8a2210c1364c0';
const QUEUE_B: Hex = '0xbCDC7A2F051dF9EBbFEFd1Dd5F57EE9616555Ac8';
const ZERO: Hex = '0x0000000000000000000000000000000000000000';
const PARENT_CHAIN_ID = 11155111;
const ESTIMATE = 159_335n;
const ON_FINALIZE = 300_000n;
const FLOOR = ON_FINALIZE + PRE_LOOP_GAS_ALLOWANCE;

const hex32 = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const txHash = (n: bigint): Hex => hex32(n);

const rejection = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
};

/** One parent chain behind one adapter; records everything that would hit the network. */
class ParentChain implements Adapter {
  readonly reads: ReadRequest[] = [];
  readonly writes: WriteRequest[] = [];
  readonly prepares: WriteRequest[] = [];
  readonly estimates: WriteRequest[] = [];
  readonly queueByToken = new Map<string, Hex>();
  readonly sizeByQueue = new Map<string, bigint>();
  readonly receipts = new Map<string, Receipt>();
  readonly existingExits = new Set<bigint>();
  onFinalize: bigint | Error = ON_FINALIZE;
  estimate: bigint | Error = ESTIMATE;
  now = 1_000n;

  getChainId(): Promise<number> {
    return Promise.resolve(1);
  }

  read(req: ReadRequest): Promise<unknown> {
    this.reads.push(req);
    const [first] = req.args ?? [];
    switch (req.functionName) {
      case 'exitsQueues':
        return Promise.resolve(this.queueByToken.get(String(first).toLowerCase()) ?? ZERO);
      case 'currentSize':
        return Promise.resolve(this.sizeByQueue.get(req.address.toLowerCase()) ?? 0n);
      case 'ON_FINALIZE_GAS_LIMIT':
        return this.onFinalize instanceof Error
          ? Promise.reject(this.onFinalize)
          : Promise.resolve(this.onFinalize);
      case 'exists':
        return Promise.resolve(typeof first === 'bigint' && this.existingExits.has(first));
      default:
        return Promise.reject(new Error(`unscripted read ${req.functionName}`));
    }
  }

  write(req: WriteRequest): Promise<TxResult> {
    this.writes.push(req);
    return Promise.resolve({
      hash: txHash(0xaan),
      confirmed: () => Promise.reject(new Error('n/a'))
    });
  }

  prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    this.prepares.push(req);
    return Promise.resolve({ to: req.address, data: '0x' });
  }

  estimateGas(req: WriteRequest): Promise<bigint> {
    this.estimates.push(req);
    return this.estimate instanceof Error
      ? Promise.reject(this.estimate)
      : Promise.resolve(this.estimate);
  }

  getTransactionReceipt(hash: string): Promise<Receipt | null> {
    return Promise.resolve(this.receipts.get(hash) ?? null);
  }

  keccak256(): string {
    throw new Error('not used');
  }

  request<T>(method: string): Promise<T> {
    if (method !== 'eth_getBlockByNumber') return Promise.reject(new Error(`unscripted ${method}`));
    return Promise.resolve({ number: '0xf4240', timestamp: `0x${this.now.toString(16)}` } as T);
  }

  queue({ token, queue, size }: { token: Hex; queue: Hex; size: bigint }): void {
    this.queueByToken.set(token.toLowerCase(), queue);
    this.sizeByQueue.set(queue.toLowerCase(), size);
  }

  reads_(name: string): ReadRequest[] {
    return this.reads.filter((r) => r.functionName === name);
  }
}

const managerOn = (chain: ParentChain): PlasmaWithdrawManager =>
  new PlasmaWithdrawManager({
    adapter: chain,
    getWithdrawManagerAddress: () => Promise.resolve(MANAGER),
    logger: noopLogger,
    chainId: PARENT_CHAIN_ID
  });

describe('PlasmaWithdrawManager.getExitQueueSize', () => {
  it('reads the token queue address, then its current size', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 4n });
    expect(await managerOn(chain).getExitQueueSize(TOKEN_A)).equals(4n);
    expect(chain.reads_('currentSize')).lengthOf(1);
    expect(chain.reads_('currentSize')[0]).property('address').equals(QUEUE_A);
  });

  it('is 0 without reading a queue when the token has no queue contract', async () => {
    const chain = new ParentChain();
    expect(await managerOn(chain).getExitQueueSize(TOKEN_A)).equals(0n);
    expect(chain.reads_('currentSize')).lengthOf(0);
  });
});

describe('PlasmaWithdrawManager.processExits routing', () => {
  it('calls processExits(address) for one token', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    await managerOn(chain).processExits({ tokens: [TOKEN_A] });
    expect(chain.writes).lengthOf(1);
    expect(chain.writes[0]).property('functionName').equals('processExits');
    expect(chain.writes[0]).property('args').deep.equals([TOKEN_A]);
    expect(chain.writes[0]).property('address').equals(MANAGER);
    expect(chain.writes[0]).property('chainId').equals(PARENT_CHAIN_ID);
  });

  it('calls processExitsBatch(address[]) for several tokens', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    chain.queue({ token: TOKEN_B, queue: QUEUE_B, size: 1n });
    await managerOn(chain).processExits({ tokens: [TOKEN_A, TOKEN_B] });
    expect(chain.writes[0]).property('functionName').equals('processExitsBatch');
    expect(chain.writes[0])
      .property('args')
      .deep.equals([[TOKEN_A, TOKEN_B]]);
  });

  it('prepares the same call without sending or estimating', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    const prepared = await managerOn(chain).prepareProcessExits({ tokens: [TOKEN_A] });
    expect(prepared).property('to').equals(MANAGER);
    expect(chain.prepares[0]).property('functionName').equals('processExits');
    expect(chain.writes).lengthOf(0);
    expect(chain.estimates).lengthOf(0);
  });
});

describe('PlasmaWithdrawManager.processExits with nothing queued', () => {
  it('throws ExitQueueEmptyError naming the tokens and sends nothing', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 0n });
    const err = await rejection(() =>
      managerOn(chain).processExits({ tokens: [TOKEN_A, TOKEN_B] })
    );
    expect(err).instanceOf(ExitError);
    expect(ExitQueueEmptyError.find(err)?.info.tokens).deep.equals([TOKEN_A, TOKEN_B]);
    expect(chain.writes).lengthOf(0);
    expect(chain.estimates).lengthOf(0);
  });

  it('treats an empty token list as nothing to process', async () => {
    const chain = new ParentChain();
    const err = await rejection(() => managerOn(chain).processExits({ tokens: [] }));
    expect(ExitQueueEmptyError.find(err)?.info.tokens).deep.equals([]);
    expect(chain.writes).lengthOf(0);
  });

  it('throws before preparing too', async () => {
    const chain = new ParentChain();
    const err = await rejection(() => managerOn(chain).prepareProcessExits({ tokens: [TOKEN_A] }));
    expect(ExitQueueEmptyError.has(err)).equals(true);
    expect(chain.prepares).lengthOf(0);
  });

  it('processes when only one of several tokens has a queued exit', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_B, queue: QUEUE_B, size: 1n });
    await managerOn(chain).processExits({ tokens: [TOKEN_A, TOKEN_B] });
    expect(chain.writes).lengthOf(1);
  });
});

describe('PlasmaWithdrawManager.processExits default gas', () => {
  it.each([1n, 3n])('is estimate + n * 350000 for n = %s', async (n) => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: n });
    await managerOn(chain).processExits({ tokens: [TOKEN_A] });
    expect(chain.writes[0])
      .property('gasLimit')
      .equals(ESTIMATE + n * 350_000n);
  });

  it('counts the queued exits of every token named', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 2n });
    chain.queue({ token: TOKEN_B, queue: QUEUE_B, size: 3n });
    await managerOn(chain).processExits({ tokens: [TOKEN_A, TOKEN_B] });
    expect(chain.writes[0])
      .property('gasLimit')
      .equals(ESTIMATE + 5n * 350_000n);
  });

  it('is capped below the per-transaction gas limit at a large queue', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 500n });
    await managerOn(chain).processExits({ tokens: [TOKEN_A] });
    expect(chain.writes[0]).property('gasLimit').equals(16_000_000n);
    expect(MAX_PROCESS_EXITS_GAS_LIMIT).equals(16_000_000n);
    expect(MAX_PROCESS_EXITS_GAS_LIMIT < 2n ** 24n).equals(true);
  });

  it('reaches the caller as the same object when estimateGas rejects', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    const libraryError = new Error('execution reverted');
    chain.estimate = libraryError;
    const err = await rejection(() => managerOn(chain).processExits({ tokens: [TOKEN_A] }));
    expect(err).equals(libraryError);
    expect(chain.writes).lengthOf(0);
  });

  it('reaches the caller as the same object when a queue read rejects', async () => {
    const chain = new ParentChain();
    const libraryError = new Error('rpc down');
    chain.read = (): Promise<unknown> => Promise.reject(libraryError);
    const err = await rejection(() => managerOn(chain).processExits({ tokens: [TOKEN_A] }));
    expect(err).equals(libraryError);
  });
});

describe('PlasmaWithdrawManager.getProcessExitsGasLimit', () => {
  it.each([
    [1n, ESTIMATE + 350_000n],
    [3n, ESTIMATE + 3n * 350_000n],
    [500n, MAX_PROCESS_EXITS_GAS_LIMIT]
  ])('equals the limit the write sends for %s queued exits (%s)', async (size, expected) => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size });
    const manager = managerOn(chain);
    const limit = await manager.getProcessExitsGasLimit({ tokens: [TOKEN_A] });
    expect(limit).equals(expected);
    expect(chain.writes).lengthOf(0);
    expect(chain.prepares).lengthOf(0);
    await manager.processExits({ tokens: [TOKEN_A] });
    expect(chain.writes[0]).property('gasLimit').equals(limit);
  });

  it('equals the batch write limit, counting the exits of every token', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 2n });
    chain.queue({ token: TOKEN_B, queue: QUEUE_B, size: 3n });
    const manager = managerOn(chain);
    const limit = await manager.getProcessExitsGasLimit({ tokens: [TOKEN_A, TOKEN_B] });
    expect(limit).equals(ESTIMATE + 5n * 350_000n);
    await manager.processExits({ tokens: [TOKEN_A, TOKEN_B] });
    expect(chain.writes[0]).property('functionName').equals('processExitsBatch');
    expect(chain.writes[0]).property('gasLimit').equals(limit);
  });

  it('estimates the call the write would send, as the sender the caller names', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    const sender: Hex = '0x2222222222222222222222222222222222222222';
    await managerOn(chain).getProcessExitsGasLimit({ tokens: [TOKEN_A] }, { from: sender });
    expect(chain.estimates).lengthOf(1);
    expect(chain.estimates[0]).property('functionName').equals('processExits');
    expect(chain.estimates[0]).property('args').deep.equals([TOKEN_A]);
    expect(chain.estimates[0]).property('from').equals(sender);
  });

  it('throws ExitQueueEmptyError as the write does, estimating nothing', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 0n });
    const err = await rejection(() =>
      managerOn(chain).getProcessExitsGasLimit({ tokens: [TOKEN_A, TOKEN_B] })
    );
    expect(err).instanceOf(ExitError);
    expect(err).nested.property('info.operation').equals('getProcessExitsGasLimit');
    expect(err).nested.property('info.mode').equals('read');
    expect(ExitQueueEmptyError.find(err)?.info.tokens).deep.equals([TOKEN_A, TOKEN_B]);
    expect(chain.estimates).lengthOf(0);
    expect(chain.writes).lengthOf(0);
  });

  it('throws on an empty token list too', async () => {
    const err = await rejection(() =>
      managerOn(new ParentChain()).getProcessExitsGasLimit({ tokens: [] })
    );
    expect(ExitQueueEmptyError.has(err)).equals(true);
  });

  it('rethrows an estimation failure and a queue read failure as the same object', async () => {
    const estimating = new ParentChain();
    estimating.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    const estimateError = new Error('execution reverted');
    estimating.estimate = estimateError;
    expect(
      await rejection(() => managerOn(estimating).getProcessExitsGasLimit({ tokens: [TOKEN_A] }))
    ).equals(estimateError);

    const reading = new ParentChain();
    const readError = new Error('rpc down');
    reading.read = (): Promise<unknown> => Promise.reject(readError);
    expect(
      await rejection(() => managerOn(reading).getProcessExitsGasLimit({ tokens: [TOKEN_A] }))
    ).equals(readError);
  });

  it('does not read ON_FINALIZE_GAS_LIMIT: the default limit does not depend on it', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    await managerOn(chain).getProcessExitsGasLimit({ tokens: [TOKEN_A] });
    expect(chain.reads_('ON_FINALIZE_GAS_LIMIT')).lengthOf(0);
  });
});

describe('PlasmaWithdrawManager.processExits caller gas limit', () => {
  it('rejects a limit one below ON_FINALIZE_GAS_LIMIT + 30000 and sends nothing', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    const err = await rejection(() =>
      managerOn(chain).processExits({ tokens: [TOKEN_A] }, { gasLimit: FLOOR - 1n })
    );
    expect(err).instanceOf(ExitError);
    const low = ExitGasLimitTooLowError.find(err);
    expect(low?.info.gasLimit).equals(FLOOR - 1n);
    expect(low?.info.minimum).equals(330_000n);
    expect(chain.writes).lengthOf(0);
    expect(chain.estimates).lengthOf(0);
  });

  it('sends exactly the minimum untouched, without estimating', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    await managerOn(chain).processExits({ tokens: [TOKEN_A] }, { gasLimit: FLOOR });
    expect(FLOOR).equals(330_000n);
    expect(chain.writes[0]).property('gasLimit').equals(330_000n);
    expect(chain.estimates).lengthOf(0);
  });

  it('sends the SDK one-exit default and a 600000 limit untouched', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    const manager = managerOn(chain);
    await manager.processExits({ tokens: [TOKEN_A] }, { gasLimit: ESTIMATE + 350_000n });
    await manager.processExits({ tokens: [TOKEN_A] }, { gasLimit: 600_000n });
    expect(chain.writes[0]).property('gasLimit').equals(509_335n);
    expect(chain.writes[1]).property('gasLimit').equals(600_000n);
  });

  it('sends the default limit when none is given, whatever the floor is', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    await managerOn(chain).processExits({ tokens: [TOKEN_A] });
    expect(chain.writes[0]).property('gasLimit').equals(509_335n);
  });

  it('sends a limit above the cap untouched: the caller always wins above the floor', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    await managerOn(chain).processExits({ tokens: [TOKEN_A] }, { gasLimit: 20_000_000n });
    expect(chain.writes[0]).property('gasLimit').equals(20_000_000n);
  });

  it('uses the value the contract reports, not a hardcoded one', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    chain.onFinalize = 500_000n;
    const err = await rejection(() =>
      managerOn(chain).processExits({ tokens: [TOKEN_A] }, { gasLimit: FLOOR })
    );
    expect(ExitGasLimitTooLowError.find(err)?.info.minimum).equals(530_000n);
  });

  it('reads the constant once per instance', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    const manager = managerOn(chain);
    await manager.processExits({ tokens: [TOKEN_A] }, { gasLimit: FLOOR });
    await manager.processExits({ tokens: [TOKEN_A] }, { gasLimit: FLOOR });
    await manager.prepareProcessExits({ tokens: [TOKEN_A] }, { gasLimit: FLOOR });
    expect(chain.reads_('ON_FINALIZE_GAS_LIMIT')).lengthOf(1);
  });

  it('does not read the constant when no limit is given', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    await managerOn(chain).processExits({ tokens: [TOKEN_A] });
    expect(chain.reads_('ON_FINALIZE_GAS_LIMIT')).lengthOf(0);
  });

  it('rethrows a failed read as the same object, caches nothing, and reads again on the next call', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    const libraryError = new Error('rpc down');
    chain.onFinalize = libraryError;
    const manager = managerOn(chain);

    const err = await rejection(() =>
      manager.processExits({ tokens: [TOKEN_A] }, { gasLimit: 329_999n })
    );
    expect(err).equals(libraryError);
    expect(chain.writes).lengthOf(0);
    const prepared = await rejection(() =>
      manager.prepareProcessExits({ tokens: [TOKEN_A] }, { gasLimit: 330_000n })
    );
    expect(prepared).equals(libraryError);
    expect(chain.prepares).lengthOf(0);

    chain.onFinalize = 400_000n;
    const next = await rejection(() =>
      manager.processExits({ tokens: [TOKEN_A] }, { gasLimit: 330_000n })
    );
    expect(ExitGasLimitTooLowError.find(next)?.info.minimum).equals(430_000n);
    expect(chain.reads_('ON_FINALIZE_GAS_LIMIT')).lengthOf(3);
  });

  it('applies the floor when preparing, and prepares a limit at the minimum', async () => {
    const chain = new ParentChain();
    chain.queue({ token: TOKEN_A, queue: QUEUE_A, size: 1n });
    const manager = managerOn(chain);
    const err = await rejection(() =>
      manager.prepareProcessExits({ tokens: [TOKEN_A] }, { gasLimit: FLOOR - 1n })
    );
    expect(ExitGasLimitTooLowError.has(err)).equals(true);
    expect(chain.prepares).lengthOf(0);
    await manager.prepareProcessExits({ tokens: [TOKEN_A] }, { gasLimit: FLOOR });
    expect(chain.prepares).lengthOf(1);
  });
});

describe('readPlasmaWithdrawStatus', () => {
  const BURN = txHash(0xb0n);
  const CONFIRM = txHash(0xc0n);
  const BURN_BLOCK = 266n;
  // Position 130 RLP-encodes to 0x8182, so a mask taken from the plain index
  // (130) or from the index's low bits cannot pass for it.
  const BURN_INDEX = 130;
  const BURN_MASK = 0x8182n;
  const BURNER: Hex = '0x00000000000000000000000000000000000000aa';
  const OTHER_ACCOUNT: Hex = '0x00000000000000000000000000000000000000bb';
  const EXITABLE_AT = 486n;
  const exitIdOf = ({
    block = BURN_BLOCK,
    mask = BURN_MASK
  }: { block?: bigint; mask?: bigint } = {}): bigint =>
    (EXITABLE_AT << 128n) | (block << 33n) | (mask << 1n);
  const EXIT_ID = exitIdOf();
  const addresses = { WithdrawManager: MANAGER, ExitNFT: EXIT_NFT };

  const startedLog = ({
    address = MANAGER,
    exitId = EXIT_ID,
    exitor = BURNER
  }: { address?: Hex; exitId?: bigint; exitor?: Hex } = {}): Receipt['logs'][number] => ({
    address,
    topics: [PlasmaEventSignature.ExitStarted, hex32(BigInt(exitor)), hex32(exitId), hex32(2n)],
    data: '0x',
    logIndex: 0
  });
  const receiptOf = ({
    status = 'success',
    logs
  }: {
    status?: Receipt['status'];
    logs: Receipt['logs'];
  }): Receipt => ({ transactionHash: CONFIRM, status, blockNumber: 484n, logs });

  const proofOf = (
    status: Awaited<ReturnType<PlasmaBurnReader['getCheckpointStatus']>>,
    burn: Partial<PlasmaBurn> = {}
  ): PlasmaBurnReader & { burnReads: number } => {
    const reader = {
      burnReads: 0,
      getCheckpointStatus: (): Promise<typeof status> => Promise.resolve(status),
      getBurn: (): Promise<PlasmaBurn> => {
        reader.burnReads += 1;
        return Promise.resolve({
          blockNumber: BURN_BLOCK,
          transactionIndex: BURN_INDEX,
          exitor: BURNER,
          ...burn
        });
      }
    };
    return reader;
  };
  const CHECKPOINTED = { checkpointed: true } as const;

  const read = ({
    chain,
    proof = proofOf(CHECKPOINTED),
    ...ids
  }: {
    chain: ParentChain;
    proof?: PlasmaBurnReader;
    burnTxHash?: string;
    confirmTxHash?: string;
  }) =>
    readPlasmaWithdrawStatus({
      burnTxHash: ids.burnTxHash ?? BURN,
      ...(ids.confirmTxHash !== undefined ? { confirmTxHash: ids.confirmTxHash } : {}),
      proof,
      parentAdapter: chain,
      addresses
    });

  const confirmedChain = (): ParentChain => {
    const chain = new ParentChain();
    chain.receipts.set(CONFIRM, receiptOf({ logs: [startedLog()] }));
    chain.existingExits.add(EXIT_ID);
    return chain;
  };

  it("answers 'pending' while the burn is in no block, without reading the parent chain", async () => {
    const chain = new ParentChain();
    const proof = proofOf({ checkpointed: false, reason: 'pending' });
    expect(await read({ chain, proof, confirmTxHash: CONFIRM })).deep.equals({
      exited: false,
      reason: 'pending'
    });
    expect(chain.reads).lengthOf(0);
  });

  it("answers 'not-checkpointed' while the burn waits for its checkpoint", async () => {
    const chain = confirmedChain();
    const proof = proofOf({ checkpointed: false, reason: 'not-checkpointed' });
    expect(await read({ chain, proof, confirmTxHash: CONFIRM })).deep.equals({
      exited: false,
      reason: 'not-checkpointed'
    });
  });

  it("answers 'not-confirmed' for a checkpointed burn when confirmTxHash is omitted", async () => {
    const chain = confirmedChain();
    expect(await read({ chain })).deep.equals({ exited: false, reason: 'not-confirmed' });
  });

  it("answers 'not-confirmed' when the confirm transaction has no receipt", async () => {
    const chain = new ParentChain();
    expect(await read({ chain, confirmTxHash: CONFIRM })).deep.equals({
      exited: false,
      reason: 'not-confirmed'
    });
  });

  it("answers 'not-confirmed' when the confirm transaction reverted", async () => {
    const chain = new ParentChain();
    chain.receipts.set(CONFIRM, receiptOf({ status: 'reverted', logs: [startedLog()] }));
    expect(await read({ chain, confirmTxHash: CONFIRM })).deep.equals({
      exited: false,
      reason: 'not-confirmed'
    });
  });

  it("answers 'in-exit-window' before exitableAt", async () => {
    const chain = confirmedChain();
    chain.now = EXITABLE_AT - 1n;
    expect(await read({ chain, confirmTxHash: CONFIRM })).deep.equals({
      exited: false,
      reason: 'in-exit-window'
    });
  });

  it("answers 'ready-to-process' from exitableAt on", async () => {
    const chain = confirmedChain();
    chain.now = EXITABLE_AT;
    expect(await read({ chain, confirmTxHash: CONFIRM })).deep.equals({
      exited: false,
      reason: 'ready-to-process'
    });
  });

  it('answers exited once the exit token is gone, whatever the clock says', async () => {
    const chain = confirmedChain();
    chain.existingExits.clear();
    chain.now = EXITABLE_AT - 100n;
    expect(await read({ chain, confirmTxHash: CONFIRM })).deep.equals({ exited: true });
    expect(chain.reads_('exists')[0]).property('address').equals(EXIT_NFT);
    expect(chain.reads_('exists')[0]).property('args').deep.equals([EXIT_ID]);
  });

  it('throws ExitNotStartedError when the confirm receipt has no ExitStarted log', async () => {
    const chain = new ParentChain();
    chain.receipts.set(CONFIRM, receiptOf({ logs: [] }));
    const err = await rejection(() => read({ chain, confirmTxHash: CONFIRM }));
    expect(err).instanceOf(ExitNotStartedError);
    expect(err).property('info').deep.equals({
      burnTxHash: BURN,
      confirmTxHash: CONFIRM,
      reason: 'no-exit-started-log'
    });
  });

  it('does not take an ExitStarted-shaped log from another contract for the exit', async () => {
    const chain = new ParentChain();
    chain.receipts.set(CONFIRM, receiptOf({ logs: [startedLog({ address: TOKEN_A })] }));
    const err = await rejection(() => read({ chain, confirmTxHash: CONFIRM }));
    expect(err).property('info').property('reason').equals('no-exit-started-log');
  });

  it('throws ExitNotStartedError when the exit belongs to a burn in another block', async () => {
    const chain = new ParentChain();
    const otherBurn = exitIdOf({ block: BURN_BLOCK + 1n });
    chain.receipts.set(CONFIRM, receiptOf({ logs: [startedLog({ exitId: otherBurn })] }));
    chain.existingExits.add(otherBurn);
    const err = await rejection(() => read({ chain, confirmTxHash: CONFIRM }));
    expect(err).instanceOf(ExitNotStartedError);
    expect(err).property('info').property('reason').equals('burn-block-mismatch');
    expect(chain.reads_('exists')).lengthOf(0);
  });

  it('throws ExitNotStartedError when the exit was started for another account', async () => {
    const chain = new ParentChain();
    chain.receipts.set(CONFIRM, receiptOf({ logs: [startedLog({ exitor: OTHER_ACCOUNT })] }));
    chain.existingExits.add(EXIT_ID);
    const err = await rejection(() => read({ chain, confirmTxHash: CONFIRM }));
    expect(err).instanceOf(ExitNotStartedError);
    expect(err).property('info').deep.equals({
      burnTxHash: BURN,
      confirmTxHash: CONFIRM,
      reason: 'exitor-mismatch'
    });
    expect(chain.reads_('exists')).lengthOf(0);
  });

  it('compares the exitor whatever the case of the topic the node returned', async () => {
    const chain = confirmedChain();
    chain.now = EXITABLE_AT - 1n;
    const upperCaseExitor: Hex = `0x${'00'.repeat(12)}${'AA'.padStart(40, '0')}`;
    const mixedCase = {
      ...startedLog(),
      topics: [PlasmaEventSignature.ExitStarted, upperCaseExitor, hex32(EXIT_ID)] as const
    };
    chain.receipts.set(CONFIRM, receiptOf({ logs: [mixedCase] }));
    expect(await read({ chain, confirmTxHash: CONFIRM })).deep.equals({
      exited: false,
      reason: 'in-exit-window'
    });
  });

  it('throws ExitNotStartedError when the exit is for another transaction in the same block', async () => {
    const chain = new ParentChain();
    // Same block, same exitor, the neighbouring transaction's position.
    const neighbour = exitIdOf({ mask: 0x8183n });
    chain.receipts.set(CONFIRM, receiptOf({ logs: [startedLog({ exitId: neighbour })] }));
    chain.existingExits.add(neighbour);
    const err = await rejection(() => read({ chain, confirmTxHash: CONFIRM }));
    expect(err).instanceOf(ExitNotStartedError);
    expect(err).property('info').deep.equals({
      burnTxHash: BURN,
      confirmTxHash: CONFIRM,
      reason: 'branch-mask-mismatch'
    });
    expect(chain.reads_('exists')).lengthOf(0);
  });

  it('does not take the plain transaction index for the branch mask', async () => {
    const chain = new ParentChain();
    const plain = exitIdOf({ mask: BigInt(BURN_INDEX) });
    chain.receipts.set(CONFIRM, receiptOf({ logs: [startedLog({ exitId: plain })] }));
    chain.existingExits.add(plain);
    const err = await rejection(() => read({ chain, confirmTxHash: CONFIRM }));
    expect(err).property('info').property('reason').equals('branch-mask-mismatch');
  });

  it('expects 0x80, not 0, for a burn first in its block', async () => {
    const first = proofOf(CHECKPOINTED, { transactionIndex: 0 });
    const zero = exitIdOf({ mask: 0n });
    const chain = new ParentChain();
    chain.receipts.set(CONFIRM, receiptOf({ logs: [startedLog({ exitId: zero })] }));
    chain.existingExits.add(zero);
    const err = await rejection(() => read({ chain, proof: first, confirmTxHash: CONFIRM }));
    expect(err).property('info').property('reason').equals('branch-mask-mismatch');

    const genuine = exitIdOf({ mask: 0x80n });
    chain.receipts.set(CONFIRM, receiptOf({ logs: [startedLog({ exitId: genuine })] }));
    chain.existingExits.add(genuine);
    chain.now = EXITABLE_AT - 1n;
    expect(await read({ chain, proof: first, confirmTxHash: CONFIRM })).deep.equals({
      exited: false,
      reason: 'in-exit-window'
    });
  });

  it('asks for the burn only once there is an exit to compare it with', async () => {
    const chain = confirmedChain();
    const proof = proofOf(CHECKPOINTED);
    await read({ chain, proof, confirmTxHash: CONFIRM });
    expect(proof.burnReads).equals(1);
    const unconfirmed = proofOf(CHECKPOINTED);
    await read({ chain, proof: unconfirmed });
    expect(unconfirmed.burnReads).equals(0);
  });

  it('rejects an empty burn hash as missing input', async () => {
    const err = await rejection(() => read({ chain: new ParentChain(), burnTxHash: '' }));
    expect(err).instanceOf(TransactionHashRequiredError);
  });

  it.each(['0x1234', 'not-a-hash', `0x${'zz'.repeat(32)}`])(
    'rejects the malformed hash %s as invalid hex',
    async (bad) => {
      const burn = await rejection(() => read({ chain: new ParentChain(), burnTxHash: bad }));
      expect(burn).instanceOf(InvalidHexStringError);
      const confirm = await rejection(() => read({ chain: new ParentChain(), confirmTxHash: bad }));
      expect(confirm).instanceOf(InvalidHexStringError);
    }
  );

  it('rejects an empty confirm hash instead of reading it as omitted', async () => {
    const err = await rejection(() => read({ chain: new ParentChain(), confirmTxHash: '' }));
    expect(err).instanceOf(TransactionHashRequiredError);
  });

  it('rethrows a library failure from the parent chain unchanged', async () => {
    const chain = confirmedChain();
    const libraryError = new Error('rpc down');
    chain.getTransactionReceipt = (): Promise<Receipt | null> => Promise.reject(libraryError);
    const err = await rejection(() => read({ chain, confirmTxHash: CONFIRM }));
    expect(err).equals(libraryError);
  });
});

// --- ON_FINALIZE_GAS_LIMIT fallback, on the real libraries ----------------------
//
// Only the JSON-RPC transport is stubbed. Each library turns the node's answer
// into its own error shape, and the manager's classification of that shape is
// what is under test, so the stub must not stand in for the library.

/** What the stub node does for the `ON_FINALIZE_GAS_LIMIT` call. */
type ConstantAnswer =
  | { kind: 'value'; value: bigint }
  | { kind: 'return'; data: Hex }
  | { kind: 'rpc-error'; code: number; message: string; data?: Hex }
  | { kind: 'transport-failure' };

const word = (n: bigint): Hex => hex32(n);
const addressWord = (address: Hex): Hex => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

const SELECTOR_EXITS_QUEUES = toFunctionSelector('function exitsQueues(address)');
const SELECTOR_CURRENT_SIZE = toFunctionSelector('function currentSize()');
const SELECTOR_ON_FINALIZE = toFunctionSelector('function ON_FINALIZE_GAS_LIMIT()');

/** `Error(string)` revert data for `reason`. */
const revertData = (reason: string): Hex => {
  const bytes = new TextEncoder().encode(reason);
  const padded = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .padEnd(64, '0');
  return `0x08c379a0${word(32n).slice(2)}${word(BigInt(bytes.length)).slice(2)}${padded}`;
};

/** A node with one queued exit for `TOKEN_A`, answering the constant as scripted. */
class StubNode {
  answer: ConstantAnswer = { kind: 'value', value: ON_FINALIZE };
  /** One entry per `ON_FINALIZE_GAS_LIMIT` call that reached the node. */
  readonly constantReads: number[] = [];
  readonly transportError = new TypeError('fetch failed');

  /** The `eth_call` outcome: a result, or the JSON-RPC error body the node answers with. */
  call(data: string): { result: Hex } | { error: { code: number; message: string; data?: Hex } } {
    const selector = data.slice(0, 10);
    if (selector === SELECTOR_EXITS_QUEUES) return { result: addressWord(QUEUE_A) };
    if (selector === SELECTOR_CURRENT_SIZE) return { result: word(1n) };
    if (selector !== SELECTOR_ON_FINALIZE) {
      return { error: { code: -32601, message: `stub node: unexpected call ${selector}` } };
    }
    this.constantReads.push(this.constantReads.length);
    const { answer } = this;
    switch (answer.kind) {
      case 'value':
        return { result: word(answer.value) };
      case 'return':
        return { result: answer.data };
      case 'rpc-error':
        return {
          error: {
            code: answer.code,
            message: answer.message,
            ...(answer.data !== undefined ? { data: answer.data } : {})
          }
        };
      case 'transport-failure':
        throw this.transportError;
    }
  }
}

const callData = (params: unknown): string => {
  if (!Array.isArray(params)) return '';
  const first: unknown = params[0];
  const data: unknown =
    typeof first === 'object' && first !== null ? Reflect.get(first, 'data') : '';
  return typeof data === 'string' ? data : '';
};

/** A thrown node error, as an EIP-1193 / ethers v5 transport raises it. */
const thrownBy = (error: { code: number; message: string; data?: Hex }): Error =>
  Object.assign(new Error(error.message), error);

const nodeAnswer = (node: StubNode, method: string, params: unknown): unknown => {
  if (method === 'eth_chainId') return '0x1';
  if (method === 'net_version') return '1';
  if (method !== 'eth_call') throw new Error(`stub node: unexpected RPC ${method}`);
  const outcome = node.call(callData(params));
  if ('error' in outcome) throw thrownBy(outcome.error);
  return outcome.result;
};

class V5Provider extends v5providers.StaticJsonRpcProvider {
  private readonly node: StubNode;
  constructor(node: StubNode) {
    super('http://stub.invalid', { chainId: 1, name: 'stub' });
    this.node = node;
  }
  override async send(method: string, params: unknown[]): Promise<unknown> {
    return nodeAnswer(this.node, method, params);
  }
}

class V6Provider extends JsonRpcApiProvider {
  private readonly node: StubNode;
  constructor(node: StubNode) {
    super(Network.from(1), { staticNetwork: true, batchMaxCount: 1 });
    this.node = node;
  }
  override async _send(
    payload: JsonRpcPayload | JsonRpcPayload[]
  ): Promise<Array<JsonRpcResult | JsonRpcError>> {
    const batch = Array.isArray(payload) ? payload : [payload];
    return batch.map((p) => {
      try {
        return { id: p.id, result: nodeAnswer(this.node, p.method, p.params) };
      } catch (err) {
        // A JSON-RPC error body keeps its code and data; anything else is a
        // transport failure and leaves `_send` as it is.
        const code: unknown = err instanceof Error ? Reflect.get(err, 'code') : undefined;
        if (!(err instanceof Error) || typeof code !== 'number') throw err;
        const data: unknown = Reflect.get(err, 'data');
        return {
          id: p.id,
          error: { code, message: err.message, ...(typeof data === 'string' ? { data } : {}) }
        };
      }
    });
  }
}

const parentTransport = (node: StubNode) =>
  custom(
    {
      request: async ({ method, params }: { method: string; params?: unknown }) =>
        nodeAnswer(node, method, params)
    },
    // viem retries a failed call by default, which only slows the failure rows.
    { retryCount: 0 }
  );

const LIBRARIES: Array<[string, (node: StubNode) => Adapter]> = [
  [
    'viem',
    (node) => viemAdapter({ public: createPublicClient({ transport: parentTransport(node) }) })
  ],
  ['ethers v5', (node) => ethersV5Adapter({ provider: new V5Provider(node) })],
  ['ethers v6', (node) => ethersV6Adapter({ provider: new V6Provider(node) })]
];

/** The contract answered, but has no usable `ON_FINALIZE_GAS_LIMIT`. */
const ABSENT: Array<[string, ConstantAnswer]> = [
  ['an empty return', { kind: 'return', data: '0x' }],
  ['an undecodable return', { kind: 'return', data: '0x1234' }],
  [
    'a revert with data',
    { kind: 'rpc-error', code: 3, message: 'execution reverted: nope', data: revertData('nope') }
  ],
  ['a revert without data', { kind: 'rpc-error', code: 3, message: 'execution reverted' }]
];

/** Failures that never reached the contract, or that merely look like a revert. */
const NOT_AN_ANSWER: Array<[string, ConstantAnswer]> = [
  ['a transport failure', { kind: 'transport-failure' }],
  ['an internal RPC error', { kind: 'rpc-error', code: -32603, message: 'internal error' }],
  [
    // viem maps this to a ContractFunctionRevertedError and keeps the data, so
    // only the RPC code tells it from a revert.
    'an internal RPC error carrying hex data',
    { kind: 'rpc-error', code: -32603, message: 'internal error', data: revertData('proxy') }
  ],
  [
    'a rate limit whose text says execution reverted',
    { kind: 'rpc-error', code: -32005, message: 'execution reverted: rate limit exceeded' }
  ],
  ['a server error whose text says revert', { kind: 'rpc-error', code: -32000, message: 'revert' }]
];

describe.each(LIBRARIES)('ON_FINALIZE_GAS_LIMIT read on %s', (_library, build) => {
  const managerOver = (node: StubNode) => {
    const { adapter, thrown } = recordingAdapter(build(node));
    const manager = new PlasmaWithdrawManager({
      adapter,
      getWithdrawManagerAddress: () => Promise.resolve(MANAGER),
      logger: noopLogger,
      chainId: PARENT_CHAIN_ID
    });
    return { manager, thrown };
  };
  const prepareAt = (manager: PlasmaWithdrawManager, gasLimit: bigint): Promise<unknown> =>
    manager.prepareProcessExits({ tokens: [TOKEN_A] }, { gasLimit });

  it('uses the constant the contract returns', async () => {
    const node = new StubNode();
    node.answer = { kind: 'value', value: 500_000n };
    const { manager } = managerOver(node);
    const err = await rejection(() => prepareAt(manager, FLOOR));
    expect(ExitGasLimitTooLowError.find(err)?.info.minimum).equals(530_000n);
  });

  it.each(ABSENT)(
    'falls back to 300000 on %s, and reads the contract once',
    async (_name, answer) => {
      const node = new StubNode();
      node.answer = answer;
      const { manager } = managerOver(node);
      const err = await rejection(() => prepareAt(manager, 329_999n));
      expect(ExitGasLimitTooLowError.find(err)?.info.minimum).equals(330_000n);
      // The fallback is cached: a library may retry a failed call inside one
      // read, so what is compared is the count before and after the next call.
      const readsAfterFirst = node.constantReads.length;
      expect(await prepareAt(manager, 330_000n))
        .property('to')
        .equals(MANAGER);
      expect(node.constantReads).lengthOf(readsAfterFirst);
    }
  );

  it.each(NOT_AN_ANSWER)(
    'rethrows %s as the very object the library threw, with no fallback and no cache',
    async (_name, answer) => {
      const node = new StubNode();
      node.answer = answer;
      const { manager, thrown } = managerOver(node);

      const err = await rejection(() => prepareAt(manager, 330_000n));

      // The consumer's error is what an adapter call rejected with: not
      // wrapped, not replaced, and no gas floor was guessed from it.
      expect(thrown).include(err);
      expect(isMaticjsError(err)).equals(false);
      expect(ExitGasLimitTooLowError.has(err)).equals(false);

      // The failure was not cached: the next call asks the contract again.
      const readsAfterFailure = node.constantReads.length;
      node.answer = { kind: 'value', value: 400_000n };
      const next = await rejection(() => prepareAt(manager, 330_000n));
      expect(ExitGasLimitTooLowError.find(next)?.info.minimum).equals(430_000n);
      expect(node.constantReads.length).greaterThan(readsAfterFailure);
    }
  );
});
