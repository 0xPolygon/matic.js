/**
 * `ExitProofBuilder` owns what a bridge needs to prove a burn on the child
 * chain: whether the burn's block is checkpointed on the parent chain, and the
 * RLP exit payload a bridge's exit entry point verifies.
 *
 * # Why this is its own module
 *
 * The proof construction depends only on the parent chain's checkpoint
 * contract (`RootChain`), the child chain's RPC and the optional proof API. It
 * knows nothing about a particular bridge's contracts, so every bridge that
 * proves child-chain burns can share one implementation instead of copying it.
 * It therefore imports no bridge ABI and no token class; from `../pos/` it takes only
 * the checkpoint-slot helpers, which belong to no one bridge, and its status type comes
 * from the shared `./checkpoint-status.js`.
 *
 * # Proof API is opt-in
 *
 * `proofApiClient` is `undefined` when no proof API URL was configured: the
 * fast-exit path then throws `ProofApiNotSetError` and every payload is built
 * locally from RPC.
 */

import { RLP } from '@ethereumjs/rlp';

import type { RootChainABI } from '../abi/RootChain.js';
import type { BlockTag, Hex } from '../adapter.js';
import type { CheckpointRangeInvalidReason } from '../errors.js';
import type {
  IBlockWithTransaction,
  IRootBlockInfo,
  ITransactionReceipt
} from '../interfaces/index.js';
import type { Logger } from '../logger.js';
import type { ProofChildClient } from '../utils/proof_util.js';
import type { CheckpointStatus } from './checkpoint-status.js';
import type { ContractCaller } from './contract-caller.js';
import type { ProofApiClient } from './proof-api-client.js';

import { LogEventSignature } from '../constant.js';
import {
  BurnTxNotCheckpointedError,
  CheckpointRangeInvalidError,
  HttpRequestFailedError,
  IndexOutOfBoundsError,
  LogNotFoundInReceiptError,
  NegativeIndexError,
  ProofApiNotSetError,
  TransactionNotFoundError
} from '../errors.js';
import { findCheckpointSlot } from '../pos/find_checkpoint_slot.js';
import { BufferUtil } from '../utils/buffer-utils.js';
import { concatBytes } from '../utils/bytes.js';
import { MAX_CHECKPOINT_DEPTH, ProofUtil } from '../utils/proof_util.js';

/**
 * Extended child-chain client that the proof builders need beyond what
 * the bare `ProofChildClient` covers — block lookups (for the
 * receipts-trie input) and tx-hash → blockNumber lookups (for the
 * starting-point of `getRootBlockInfo`).
 */
export interface BridgeChildClient extends ProofChildClient {
  /**
   * Resolve a tx hash to its blockNumber, `null` while the tx is pending.
   * Rejects with `TransactionNotFoundError` when the node does not know the
   * tx at all.
   */
  getTransaction(hash: string): Promise<{ blockNumber: number | null }>;
  /** Fetch a full block including all transaction objects. */
  getBlockWithTransaction(blockNumberOrHash: number | string): Promise<IBlockWithTransaction>;
  /**
   * Solidity-packed keccak — `keccak256(solidityPack(...args))`. The
   * bridge's exit-hash computation calls this with `(uint256 blockNumber,
   * bytes path, uint256 logIndex)` to mirror the on-chain
   * `RootChainManager.processedExits` keying. Matches the legacy
   * `web3.utils.soliditySha3` shape.
   */
  soliditySha3(...args: unknown[]): string;
}

/**
 * Everything the payload encoder needs for the LOCAL construction path,
 * reconstructed once and shared between the single- and multi-payload
 * builders so a multi-token burn pays the receipt/block/proof cost once.
 */
interface LocalPayloadInputs {
  receipt: ITransactionReceipt;
  block: IBlockWithTransaction;
  rootBlockInfo: IRootBlockInfo;
  blockProof: string;
  receiptProof: { parentNodes: unknown; path: Uint8Array };
  txBlockNumber: number;
}

