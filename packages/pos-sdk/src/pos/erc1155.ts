/**
 * `ERC1155` — typed wrapper around the bridge's child-chain ERC-1155
 * surface plus the deposit / withdraw flows.
 *
 * Composes `ContractCaller` + `POSBridgeHelpers` + `RootChainManager`.
 */

import type { Adapter, Hex, PreparedTx, TxResult } from '../adapter.js';
import type {ContractCallerOptions} from '../internal/contract-caller.js';
import type { POSBridgeHelpers } from '../internal/pos-bridge-helpers.js';
import type { Logger } from '../logger.js';
import type { RootChainManager } from './root_chain_manager.js';

import { ChildERC1155ABI } from '../abi/index.js';
import { LogEventSignature } from '../constant.js';
import { POSBridgeError } from '../errors.js';
import { ContractCaller  } from '../internal/contract-caller.js';

export interface POSERC1155DepositParam {
  tokenId: bigint;
  amount: bigint;
  userAddress: string;
  data?: string;
}

export interface POSERC1155DepositBatchParam {
  tokenIds: bigint[];
  amounts: bigint[];
  userAddress: string;
  data?: string;
}

export interface POSERC1155TransferParam {
  tokenId: bigint;
  amount: bigint;
  from: string;
  to: string;
  data?: string;
}

export interface ERC1155Config {
  tokenAddress: Hex;
  isParent: boolean;
  adapter: Adapter;
  bridge: POSBridgeHelpers;
  rootChainManager: RootChainManager;
  parentAdapter: Adapter;
  encodeParameters: (params: readonly unknown[], types: readonly string[]) => string;
  /** Optional override for the mintable-ERC-1155 predicate. */
  mintablePredicateAddress?: string;
  logger: Logger;
  defaultFrom?: Hex;
}

const EMPTY_BYTES = '0x' as const;

