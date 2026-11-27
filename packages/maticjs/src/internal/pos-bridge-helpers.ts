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

import type { RootChainABI } from '../abi/RootChain.js';
import type { RootChainManagerABI } from '../abi/RootChainManager.js';
import type {
  Adapter,
  BlockTag,
  Hex,
  PreparedTx,
  Receipt,
  ReceiptLog,
  TxResult
} from '../adapter.js';
import type { ITransactionReceipt } from '../interfaces/index.js';
import type { Logger } from '../logger.js';
import type { CheckpointStatus, DepositStatus } from '../pos/bridge-status.js';
import type { WithdrawStatus } from '../pos/withdraw-status.js';
import type { WriteCall } from './abi-types.js';
import type { ContractCallerOptions } from './contract-caller.js';
import type { BridgeChildClient } from './exit-proof.js';
import type { ProofApiClient } from './proof-api-client.js';

import { FailedStateSyncHashesABI, ReplayFailedStateSyncABI } from '../abi/failed-state-sync.js';
import { StateReceiverABI } from '../abi/StateReceiver.js';
import { LogEventSignature } from '../constant.js';
import {
  DepositNotReplayableError,
  IndexOutOfBoundsError,
  InvalidTokenTypeError,
  NegativeIndexError,
  StateSyncedEventNotFoundError,
  UntrustedPredicateError,
  TransactionHashRequiredError,
  TransactionNotFoundError
} from '../errors.js';
import { STATE_RECEIVER_ADDRESS } from '../networks.js';
import { BufferUtil } from '../utils/buffer-utils.js';
import { concatBytes } from '../utils/bytes.js';
import { ProofUtil } from '../utils/proof_util.js';
import { decodeBytesParameter, encodeAbiParameters } from './abi-encode.js';
import { withConcurrency } from './concurrency.js';
import { ContractCaller } from './contract-caller.js';
import { ExitProofBuilder, getAllLogIndices, getLogIndex, ZERO_TOPIC } from './exit-proof.js';

// The checkpoint-range guard and the child-client shape moved with the exit
// proof construction; they stay importable from here for existing callers.
export { assertCheckpointRange, MAX_CHECKPOINT_BLOCKS } from './exit-proof.js';
export type { BridgeChildClient } from './exit-proof.js';

// The child `StateReceiver` is read and replayed through one caller, over the
// generated ABI plus the two hand-carried fragments. The caller's types are
// derived from this one value, so they follow the spread if it changes.
const STATE_RECEIVER_ABI = [
  ...StateReceiverABI,
  ...FailedStateSyncHashesABI,
  ...ReplayFailedStateSyncABI
] as const;
type StateReceiverAbi = typeof STATE_RECEIVER_ABI;

export interface POSBridgeHelpersConfig {
  /**
   * The on-chain `RootChainManager` contract on the parent chain.
   * Used for predicate lookups (`tokenToType` / `typeToPredicate`)
   * and exit-status reads (`processedExits`).
   */
  rootChainManagerCaller: ContractCaller<typeof RootChainManagerABI>;
  /**
   * The on-chain `RootChain` contract on the parent chain. Used for
   * `findRootBlockFromChild` during exit-payload construction.
   */
  rootChainCaller: ContractCaller<typeof RootChainABI>;
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

export class POSBridgeHelpers {
  readonly #rootChainManagerCaller: ContractCaller<typeof RootChainManagerABI>;
  private readonly childClient: BridgeChildClient;
  private readonly childAdapter: Adapter;
  private readonly parentAdapter: Adapter;
  readonly #stateReceiverCaller: ContractCaller<StateReceiverAbi>;
  private readonly exitProof: ExitProofBuilder;
  private readonly proofConcurrency: number;
  private readonly getTrustedPredicates: () => Promise<readonly string[]>;
  private readonly predicateCache = new Map<string, Promise<string>>();

