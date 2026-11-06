/**
 * `ValidatorShare` — delegator-side staking against one validator's
 * share contract. Each validator has its own ValidatorShare proxy
 * (resolve it with `stakeManager.getValidatorContract`), so instances
 * are bound to a caller-supplied address rather than the address index.
 */

import type { Hex, PreparedTx, TxResult } from '../adapter.js';
import type { TxOptions } from '../types.js';
import type { StakingContractConfig } from './stake-manager.js';

import { ValidatorShareABI } from '../abi/ValidatorShare.js';
import { StakingReadError, StakingWriteError, withOperation } from '../errors.js';
import { ContractCaller } from '../internal/contract-caller.js';
import { pinChainId, toBigInt, toTuple } from './stake-manager.js';

/**
 * One unbonding request: shares burned and the epoch the request was made
 * in. The contract stores the request epoch, not the unlock epoch: the
 * claim succeeds once `withdrawEpoch + WITHDRAWAL_DELAY <= currentEpoch`
 * (`stakeManager.getWithdrawalDelay()`), so a UI computing the unlock
 * time must add the delay itself.
 */
export interface Unbond {
  shares: bigint;
  /** Epoch the undelegation was requested in (`sellVoucher_newPOL`), as stored on-chain. */
  withdrawEpoch: bigint;
}

/** A delegator's stake in this validator and the exchange rate it was valued at. */
export interface DelegatorStake {
  stake: bigint;
  rate: bigint;
}

export interface DelegateParams {
  amount: bigint;
  /** Slippage floor: the tx reverts if fewer shares would be minted. */
  minSharesToMint: bigint;
}

export interface DelegateWithPermitParams extends DelegateParams {
  /** The permit deadline that was signed — must match the signed message. */
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

export interface UndelegateParams {
  amount: bigint;
  /** Slippage ceiling: the tx reverts if more shares would be burned. */
  maxSharesToBurn: bigint;
}

export interface ClaimUndelegatedParams {
  /** Unbond nonce returned by the undelegation (see {@link ValidatorShare.getUnbondNonce}). */
  nonce: bigint;
}

/**
 * Every public method wraps a condition the SDK detects in one operation
 * error named for the call: `StakingReadError` for reads,
 * `StakingWriteError` for writes and their `prepare*` twins. A wallet, node
 * or library error is rethrown unchanged.
 */
export class ValidatorShare {
  /** The ValidatorShare proxy this instance is bound to. */
  readonly address: Hex;
  private readonly caller: ContractCaller;
  private readonly l1ChainId: number;

  constructor(config: Omit<StakingContractConfig, 'getAddress'> & { address: Hex }) {
    const address = config.address;
    this.address = address;
    this.l1ChainId = config.l1ChainId;
    this.caller = new ContractCaller({
      adapter: config.adapter,
      getAddress: () => Promise.resolve(address),
      abi: ValidatorShareABI,
      isParent: true,
      logger: config.logger
    });
  }

  private async write(
    method: string,
    args: readonly unknown[],
    options?: TxOptions
  ): Promise<TxResult> {
    return this.caller.write(method, args, pinChainId(options, this.l1ChainId));
  }

  private async prepare(
    method: string,
    args: readonly unknown[],
    options?: TxOptions
  ): Promise<PreparedTx> {
    return this.caller.prepareWrite(method, args, pinChainId(options, this.l1ChainId));
  }

  private async readBigInt(
    method: string,
    args: readonly unknown[],
    options?: TxOptions
  ): Promise<bigint> {
    return toBigInt(await this.caller.read<unknown>(method, args, options), method);
  }

  private async readUnbond(
    method: string,
    args: readonly unknown[],
    options?: TxOptions
  ): Promise<Unbond> {
    const t = toTuple(await this.caller.read<unknown>(method, args, options), 2, method);
    return {
      shares: toBigInt(t[0], `${method}.shares`),
      withdrawEpoch: toBigInt(t[1], `${method}.withdrawEpoch`)
    };
  }

  // --- writes -------------------------------------------------------

  /** Delegates legacy MATIC: calls `buyVoucher(amount, minSharesToMint)`. */
  async delegateMatic(params: DelegateParams, options?: TxOptions): Promise<TxResult> {
    return withOperation({
      error: StakingWriteError,
      info: {
        operation: 'delegateMatic',
        mode: 'write',
        contractAddress: this.address,
        method: 'buyVoucher'
      },
      run: () => this.write('buyVoucher', [params.amount, params.minSharesToMint], options)
    });
  }

  /** Unsigned {@link delegateMatic}. */
  async prepareDelegateMatic(params: DelegateParams, options?: TxOptions): Promise<PreparedTx> {
    return withOperation({
      error: StakingWriteError,
      info: {
        operation: 'prepareDelegateMatic',
        mode: 'prepare',
        contractAddress: this.address,
        method: 'buyVoucher'
      },
      run: () => this.prepare('buyVoucher', [params.amount, params.minSharesToMint], options)
    });
  }

