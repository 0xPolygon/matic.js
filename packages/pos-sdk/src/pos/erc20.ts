/**
 * `ERC20` — typed wrapper around the bridge's child-chain ERC-20
 * surface plus the deposit/withdraw flows on the parent chain.
 *
 * The class composes (rather than inherits) `ContractCaller` and the
 * `POSBridgeHelpers` / `RootChainManager` services. The legacy
 * `BaseToken → POSToken → ERC20` chain is gone; every cross-chain
 * helper that used to live on the base classes is now reached via
 * an injected dependency.
 *
 * # Method signatures use `bigint` for amounts
 *
 * The legacy SDK accepted `string | number | BN | BaseBigNumber` and
 * threaded everything through a `Converter` that rejected "non-numeric"
 * values at runtime. The new surface speaks native `bigint` directly —
 * if a consumer has a `BigNumber` (ethers v5) or hex string, they
 * convert at the boundary, not inside the SDK.
 */

import type { Adapter, Hex, PreparedTx, TxResult } from '../adapter.js';
import type {ContractCallerOptions} from '../internal/contract-caller.js';
import type { POSBridgeHelpers } from '../internal/pos-bridge-helpers.js';
import type { Logger } from '../logger.js';
import type { GasSwapper } from './gas_swapper.js';
import type { RootChainManager } from './root_chain_manager.js';

import { ChildERC20ABI } from '../abi/index.js';
import { MAX_AMOUNT, LogEventSignature } from '../constant.js';
import { POSBridgeError } from '../errors.js';
import { ContractCaller  } from '../internal/contract-caller.js';

export interface ERC20Config {
  /** Token contract address. */
  tokenAddress: Hex;
  /** `true` if the address is on the parent chain (Ethereum); `false` if on Polygon. */
  isParent: boolean;
  /**
   * Adapter for the chain where this token lives — parent OR child,
   * matching `isParent`. Read/write/estimate flow through here.
   */
  adapter: Adapter;
  /** Cross-chain bridge primitives. Required for exit / withdrawal. */
  bridge: POSBridgeHelpers;
  /** Parent-chain `RootChainManager` handle. Required for deposit / exit. */
  rootChainManager: RootChainManager;
  /** Optional GasSwapper handle for the `*WithGas` deposit variants. */
  gasSwapper?: GasSwapper;
  /**
   * Adapter for the parent chain. Used by `deposit` / `depositWithGas`
   * to call `encodeParameters`-style ABI encoding for the deposit-data
   * payload. May coincide with `adapter` when `isParent === true`.
   */
  parentAdapter: Adapter;
  /**
   * `encodeParameters` hook: ABI-encode `params` against `types`.
   * Stage 4 wires the three adapter implementations to expose this;
   * Stage 2 only needs the contract.
   */
  encodeParameters: (params: readonly unknown[], types: readonly string[]) => string;
  logger: Logger;
  defaultFrom?: Hex;
}

// Stage 6 (MIGRATION.md) note — public deposit shape:
//   erc20.deposit(amount, userAddress, options)
//   erc20.depositWithGas(amount, userAddress, swapEthAmount, swapCallData, options)
//   posClient.depositEther(amount, userAddress, options)
//   posClient.depositEtherWithGas(amount, userAddress, swapEthAmount, swapCallData, options)
//
// The legacy SDK exposed `_depositEther` / `_depositEtherWithGas` on
// every ERC20 instance — vestigial, since they didn't read any ERC20
// state and the receiver-token concept doesn't apply to native ETH.
// 1.0 hoists ETH deposits to the top-level `POSClient` where they
// belong; ERC20 only owns ERC20-specific deposit shapes.