export interface ExitProofBuilderConfig {
  /**
   * The on-chain `RootChain` contract on the parent chain. Used for
   * `findRootBlockFromChild` during exit-payload construction.
   */
  rootChainCaller: ContractCaller<typeof RootChainABI>;
  /** Matic (child) chain client for receipt / block / proof reads. */
  childClient: BridgeChildClient;
  /**
   * Concrete proof-API client, built from `proofGenerationApiUrl` in
   * `POSClient.init`. `undefined` means no URL was configured: the
   * fast-exit path throws `ProofApiNotSetError` and all
   * payloads are built locally from RPC. When present, the slow path
   * also prefers the API for its sub-steps (block-included, fast-merkle
   * -proof), falling back to local construction on API failure.
   */
  proofApiClient?: ProofApiClient;
  /**
   * L1 block tag the root-chain reads (`getLastChildBlock`,
   * `currentHeaderBlock`, `headerBlocks`) pin to. Defaults to `'safe'`
   * to avoid reorg races — see {@link findCheckpointSlot}.
   */
  rootChainDefaultBlock?: BlockTag;
  logger: Logger;
  /**
   * Maximum concurrent receipt fetches when reconstructing proofs
   * locally. Polygon mainnet blocks can hit 280+ transactions;
   * firing all of them at once trips RPC rate limits.
   */
  proofConcurrency: number;
}

/**
 * Largest checkpoint, in child blocks, the SDK will build a proof over.
 * Real checkpoints span a few hundred blocks; 2^16 leaves headroom for
 * any protocol change while keeping the merkle-path builder's
 * allocations bounded no matter what an RPC or proof API claims.
 */
export const MAX_CHECKPOINT_BLOCKS = 2 ** MAX_CHECKPOINT_DEPTH;

/**
 * The reason a checkpoint range cannot be a real checkpoint of the burn, or
 * `undefined` when it can: inverted, not containing the burn's block, or
 * larger than {@link MAX_CHECKPOINT_BLOCKS}. The range comes from an RPC or the proof
 * API, and sizes the merkle-path allocation, so it is checked before use.
 */
export function checkpointRangeProblem({
  start,
  end,
  txBlockNumber
}: {
  start: bigint;
  end: bigint;
  txBlockNumber: number;
}): CheckpointRangeInvalidReason | undefined {
  // Precedence matters: a range can be inverted and also miss the burn block,
  // and callers (and the error's `info`) report the first problem only.
  if (end < start) return 'inverted';
  if (BigInt(txBlockNumber) < start || BigInt(txBlockNumber) > end) return 'not-containing';
  if (end - start + 1n > BigInt(MAX_CHECKPOINT_BLOCKS)) return 'too-large';
  return undefined;
}

/** Throw `CheckpointRangeInvalidError` when {@link checkpointRangeProblem} finds a problem. */
export function assertCheckpointRange({
  start,
  end,
  txBlockNumber
}: {
  start: bigint;
  end: bigint;
  txBlockNumber: number;
}): void {
  const reason = checkpointRangeProblem({ start, end, txBlockNumber });
  if (reason !== undefined) {
    throw new CheckpointRangeInvalidError(
      `checkpoint range ${start}-${end} is not a valid checkpoint for block ${txBlockNumber} (${reason})`,
      { info: { start: start.toString(), end: end.toString(), txBlockNumber, reason } }
    );
  }
}

const DEFAULT_ROOT_CHAIN_BLOCK: BlockTag = 'safe';

export const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';

export class ExitProofBuilder {
  readonly #rootChainCaller: ContractCaller<typeof RootChainABI>;
  private readonly childClient: BridgeChildClient;
  private readonly proofApiClient: ProofApiClient | undefined;
  private readonly rootChainDefaultBlock: BlockTag;
  private readonly logger: Logger;
  private readonly proofConcurrency: number;