  constructor(config: POSBridgeHelpersConfig) {
    this.#rootChainManagerCaller = config.rootChainManagerCaller;
    this.childClient = config.childClient;
    this.childAdapter = config.childAdapter;
    this.parentAdapter = config.parentAdapter;
    this.#stateReceiverCaller = new ContractCaller({
      adapter: config.childAdapter,
      getAddress: () => Promise.resolve(STATE_RECEIVER_ADDRESS),
      abi: STATE_RECEIVER_ABI,
      isParent: false,
      logger: config.logger,
      chainId: config.childChainId
    });
    this.exitProof = new ExitProofBuilder({
      rootChainCaller: config.rootChainCaller,
      childClient: config.childClient,
      proofApiClient: config.proofApiClient,
      rootChainDefaultBlock: config.rootChainDefaultBlock,
      logger: config.logger,
      proofConcurrency: config.proofConcurrency
    });
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
      const tokenType = await this.#rootChainManagerCaller.read('tokenToType', [tokenAddress]);
      if (tokenType === ZERO_TOPIC) {
        throw new InvalidTokenTypeError(
          `Token ${tokenAddress} is not registered with the RootChainManager`,
          { info: { tokenAddress } }
        );
      }
      const predicate = await this.#rootChainManagerCaller.read('typeToPredicate', [tokenType]);
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

  /** {@link ExitProofBuilder.getCheckpointStatus} */
  getCheckpointStatus(burnTxHash: string): Promise<CheckpointStatus> {
    return this.exitProof.getCheckpointStatus(burnTxHash);
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

  /** {@link ExitProofBuilder.buildExitPayload} */
  buildExitPayload(burnTxHash: string, eventSignature: string, isFast: boolean): Promise<string> {
    return this.exitProof.buildExitPayload(burnTxHash, eventSignature, isFast);
  }

  /** {@link ExitProofBuilder.buildExitPayloadOnIndex} */
  buildExitPayloadOnIndex(
    burnTxHash: string,
    eventSignature: string,
    index: number,
    isFast: boolean
  ): Promise<string> {
    return this.exitProof.buildExitPayloadOnIndex(burnTxHash, eventSignature, index, isFast);
  }

  /** {@link ExitProofBuilder.buildExitPayloads} */
  buildExitPayloads(burnTxHash: string, eventSignature: string, isFast = false): Promise<string[]> {
    return this.exitProof.buildExitPayloads(burnTxHash, eventSignature, isFast);
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
    const call = await this.replayCallOf(depositTxHash);
    return this.#stateReceiverCaller.write(call, options);
  }

  /** The unsigned `{ to, data }` of {@link replayDeposit}; reads the chain to build it. */
  async prepareReplayDeposit({
    depositTxHash,
    options
  }: {
    depositTxHash: string;
    options: ContractCallerOptions;
  }): Promise<PreparedTx> {
    const call = await this.replayCallOf(depositTxHash);
    return this.#stateReceiverCaller.prepareWrite(call, options);
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
    const stateReceiverCaller = this.#stateReceiverCaller;
    const [receipt, lastStateId] = await Promise.all([
      this.parentAdapter.getTransactionReceipt(depositTxHash),
      stateReceiverCaller.read('lastStateId', [])
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
    if (lastStateId < stateSync.stateId)
      return { status: { deposited: false, reason: 'not-synced' }, payload: undefined };

    const [storedHash, storedPayload] = await Promise.all([
      stateReceiverCaller.read('failedStateSyncHashes', [stateSync.stateId]),
      stateReceiverCaller.read('failedStateSyncs', [stateSync.stateId])
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
  private async replayCallOf(depositTxHash: string): Promise<WriteCall<StateReceiverAbi>> {
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
    const { receipt, checkpointed } = await this.exitProof.readBurn(burnTxHash);
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
      (await this.#rootChainManagerCaller.read('processedExits', [exitHash])) ? EXITED : NOT_EXITED
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
}

const PENDING: WithdrawStatus = { exited: false, reason: 'pending' };
const NOT_CHECKPOINTED: WithdrawStatus = { exited: false, reason: 'not-checkpointed' };
const NOT_EXITED: WithdrawStatus = { exited: false, reason: 'not-exited' };
const EXITED: WithdrawStatus = { exited: true };

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
