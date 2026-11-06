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
import type { ContractCallerOptions } from '../internal/contract-caller.js';
import type { POSBridgeHelpers } from '../internal/pos-bridge-helpers.js';
import type { Logger } from '../logger.js';
import type { GasSwapper } from './gas_swapper.js';
import type { RootChainManager } from './root_chain_manager.js';

import { ChildERC20ABI } from '../abi/index.js';
import { MAX_AMOUNT, LogEventSignature } from '../constant.js';
import {
  AllowedOnChildError,
  AllowedOnRootError,
  ApproveError,
  ContractNotAvailableOnNetworkError,
  DepositError,
  ExitError,
  BridgeStatusError,
  NullSpenderAddressError,
  OnlyAllowedOnMainnetError,
  TokenReadError,
  TransferError,
  WithdrawStartError,
  withOperation
} from '../errors.js';
import { assertOptionsObject, ContractCaller } from '../internal/contract-caller.js';

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
   */
  encodeParameters: (params: readonly unknown[], types: readonly string[]) => string;
  logger: Logger;
  defaultFrom?: Hex;
}

// Public deposit shape (see MIGRATION.md):
//   erc20.deposit(amount, userAddress, options)
//   erc20.depositWithGas(amount, userAddress, swapEthAmount, swapCallData, options)
//   posClient.depositEther(amount, userAddress, options)
//   posClient.depositEtherWithGas(amount, userAddress, swapEthAmount, swapCallData, options)
//
// The legacy SDK exposed `_depositEther` / `_depositEtherWithGas` on
// every ERC20 instance — vestigial, since they didn't read any ERC20
// state and the receiver-token concept doesn't apply to native ETH.
// 4.0 hoists ETH deposits to the top-level `POSClient` where they
// belong; ERC20 only owns ERC20-specific deposit shapes.

export class ERC20 {
  private readonly caller: ContractCaller;
  readonly tokenAddress: Hex;
  readonly isParent: boolean;
  private readonly bridge: POSBridgeHelpers;
  private readonly rootChainManager: RootChainManager;
  private readonly gasSwapper: GasSwapper | undefined;
  private readonly parentAdapter: Adapter;
  private readonly encodeParameters: (
    params: readonly unknown[],
    types: readonly string[]
  ) => string;