  constructor(config: ExitProofBuilderConfig) {
    this.#rootChainCaller = config.rootChainCaller;
    this.childClient = config.childClient;
    this.proofApiClient = config.proofApiClient;
    this.rootChainDefaultBlock = config.rootChainDefaultBlock ?? DEFAULT_ROOT_CHAIN_BLOCK;
    this.logger = config.logger;
    this.proofConcurrency = config.proofConcurrency;
  }

  /**
   * Whether the block containing `burnTxHash` has been checkpointed on the
   * parent chain, and if not, whether the tx is still pending or mined and
   * waiting. Consumers building exit payloads outside the standard token
   * flows poll this first to avoid the `BurnTxNotCheckpointedError` the
   * builders throw.
   */
  async getCheckpointStatus(burnTxHash: string): Promise<CheckpointStatus> {
    const info = await this.getChainBlockInfo(burnTxHash);
    // A pending tx is in no block, so in no checkpoint.
    if (info.txBlockNumber === null) return { checkpointed: false, reason: 'pending' };
    return isCheckpointed({ ...info, txBlockNumber: info.txBlockNumber })
      ? { checkpointed: true }
      : { checkpointed: false, reason: 'not-checkpointed' };
  }

  /** Build the exit payload for `RootChainManager.exit(payload)`. */
  buildExitPayload(burnTxHash: string, eventSignature: string, isFast: boolean): Promise<string> {
    return this.buildExitPayloadInner(burnTxHash, eventSignature, isFast, 0);
  }

  /**
   * Build the exit payload for the n-th matching log in the burn tx.
   * Used by NFT transfers that emit multiple `Transfer` events under a
   * single tx hash.
   */
  buildExitPayloadOnIndex(
    burnTxHash: string,
    eventSignature: string,
    index: number,
    isFast: boolean
  ): Promise<string> {
    if (index < 0) {
      throw new NegativeIndexError('Index must not be a negative integer', { info: { index } });
    }
    return this.buildExitPayloadInner(burnTxHash, eventSignature, isFast, index);
  }

  /**
   * Build exit payloads for EVERY matching log under the burn tx
   * (`buildMultiplePayloadsForExit` equivalent). Fast path fetches the
   * pre-built array from the proof API; local path enumerates the
   * matching log indices and builds one payload per index from a single
   * receipt/block/proof reconstruction.
   */
  async buildExitPayloads(
    burnTxHash: string,
    eventSignature: string,
    isFast = false
  ): Promise<string[]> {
    if (isFast) {
      // Fast path still REQUIRES the proof API to be configured (0.x
      // parity: `if (isFast && !service.network) throw ProofAPINotSet`) —
      // but an API that is configured and then FAILS falls back to local
      // construction, exactly as 0.x's `getExitProofFromAPI` did. A proof
      // API outage degrades fast exits to slow ones instead of breaking
      // withdrawals outright.
      const client = this.requireProofApiClient();
      try {
        return await client.getAllExitPayloads(burnTxHash, eventSignature);
      } catch (err) {
        this.logger.warn(
          { err, burnTxHash },
          'all-exit-payloads API failed; falling back to local construction'
        );
      }
    }

    const inputs = await this.buildLocalPayloadInputs(burnTxHash);
    const logIndices = getAllLogIndices(eventSignature, inputs.receipt);
    return encodePayloadsForIndices(inputs, logIndices);
  }

