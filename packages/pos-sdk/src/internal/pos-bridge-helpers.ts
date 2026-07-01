/**
 * `POSBridgeHelpers` is the composition replacement for the legacy
 * `ExitUtil` + `POSToken` mix-in. It owns the small set of read-only
 * bridge primitives every concrete token class needs:
 *
 * - `getPredicateAddress(token)` — root-chain predicate lookup
 * - `isWithdrawn(burnTxHash, eventSig)` — completed-exit check
 * - `buildExitPayload(burnTxHash, eventSig, isFast)` — exit payload
 *   for `RootChainManager.exit(...)`
 * - the indexed variants `isWithdrawnOnIndex` / `buildExitPayloadOnIndex`
 *
 * # Why this lives in `internal/`
 *
 * Consumers don't need to construct one of these directly — `POSClient`
 * (Stage 3) wires it up internally and the token classes pull what they
 * need from it. Keeping it under `internal/` documents the boundary.
 *
 * # Why the constructor takes more than a minimal shape
 *
 * The proof-payload work that used to live in `ExitUtil` requires
 * several capabilities to function: `findRootBlockFromChild` reads from
 * the RootChain contract on L1, proof generation walks the matic-chain
 * (L2) RPC, and `isDeposited` reads the child `StateReceiver` plus the
 * parent-chain deposit receipt. The constructor accepts those
 * dependencies as named fields rather than smuggling them in via a
 * single grab-bag — the explicit shape makes the wiring legible.
 *
 * # Proof API is opt-in
 *
 * `proofApiClient` is the concrete (internal) `ProofApiClient`, built
 * from `proofGenerationApiUrl` in `POSClient.init`. When `undefined`
 * (no URL configured) the fast-exit path throws
 * `POSBridgeError('PROOF_API_NOT_SET')` and every payload is built
 * locally. The URL is set once at init — there is no runtime setter.
 */

import rlp from 'rlp';

import type { Adapter, BlockTag, Hex } from '../adapter.js';
import type {
  IBlockWithTransaction,
  IRootBlockInfo,
  ITransactionReceipt
} from '../interfaces/index.js';
import type { Logger } from '../logger.js';
import type {ProofChildClient} from '../utils/proof_util.js';
import type { ProofApiClient } from './proof-api-client.js';

import { StateReceiverABI } from '../abi/index.js';
import { LogEventSignature } from '../constant.js';
import { POSBridgeError } from '../errors.js';
import { STATE_RECEIVER_ADDRESS } from '../networks.js';
import { findCheckpointSlot } from '../pos/find_checkpoint_slot.js';
import { BufferUtil } from '../utils/buffer-utils.js';
import { concatBytes } from '../utils/bytes.js';
import { ProofUtil  } from '../utils/proof_util.js';
import { ContractCaller } from './contract-caller.js';

/**
 * Extended child-chain client that the proof builders need beyond what
 * the bare `ProofChildClient` covers — block lookups (for the
 * receipts-trie input) and tx-hash → blockNumber lookups (for the
 * starting-point of `getRootBlockInfo`).
 *
 * Stage 4 wires viem / ethers v5 / ethers v6 implementations into this
 * surface. Stage 2 only requires that the type-checker is happy: the
 * implementations are `unknown` until then.
 */
export interface BridgeChildClient extends ProofChildClient {
  /** Resolve a tx hash to its blockNumber. */
  getTransaction(hash: string): Promise<{ blockNumber: number }>;
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

export interface POSBridgeHelpersConfig {
  /**
   * The on-chain `RootChainManager` contract on the parent chain.
   * Used for predicate lookups (`tokenToType` / `typeToPredicate`)
   * and exit-status reads (`processedExits`).
   */
  rootChainManagerCaller: ContractCaller;
  /**
   * The on-chain `RootChain` contract on the parent chain. Used for
   * `findRootBlockFromChild` during exit-payload construction.
   */
  rootChainCaller: ContractCaller;
  /** Matic (child) chain client for receipt / block / proof reads. */
  childClient: BridgeChildClient;
  /**
   * Child-chain adapter. Used by `isDeposited` to read
   * `StateReceiver.lastStateId()` at the fixed genesis address.
   */
  childAdapter: Adapter;
  /**
   * Parent-chain adapter. Used by `isDeposited` to fetch the deposit
   * transaction's receipt — the `StateSynced` event is emitted on the
   * PARENT chain by the StateSender during a deposit.
   */
  parentAdapter: Adapter;
  /**
   * Concrete proof-API client, built from `proofGenerationApiUrl` in
   * `POSClient.init`. `undefined` means no URL was configured: the
   * fast-exit path throws `POSBridgeError('PROOF_API_NOT_SET')` and all
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
   * locally. Polygon mainnet blocks can hit 280+ transactions; firing
   * all of them at once trips RPC rate limits.
   */
  proofConcurrency: number;
}

const DEFAULT_ROOT_CHAIN_BLOCK: BlockTag = 'safe';

const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';

export class POSBridgeHelpers {
  readonly #rootChainManagerCaller: ContractCaller;
  readonly #rootChainCaller: ContractCaller;
  readonly #childClient: BridgeChildClient;
  readonly #childAdapter: Adapter;
  readonly #parentAdapter: Adapter;
  readonly #proofApiClient: ProofApiClient | undefined;
  readonly #rootChainDefaultBlock: BlockTag;
  readonly #logger: Logger;
  readonly #proofConcurrency: number;

