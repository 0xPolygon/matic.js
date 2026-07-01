/**
 * `ERC721` — typed wrapper around the bridge's child-chain ERC-721
 * surface plus the deposit / withdraw flows.
 *
 * Composes a `ContractCaller` plus the `POSBridgeHelpers` /
 * `RootChainManager` services. The legacy inheritance chain is gone.
 *
 * The commented-out batch-exit block from the legacy class
 * (years-stale half-implementation) is dropped here.
 */

import type { Adapter, Hex, PreparedTx, TxResult } from '../adapter.js';
import type {ContractCallerOptions} from '../internal/contract-caller.js';
import type { POSBridgeHelpers } from '../internal/pos-bridge-helpers.js';
import type { Logger } from '../logger.js';
import type { RootChainManager } from './root_chain_manager.js';

import { ChildERC721ABI } from '../abi/index.js';
import { LogEventSignature } from '../constant.js';
import { POSBridgeError } from '../errors.js';
import { ContractCaller  } from '../internal/contract-caller.js';

export interface ERC721Config {
  tokenAddress: Hex;
  isParent: boolean;
  adapter: Adapter;
  bridge: POSBridgeHelpers;
  rootChainManager: RootChainManager;
  parentAdapter: Adapter;
  encodeParameters: (params: readonly unknown[], types: readonly string[]) => string;
  logger: Logger;
  defaultFrom?: Hex;
}

const MAX_BATCH_SIZE = 20;