  /**
   * Read the burn receipt and the checkpoint state. `receipt` is `undefined`
   * while the burn is still pending: it exists but is in no block yet, so
   * it is not checkpointed. A tx the node does not know at all still
   * rejects with `TransactionNotFoundError`, as that is a bad reference and
   * not a status.
   */
  async readBurn(
    burnTxHash: string
  ): Promise<{ receipt: ITransactionReceipt | undefined; checkpointed: boolean }> {
    const [lastChildBlock, receipt] = await Promise.all([
      this.#rootChainCaller.read('getLastChildBlock', [], {
        blockTag: this.rootChainDefaultBlock
      }),
      this.receiptOrPending(burnTxHash)
    ]);
    if (receipt === undefined) return { receipt, checkpointed: false };
    return {
      receipt,
      checkpointed: isCheckpointed({
        lastChildBlock,
        txBlockNumber: receipt.blockNumber
      })
    };
  }

  /**
   * The child-chain receipt, or `undefined` when the tx is pending (a node
   * has no receipt for a pending tx, same as for an unknown one). The
   * `getTransaction` lookup tells the two apart and rejects with
   * `TransactionNotFoundError` for an unknown tx.
   */
  private async receiptOrPending(txHash: string): Promise<ITransactionReceipt | undefined> {
    try {
      return await this.childClient.getTransactionReceipt(txHash);
    } catch (err) {
      if (!(err instanceof TransactionNotFoundError)) throw err;
      const tx = await this.childClient.getTransaction(txHash);
      if (tx.blockNumber === null) return undefined;
      throw err;
    }
  }

  // ---- internals --------------------------------------------------------

  private requireProofApiClient(): ProofApiClient {
    if (this.proofApiClient === undefined) {
      throw new ProofApiNotSetError(
        'Proof api is not set, please set it before invoking the fast-exit path'
      );
    }
    return this.proofApiClient;
  }

  private async buildExitPayloadInner(
    burnTxHash: string,
    logEventSig: string,
    isFast: boolean,
    index: number
  ): Promise<string> {
    if (isFast) {
      // Single fast-path payload: the API returns the fully-built payload
      // for the requested token index, matching the 0.x `getExitProofFromAPI`
      // shape. The fast path still REQUIRES the proof API to be configured
      // (0.x parity) — but an API that is configured and then FAILS falls
      // back to local construction, exactly as 0.x's `getExitProofFromAPI`
      // `.catch(() => buildPayloadForExit(..., false))` did. A proof API
      // outage degrades fast exits to slow ones instead of breaking
      // withdrawals outright.
      const client = this.requireProofApiClient();
      try {
        return await client.getExitPayload(burnTxHash, logEventSig, index > 0 ? index : undefined);
      } catch (err) {
        this.logger.warn(
          { err, burnTxHash },
          'exit-payload API failed; falling back to local construction'
        );
      }
    }

    const inputs = await this.buildLocalPayloadInputs(burnTxHash);

    let logIndex: number;
    if (index > 0) {
      const logIndices = getAllLogIndices(logEventSig, inputs.receipt);
      if (index >= logIndices.length) {
        throw new IndexOutOfBoundsError(
          'Index is greater than the number of tokens in this transaction',
          { info: { index, available: logIndices.length } }
        );
      }
      logIndex = logIndices[index] as number;
    } else {
      logIndex = getLogIndex(logEventSig, inputs.receipt);
    }

    return encodePayloadFromInputs(inputs, logIndex);
  }

  /**
   * Reconstruct everything the encoder needs for the LOCAL path: receipt,
   * block, root-block info, block proof, and receipt proof.
   *
   * When a proof-API client is configured the slow path prefers the API
   * for two sub-steps (mirroring 0.x `exit_util.ts` lines ~190-237's
   * `getRootBlockInfoFromAPI` / `getBlockProofFromAPI`):
   *  - `getBlockIncluded` instead of the on-chain `findCheckpointSlot`
   *    + `headerBlocks` lookup;
   *  - `getFastMerkleProof` instead of local `ProofUtil.buildBlockProof`.
   * Both fall back to local construction on API failure or a 404
   * "not checkpointed yet". The receipt-trie proof is always local — the
   * API has no equivalent sub-step.
   *
   * Both the single and multi builders gate on the checkpoint check here:
   * 0.x's multi builder skipped the gate only on the fast path, and the
   * fast path never reaches this method (it returns API payloads
   * directly), so the local path always gates.
   */
  private async buildLocalPayloadInputs(burnTxHash: string): Promise<LocalPayloadInputs> {
    const pendingInfo = await this.getChainBlockInfo(burnTxHash);
    if (pendingInfo.txBlockNumber === null) {
      throw new TransactionNotFoundError(`Transaction ${burnTxHash} is not yet mined`, {
        info: { transactionHash: burnTxHash }
      });
    }
    const blockInfo = { ...pendingInfo, txBlockNumber: pendingInfo.txBlockNumber };
    if (!isCheckpointed(blockInfo)) {
      throw new BurnTxNotCheckpointedError('Burn transaction has not been checkpointed as yet', {
        info: {
          burnTxHash,
          lastChildBlock: blockInfo.lastChildBlock.toString(),
          txBlockNumber: blockInfo.txBlockNumber
        }
      });
    }

    const txBlockNumber = blockInfo.txBlockNumber;
    const [receipt, block] = await Promise.all([
      this.childClient.getTransactionReceipt(burnTxHash),
      this.childClient.getBlockWithTransaction(txBlockNumber)
    ]);
    const rootBlockInfo = await this.getRootBlockInfoPreferApi(txBlockNumber);
    const blockProof = await this.buildBlockProofPreferApi(txBlockNumber, rootBlockInfo);
    const receiptProof = await ProofUtil.getReceiptProof(
      receipt,
      block,
      this.childClient,
      this.proofConcurrency
    );

    return { receipt, block, rootBlockInfo, blockProof, receiptProof, txBlockNumber };
  }

  /**
   * Prefer the proof API's `block-included` over the on-chain checkpoint
   * lookup when a client is configured; fall back to local on any API
   * failure or a not-checkpointed (`null`) response.
   */
  private async getRootBlockInfoPreferApi(txBlockNumber: number): Promise<IRootBlockInfo> {
    const client = this.proofApiClient;
    if (client === undefined) return this.getRootBlockInfo(txBlockNumber);
    try {
      const included = await client.getBlockIncluded(txBlockNumber);
      if (included === null) {
        // 404 / not-checkpointed — let the local lookup throw the precise
        // BurnTxNotCheckpointedError signal.
        return this.getRootBlockInfo(txBlockNumber);
      }
      try {
        assertCheckpointRange({
          start: included.start,
          end: included.end,
          txBlockNumber
        });
      } catch (rangeErr) {
        const invalid = CheckpointRangeInvalidError.find(rangeErr);
        if (invalid === null) throw rangeErr;
        // Surfaced as the API failing so the fallback below recomputes the
        // slot on-chain; a range that does not hold the burn is the API's
        // fault, not a condition for the consumer.
        throw new HttpRequestFailedError(
          'proof API block-included range is not a valid checkpoint for the burn block',
          { info: { field: 'range', start: invalid.info.start, end: invalid.info.end } }
        );
      }
      return {
        headerBlockNumber: included.headerBlockNumber,
        start: included.start.toString(),
        end: included.end.toString()
      };
    } catch (err) {
      this.logger.warn(
        { err, txBlockNumber },
        'block-included API failed; falling back to local lookup'
      );
      return this.getRootBlockInfo(txBlockNumber);
    }
  }

  /**
   * Prefer the proof API's `fast-merkle-proof` over local block-proof
   * construction when a client is configured; fall back to local on any
   * API failure.
   */
  private async buildBlockProofPreferApi(
    txBlockNumber: number,
    rootBlockInfo: IRootBlockInfo
  ): Promise<string> {
    const client = this.proofApiClient;
    const start = Number(rootBlockInfo.start);
    const end = Number(rootBlockInfo.end);
    if (client !== undefined) {
      try {
        return await client.getFastMerkleProof(start, end, txBlockNumber);
      } catch (err) {
        this.logger.warn(
          { err, txBlockNumber },
          'fast-merkle-proof API failed; falling back to local construction'
        );
      }
    }
    return ProofUtil.buildBlockProof(this.childClient, start, end, txBlockNumber);
  }

  private async getChainBlockInfo(
    burnTxHash: string
  ): Promise<{ lastChildBlock: bigint; txBlockNumber: number | null }> {
    const [lastChildBlock, tx] = await Promise.all([
      this.#rootChainCaller.read('getLastChildBlock', [], {
        blockTag: this.rootChainDefaultBlock
      }),
      this.childClient.getTransaction(burnTxHash)
    ]);
    return {
      lastChildBlock,
      txBlockNumber: tx.blockNumber
    };
  }

  /**
   * Read the root-block info for the checkpoint that contains
   * `txBlockNumber`. Uses `findCheckpointSlot` to binary-search for
   * the slot, then reads the slot's stored start/end pair.
   */
  private async getRootBlockInfo(txBlockNumber: number): Promise<IRootBlockInfo> {
    const blockTag = this.rootChainDefaultBlock;
    const headerBlockNumber = await findCheckpointSlot({
      childBlockNumber: BigInt(txBlockNumber),
      readCurrentHeaderBlock: () =>
        this.#rootChainCaller.read('currentHeaderBlock', [], { blockTag }),
      readHeaderBlocks: async (headerId) => {
        const [, start, end] = await this.#rootChainCaller.read('headerBlocks', [headerId], {
          blockTag
        });
        return { start, end };
      }
    });

    const [, start, end] = await this.#rootChainCaller.read('headerBlocks', [headerBlockNumber], {
      blockTag
    });
    assertCheckpointRange({ start, end, txBlockNumber });

    return {
      headerBlockNumber,
      end: end.toString(),
      start: start.toString()
    };
  }
}

