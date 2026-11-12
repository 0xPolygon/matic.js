/**
 * `POSBridgeHelpers` is the composition replacement for the legacy
 * `ExitUtil` + `POSToken` mix-in. It owns the small set of read-only
 * bridge primitives every concrete token class needs:
 *
 * - `getPredicateAddress(token)` — root-chain predicate lookup
 * - `getWithdrawStatus(burnTxHash, eventSig)` — exit status with reason
 * - `buildExitPayload(burnTxHash, eventSig, isFast)` — exit payload
 *   for `RootChainManager.exit(...)`
 * - the indexed variants `getWithdrawStatusOnIndex` / `buildExitPayloadOnIndex`
 * - `getDepositStatus(depositTxHash)` and the recovery write beside it,
 *   `replayDeposit` / `prepareReplayDeposit` (the one write here, on the child
 *   chain's `StateReceiver`)
 *
 * # Why this lives in `internal/`
 *
 * Consumers don't need to construct one of these directly — `POSClient`
 * wires it up internally and the token classes pull what they
 * need from it. Keeping it under `internal/` documents the boundary.
 *
 * # Why the constructor takes more than a minimal shape
 *
 * The proof-payload work that used to live in `ExitUtil` requires
 * several capabilities to function: `findRootBlockFromChild` reads from
 * the RootChain contract on L1, proof generation walks the matic-chain
 * (L2) RPC, and `getDepositStatus` reads the child `StateReceiver` plus the
 * parent-chain deposit receipt. The constructor accepts those
 * dependencies as named fields rather than smuggling them in via a
 * single grab-bag — the explicit shape makes the wiring legible.
 *
 * # Proof API is opt-in
 *
 * `proofApiClient` is the concrete (internal) `ProofApiClient`, built
 * from `proofGenerationApiUrl` in `POSClient.init`. When `undefined`
 * (no URL configured) the fast-exit path throws
 * `ProofApiNotSetError` and every payload is built
 * locally. The URL is set once at init — there is no runtime setter.
 */

import { RLP } from '@ethereumjs/rlp';

import type {
  Adapter,
  BlockTag,
  Hex,
  PreparedTx,
  Receipt,
  ReceiptLog,
  TxResult
} from '../adapter.js';
import type {
  IBlockWithTransaction,
  IRootBlockInfo,
  ITransactionReceipt
} from '../interfaces/index.js';
import type { Logger } from '../logger.js';
import type { CheckpointStatus, DepositStatus } from '../pos/bridge-status.js';
import type { WithdrawStatus } from '../pos/withdraw-status.js';
import type { ProofChildClient } from '../utils/proof_util.js';
import type { ContractCallerOptions } from './contract-caller.js';
import type { ProofApiClient } from './proof-api-client.js';

import { FailedStateSyncHashesABI, ReplayFailedStateSyncABI } from '../abi/failed-state-sync.js';
import { StateReceiverABI } from '../abi/index.js';
import { LogEventSignature } from '../constant.js';
import {
  BurnTxNotCheckpointedError,
  CheckpointRangeInvalidError,
  DepositNotReplayableError,
  HttpRequestFailedError,
  IndexOutOfBoundsError,
  InvalidTokenTypeError,
  LogNotFoundInReceiptError,
  NegativeIndexError,
  ProofApiNotSetError,
  StateSyncedEventNotFoundError,
  UntrustedPredicateError,
  TransactionHashRequiredError,
  TransactionNotFoundError
} from '../errors.js';
import { STATE_RECEIVER_ADDRESS } from '../networks.js';
import { findCheckpointSlot, parseHeaderBlocksResult } from '../pos/find_checkpoint_slot.js';
import { BufferUtil } from '../utils/buffer-utils.js';
import { concatBytes } from '../utils/bytes.js';
import { MAX_CHECKPOINT_DEPTH, ProofUtil } from '../utils/proof_util.js';
import { decodeBytesParameter, encodeAbiParameters } from './abi-encode.js';
import { withConcurrency } from './concurrency.js';
import { ContractCaller } from './contract-caller.js';

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
   * Child-chain adapter. Used by `getDepositStatus` to read
   * `StateReceiver.lastStateId()` at the fixed genesis address.
   */
  childAdapter: Adapter;
  /**
   * Parent-chain adapter. Used by `getDepositStatus` to fetch the deposit
   * transaction's receipt — the `StateSynced` event is emitted on the
   * PARENT chain by the StateSender during a deposit.
   */
  parentAdapter: Adapter;
  /**
   * Pinned id of the child chain, so the replay write is checked against the
   * signer like every other bridge write.
   */
  childChainId?: number;
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
   * locally, and concurrent `processedExits` reads when checking several
   * logs of one burn. Polygon mainnet blocks can hit 280+ transactions;
   * firing all of them at once trips RPC rate limits.
   */
  proofConcurrency: number;
  /**
   * The predicate addresses the active address index trusts as approval
   * spenders. `typeToPredicate` is read from an RPC, so its answer is
   * only used when it is in this set.
   */
  getTrustedPredicates: () => Promise<readonly string[]>;
}