  constructor(config: POSBridgeHelpersConfig) {
    this.#rootChainManagerCaller = config.rootChainManagerCaller;
    this.#rootChainCaller = config.rootChainCaller;
    this.#childClient = config.childClient;
    this.#childAdapter = config.childAdapter;
    this.#parentAdapter = config.parentAdapter;
    this.#proofApiClient = config.proofApiClient;
    this.#rootChainDefaultBlock = config.rootChainDefaultBlock ?? DEFAULT_ROOT_CHAIN_BLOCK;
    this.#logger = config.logger;
    this.#proofConcurrency = config.proofConcurrency;
  }

  /**
   * Look up the predicate contract for a token.
   *
   * The protocol level: `RootChainManager.tokenToType(token)` returns
   * a 32-byte type discriminator (`bytes32`); that discriminator is
   * fed to `typeToPredicate(type)` to get the predicate's address.
   * Empty `tokenType` means the token is not registered with the
   * bridge — surface that as a clear `POSBridgeError`.
   */
  async getPredicateAddress(tokenAddress: string): Promise<string> {
    const tokenType = await this.#rootChainManagerCaller.read<string>(
      'tokenToType',
      [tokenAddress]
    );
    if (!tokenType || tokenType === ZERO_TOPIC) {
      throw new POSBridgeError(
        'INVALID_TOKEN_TYPE',
        `Token ${tokenAddress} is not registered with the RootChainManager`,
        { tokenAddress }
      );
    }
    return await this.#rootChainManagerCaller.read<string>('typeToPredicate', [tokenType]);
  }

  /** True iff the burn-tx's exit has been processed on the parent chain. */
  async isWithdrawn(txHash: string, eventSignature: string): Promise<boolean> {
    if (!txHash) {
      throw new POSBridgeError(
        'TRANSACTION_HASH_REQUIRED',
        'txHash not provided for isWithdrawn',
        { eventSignature }
      );
    }
    const exitHash = await this.#getExitHash(txHash, 0, eventSignature);
    return await this.#rootChainManagerCaller.read<boolean>('processedExits', [exitHash]);
  }

  /** True iff the n-th log under the burn-tx has been processed. */
  async isWithdrawnOnIndex(
    txHash: string,
    index: number,
    eventSignature: string
  ): Promise<boolean> {
    if (!txHash) {
      throw new POSBridgeError(
        'TRANSACTION_HASH_REQUIRED',
        'txHash not provided for isWithdrawnOnIndex',
        { eventSignature, index }
      );
    }
    if (index < 0) {
      throw new POSBridgeError(
        'NEGATIVE_INDEX',
        'Index must not be a negative integer',
        { index }
      );
    }
    const exitHash = await this.#getExitHash(txHash, index, eventSignature);
    return await this.#rootChainManagerCaller.read<boolean>('processedExits', [exitHash]);
  }

  /**
   * True iff the block containing `burnTxHash` has been checkpointed
   * on the parent chain. Consumers building exit payloads outside the
   * standard token-class flows poll this first to avoid the
   * `BURN_TX_NOT_CHECKPOINTED` failure.
   */
  async isCheckpointed(burnTxHash: string): Promise<boolean> {
    const info = await this.#getChainBlockInfo(burnTxHash);
    return isCheckpointed(info);
  }