/**
 * `lastChildBlock >= txBlockNumber` ⇒ the burn tx is included in a
 * checkpoint.
 */
function isCheckpointed(data: { lastChildBlock: bigint; txBlockNumber: number }): boolean {
  return data.lastChildBlock >= BigInt(data.txBlockNumber);
}

/**
 * Look up the index of the FIRST log matching the event signature in
 * the receipt. ERC-20 / ERC-721 / ERC-1155 transfers all encode the
 * burn target as the indexed `address(0)` recipient at a fixed topic
 * position, which differs across event shapes. The switch keeps the
 * matcher tight.
 */
export function getLogIndex(logEventSig: string, receipt: ITransactionReceipt): number {
  let logIndex = -1;
  switch (logEventSig.toLowerCase()) {
    case LogEventSignature.Erc20Transfer.toLowerCase():
    case LogEventSignature.Erc721TransferWithMetadata.toLowerCase():
      logIndex = (receipt.logs ?? []).findIndex(
        (log) =>
          log.topics[0]?.toLowerCase() === logEventSig.toLowerCase() &&
          log.topics[2]?.toLowerCase() === ZERO_TOPIC
      );
      break;

    case LogEventSignature.Erc1155Transfer.toLowerCase():
    case LogEventSignature.Erc1155BatchTransfer.toLowerCase():
      logIndex = (receipt.logs ?? []).findIndex(
        (log) =>
          log.topics[0]?.toLowerCase() === logEventSig.toLowerCase() &&
          log.topics[3]?.toLowerCase() === ZERO_TOPIC
      );
      break;

    default:
      logIndex = (receipt.logs ?? []).findIndex(
        (log) => log.topics[0]?.toLowerCase() === logEventSig.toLowerCase()
      );
  }
  if (logIndex < 0) {
    throw new LogNotFoundInReceiptError('Log not found in receipt', {
      info: {
        eventSignature: logEventSig,
        transactionHash: receipt.transactionHash
      }
    });
  }
  return logIndex;
}