/**
 * Largest checkpoint, in child blocks, the SDK will build a proof over.
 * Real checkpoints span a few hundred blocks; 2^16 leaves headroom for
 * any protocol change while keeping the merkle-path builder's
 * allocations bounded no matter what an RPC or proof API claims.
 */
export const MAX_CHECKPOINT_BLOCKS = 2 ** MAX_CHECKPOINT_DEPTH;

/**
 * Reject a checkpoint range that cannot be a real checkpoint of the burn:
 * inverted, not containing the burn's block, or larger than
 * {@link MAX_CHECKPOINT_BLOCKS}. The range comes from an RPC or the proof
 * API, and sizes the merkle-path allocation, so it is checked before use.
 */
export function assertCheckpointRange({
  start,
  end,
  txBlockNumber
}: {
  start: bigint;
  end: bigint;
  txBlockNumber: number;
}): void {
  const reason =
    end < start
      ? 'inverted'
      : BigInt(txBlockNumber) < start || BigInt(txBlockNumber) > end
        ? 'not-containing'
        : end - start + 1n > BigInt(MAX_CHECKPOINT_BLOCKS)
          ? 'too-large'
          : undefined;
  if (reason !== undefined) {
    throw new CheckpointRangeInvalidError(
      `checkpoint range ${start}-${end} is not a valid checkpoint for block ${txBlockNumber} (${reason})`,
      { info: { start: start.toString(), end: end.toString(), txBlockNumber, reason } }
    );
  }
}

const DEFAULT_ROOT_CHAIN_BLOCK: BlockTag = 'safe';

const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';

export class POSBridgeHelpers {
  private readonly rootChainManagerCaller: ContractCaller;
  private readonly rootChainCaller: ContractCaller;
  private readonly childClient: BridgeChildClient;
  private readonly childAdapter: Adapter;
  private readonly parentAdapter: Adapter;
  private readonly stateReceiverCaller: ContractCaller;
  private readonly proofApiClient: ProofApiClient | undefined;
  private readonly rootChainDefaultBlock: BlockTag;
  private readonly logger: Logger;
  private readonly proofConcurrency: number;
  private readonly getTrustedPredicates: () => Promise<readonly string[]>;
  private readonly predicateCache = new Map<string, Promise<string>>();

  constructor(config: POSBridgeHelpersConfig) {
    this.rootChainManagerCaller = config.rootChainManagerCaller;
    this.rootChainCaller = config.rootChainCaller;
    this.childClient = config.childClient;
    this.childAdapter = config.childAdapter;
    this.parentAdapter = config.parentAdapter;
    this.stateReceiverCaller = new ContractCaller({
      adapter: config.childAdapter,
      getAddress: () => Promise.resolve(STATE_RECEIVER_ADDRESS),
      abi: [...StateReceiverABI, ...FailedStateSyncHashesABI, ...ReplayFailedStateSyncABI],
      isParent: false,
      logger: config.logger,
      chainId: config.childChainId
    });
    this.proofApiClient = config.proofApiClient;
    this.rootChainDefaultBlock = config.rootChainDefaultBlock ?? DEFAULT_ROOT_CHAIN_BLOCK;
    this.logger = config.logger;
    this.proofConcurrency = config.proofConcurrency;
    this.getTrustedPredicates = config.getTrustedPredicates;
  }