  /**
   * Build a Merkle inclusion proof for `blockNumber` against the header
   * range `[start, end]`. Surfaced on the public API for consumers
   * (e.g. `proof-generation-api`) that build proofs for non-token
   * events — sync block transactions, custom bridge events, etc.
   */
  getBlockProof(
    blockNumber: number,
    range: { start: number; end: number }
  ): Promise<string> {
    return ProofUtil.buildBlockProof(this.#childClient, range.start, range.end, blockNumber);
  }

  /** Build the exit payload for `RootChainManager.exit(payload)`. */
  buildExitPayload(
    burnTxHash: string,
    eventSignature: string,
    isFast: boolean
  ): Promise<string> {
    return this.#buildExitPayloadInner(burnTxHash, eventSignature, isFast, 0);
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
      throw new POSBridgeError(
        'NEGATIVE_INDEX',
        'Index must not be a negative integer',
        { index }
      );
    }
    return this.#buildExitPayloadInner(burnTxHash, eventSignature, isFast, index);
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
      const client = this.#requireProofApiClient();
      return client.getAllExitPayloads(burnTxHash, eventSignature);
    }

    const inputs = await this.#buildLocalPayloadInputs(burnTxHash);
    const logIndices = getAllLogIndices(eventSignature, inputs.receipt);
    return encodePayloadsForIndices(inputs, logIndices);
  }

  /**
   * Restore the legacy `BridgeClient.isDeposited` check: confirm a
   * deposit's state-sync has been applied on the child chain.
   *
   * The deposit tx and its `StateSynced` event live on the PARENT chain
   * (the StateSender emits it during deposit) — so the receipt is fetched
   * from the parent adapter, matching the 0.x behaviour. `topics[1]` of
   * that log is the deposit's state id (a 32-byte uint256); the deposit
   * has landed once the child chain's `StateReceiver.lastStateId()` has
   * advanced to at least that id.
   */
  async isDeposited(depositTxHash: string): Promise<boolean> {
    const stateReceiverCaller = new ContractCaller({
      adapter: this.#childAdapter,
      getAddress: () => Promise.resolve(STATE_RECEIVER_ADDRESS),
      abi: StateReceiverABI,
      isParent: false,
      logger: this.#logger
    });

    const [receipt, lastStateId] = await Promise.all([
      this.#parentAdapter.getTransactionReceipt(depositTxHash),
      stateReceiverCaller.read<bigint | string>('lastStateId', [])
    ]);

    if (receipt === null) {
      throw new POSBridgeError(
        'TRANSACTION_HASH_REQUIRED',
        `No receipt for deposit transaction ${depositTxHash}`,
        { transactionHash: depositTxHash }
      );
    }

    const targetLog = receipt.logs.find(
      (log) => log.topics[0]?.toLowerCase() === LogEventSignature.StateSynced.toLowerCase()
    );
    if (targetLog === undefined) {
      throw new POSBridgeError(
        'STATE_SYNCED_EVENT_NOT_FOUND',
        'StateSynced event not found in the deposit receipt',
        { transactionHash: depositTxHash }
      );
    }

    const rootStateTopic = targetLog.topics[1];
    if (rootStateTopic === undefined) {
      throw new POSBridgeError(
        'STATE_SYNCED_EVENT_NOT_FOUND',
        'StateSynced event is missing its indexed state id',
        { transactionHash: depositTxHash }
      );
    }

    // A 32-byte indexed uint256 topic is just its big-endian hex — decode
    // by reading it as a bigint directly (no ABI coder needed).
    const rootStateId = BigInt(rootStateTopic);
    return BigInt(lastStateId) >= rootStateId;
  }

  // ---- internals --------------------------------------------------------

  #requireProofApiClient(): ProofApiClient {
    if (this.#proofApiClient === undefined) {
      throw new POSBridgeError(
        'PROOF_API_NOT_SET',
        'Proof api is not set, please set it before invoking the fast-exit path'
      );
    }
    return this.#proofApiClient;
  }

  async #buildExitPayloadInner(
    burnTxHash: string,
    logEventSig: string,
    isFast: boolean,
    index: number
  ): Promise<string> {
    if (isFast) {
      // Single fast-path payload: the API returns the fully-built payload
      // for the requested token index, matching the 0.x `getExitProofFromAPI`
      // shape (exit_util.ts buildPayloadForExit: `if (isFast) return
      // getExitProofFromAPI(...)`). The `tokenIndex` query selects the n-th
      // matching log server-side.
      const client = this.#requireProofApiClient();
      return client.getExitPayload(
        burnTxHash,
        logEventSig,
        index > 0 ? index : undefined
      );
    }

    const inputs = await this.#buildLocalPayloadInputs(burnTxHash);

    let logIndex: number;
    if (index > 0) {
      const logIndices = getAllLogIndices(logEventSig, inputs.receipt);
      if (index >= logIndices.length) {
        throw new POSBridgeError(
          'INDEX_OUT_OF_BOUNDS',
          'Index is greater than the number of tokens in this transaction',
          { index, available: logIndices.length }
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
   * Both the single and multi builders gate on `isCheckpointed` here:
   * 0.x's multi builder skipped the gate only on the fast path, and the
   * fast path never reaches this method (it returns API payloads
   * directly), so the local path always gates.
   */
  async #buildLocalPayloadInputs(burnTxHash: string): Promise<LocalPayloadInputs> {
    const blockInfo = await this.#getChainBlockInfo(burnTxHash);
    if (!isCheckpointed(blockInfo)) {
      throw new POSBridgeError(
        'BURN_TX_NOT_CHECKPOINTED',
        'Burn transaction has not been checkpointed as yet',
        {
          burnTxHash,
          lastChildBlock: blockInfo.lastChildBlock.toString(),
          txBlockNumber: blockInfo.txBlockNumber
        }
      );
    }

    const txBlockNumber = blockInfo.txBlockNumber;
    const [receipt, block] = await Promise.all([
      this.#childClient.getTransactionReceipt(burnTxHash),
      this.#childClient.getBlockWithTransaction(txBlockNumber)
    ]);
    const rootBlockInfo = await this.#getRootBlockInfoPreferApi(txBlockNumber);
    const blockProof = await this.#buildBlockProofPreferApi(txBlockNumber, rootBlockInfo);
    const receiptProof = await ProofUtil.getReceiptProof(
      receipt,
      block,
      this.#childClient,
      this.#proofConcurrency
    );

    return { receipt, block, rootBlockInfo, blockProof, receiptProof, txBlockNumber };
  }

  /**
   * Prefer the proof API's `block-included` over the on-chain checkpoint
   * lookup when a client is configured; fall back to local on any API
   * failure or a not-checkpointed (`null`) response.
   */
  async #getRootBlockInfoPreferApi(txBlockNumber: number): Promise<IRootBlockInfo> {
    const client = this.#proofApiClient;
    if (client === undefined) return this.#getRootBlockInfo(txBlockNumber);
    try {
      const included = await client.getBlockIncluded(txBlockNumber);
      if (included === null) {
        // 404 / not-checkpointed — let the local lookup throw the precise
        // BURN_TX_NOT_CHECKPOINTED signal.
        return this.#getRootBlockInfo(txBlockNumber);
      }
      return {
        headerBlockNumber: included.headerBlockNumber,
        start: included.start.toString(),
        end: included.end.toString()
      };
    } catch (err) {
      this.#logger.warn({ err, txBlockNumber }, 'block-included API failed; falling back to local lookup');
      return this.#getRootBlockInfo(txBlockNumber);
    }
  }

  /**
   * Prefer the proof API's `fast-merkle-proof` over local block-proof
   * construction when a client is configured; fall back to local on any
   * API failure.
   */
  async #buildBlockProofPreferApi(
    txBlockNumber: number,
    rootBlockInfo: IRootBlockInfo
  ): Promise<string> {
    const client = this.#proofApiClient;
    const start = Number(rootBlockInfo.start);
    const end = Number(rootBlockInfo.end);
    if (client !== undefined) {
      try {
        return await client.getFastMerkleProof(start, end, txBlockNumber);
      } catch (err) {
        this.#logger.warn({ err, txBlockNumber }, 'fast-merkle-proof API failed; falling back to local construction');
      }
    }
    return ProofUtil.buildBlockProof(this.#childClient, start, end, txBlockNumber);
  }

  /**
   * Compute the exit-hash for a burn tx + log index. The on-chain
   * `RootChainManager` keys `processedExits` by this hash.
   */
  async #getExitHash(
    burnTxHash: string,
    index: number,
    logEventSig: string
  ): Promise<string> {
    const [lastChildBlock, receipt] = await Promise.all([
      this.#rootChainCaller.read<bigint | string>('getLastChildBlock', [], {
        blockTag: this.#rootChainDefaultBlock
      }),
      this.#childClient.getTransactionReceipt(burnTxHash)
    ]);
    const block = await this.#childClient.getBlockWithTransaction(receipt.blockNumber);

    const checkpointed = isCheckpointed({
      lastChildBlock: BigInt(typeof lastChildBlock === 'bigint' ? lastChildBlock : lastChildBlock),
      txBlockNumber: receipt.blockNumber
    });
    if (!checkpointed) {
      throw new POSBridgeError(
        'BURN_TX_NOT_CHECKPOINTED',
        'Burn transaction has not been checkpointed as yet',
        { burnTxHash }
      );
    }

    const receiptProof = await ProofUtil.getReceiptProof(
      receipt,
      block,
      this.#childClient,
      this.#proofConcurrency
    );

    // Split each path byte into its two nibbles, each stored as a
    // single-byte value (high nibble first). The legacy code wrote this as
    // `Buffer.from('0' + (byte / 0x10).toString(16), 'hex')`, relying on
    // `Buffer.from(_, 'hex')` truncating at the first non-hex character:
    // the float `byte / 0x10` stringifies to e.g. `"0f.f"`, and the lenient
    // parse silently dropped the `.f`, yielding `Math.floor(byte / 16)`.
    // `hexToBytes` is strict and would throw, so compute the nibbles
    // directly — `byte >> 4` and `byte & 0x0f` reproduce the exact bytes.
    const nibbleArr: Uint8Array[] = [];
    receiptProof.path.forEach((byte: number) => {
      nibbleArr.push(Uint8Array.of(byte >> 4));
      nibbleArr.push(Uint8Array.of(byte & 0x0f));
    });

    let logIndex: number;
    if (index > 0) {
      const logIndices = getAllLogIndices(logEventSig, receipt);
      logIndex = logIndices[index] as number;
    } else {
      logIndex = getLogIndex(logEventSig, receipt);
    }

    return this.#childClient.soliditySha3(
      receipt.blockNumber,
      BufferUtil.bufferToHex(concatBytes(...nibbleArr)),
      logIndex
    );
  }

  async #getChainBlockInfo(
    burnTxHash: string
  ): Promise<{ lastChildBlock: bigint; txBlockNumber: number }> {
    const [lastChildBlock, tx] = await Promise.all([
      this.#rootChainCaller.read<bigint | string>('getLastChildBlock', [], {
        blockTag: this.#rootChainDefaultBlock
      }),
      this.#childClient.getTransaction(burnTxHash)
    ]);
    return {
      lastChildBlock: BigInt(lastChildBlock),
      txBlockNumber: tx.blockNumber
    };
  }

  /**
   * Read the root-block info for the checkpoint that contains
   * `txBlockNumber`. Uses `findCheckpointSlot` to binary-search for
   * the slot, then reads the slot's stored start/end pair.
   */
  async #getRootBlockInfo(txBlockNumber: number): Promise<IRootBlockInfo> {
    const blockTag = this.#rootChainDefaultBlock;
    const headerBlockNumber = await findCheckpointSlot({
      childBlockNumber: BigInt(txBlockNumber),
      readCurrentHeaderBlock: async () => {
        const v = await this.#rootChainCaller.read<bigint | string>('currentHeaderBlock', [], {
          blockTag
        });
        return BigInt(v);
      },
      readHeaderBlocks: async (headerId) => {
        const headerBlock = await this.#rootChainCaller.read<{
          start: bigint | string;
          end: bigint | string;
        }>('headerBlocks', [`0x${headerId.toString(16)}`], { blockTag });
        return {
          start: BigInt(headerBlock.start),
          end: BigInt(headerBlock.end)
        };
      }
    });

    const rootBlockInfo = await this.#rootChainCaller.read<{
      start: bigint | string;
      end: bigint | string;
    }>('headerBlocks', [`0x${headerBlockNumber.toString(16)}`], { blockTag });

    return {
      headerBlockNumber,
      end: BigInt(rootBlockInfo.end).toString(),
      start: BigInt(rootBlockInfo.start).toString()
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
function getLogIndex(logEventSig: string, receipt: ITransactionReceipt): number {
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
    throw new POSBridgeError(
      'LOG_NOT_FOUND_IN_RECEIPT',
      'Log not found in receipt',
      { eventSignature: logEventSig, transactionHash: receipt.transactionHash }
    );
  }
  return logIndex;
}

/** Same matcher as `getLogIndex` but returns every matching index. */
function getAllLogIndices(logEventSig: string, receipt: ITransactionReceipt): number[] {
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
    throw new POSBridgeError(
      'LOG_NOT_FOUND_IN_RECEIPT',
      'Log not found in receipt',
      { eventSignature: logEventSig, transactionHash: receipt.transactionHash }
    );
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
  const encoded = rlp.encode([
    headerNumber,
    buildBlockProof,
    blockNumber,
    timestamp,
    BufferUtil.bufferToHex(transactionsRoot),
    BufferUtil.bufferToHex(receiptsRoot),
    BufferUtil.bufferToHex(receipt),
    BufferUtil.bufferToHex(rlp.encode(receiptParentNodes as never)),
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