export class ERC721 {
  readonly #caller: ContractCaller;
  readonly #tokenAddress: Hex;
  readonly #isParent: boolean;
  readonly #bridge: POSBridgeHelpers;
  readonly #rootChainManager: RootChainManager;
  readonly #encodeParameters: (
    params: readonly unknown[],
    types: readonly string[]
  ) => string;

  constructor(config: ERC721Config) {
    this.#tokenAddress = config.tokenAddress;
    this.#isParent = config.isParent;
    this.#bridge = config.bridge;
    this.#rootChainManager = config.rootChainManager;
    this.#encodeParameters = config.encodeParameters;
    this.#caller = new ContractCaller({
      adapter: config.adapter,
      getAddress: () => Promise.resolve(config.tokenAddress),
      abi: ChildERC721ABI,
      isParent: config.isParent,
      logger: config.logger,
      defaultFrom: config.defaultFrom
    });
  }

  /** Number of tokens owned by `userAddress`. */
  async getTokensCount(userAddress: string, options?: ContractCallerOptions): Promise<number> {
    const v = await this.#caller.read<bigint | string>('balanceOf', [userAddress], options);
    return Number(v);
  }

  /**
   * Token id at index `index` of `userAddress`'s holdings. Used to
   * paginate through all token ids without precomputing them on the
   * client.
   */
  async getTokenIdAtIndexForUser(
    index: number,
    userAddress: string,
    options?: ContractCallerOptions
  ): Promise<bigint> {
    const v = await this.#caller.read<bigint | string>(
      'tokenOfOwnerByIndex',
      [userAddress, index],
      options
    );
    return BigInt(v);
  }

  /**
   * Fetch every token id owned by `userAddress`, capped at `limit`.
   * Each token is fetched serially; for very large holdings (>1000)
   * consider stepping through the index manually.
   */
  async getAllTokens(userAddress: string, limit = Infinity): Promise<bigint[]> {
    const rawCount = await this.getTokensCount(userAddress);
    let count = Number(rawCount);
    if (count > limit) {
      count = limit;
    }
    const out: bigint[] = [];
    for (let i = 0; i < count; i++) {
      out.push(await this.getTokenIdAtIndexForUser(i, userAddress));
    }
    return out;
  }

  /** True iff the bridge's predicate is approved for `tokenId`. */
  async isApproved(tokenId: bigint, options?: ContractCallerOptions): Promise<boolean> {
    this.#requireParent('isApproved');
    const [approved, predicate] = await Promise.all([
      this.#caller.read<string>('getApproved', [tokenId], options),
      this.#bridge.getPredicateAddress(this.#tokenAddress)
    ]);
    return approved.toLowerCase() === predicate.toLowerCase();
  }

  /** True iff the bridge's predicate has operator-level approval. */
  isApprovedAll(userAddress: string, options?: ContractCallerOptions): Promise<boolean> {
    this.#requireParent('isApprovedAll');
    return this.#bridge.getPredicateAddress(this.#tokenAddress).then((predicate) =>
      this.#caller.read<boolean>('isApprovedForAll', [userAddress, predicate], options)
    );
  }

  /** Approve the predicate to move `tokenId`. */
  approve(tokenId: bigint, options: ContractCallerOptions = {}): Promise<TxResult> {
    this.#requireParent('approve');
    return this.#bridge.getPredicateAddress(this.#tokenAddress).then((predicate) =>
      this.#caller.write('approve', [predicate, tokenId], options)
    );
  }

  /** Same as {@link approve} but returns the unsigned `{ to, data, value? }`. */
  prepareApprove(tokenId: bigint, options: ContractCallerOptions = {}): Promise<PreparedTx> {
    this.#requireParent('approve');
    return this.#bridge.getPredicateAddress(this.#tokenAddress).then((predicate) =>
      this.#caller.prepareWrite('approve', [predicate, tokenId], options)
    );
  }

  /** Operator-level `setApprovalForAll(predicate, true)`. */
  approveAll(options: ContractCallerOptions = {}): Promise<TxResult> {
    this.#requireParent('approveAll');
    return this.#bridge.getPredicateAddress(this.#tokenAddress).then((predicate) =>
      this.#caller.write('setApprovalForAll', [predicate, true], options)
    );
  }

  /** Same as {@link approveAll} but returns the unsigned `{ to, data, value? }`. */
  prepareApproveAll(options: ContractCallerOptions = {}): Promise<PreparedTx> {
    this.#requireParent('approveAll');
    return this.#bridge.getPredicateAddress(this.#tokenAddress).then((predicate) =>
      this.#caller.prepareWrite('setApprovalForAll', [predicate, true], options)
    );
  }

  /** Bridge-deposit a single token. Parent-chain only. */
  deposit(
    tokenId: bigint,
    userAddress: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireParent('deposit');
    const amountInABI = this.#encodeParameters([tokenId], ['uint256']);
    return this.#rootChainManager.deposit(userAddress, this.#tokenAddress, amountInABI, options);
  }

  /** Same as {@link deposit} but returns the unsigned `{ to, data, value? }`. */
  prepareDeposit(
    tokenId: bigint,
    userAddress: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    this.#requireParent('deposit');
    const amountInABI = this.#encodeParameters([tokenId], ['uint256']);
    return this.#rootChainManager.prepareDeposit(userAddress, this.#tokenAddress, amountInABI, options);
  }

  /** Bridge-deposit up to 20 tokens. Parent-chain only. */
  depositMany(
    tokenIds: bigint[],
    userAddress: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireParent('depositMany');
    this.#validateBatch(tokenIds);
    const amountInABI = this.#encodeParameters([tokenIds], ['uint256[]']);
    return this.#rootChainManager.deposit(userAddress, this.#tokenAddress, amountInABI, options);
  }

  /** Same as {@link depositMany} but returns the unsigned `{ to, data, value? }`. */
  prepareDepositMany(
    tokenIds: bigint[],
    userAddress: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    this.#requireParent('depositMany');
    this.#validateBatch(tokenIds);
    const amountInABI = this.#encodeParameters([tokenIds], ['uint256[]']);
    return this.#rootChainManager.prepareDeposit(userAddress, this.#tokenAddress, amountInABI, options);
  }

  /** Burn `tokenId` on the child chain to start a withdrawal. */
  startWithdraw(tokenId: bigint, options: ContractCallerOptions = {}): Promise<TxResult> {
    this.#requireChild('startWithdraw');
    return this.#caller.write('withdraw', [tokenId], options);
  }

  /** Same as {@link startWithdraw} but returns the unsigned `{ to, data, value? }`. */
  prepareStartWithdraw(tokenId: bigint, options: ContractCallerOptions = {}): Promise<PreparedTx> {
    this.#requireChild('startWithdraw');
    return this.#caller.prepareWrite('withdraw', [tokenId], options);
  }

  /** Burn-with-metadata variant — used when the on-chain token has
   *  per-instance metadata that should travel with the bridge exit. */
  startWithdrawWithMetaData(
    tokenId: bigint,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireChild('startWithdrawWithMetaData');
    return this.#caller.write('withdrawWithMetadata', [tokenId], options);
  }

  /** Same as {@link startWithdrawWithMetaData} but returns the unsigned `{ to, data, value? }`. */
  prepareStartWithdrawWithMetaData(
    tokenId: bigint,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    this.#requireChild('startWithdrawWithMetaData');
    return this.#caller.prepareWrite('withdrawWithMetadata', [tokenId], options);
  }

  /** Burn up to 20 tokens in a single tx. */
  startWithdrawMany(
    tokenIds: bigint[],
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireChild('startWithdrawMany');
    this.#validateBatch(tokenIds);
    return this.#caller.write('withdrawBatch', [tokenIds], options);
  }

  /** Same as {@link startWithdrawMany} but returns the unsigned `{ to, data, value? }`. */
  prepareStartWithdrawMany(
    tokenIds: bigint[],
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    this.#requireChild('startWithdrawMany');
    this.#validateBatch(tokenIds);
    return this.#caller.prepareWrite('withdrawBatch', [tokenIds], options);
  }

  /** Submit the exit payload (slow path). */
  async completeWithdraw(
    burnTransactionHash: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireParent('completeWithdraw');
    const payload = await this.#bridge.buildExitPayload(
      burnTransactionHash,
      LogEventSignature.Erc721Transfer,
      false
    );
    return this.#rootChainManager.exit(payload, options);
  }

  /** Same as {@link completeWithdraw} but returns the unsigned `{ to, data, value? }`. */
  async prepareCompleteWithdraw(
    burnTransactionHash: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    this.#requireParent('completeWithdraw');
    const payload = await this.#bridge.buildExitPayload(
      burnTransactionHash,
      LogEventSignature.Erc721Transfer,
      false
    );
    return this.#rootChainManager.prepareExit(payload, options);
  }

  /** Submit the exit payload for the n-th matching log. */
  async completeWithdrawOnIndex(
    burnTransactionHash: string,
    index: number,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireParent('completeWithdrawOnIndex');
    const payload = await this.#bridge.buildExitPayloadOnIndex(
      burnTransactionHash,
      LogEventSignature.Erc721Transfer,
      index,
      false
    );
    return this.#rootChainManager.exit(payload, options);
  }

  /** Same as {@link completeWithdrawOnIndex} but returns the unsigned `{ to, data, value? }`. */
  async prepareCompleteWithdrawOnIndex(
    burnTransactionHash: string,
    index: number,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    this.#requireParent('completeWithdrawOnIndex');
    const payload = await this.#bridge.buildExitPayloadOnIndex(
      burnTransactionHash,
      LogEventSignature.Erc721Transfer,
      index,
      false
    );
    return this.#rootChainManager.prepareExit(payload, options);
  }

  /** Submit the exit payload (fast path via proof API). */
  async completeWithdrawFast(
    burnTransactionHash: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireParent('completeWithdrawFast');
    const payload = await this.#bridge.buildExitPayload(
      burnTransactionHash,
      LogEventSignature.Erc721Transfer,
      true
    );
    return this.#rootChainManager.exit(payload, options);
  }

  /** Same as {@link completeWithdrawFast} but returns the unsigned `{ to, data, value? }`. */
  async prepareCompleteWithdrawFast(
    burnTransactionHash: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    this.#requireParent('completeWithdrawFast');
    const payload = await this.#bridge.buildExitPayload(
      burnTransactionHash,
      LogEventSignature.Erc721Transfer,
      true
    );
    return this.#rootChainManager.prepareExit(payload, options);
  }

  /** True iff a single-token exit has been processed. */
  isWithdrawExited(txHash: string): Promise<boolean> {
    return this.#bridge.isWithdrawn(txHash, LogEventSignature.Erc721Transfer);
  }

  /** True iff a batch-transfer exit has been processed. */
  isWithdrawExitedMany(txHash: string): Promise<boolean> {
    return this.#bridge.isWithdrawn(txHash, LogEventSignature.Erc721BatchTransfer);
  }

  /** True iff the n-th matching log under `txHash` has been exited. */
  isWithdrawExitedOnIndex(txHash: string, index: number): Promise<boolean> {
    return this.#bridge.isWithdrawnOnIndex(
      txHash,
      index,
      LogEventSignature.Erc721Transfer
    );
  }

  /**
   * Standard ERC-721 `transferFrom(from, to, tokenId)`. Works on
   * both parent and child chains.
   */
  transfer(
    tokenId: bigint,
    from: string,
    to: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    return this.#caller.write('transferFrom', [from, to, tokenId], options);
  }

  /** Same as {@link transfer} but returns the unsigned `{ to, data, value? }`. */
  prepareTransfer(
    tokenId: bigint,
    from: string,
    to: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return this.#caller.prepareWrite('transferFrom', [from, to, tokenId], options);
  }

  // --- guards ------------------------------------------------------------

  #validateBatch(tokenIds: readonly bigint[]): void {
    if (tokenIds.length > MAX_BATCH_SIZE) {
      throw new POSBridgeError(
        'BATCH_SIZE_LIMIT_EXCEEDED',
        `cannot process more than ${MAX_BATCH_SIZE} tokens in a single transaction`,
        { count: tokenIds.length, max: MAX_BATCH_SIZE }
      );
    }
  }

  #requireParent(action: string): void {
    if (!this.#isParent) {
      throw new POSBridgeError(
        'UNSUPPORTED_NETWORK',
        `${action} is allowed only on the parent (root) chain`,
        { action, isParent: this.#isParent, tokenAddress: this.#tokenAddress }
      );
    }
  }

  #requireChild(action: string): void {
    if (this.#isParent) {
      throw new POSBridgeError(
        'UNSUPPORTED_NETWORK',
        `${action} is allowed only on the child chain`,
        { action, isParent: this.#isParent, tokenAddress: this.#tokenAddress }
      );
    }
  }
}