export class ERC20 {
  readonly #caller: ContractCaller;
  readonly #tokenAddress: Hex;
  readonly #isParent: boolean;
  readonly #bridge: POSBridgeHelpers;
  readonly #rootChainManager: RootChainManager;
  readonly #gasSwapper: GasSwapper | undefined;
  readonly #parentAdapter: Adapter;
  readonly #encodeParameters: (
    params: readonly unknown[],
    types: readonly string[]
  ) => string;

  constructor(config: ERC20Config) {
    this.#tokenAddress = config.tokenAddress;
    this.#isParent = config.isParent;
    this.#bridge = config.bridge;
    this.#rootChainManager = config.rootChainManager;
    this.#gasSwapper = config.gasSwapper;
    this.#parentAdapter = config.parentAdapter;
    this.#encodeParameters = config.encodeParameters;
    this.#caller = new ContractCaller({
      adapter: config.adapter,
      getAddress: () => Promise.resolve(config.tokenAddress),
      abi: ChildERC20ABI,
      isParent: config.isParent,
      logger: config.logger,
      defaultFrom: config.defaultFrom
    });
  }

  /** ERC-20 `balanceOf(userAddress)`. Returned as native `bigint`. */
  async getBalance(userAddress: string, options?: ContractCallerOptions): Promise<bigint> {
    const v = await this.#caller.read<bigint | string>('balanceOf', [userAddress], options);
    return BigInt(v);
  }

  /**
   * `allowance(userAddress, spender)`. When `spender` is omitted, the
   * allowance is read against the bridge's predicate contract — the
   * legacy default and what every standard deposit flow uses.
   */
  async getAllowance(
    userAddress: string,
    options: ContractCallerOptions & { spenderAddress?: string } = {}
  ): Promise<bigint> {
    const spender = options.spenderAddress ?? (await this.#bridge.getPredicateAddress(this.#tokenAddress));
    const v = await this.#caller.read<bigint | string>('allowance', [userAddress, spender], options);
    return BigInt(v);
  }

  /**
   * Approve the bridge predicate (default) or an arbitrary spender to
   * spend `amount`. On the child chain, `spenderAddress` MUST be
   * supplied — there is no predicate to default to.
   */
  approve(
    amount: bigint,
    options: ContractCallerOptions & { spenderAddress?: string } = {}
  ): Promise<TxResult> {
    if (options.spenderAddress === undefined && !this.#isParent) {
      throw new POSBridgeError(
        'NULL_SPENDER_ADDRESS',
        'spenderAddress is required when calling approve on a child-chain token',
        { tokenAddress: this.#tokenAddress }
      );
    }
    const predicatePromise =
      options.spenderAddress !== undefined
        ? Promise.resolve(options.spenderAddress)
        : this.#bridge.getPredicateAddress(this.#tokenAddress);
    return predicatePromise.then((spender) =>
      this.#caller.write('approve', [spender, amount], options)
    );
  }

  /** Same as {@link approve} but returns the unsigned `{ to, data, value? }`. */
  prepareApprove(
    amount: bigint,
    options: ContractCallerOptions & { spenderAddress?: string } = {}
  ): Promise<PreparedTx> {
    if (options.spenderAddress === undefined && !this.#isParent) {
      throw new POSBridgeError(
        'NULL_SPENDER_ADDRESS',
        'spenderAddress is required when calling approve on a child-chain token',
        { tokenAddress: this.#tokenAddress }
      );
    }
    const predicatePromise =
      options.spenderAddress !== undefined
        ? Promise.resolve(options.spenderAddress)
        : this.#bridge.getPredicateAddress(this.#tokenAddress);
    return predicatePromise.then((spender) =>
      this.#caller.prepareWrite('approve', [spender, amount], options)
    );
  }

  /** Convenience wrapper: `approve(2^256 - 1, …)`. */
  approveMax(
    options: ContractCallerOptions & { spenderAddress?: string } = {}
  ): Promise<TxResult> {
    return this.approve(MAX_AMOUNT, options);
  }

  /** Same as {@link approveMax} but returns the unsigned `{ to, data, value? }`. */
  prepareApproveMax(
    options: ContractCallerOptions & { spenderAddress?: string } = {}
  ): Promise<PreparedTx> {
    return this.prepareApprove(MAX_AMOUNT, options);
  }

  /**
   * Bridge-deposit `amount` of the token to `userAddress`. Only valid
   * on the parent chain; calling on a child-chain token throws.
   */
  deposit(
    amount: bigint,
    userAddress: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireParent('deposit');

    const amountInABI = this.#encodeParameters([amount], ['uint256']);
    return this.#rootChainManager.deposit(userAddress, this.#tokenAddress, amountInABI, options);
  }

  /** Same as {@link deposit} but returns the unsigned `{ to, data, value? }`. */
  prepareDeposit(
    amount: bigint,
    userAddress: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    this.#requireParent('deposit');
    const amountInABI = this.#encodeParameters([amount], ['uint256']);
    return this.#rootChainManager.prepareDeposit(userAddress, this.#tokenAddress, amountInABI, options);
  }

  /**
   * Bridge-deposit `amount` plus ETH for `swapCallData`. Mainnet-only
   * because the GasSwapper contract is only deployed there.
   */
  async depositWithGas(
    amount: bigint,
    userAddress: string,
    swapEthAmount: bigint,
    swapCallData: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    this.#requireParent('depositWithGas');
    const swapper = this.#requireGasSwapper('depositWithGas');
    const chainId = await this.#parentAdapter.getChainId();
    if (chainId !== 1) {
      throw new POSBridgeError(
        'ONLY_ALLOWED_ON_MAINNET',
        'depositWithGas is only allowed on Ethereum mainnet',
        { chainId }
      );
    }
    const amountInABI = this.#encodeParameters([amount], ['uint256']);
    return swapper.depositWithGas(
      this.#tokenAddress,
      amountInABI,
      userAddress,
      swapCallData,
      { ...options, value: swapEthAmount }
    );
  }

  /** Same as {@link depositWithGas} but returns the unsigned `{ to, data, value? }`. */
  async prepareDepositWithGas(
    amount: bigint,
    userAddress: string,
    swapEthAmount: bigint,
    swapCallData: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    this.#requireParent('depositWithGas');
    const swapper = this.#requireGasSwapper('depositWithGas');
    const chainId = await this.#parentAdapter.getChainId();
    if (chainId !== 1) {
      throw new POSBridgeError(
        'ONLY_ALLOWED_ON_MAINNET',
        'depositWithGas is only allowed on Ethereum mainnet',
        { chainId }
      );
    }
    const amountInABI = this.#encodeParameters([amount], ['uint256']);
    return swapper.prepareDepositWithGas(
      this.#tokenAddress,
      amountInABI,
      userAddress,
      swapCallData,
      { ...options, value: swapEthAmount }
    );
  }

  /**
   * Burn `amount` on the child chain to start a withdrawal. Only
   * valid on the child chain.
   */
  startWithdraw(amount: bigint, options: ContractCallerOptions = {}): Promise<TxResult> {
    this.#requireChild('startWithdraw');
    return this.#caller.write('withdraw', [amount], options);
  }

  /** Same as {@link startWithdraw} but returns the unsigned `{ to, data, value? }`. */
  prepareStartWithdraw(amount: bigint, options: ContractCallerOptions = {}): Promise<PreparedTx> {
    this.#requireChild('startWithdraw');
    return this.#caller.prepareWrite('withdraw', [amount], options);
  }

  /**
   * Submit the exit-payload that completes a withdrawal. Only valid
   * on the parent chain. Set `isFast: true` to use the proof-API path.
   */
  async completeWithdraw(
    burnTransactionHash: string,
    options: ContractCallerOptions & { burnEventSignature?: string; isFast?: boolean } = {}
  ): Promise<TxResult> {
    this.#requireParent('completeWithdraw');
    const eventSignature = options.burnEventSignature ?? LogEventSignature.Erc20Transfer;
    const payload = await this.#bridge.buildExitPayload(
      burnTransactionHash,
      eventSignature,
      options.isFast ?? false
    );
    return this.#rootChainManager.exit(payload, options);
  }

  /** Same as {@link completeWithdraw} but returns the unsigned `{ to, data, value? }`. */
  async prepareCompleteWithdraw(
    burnTransactionHash: string,
    options: ContractCallerOptions & { burnEventSignature?: string; isFast?: boolean } = {}
  ): Promise<PreparedTx> {
    this.#requireParent('completeWithdraw');
    const eventSignature = options.burnEventSignature ?? LogEventSignature.Erc20Transfer;
    const payload = await this.#bridge.buildExitPayload(
      burnTransactionHash,
      eventSignature,
      options.isFast ?? false
    );
    return this.#rootChainManager.prepareExit(payload, options);
  }

  /** Shorthand for `completeWithdraw(..., { isFast: true })`. */
  completeWithdrawFast(
    burnTransactionHash: string,
    options: ContractCallerOptions & { burnEventSignature?: string } = {}
  ): Promise<TxResult> {
    return this.completeWithdraw(burnTransactionHash, { ...options, isFast: true });
  }

  /** Same as {@link completeWithdrawFast} but returns the unsigned `{ to, data, value? }`. */
  prepareCompleteWithdrawFast(
    burnTransactionHash: string,
    options: ContractCallerOptions & { burnEventSignature?: string } = {}
  ): Promise<PreparedTx> {
    return this.prepareCompleteWithdraw(burnTransactionHash, { ...options, isFast: true });
  }

  /** True iff the burn-tx's exit has been processed on the parent chain. */
  isWithdrawExited(burnTxHash: string): Promise<boolean> {
    return this.#bridge.isWithdrawn(burnTxHash, LogEventSignature.Erc20Transfer);
  }

  /**
   * Transfer `amount` to `to`. Standard ERC-20 transfer; works on
   * both parent and child chains.
   */
  transfer(amount: bigint, to: string, options: ContractCallerOptions = {}): Promise<TxResult> {
    return this.#caller.write('transfer', [to, amount], options);
  }

  /** Same as {@link transfer} but returns the unsigned `{ to, data, value? }`. */
  prepareTransfer(amount: bigint, to: string, options: ContractCallerOptions = {}): Promise<PreparedTx> {
    return this.#caller.prepareWrite('transfer', [to, amount], options);
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

  #requireGasSwapper(action: string): GasSwapper {
    const swapper = this.#gasSwapper;
    if (swapper === undefined) {
      // Log-once: the consumer's outermost boundary logs the thrown
      // error. Logging here too would double-report the same failure.
      throw new POSBridgeError(
        'CONTRACT_NOT_AVAILABLE_ON_NETWORK',
        `${action} requires a GasSwapper, which is not deployed/configured on this network`,
        { action }
      );
    }
    return swapper;
  }
}