  constructor(config: ERC20Config) {
    this.tokenAddress = config.tokenAddress;
    this.isParent = config.isParent;
    this.bridge = config.bridge;
    this.rootChainManager = config.rootChainManager;
    this.gasSwapper = config.gasSwapper;
    this.parentAdapter = config.parentAdapter;
    this.encodeParameters = config.encodeParameters;
    this.caller = new ContractCaller({
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
    return withOperation({
      error: TokenReadError,
      info: {
        operation: 'getBalance',
        mode: 'read',
        tokenAddress: this.tokenAddress,
        method: 'balanceOf'
      },
      run: async () => {
        const v = await this.caller.read<bigint | string>('balanceOf', [userAddress], options);
        return BigInt(v);
      }
    });
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
    return withOperation({
      error: TokenReadError,
      info: {
        operation: 'getAllowance',
        mode: 'read',
        tokenAddress: this.tokenAddress,
        method: 'allowance'
      },
      run: async () => {
        // Inside `run` so a non-object option rejects as this operation's
        // error instead of escaping as a bare condition.
        assertOptionsObject({ method: 'getAllowance', options });
        if (options.spenderAddress === undefined && !this.isParent) {
          // Same guard as `approve`: on the child chain there is no bridge
          // predicate to default the spender to, and falling through to the
          // predicate lookup produces a misleading InvalidTokenTypeError.
          throw new NullSpenderAddressError(
            'spenderAddress is required when calling getAllowance on a child-chain token',
            { info: { tokenAddress: this.tokenAddress } }
          );
        }
        const spender =
          options.spenderAddress ?? (await this.bridge.getPredicateAddress(this.tokenAddress));
        const v = await this.caller.read<bigint | string>(
          'allowance',
          [userAddress, spender],
          options
        );
        return BigInt(v);
      }
    });
  }

  /**
   * Approve the bridge predicate (default) or an arbitrary spender to
   * spend `amount`. On the child chain, `spenderAddress` MUST be
   * supplied — there is no predicate to default to.
   */
  async approve(
    amount: bigint,
    options: ContractCallerOptions & { spenderAddress?: string } = {}
  ): Promise<TxResult> {
    return withOperation({
      error: ApproveError,
      info: {
        operation: 'approve',
        mode: 'write',
        tokenAddress: this.tokenAddress,
        method: 'approve'
      },
      run: async () => {
        assertOptionsObject({ method: 'approve', options });
        if (options.spenderAddress === undefined && !this.isParent) {
          throw new NullSpenderAddressError(
            'spenderAddress is required when calling approve on a child-chain token',
            { info: { tokenAddress: this.tokenAddress } }
          );
        }
        const spender =
          options.spenderAddress ?? (await this.bridge.getPredicateAddress(this.tokenAddress));
        return this.caller.write('approve', [spender, amount], options);
      }
    });
  }

  /** Same as {@link approve} but returns the unsigned `{ to, data, value? }`. */
  async prepareApprove(
    amount: bigint,
    options: ContractCallerOptions & { spenderAddress?: string } = {}
  ): Promise<PreparedTx> {
    return withOperation({
      error: ApproveError,
      info: {
        operation: 'prepareApprove',
        mode: 'prepare',
        tokenAddress: this.tokenAddress,
        method: 'approve'
      },
      run: async () => {
        assertOptionsObject({ method: 'prepareApprove', options });
        if (options.spenderAddress === undefined && !this.isParent) {
          throw new NullSpenderAddressError(
            'spenderAddress is required when calling approve on a child-chain token',
            { info: { tokenAddress: this.tokenAddress } }
          );
        }
        const spender =
          options.spenderAddress ?? (await this.bridge.getPredicateAddress(this.tokenAddress));
        return this.caller.prepareWrite('approve', [spender, amount], options);
      }
    });
  }

  /** Convenience wrapper: `approve(2^256 - 1, …)`. */
  async approveMax(
    options: ContractCallerOptions & { spenderAddress?: string } = {}
  ): Promise<TxResult> {
    return withOperation({
      error: ApproveError,
      info: {
        operation: 'approveMax',
        mode: 'write',
        tokenAddress: this.tokenAddress,
        method: 'approve'
      },
      run: () => this.approve(MAX_AMOUNT, options)
    });
  }

  /** Same as {@link approveMax} but returns the unsigned `{ to, data, value? }`. */
  async prepareApproveMax(
    options: ContractCallerOptions & { spenderAddress?: string } = {}
  ): Promise<PreparedTx> {
    return withOperation({
      error: ApproveError,
      info: {
        operation: 'prepareApproveMax',
        mode: 'prepare',
        tokenAddress: this.tokenAddress,
        method: 'approve'
      },
      run: () => this.prepareApprove(MAX_AMOUNT, options)
    });
  }

  /**
   * Bridge-deposit `amount` of the token to `userAddress`. Only valid
   * on the parent chain; calling on a child-chain token throws.
   */
  async deposit(
    amount: bigint,
    userAddress: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    return withOperation({
      error: DepositError,
      info: { operation: 'deposit', mode: 'write', tokenAddress: this.tokenAddress },
      run: () => {
        this.requireParent('deposit');
        const amountInABI = this.encodeParameters([amount], ['uint256']);
        return this.rootChainManager.deposit(userAddress, this.tokenAddress, amountInABI, options);
      }
    });
  }

  /** Same as {@link deposit} but returns the unsigned `{ to, data, value? }`. */
  async prepareDeposit(
    amount: bigint,
    userAddress: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return withOperation({
      error: DepositError,
      info: { operation: 'prepareDeposit', mode: 'prepare', tokenAddress: this.tokenAddress },
      run: () => {
        this.requireParent('deposit');
        const amountInABI = this.encodeParameters([amount], ['uint256']);
        return this.rootChainManager.prepareDeposit(
          userAddress,
          this.tokenAddress,
          amountInABI,
          options
        );
      }
    });
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
    return withOperation({
      error: DepositError,
      info: { operation: 'depositWithGas', mode: 'write', tokenAddress: this.tokenAddress },
      run: async () => {
        this.requireParent('depositWithGas');
        const swapper = this.requireGasSwapper('depositWithGas');
        const chainId = await this.parentAdapter.getChainId();
        if (chainId !== 1) {
          throw new OnlyAllowedOnMainnetError(
            'depositWithGas is only allowed on Ethereum mainnet',
            { info: { chainId } }
          );
        }
        const amountInABI = this.encodeParameters([amount], ['uint256']);
        return swapper.depositWithGas(this.tokenAddress, amountInABI, userAddress, swapCallData, {
          ...options,
          value: swapEthAmount
        });
      }
    });
  }

  /** Same as {@link depositWithGas} but returns the unsigned `{ to, data, value? }`. */
  async prepareDepositWithGas(
    amount: bigint,
    userAddress: string,
    swapEthAmount: bigint,
    swapCallData: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return withOperation({
      error: DepositError,
      info: {
        operation: 'prepareDepositWithGas',
        mode: 'prepare',
        tokenAddress: this.tokenAddress
      },
      run: async () => {
        this.requireParent('depositWithGas');
        const swapper = this.requireGasSwapper('depositWithGas');
        const chainId = await this.parentAdapter.getChainId();
        if (chainId !== 1) {
          throw new OnlyAllowedOnMainnetError(
            'depositWithGas is only allowed on Ethereum mainnet',
            { info: { chainId } }
          );
        }
        const amountInABI = this.encodeParameters([amount], ['uint256']);
        return swapper.prepareDepositWithGas(
          this.tokenAddress,
          amountInABI,
          userAddress,
          swapCallData,
          { ...options, value: swapEthAmount }
        );
      }
    });
  }

  /**
   * Burn `amount` on the child chain to start a withdrawal. Only
   * valid on the child chain.
   */
  async startWithdraw(amount: bigint, options: ContractCallerOptions = {}): Promise<TxResult> {
    return withOperation({
      error: WithdrawStartError,
      info: {
        operation: 'startWithdraw',
        mode: 'write',
        tokenAddress: this.tokenAddress,
        method: 'withdraw'
      },
      run: () => {
        this.requireChild('startWithdraw');
        return this.caller.write('withdraw', [amount], options);
      }
    });
  }

  /** Same as {@link startWithdraw} but returns the unsigned `{ to, data, value? }`. */
  async prepareStartWithdraw(
    amount: bigint,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return withOperation({
      error: WithdrawStartError,
      info: {
        operation: 'prepareStartWithdraw',
        mode: 'prepare',
        tokenAddress: this.tokenAddress,
        method: 'withdraw'
      },
      run: () => {
        this.requireChild('startWithdraw');
        return this.caller.prepareWrite('withdraw', [amount], options);
      }
    });
  }

  /**
   * Submit the exit-payload that completes a withdrawal. Only valid
   * on the parent chain. Set `isFast: true` to use the proof-API path.
   */
  async completeWithdraw(
    burnTransactionHash: string,
    options: ContractCallerOptions & { burnEventSignature?: string; isFast?: boolean } = {}
  ): Promise<TxResult> {
    const isFast = options.isFast ?? false;
    return withOperation({
      error: ExitError,
      info: {
        operation: 'completeWithdraw',
        mode: 'write',
        tokenAddress: this.tokenAddress,
        burnTxHash: burnTransactionHash,
        isFast
      },
      run: async () => {
        this.requireParent('completeWithdraw');
        const eventSignature = options.burnEventSignature ?? LogEventSignature.Erc20Transfer;
        const payload = await this.bridge.buildExitPayload(
          burnTransactionHash,
          eventSignature,
          isFast
        );
        return this.rootChainManager.exit(payload, options);
      }
    });
  }

  /** Same as {@link completeWithdraw} but returns the unsigned `{ to, data, value? }`. */
  async prepareCompleteWithdraw(
    burnTransactionHash: string,
    options: ContractCallerOptions & { burnEventSignature?: string; isFast?: boolean } = {}
  ): Promise<PreparedTx> {
    const isFast = options.isFast ?? false;
    return withOperation({
      error: ExitError,
      info: {
        operation: 'prepareCompleteWithdraw',
        mode: 'prepare',
        tokenAddress: this.tokenAddress,
        burnTxHash: burnTransactionHash,
        isFast
      },
      run: async () => {
        this.requireParent('completeWithdraw');
        const eventSignature = options.burnEventSignature ?? LogEventSignature.Erc20Transfer;
        const payload = await this.bridge.buildExitPayload(
          burnTransactionHash,
          eventSignature,
          isFast
        );
        return this.rootChainManager.prepareExit(payload, options);
      }
    });
  }

  /** Shorthand for `completeWithdraw(..., { isFast: true })`. */
  async completeWithdrawFast(
    burnTransactionHash: string,
    options: ContractCallerOptions & { burnEventSignature?: string } = {}
  ): Promise<TxResult> {
    return withOperation({
      error: ExitError,
      info: {
        operation: 'completeWithdrawFast',
        mode: 'write',
        tokenAddress: this.tokenAddress,
        burnTxHash: burnTransactionHash,
        isFast: true
      },
      run: () => this.completeWithdraw(burnTransactionHash, { ...options, isFast: true })
    });
  }

  /** Same as {@link completeWithdrawFast} but returns the unsigned `{ to, data, value? }`. */
  async prepareCompleteWithdrawFast(
    burnTransactionHash: string,
    options: ContractCallerOptions & { burnEventSignature?: string } = {}
  ): Promise<PreparedTx> {
    return withOperation({
      error: ExitError,
      info: {
        operation: 'prepareCompleteWithdrawFast',
        mode: 'prepare',
        tokenAddress: this.tokenAddress,
        burnTxHash: burnTransactionHash,
        isFast: true
      },
      run: () => this.prepareCompleteWithdraw(burnTransactionHash, { ...options, isFast: true })
    });
  }

  /** True iff the burn-tx's exit has been processed on the parent chain. */
  async isWithdrawExited(burnTxHash: string): Promise<boolean> {
    return withOperation({
      error: BridgeStatusError,
      info: {
        operation: 'isWithdrawExited',
        mode: 'read',
        tokenAddress: this.tokenAddress,
        burnTxHash
      },
      run: () => this.bridge.isWithdrawn(burnTxHash, LogEventSignature.Erc20Transfer)
    });
  }

  /**
   * Transfer `amount` to `to`. Standard ERC-20 transfer; works on
   * both parent and child chains.
   */
  async transfer(
    amount: bigint,
    to: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    return withOperation({
      error: TransferError,
      info: {
        operation: 'transfer',
        mode: 'write',
        tokenAddress: this.tokenAddress,
        method: 'transfer'
      },
      run: () => this.caller.write('transfer', [to, amount], options)
    });
  }

  /** Same as {@link transfer} but returns the unsigned `{ to, data, value? }`. */
  async prepareTransfer(
    amount: bigint,
    to: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return withOperation({
      error: TransferError,
      info: {
        operation: 'prepareTransfer',
        mode: 'prepare',
        tokenAddress: this.tokenAddress,
        method: 'transfer'
      },
      run: () => this.caller.prepareWrite('transfer', [to, amount], options)
    });
  }

  // --- guards ------------------------------------------------------------

  private requireParent(action: string): void {
    if (!this.isParent) {
      throw new AllowedOnRootError(`${action} is allowed only on the parent (root) chain`, {
        info: { action, isParent: this.isParent, tokenAddress: this.tokenAddress }
      });
    }
  }

  private requireChild(action: string): void {
    if (this.isParent) {
      throw new AllowedOnChildError(`${action} is allowed only on the child chain`, {
        info: {
          action,
          isParent: this.isParent,
          tokenAddress: this.tokenAddress
        }
      });
    }
  }

  private requireGasSwapper(action: string): GasSwapper {
    const swapper = this.gasSwapper;
    if (swapper === undefined) {
      // Log-once: the consumer's outermost boundary logs the thrown
      // error. Logging here too would double-report the same failure.
      throw new ContractNotAvailableOnNetworkError(
        `${action} requires a GasSwapper, which is not deployed/configured on this network`,
        { info: { action } }
      );
    }
    return swapper;
  }
}