  /**
   * Look up the predicate contract for a token.
   *
   * The protocol level: `RootChainManager.tokenToType(token)` returns
   * a 32-byte type discriminator (`bytes32`); that discriminator is
   * fed to `typeToPredicate(type)` to get the predicate's address.
   * Empty `tokenType` means the token is not registered with the
   * bridge — surface that as a clear `InvalidTokenTypeError`.
   */
  async getPredicateAddress(tokenAddress: string): Promise<string> {
    // Promise-cached per token: the default-spender `approve` /
    // `getAllowance` flows resolve the predicate on every call, and the
    // 0.x SDK cached this pair of reads — without a cache each such call
    // pays two extra RPC round-trips for a mapping that changes only on
    // a bridge redeployment (which re-registers tokens, i.e. same
    // answer). Caching the PROMISE dedupes concurrent callers; eviction
    // on failure lets the next caller retry.
    const cached = this.predicateCache.get(tokenAddress);
    if (cached !== undefined) return cached;
    const lookup = (async (): Promise<string> => {
      const tokenType = await this.rootChainManagerCaller.read<string>('tokenToType', [
        tokenAddress
      ]);
      if (!tokenType || tokenType === ZERO_TOPIC) {
        throw new InvalidTokenTypeError(
          `Token ${tokenAddress} is not registered with the RootChainManager`,
          { info: { tokenAddress } }
        );
      }
      const predicate = await this.rootChainManagerCaller.read<string>('typeToPredicate', [
        tokenType
      ]);
      // The answer came from an RPC and is about to become an approval
      // spender, so it must be one of the predicates the index publishes.
      // Thrown inside the cached promise so the eviction below clears it.
      const trusted = await this.getTrustedPredicates();
      const lower = String(predicate).toLowerCase();
      if (!trusted.some((a) => a.toLowerCase() === lower)) {
        throw new UntrustedPredicateError(
          `RootChainManager returned predicate ${String(predicate)} for ${tokenAddress}, which is not in the address index`,
          { info: { tokenAddress, predicate: String(predicate) } }
        );
      }
      return predicate;
    })().catch((err: unknown) => {
      this.predicateCache.delete(tokenAddress);
      throw err;
    });
    this.predicateCache.set(tokenAddress, lookup);
    return lookup;
  }

  /**
   * Where the burn stands: exited, checkpointed but not exited, or not yet
   * checkpointed. A burn that is not checkpointed cannot have been exited,
   * so that case is answered without computing an exit hash or reading
   * `processedExits`.
   */
  async getWithdrawStatus(txHash: string, eventSignature: string): Promise<WithdrawStatus> {
    if (!txHash) {
      throw new TransactionHashRequiredError('txHash not provided for getWithdrawStatus', {
        info: {
          eventSignature
        }
      });
    }
    const [status] = await this.readWithdrawStatuses(txHash, [0], eventSignature);
    return status ?? NOT_CHECKPOINTED;
  }

  /** {@link getWithdrawStatus} for the n-th log under the burn-tx. */
  async getWithdrawStatusOnIndex(
    txHash: string,
    index: number,
    eventSignature: string
  ): Promise<WithdrawStatus> {
    if (!txHash) {
      throw new TransactionHashRequiredError('txHash not provided for getWithdrawStatusOnIndex', {
        info: { eventSignature, index }
      });
    }
    if (index < 0) {
      throw new NegativeIndexError('Index must not be a negative integer', { info: { index } });
    }
    const [status] = await this.readWithdrawStatuses(txHash, [index], eventSignature);
    return status ?? NOT_CHECKPOINTED;
  }