  /** Delegates POL: calls `buyVoucherPOL(amount, minSharesToMint)`. Needs a prior POL approval. */
  async delegate(params: DelegateParams, options?: TxOptions): Promise<TxResult> {
    return withOperation({
      error: StakingWriteError,
      info: {
        operation: 'delegate',
        mode: 'write',
        contractAddress: this.address,
        method: 'buyVoucherPOL'
      },
      run: () => this.write('buyVoucherPOL', [params.amount, params.minSharesToMint], options)
    });
  }

  /** Unsigned {@link delegate}. */
  async prepareDelegate(params: DelegateParams, options?: TxOptions): Promise<PreparedTx> {
    return withOperation({
      error: StakingWriteError,
      info: {
        operation: 'prepareDelegate',
        mode: 'prepare',
        contractAddress: this.address,
        method: 'buyVoucherPOL'
      },
      run: () => this.prepare('buyVoucherPOL', [params.amount, params.minSharesToMint], options)
    });
  }

  /**
   * Delegates POL with a signed permit instead of a prior approval:
   * calls `buyVoucherWithPermit(amount, minSharesToMint, deadline, v, r, s)`.
   */
  async delegateWithPermit(
    params: DelegateWithPermitParams,
    options?: TxOptions
  ): Promise<TxResult> {
    return withOperation({
      error: StakingWriteError,
      info: {
        operation: 'delegateWithPermit',
        mode: 'write',
        contractAddress: this.address,
        method: 'buyVoucherWithPermit'
      },
      run: () => this.write('buyVoucherWithPermit', permitArgs(params), options)
    });
  }

  /** Unsigned {@link delegateWithPermit}. */
  async prepareDelegateWithPermit(
    params: DelegateWithPermitParams,
    options?: TxOptions
  ): Promise<PreparedTx> {
    return withOperation({
      error: StakingWriteError,
      info: {
        operation: 'prepareDelegateWithPermit',
        mode: 'prepare',
        contractAddress: this.address,
        method: 'buyVoucherWithPermit'
      },
      run: () => this.prepare('buyVoucherWithPermit', permitArgs(params), options)
    });
  }

  /** Claims an unlocked unbond: calls `unstakeClaimTokens_newPOL(nonce)`. */
  async claimUndelegated(params: ClaimUndelegatedParams, options?: TxOptions): Promise<TxResult> {
    return withOperation({
      error: StakingWriteError,
      info: {
        operation: 'claimUndelegated',
        mode: 'write',
        contractAddress: this.address,
        method: 'unstakeClaimTokens_newPOL'
      },
      run: () => this.write('unstakeClaimTokens_newPOL', [params.nonce], options)
    });
  }

  /** Unsigned {@link claimUndelegated}. */
  async prepareClaimUndelegated(
    params: ClaimUndelegatedParams,
    options?: TxOptions
  ): Promise<PreparedTx> {
    return withOperation({
      error: StakingWriteError,
      info: {
        operation: 'prepareClaimUndelegated',
        mode: 'prepare',
        contractAddress: this.address,
        method: 'unstakeClaimTokens_newPOL'
      },
      run: () => this.prepare('unstakeClaimTokens_newPOL', [params.nonce], options)
    });
  }

  /** Starts unbonding: calls `sellVoucher_newPOL(amount, maxSharesToBurn)`. */
  async undelegate(params: UndelegateParams, options?: TxOptions): Promise<TxResult> {
    return withOperation({
      error: StakingWriteError,
      info: {
        operation: 'undelegate',
        mode: 'write',
        contractAddress: this.address,
        method: 'sellVoucher_newPOL'
      },
      run: () => this.write('sellVoucher_newPOL', [params.amount, params.maxSharesToBurn], options)
    });
  }

  /** Unsigned {@link undelegate}. */
  async prepareUndelegate(params: UndelegateParams, options?: TxOptions): Promise<PreparedTx> {
    return withOperation({
      error: StakingWriteError,
      info: {
        operation: 'prepareUndelegate',
        mode: 'prepare',
        contractAddress: this.address,
        method: 'sellVoucher_newPOL'
      },
      run: () =>
        this.prepare('sellVoucher_newPOL', [params.amount, params.maxSharesToBurn], options)
    });
  }

  /** Re-delegates accrued rewards: calls `restakePOL()`. */
  async restakeRewards(options?: TxOptions): Promise<TxResult> {
    return withOperation({
      error: StakingWriteError,
      info: {
        operation: 'restakeRewards',
        mode: 'write',
        contractAddress: this.address,
        method: 'restakePOL'
      },
      run: () => this.write('restakePOL', [], options)
    });
  }

  /** Unsigned {@link restakeRewards}. */
  async prepareRestakeRewards(options?: TxOptions): Promise<PreparedTx> {
    return withOperation({
      error: StakingWriteError,
      info: {
        operation: 'prepareRestakeRewards',
        mode: 'prepare',
        contractAddress: this.address,
        method: 'restakePOL'
      },
      run: () => this.prepare('restakePOL', [], options)
    });
  }