export class ERC1155 {
  readonly #caller: ContractCaller;
  readonly #tokenAddress: Hex;
  readonly #isParent: boolean;
  readonly #bridge: POSBridgeHelpers;
  readonly #rootChainManager: RootChainManager;
  readonly #encodeParameters: (
    params: readonly unknown[],
    types: readonly string[]
  ) => string;
  readonly #mintablePredicateAddress: string | undefined;

  constructor(config: ERC1155Config) {
    this.#tokenAddress = config.tokenAddress;
    this.#isParent = config.isParent;
    this.#bridge = config.bridge;
    this.#rootChainManager = config.rootChainManager;
    this.#encodeParameters = config.encodeParameters;
    this.#mintablePredicateAddress = config.mintablePredicateAddress;
    this.#caller = new ContractCaller({
      adapter: config.adapter,
      getAddress: () => Promise.resolve(config.tokenAddress),
      abi: ChildERC1155ABI,
      isParent: config.isParent,
      logger: config.logger,
      defaultFrom: config.defaultFrom
    });
  }

  /** ERC-1155 `balanceOf(user, tokenId)`. */
  async getBalance(
    userAddress: string,
    tokenId: bigint,
    options?: ContractCallerOptions
  ): Promise<bigint> {
    const v = await this.#caller.read<bigint | string>(
      'balanceOf',
      [userAddress, tokenId],
      options
    );
    return BigInt(v);
  }

  /** Operator approval check against the bridge's predicate. */
  isApprovedAll(
    userAddress: string,
    options?: ContractCallerOptions
  ): Promise<boolean> {
    this.#requireParent('isApprovedAll');
    return this.#bridge
      .getPredicateAddress(this.#tokenAddress)
      .then((predicate) =>
        this.#caller.read<boolean>('isApprovedForAll', [userAddress, predicate], options)
      );
  }

  /** `setApprovalForAll(predicate, true)` against the standard predicate. */
  approveAll(options: ContractCallerOptions = {}): Promise<TxResult> {
    this.#requireParent('approveAll');
    return this.#approveAllInner(this.#bridge.getPredicateAddress(this.#tokenAddress), options);
  }

  /** Same as {@link approveAll} but returns the unsigned `{ to, data, value? }`. */
  prepareApproveAll(options: ContractCallerOptions = {}): Promise<PreparedTx> {
    this.#requireParent('approveAll');
    return this.#prepareApproveAllInner(this.#bridge.getPredicateAddress(this.#tokenAddress), options);
  }

  /** Same shape as `approveAll`, but targets the mintable-1155 predicate. */
  approveAllForMintable(options: ContractCallerOptions = {}): Promise<TxResult> {
    this.#requireParent('approveAllForMintable');
    if (this.#mintablePredicateAddress === undefined) {
      throw new POSBridgeError(
        'CONTRACT_NOT_AVAILABLE_ON_NETWORK',
        'No mintable-ERC-1155 predicate address is configured for this network',
        { tokenAddress: this.#tokenAddress }
      );
    }
    return this.#approveAllInner(
      Promise.resolve(this.#mintablePredicateAddress),
      options
    );
  }

  /** Same as {@link approveAllForMintable} but returns the unsigned `{ to, data, value? }`. */
  prepareApproveAllForMintable(options: ContractCallerOptions = {}): Promise<PreparedTx> {
    this.#requireParent('approveAllForMintable');
    if (this.#mintablePredicateAddress === undefined) {
      throw new POSBridgeError(
        'CONTRACT_NOT_AVAILABLE_ON_NETWORK',
        'No mintable-ERC-1155 predicate address is configured for this network',
        { tokenAddress: this.#tokenAddress }
      );
    }
    return this.#prepareApproveAllInner(
      Promise.resolve(this.#mintablePredicateAddress),
      options
    );
  }

  #approveAllInner(
    predicatePromise: Promise<string>,
    options: ContractCallerOptions
  ): Promise<TxResult> {
    return predicatePromise.then((predicate) =>
      this.#caller.write('setApprovalForAll', [predicate, true], options)
    );
  }

  #prepareApproveAllInner(
    predicatePromise: Promise<string>,
    options: ContractCallerOptions
  ): Promise<PreparedTx> {
    return predicatePromise.then((predicate) =>
      this.#caller.prepareWrite('setApprovalForAll', [predicate, true], options)
    );
  }

  /** Single-token deposit. Wraps `depositMany` for shape symmetry. */
  deposit(
    param: POSERC1155DepositParam,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireParent('deposit');
    return this.depositMany(
      {
        amounts: [param.amount],
        tokenIds: [param.tokenId],
        userAddress: param.userAddress,
        data: param.data
      },
      options
    );
  }

  /** Same as {@link deposit} but returns the unsigned `{ to, data, value? }`. */
  prepareDeposit(
    param: POSERC1155DepositParam,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    this.#requireParent('deposit');
    return this.prepareDepositMany(
      {
        amounts: [param.amount],
        tokenIds: [param.tokenId],
        userAddress: param.userAddress,
        data: param.data
      },
      options
    );
  }

  /** Multi-token deposit. */
  depositMany(
    param: POSERC1155DepositBatchParam,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireParent('depositMany');
    const { tokenIds, amounts, data, userAddress } = param;
    const amountInABI = this.#encodeParameters(
      [tokenIds, amounts, data ?? EMPTY_BYTES],
      ['uint256[]', 'uint256[]', 'bytes']
    );
    return this.#rootChainManager.deposit(userAddress, this.#tokenAddress, amountInABI, options);
  }

  /** Same as {@link depositMany} but returns the unsigned `{ to, data, value? }`. */
  prepareDepositMany(
    param: POSERC1155DepositBatchParam,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    this.#requireParent('depositMany');
    const { tokenIds, amounts, data, userAddress } = param;
    const amountInABI = this.#encodeParameters(
      [tokenIds, amounts, data ?? EMPTY_BYTES],
      ['uint256[]', 'uint256[]', 'bytes']
    );
    return this.#rootChainManager.prepareDeposit(userAddress, this.#tokenAddress, amountInABI, options);
  }

  /** Burn a single (tokenId, amount) on the child chain. */
  startWithdraw(
    tokenId: bigint,
    amount: bigint,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireChild('startWithdraw');
    return this.#caller.write('withdrawSingle', [tokenId, amount], options);
  }

  /** Same as {@link startWithdraw} but returns the unsigned `{ to, data, value? }`. */
  prepareStartWithdraw(
    tokenId: bigint,
    amount: bigint,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    this.#requireChild('startWithdraw');
    return this.#caller.prepareWrite('withdrawSingle', [tokenId, amount], options);
  }

  /** Burn multiple (tokenId, amount) pairs in a single tx. */
  startWithdrawMany(
    tokenIds: bigint[],
    amounts: bigint[],
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireChild('startWithdrawMany');
    return this.#caller.write('withdrawBatch', [tokenIds, amounts], options);
  }

  /** Same as {@link startWithdrawMany} but returns the unsigned `{ to, data, value? }`. */
  prepareStartWithdrawMany(
    tokenIds: bigint[],
    amounts: bigint[],
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    this.#requireChild('startWithdrawMany');
    return this.#caller.prepareWrite('withdrawBatch', [tokenIds, amounts], options);
  }

  /** Submit the single-token exit payload (slow path). */
  async completeWithdraw(
    burnTransactionHash: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireParent('completeWithdraw');
    const payload = await this.#bridge.buildExitPayload(
      burnTransactionHash,
      LogEventSignature.Erc1155Transfer,
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
      LogEventSignature.Erc1155Transfer,
      false
    );
    return this.#rootChainManager.prepareExit(payload, options);
  }

  /** Submit the single-token exit payload (fast path via proof API). */
  async completeWithdrawFast(
    burnTransactionHash: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireParent('completeWithdrawFast');
    const payload = await this.#bridge.buildExitPayload(
      burnTransactionHash,
      LogEventSignature.Erc1155Transfer,
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
      LogEventSignature.Erc1155Transfer,
      true
    );
    return this.#rootChainManager.prepareExit(payload, options);
  }

  /** Submit the batch-transfer exit payload (slow path). */
  async completeWithdrawMany(
    burnTransactionHash: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireParent('completeWithdrawMany');
    const payload = await this.#bridge.buildExitPayload(
      burnTransactionHash,
      LogEventSignature.Erc1155BatchTransfer,
      false
    );
    return this.#rootChainManager.exit(payload, options);
  }

  /** Same as {@link completeWithdrawMany} but returns the unsigned `{ to, data, value? }`. */
  async prepareCompleteWithdrawMany(
    burnTransactionHash: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    this.#requireParent('completeWithdrawMany');
    const payload = await this.#bridge.buildExitPayload(
      burnTransactionHash,
      LogEventSignature.Erc1155BatchTransfer,
      false
    );
    return this.#rootChainManager.prepareExit(payload, options);
  }

  /** Submit the batch-transfer exit payload (fast path). */
  async completeWithdrawFastMany(
    burnTransactionHash: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireParent('completeWithdrawFastMany');
    const payload = await this.#bridge.buildExitPayload(
      burnTransactionHash,
      LogEventSignature.Erc1155BatchTransfer,
      true
    );
    return this.#rootChainManager.exit(payload, options);
  }

  /** Same as {@link completeWithdrawFastMany} but returns the unsigned `{ to, data, value? }`. */
  async prepareCompleteWithdrawFastMany(
    burnTransactionHash: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    this.#requireParent('completeWithdrawFastMany');
    const payload = await this.#bridge.buildExitPayload(
      burnTransactionHash,
      LogEventSignature.Erc1155BatchTransfer,
      true
    );
    return this.#rootChainManager.prepareExit(payload, options);
  }

  /** True iff a single-token exit has been processed. */
  isWithdrawExited(txHash: string): Promise<boolean> {
    return this.#bridge.isWithdrawn(txHash, LogEventSignature.Erc1155Transfer);
  }

  /** True iff a batch-transfer exit has been processed. */
  isWithdrawExitedMany(txHash: string): Promise<boolean> {
    return this.#bridge.isWithdrawn(txHash, LogEventSignature.Erc1155BatchTransfer);
  }

  /** Standard ERC-1155 `safeTransferFrom`. */
  transfer(
    param: POSERC1155TransferParam,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    return this.#caller.write(
      'safeTransferFrom',
      [param.from, param.to, param.tokenId, param.amount, param.data ?? EMPTY_BYTES],
      options
    );
  }

  /** Same as {@link transfer} but returns the unsigned `{ to, data, value? }`. */
  prepareTransfer(
    param: POSERC1155TransferParam,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return this.#caller.prepareWrite(
      'safeTransferFrom',
      [param.from, param.to, param.tokenId, param.amount, param.data ?? EMPTY_BYTES],
      options
    );
  }

  // --- guards ------------------------------------------------------------

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