/** Same matcher as `getLogIndex` but returns every matching index. */
export function getAllLogIndices(logEventSig: string, receipt: ITransactionReceipt): number[] {
  const logs = receipt.logs ?? [];
  const matches: number[] = [];
  switch (logEventSig.toLowerCase()) {
    case LogEventSignature.Erc20Transfer.toLowerCase():
    case LogEventSignature.Erc721TransferWithMetadata.toLowerCase():
      logs.forEach((log, index) => {
        if (
          log.topics[0]?.toLowerCase() === logEventSig.toLowerCase() &&
          log.topics[2]?.toLowerCase() === ZERO_TOPIC
        ) {
          matches.push(index);
        }
      });
      break;

    case LogEventSignature.Erc1155Transfer.toLowerCase():
    case LogEventSignature.Erc1155BatchTransfer.toLowerCase():
      logs.forEach((log, index) => {
        if (
          log.topics[0]?.toLowerCase() === logEventSig.toLowerCase() &&
          log.topics[3]?.toLowerCase() === ZERO_TOPIC
        ) {
          matches.push(index);
        }
      });
      break;

    case LogEventSignature.Erc721BatchTransfer.toLowerCase():
      // ERC-721 batch transfers are detected by looking for the
      // *underlying* ERC-20 Transfer event with the burn marker — the
      // batch event itself does not encode the burn target the same way.
      logs.forEach((log, index) => {
        if (
          log.topics[0]?.toLowerCase() === LogEventSignature.Erc20Transfer.toLowerCase() &&
          log.topics[2]?.toLowerCase() === ZERO_TOPIC
        ) {
          matches.push(index);
        }
      });
      break;

    default:
      logs.forEach((log, index) => {
        if (log.topics[0]?.toLowerCase() === logEventSig.toLowerCase()) {
          matches.push(index);
        }
      });
  }
  if (matches.length === 0) {
    throw new LogNotFoundInReceiptError('Log not found in receipt', {
      info: {
        eventSignature: logEventSig,
        transactionHash: receipt.transactionHash
      }
    });
  }
  return matches;
}