  /** Withdraws accrued rewards: calls `withdrawRewardsPOL()`. */
  async withdrawRewards(options?: TxOptions): Promise<TxResult> {
    return withOperation({
      error: StakingWriteError,
      info: {
        operation: 'withdrawRewards',
        mode: 'write',
        contractAddress: this.address,
        method: 'withdrawRewardsPOL'
      },
      run: () => this.write('withdrawRewardsPOL', [], options)
    });
  }

  /** Unsigned {@link withdrawRewards}. */
  async prepareWithdrawRewards(options?: TxOptions): Promise<PreparedTx> {
    return withOperation({
      error: StakingWriteError,
      info: {
        operation: 'prepareWithdrawRewards',
        mode: 'prepare',
        contractAddress: this.address,
        method: 'withdrawRewardsPOL'
      },
      run: () => this.prepare('withdrawRewardsPOL', [], options)
    });
  }

  // --- reads --------------------------------------------------------

  /** Reads `exchangeRate()`. */
  async getExchangeRate(options?: TxOptions): Promise<bigint> {
    return withOperation({
      error: StakingReadError,
      info: {
        operation: 'getExchangeRate',
        mode: 'read',
        contractAddress: this.address,
        method: 'exchangeRate'
      },
      run: () => this.readBigInt('exchangeRate', [], options)
    });
  }

  /** Reads `getLiquidRewards(user)`. */
  async getLiquidRewards(params: { user: Hex }, options?: TxOptions): Promise<bigint> {
    return withOperation({
      error: StakingReadError,
      info: {
        operation: 'getLiquidRewards',
        mode: 'read',
        contractAddress: this.address,
        method: 'getLiquidRewards'
      },
      run: () => this.readBigInt('getLiquidRewards', [params.user], options)
    });
  }

  /** Reads `minAmount()` — the smallest delegation the contract accepts. */
  async getMinAmount(options?: TxOptions): Promise<bigint> {
    return withOperation({
      error: StakingReadError,
      info: {
        operation: 'getMinAmount',
        mode: 'read',
        contractAddress: this.address,
        method: 'minAmount'
      },
      run: () => this.readBigInt('minAmount', [], options)
    });
  }

  /** Reads `balanceOf(user)` — the delegator's shares, not tokens. */
  async getBalance(params: { user: Hex }, options?: TxOptions): Promise<bigint> {
    return withOperation({
      error: StakingReadError,
      info: {
        operation: 'getBalance',
        mode: 'read',
        contractAddress: this.address,
        method: 'balanceOf'
      },
      run: () => this.readBigInt('balanceOf', [params.user], options)
    });
  }

  /** Reads `getTotalStake(user)`. */
  async getTotalStake(params: { user: Hex }, options?: TxOptions): Promise<DelegatorStake> {
    return withOperation({
      error: StakingReadError,
      info: {
        operation: 'getTotalStake',
        mode: 'read',
        contractAddress: this.address,
        method: 'getTotalStake'
      },
      run: async () => {
        const t = toTuple(
          await this.caller.read<unknown>('getTotalStake', [params.user], options),
          2,
          'getTotalStake'
        );
        return {
          stake: toBigInt(t[0], 'getTotalStake.stake'),
          rate: toBigInt(t[1], 'getTotalStake.rate')
        };
      }
    });
  }

  /** Reads the legacy single-slot `unbonds(user)`. */
  async getUnbond(params: { user: Hex }, options?: TxOptions): Promise<Unbond> {
    return withOperation({
      error: StakingReadError,
      info: {
        operation: 'getUnbond',
        mode: 'read',
        contractAddress: this.address,
        method: 'unbonds'
      },
      run: () => this.readUnbond('unbonds', [params.user], options)
    });
  }

  /** Reads `unbonds_new(user, nonce)`. */
  async getUnbondNew(params: { user: Hex; nonce: bigint }, options?: TxOptions): Promise<Unbond> {
    return withOperation({
      error: StakingReadError,
      info: {
        operation: 'getUnbondNew',
        mode: 'read',
        contractAddress: this.address,
        method: 'unbonds_new'
      },
      run: () => this.readUnbond('unbonds_new', [params.user, params.nonce], options)
    });
  }

  /** Reads `unbondNonces(user)` — the nonce of the user's latest unbond. */
  async getUnbondNonce(params: { user: Hex }, options?: TxOptions): Promise<bigint> {
    return withOperation({
      error: StakingReadError,
      info: {
        operation: 'getUnbondNonce',
        mode: 'read',
        contractAddress: this.address,
        method: 'unbondNonces'
      },
      run: () => this.readBigInt('unbondNonces', [params.user], options)
    });
  }

  /** Reads `validatorId()`. */
  async getValidatorId(options?: TxOptions): Promise<bigint> {
    return withOperation({
      error: StakingReadError,
      info: {
        operation: 'getValidatorId',
        mode: 'read',
        contractAddress: this.address,
        method: 'validatorId'
      },
      run: () => this.readBigInt('validatorId', [], options)
    });
  }
}

function permitArgs(p: DelegateWithPermitParams): readonly unknown[] {
  return [p.amount, p.minSharesToMint, p.deadline, p.v, p.r, p.s];
}