  /**
   * {@link getWithdrawStatusOnIndex} for several logs of one burn, in the
   * order given. The receipt and checkpoint state are read once; only the
   * `processedExits` reads fan out, capped at `proofConcurrency`. Every
   * index is checked against the receipt before any of those reads.
   */
  async getWithdrawStatusOnIndices(
    txHash: string,
    indices: readonly number[],
    eventSignature: string
  ): Promise<WithdrawStatus[]> {
    if (!txHash) {
      throw new TransactionHashRequiredError('txHash not provided for getWithdrawStatusOnIndices', {
        info: { eventSignature, indices: [...indices] }
      });
    }
    for (const index of indices) {
      if (index < 0) {
        throw new NegativeIndexError('Index must not be a negative integer', {
          info: {
            index
          }
        });
      }
    }
    return this.readWithdrawStatuses(txHash, indices, eventSignature);
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

  /**
   * Build a Merkle inclusion proof for `blockNumber` against the header
   * range `[start, end]`. Surfaced on the public API for consumers
   * (e.g. `proof-generation-api`) that build proofs for non-token
   * events — sync block transactions, custom bridge events, etc.
   */
  getBlockProof(blockNumber: number, range: { start: number; end: number }): Promise<string> {
    return ProofUtil.buildBlockProof(this.childClient, range.start, range.end, blockNumber);
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
   * Whether a deposit's state-sync has been applied on the child chain, and
   * if not, why: still pending, mined and waiting for the sync, or delivered
   * to the state receiver but failed there.
   *
   * The deposit tx and its `StateSynced` event live on the PARENT chain
   * (the StateSender emits it during deposit) — so the receipt is fetched
   * from the parent adapter, matching the 0.x behaviour. `topics[1]` of
   * that log is the deposit's state id (a 32-byte uint256); the deposit
   * has been reached once the child chain's `StateReceiver.lastStateId()`
   * has advanced to at least that id. A reached state id is then either
   * delivered or recorded as failed: the receiver keeps either
   * `failedStateSyncHashes(stateId)` (since Uburu) or `failedStateSyncs(stateId)`
   * (before it) non-empty until the record is replayed. Both are read, in
   * parallel, because storage outlives the code swap and so the commit block
   * would be needed to pick one.
   *
   * Several `StateSynced` events in one tx: only the first is reported.
   *
   * Failures from before PIP-36 are kept in no mapping; such a deposit still
   * reads as delivered.
   */
  async getDepositStatus(depositTxHash: string): Promise<DepositStatus> {
    return (await this.readDelivery(depositTxHash)).status;
  }

  /**
   * Resend a failed delivery from the child-chain signer. The read is
   * shared with prepare so the two cannot disagree on which entry point
   * they encode; a deposit that is not `delivery-failed` and `replayable`
   * is refused here, before the wallet is touched.
   */
  async replayDeposit({
    depositTxHash,
    options
  }: {
    depositTxHash: string;
    options: ContractCallerOptions;
  }): Promise<TxResult> {
    const { method, args } = await this.replayCallOf(depositTxHash);
    return this.stateReceiverCaller.write(method, args, options);
  }

  /** The unsigned `{ to, data }` of {@link replayDeposit}; reads the chain to build it. */
  async prepareReplayDeposit({
    depositTxHash,
    options
  }: {
    depositTxHash: string;
    options: ContractCallerOptions;
  }): Promise<PreparedTx> {
    const { method, args } = await this.replayCallOf(depositTxHash);
    return this.stateReceiverCaller.prepareWrite(method, args, options);
  }

  /**
   * The status read behind {@link getDepositStatus}, plus the deposit's
   * `(receiver, data)` on the `delivery-failed` branch only (where
   * `stateSyncPayloadOf` already runs), so the not-synced and delivered
   * answers still never decode the log.
   */
  private async readDelivery(
    depositTxHash: string
  ): Promise<{ status: DepositStatus; payload: { receiver: Hex; data: Hex } | undefined }> {
    const stateReceiverCaller = this.stateReceiverCaller;
    const [receipt, lastStateId] = await Promise.all([
      this.parentAdapter.getTransactionReceipt(depositTxHash),
      stateReceiverCaller.read<bigint | string>('lastStateId', [])
    ]);

    if (receipt === null) {
      // No receipt means pending or unknown. A pending deposit has not
      // landed, which is a plain `false`; an unknown hash is a bad reference.
      const tx = await this.parentAdapter.request<{ blockNumber: string | null } | null>(
        'eth_getTransactionByHash',
        [depositTxHash]
      );
      if (tx !== null && tx.blockNumber === null)
        return { status: { deposited: false, reason: 'pending' }, payload: undefined };
      throw new TransactionNotFoundError(`No receipt for deposit transaction ${depositTxHash}`, {
        info: { transactionHash: depositTxHash }
      });
    }

    const stateSync = stateSyncOf({ receipt, depositTxHash });
    if (BigInt(lastStateId) < stateSync.stateId)
      return { status: { deposited: false, reason: 'not-synced' }, payload: undefined };

    const [storedHash, storedPayload] = await Promise.all([
      stateReceiverCaller.read<string>('failedStateSyncHashes', [stateSync.stateId]),
      stateReceiverCaller.read<string>('failedStateSyncs', [stateSync.stateId])
    ]);
    // Both empty: delivered, or replayed since. Both set is impossible by
    // construction; the hash wins so the answer is still defined.
    const hasHash = BigInt(storedHash) !== 0n;
    if (!hasHash && storedPayload === '0x') {
      return { status: { deposited: true }, payload: undefined };
    }

    const { receiver, data } = stateSyncPayloadOf({ log: stateSync.log, depositTxHash });
    const expected = this.childAdapter.keccak256(
      encodeAbiParameters([receiver, data], ['address', 'bytes'])
    );
    const stored = hasHash ? storedHash : this.childAdapter.keccak256(storedPayload);
    return {
      status: {
        deposited: false,
        reason: 'delivery-failed',
        stateId: stateSync.stateId,
        receiver,
        record: hasHash ? 'hash' : 'payload',
        replayable: expected.toLowerCase() === stored.toLowerCase()
      },
      payload: { receiver, data }
    };
  }

  /**
   * The replay call for a deposit, or `DepositNotReplayableError` when the
   * deposit is not in a replayable state.
   */
  private async replayCallOf(depositTxHash: string): Promise<{
    method: 'replayFailedStateSync' | 'replayFailedStateSyncWithData';
    args: readonly unknown[];
  }> {
    const { status, payload } = await this.readDelivery(depositTxHash);
    if (status.deposited) {
      throw new DepositNotReplayableError(
        `Deposit ${depositTxHash} has been delivered on the child chain; there is nothing to replay.`,
        { info: { transactionHash: depositTxHash, status } }
      );
    }
    if (status.reason !== 'delivery-failed') {
      throw new DepositNotReplayableError(
        status.reason === 'pending'
          ? `Deposit ${depositTxHash} is not mined yet; there is nothing to replay. Wait for it to mine, then poll getDepositStatus.`
          : `Deposit ${depositTxHash} has not reached the child chain's state receiver yet; there is nothing to replay. Poll getDepositStatus until it answers deposited or delivery-failed.`,
        { info: { transactionHash: depositTxHash, status } }
      );
    }
    if (payload === undefined) {
      // readDelivery always returns the payload on the delivery-failed branch,
      // so a miss here is an SDK bug, not a consumer condition: a plain Error
      // keeps it out of the typed classes and away from the "check the hash"
      // message below.
      throw new Error(`internal invariant: no state-sync payload for deposit ${depositTxHash}`);
    }
    if (!status.replayable) {
      throw new DepositNotReplayableError(
        `The state receiver's failed record for state id ${status.stateId} is not this deposit's receiver and payload; it cannot be replayed with this deposit's data. Check the deposit transaction hash: the record belongs to a different state sync.`,
        { info: { transactionHash: depositTxHash, status } }
      );
    }
    return status.record === 'hash'
      ? {
          method: 'replayFailedStateSyncWithData',
          args: [status.stateId, payload.receiver, payload.data]
        }
      : { method: 'replayFailedStateSync', args: [status.stateId] };
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

  /**
   * Read the burn receipt and the checkpoint state. `receipt` is `undefined`
   * while the burn is still pending: it exists but is in no block yet, so
   * it is not checkpointed. A tx the node does not know at all still
   * rejects with `TransactionNotFoundError`, as that is a bad reference and
   * not a status.
   */
  private async readBurn(
    burnTxHash: string
  ): Promise<{ receipt: ITransactionReceipt | undefined; checkpointed: boolean }> {
    const [lastChildBlock, receipt] = await Promise.all([
      this.rootChainCaller.read<bigint | string>('getLastChildBlock', [], {
        blockTag: this.rootChainDefaultBlock
      }),
      this.receiptOrPending(burnTxHash)
    ]);
    if (receipt === undefined) return { receipt, checkpointed: false };
    return {
      receipt,
      checkpointed: isCheckpointed({
        lastChildBlock: BigInt(lastChildBlock),
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

  /**
   * Status of the logs at `indices` under one burn. Not checkpointed means
   * not exited, so no exit hash is computed and `processedExits` is not
   * read. The log indices are still resolved against the receipt first, so
   * an index past the burn's last token is rejected whether or not the
   * checkpoint has landed.
   *
   * The exit hash is `keccak(blockNumber, nibbles(path), logIndex)` and the
   * path is just `RLP.encode(transactionIndex)` — the key the block's
   * receipts trie stores this receipt under — so it comes straight from the
   * receipt. Rebuilding the trie (one receipt fetch per tx in the block) is
   * only needed for the proof nodes, which the exit payload carries and the
   * exit hash does not.
   */
  private async readWithdrawStatuses(
    burnTxHash: string,
    indices: readonly number[],
    logEventSig: string
  ): Promise<WithdrawStatus[]> {
    const { receipt, checkpointed } = await this.readBurn(burnTxHash);
    if (receipt === undefined) return indices.map(() => PENDING);
    const logIndices = indices.map((index) => this.logIndexFor(receipt, index, logEventSig));
    if (!checkpointed) return indices.map(() => NOT_CHECKPOINTED);

    // Split each path byte into its two nibbles, each stored as a
    // single-byte value (high nibble first). The legacy code wrote this as
    // `Buffer.from('0' + (byte / 0x10).toString(16), 'hex')`, relying on
    // `Buffer.from(_, 'hex')` truncating at the first non-hex character:
    // the float `byte / 0x10` stringifies to e.g. `"0f.f"`, and the lenient
    // parse silently dropped the `.f`, yielding `Math.floor(byte / 16)`.
    // `hexToBytes` is strict and would throw, so compute the nibbles
    // directly — `byte >> 4` and `byte & 0x0f` reproduce the exact bytes.
    const nibbleArr: Uint8Array[] = [];
    RLP.encode(receipt.transactionIndex).forEach((byte: number) => {
      nibbleArr.push(Uint8Array.of(byte >> 4));
      nibbleArr.push(Uint8Array.of(byte & 0x0f));
    });

    const nibblePath = BufferUtil.bufferToHex(concatBytes(...nibbleArr));
    const exitHashes = logIndices.map((logIndex) =>
      this.childClient.soliditySha3(receipt.blockNumber, nibblePath, logIndex)
    );
    return withConcurrency(this.proofConcurrency, exitHashes, async (exitHash) =>
      (await this.rootChainManagerCaller.read<boolean>('processedExits', [exitHash]))
        ? EXITED
        : NOT_EXITED
    );
  }

  /** The log index of the `index`-th matching log in the receipt. */
  private logIndexFor(receipt: ITransactionReceipt, index: number, logEventSig: string): number {
    if (index > 0) {
      const logIndices = getAllLogIndices(logEventSig, receipt);
      const candidate = logIndices[index];
      if (candidate === undefined) {
        // Same upper-bounds guard as the exit-payload path — an
        // out-of-range index must fail loudly here too, not hash
        // `undefined` into the exit key.
        throw new IndexOutOfBoundsError(
          'Index is greater than the number of tokens in this transaction',
          { info: { index, available: logIndices.length } }
        );
      }
      return candidate;
    }
    return getLogIndex(logEventSig, receipt);
  }

  private async getChainBlockInfo(
    burnTxHash: string
  ): Promise<{ lastChildBlock: bigint; txBlockNumber: number | null }> {
    const [lastChildBlock, tx] = await Promise.all([
      this.rootChainCaller.read<bigint | string>('getLastChildBlock', [], {
        blockTag: this.rootChainDefaultBlock
      }),
      this.childClient.getTransaction(burnTxHash)
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
  private async getRootBlockInfo(txBlockNumber: number): Promise<IRootBlockInfo> {
    const blockTag = this.rootChainDefaultBlock;
    const headerBlockNumber = await findCheckpointSlot({
      childBlockNumber: BigInt(txBlockNumber),
      readCurrentHeaderBlock: async () => {
        const v = await this.rootChainCaller.read<bigint | string>('currentHeaderBlock', [], {
          blockTag
        });
        return BigInt(v);
      },
      readHeaderBlocks: async (headerId) => {
        const headerBlock = await this.rootChainCaller.read<unknown>(
          'headerBlocks',
          [`0x${headerId.toString(16)}`],
          { blockTag }
        );
        return parseHeaderBlocksResult(headerBlock);
      }
    });

    const rootBlockInfo = parseHeaderBlocksResult(
      await this.rootChainCaller.read<unknown>(
        'headerBlocks',
        [`0x${headerBlockNumber.toString(16)}`],
        { blockTag }
      )
    );
    assertCheckpointRange({
      start: rootBlockInfo.start,
      end: rootBlockInfo.end,
      txBlockNumber
    });

    return {
      headerBlockNumber,
      end: rootBlockInfo.end.toString(),
      start: rootBlockInfo.start.toString()
    };
  }
}

const PENDING: WithdrawStatus = { exited: false, reason: 'pending' };
const NOT_CHECKPOINTED: WithdrawStatus = { exited: false, reason: 'not-checkpointed' };
const NOT_EXITED: WithdrawStatus = { exited: false, reason: 'not-exited' };
const EXITED: WithdrawStatus = { exited: true };

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

/**
 * The first `StateSynced` event of a deposit receipt and its state id. The
 * receiver and payload are decoded separately (`stateSyncPayloadOf`) because
 * only the failed-delivery branch needs them, and a log whose payload cannot
 * be decoded must not break the not-synced and delivered answers.
 */
function stateSyncOf({ receipt, depositTxHash }: { receipt: Receipt; depositTxHash: string }): {
  stateId: bigint;
  log: ReceiptLog;
} {
  const log = receipt.logs.find(
    (l) => l.topics[0]?.toLowerCase() === LogEventSignature.StateSynced.toLowerCase()
  );
  if (log === undefined) {
    throw new StateSyncedEventNotFoundError('StateSynced event not found in the deposit receipt', {
      info: { transactionHash: depositTxHash }
    });
  }
  const stateTopic = log.topics[1];
  if (stateTopic === undefined) {
    throw new StateSyncedEventNotFoundError('StateSynced event is missing its indexed state id', {
      info: { transactionHash: depositTxHash }
    });
  }
  // A 32-byte indexed uint256 topic is just its big-endian hex.
  return { stateId: BigInt(stateTopic), log };
}

/**
 * The receiver and payload of a `StateSynced` log: exactly the arguments a
 * replay of a failed delivery resubmits.
 */
function stateSyncPayloadOf({ log, depositTxHash }: { log: ReceiptLog; depositTxHash: string }): {
  receiver: Hex;
  data: Hex;
} {
  const receiverTopic = log.topics[2];
  if (receiverTopic === undefined) {
    throw new StateSyncedEventNotFoundError('StateSynced event is missing its indexed receiver', {
      info: { transactionHash: depositTxHash }
    });
  }
  return {
    receiver: `0x${receiverTopic.slice(-40).toLowerCase()}`,
    data: decodeBytesParameter(log.data)
  };
}