/**
 * RLP-encode the exit payload tuple. The on-chain
 * `RootChainManager.exit(payload)` ABI expects a single `bytes` argument
 * whose layout is the encoding produced here.
 */
function encodePayload(
  headerNumber: number,
  buildBlockProof: string,
  blockNumber: number,
  timestamp: number | string,
  transactionsRoot: Uint8Array,
  receiptsRoot: Uint8Array,
  receipt: Uint8Array,
  receiptParentNodes: unknown,
  path: Uint8Array,
  logIndex: number
): Hex {
  const encoded = RLP.encode([
    headerNumber,
    buildBlockProof,
    blockNumber,
    timestamp,
    BufferUtil.bufferToHex(transactionsRoot),
    BufferUtil.bufferToHex(receiptsRoot),
    BufferUtil.bufferToHex(receipt),
    BufferUtil.bufferToHex(RLP.encode(receiptParentNodes as never)),
    BufferUtil.bufferToHex(concatBytes(Uint8Array.of(0x00), path)),
    logIndex
  ]);
  return BufferUtil.bufferToHex(encoded) as Hex;
}

/** Encode the exit payload for one log index from shared local inputs. */
function encodePayloadFromInputs(inputs: LocalPayloadInputs, logIndex: number): Hex {
  return encodePayload(
    Number(inputs.rootBlockInfo.headerBlockNumber),
    inputs.blockProof,
    inputs.txBlockNumber,
    inputs.block.timestamp,
    BufferUtil.toBuffer(inputs.block.transactionsRoot),
    BufferUtil.toBuffer(inputs.block.receiptsRoot),
    ProofUtil.getReceiptBytes(inputs.receipt),
    inputs.receiptProof.parentNodes,
    inputs.receiptProof.path,
    logIndex
  );
}

/** Encode one payload per matching log index, sharing the local inputs. */
function encodePayloadsForIndices(inputs: LocalPayloadInputs, logIndices: number[]): Hex[] {
  return logIndices.map((logIndex) => encodePayloadFromInputs(inputs, logIndex));
}
