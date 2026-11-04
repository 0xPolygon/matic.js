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

  private write(method: string, args: readonly unknown[], options?: TxOptions): Promise<TxResult> {
    return this.caller.write(method, args, pinChainId(options, this.l1ChainId));
  }

  private prepare(
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
  delegateMatic(params: DelegateParams, options?: TxOptions): Promise<TxResult> {
    return this.write('buyVoucher', [params.amount, params.minSharesToMint], options);
  }

  /** Unsigned {@link delegateMatic}. */
  prepareDelegateMatic(params: DelegateParams, options?: TxOptions): Promise<PreparedTx> {
    return this.prepare('buyVoucher', [params.amount, params.minSharesToMint], options);
  }

  /** Delegates POL: calls `buyVoucherPOL(amount, minSharesToMint)`. Needs a prior POL approval. */
  delegate(params: DelegateParams, options?: TxOptions): Promise<TxResult> {
    return this.write('buyVoucherPOL', [params.amount, params.minSharesToMint], options);
  }

  /** Unsigned {@link delegate}. */
  prepareDelegate(params: DelegateParams, options?: TxOptions): Promise<PreparedTx> {
    return this.prepare('buyVoucherPOL', [params.amount, params.minSharesToMint], options);
  }

  /**
   * Delegates POL with a signed permit instead of a prior approval:
   * calls `buyVoucherWithPermit(amount, minSharesToMint, deadline, v, r, s)`.
   */
  delegateWithPermit(params: DelegateWithPermitParams, options?: TxOptions): Promise<TxResult> {
    return this.write('buyVoucherWithPermit', permitArgs(params), options);
  }

  /** Unsigned {@link delegateWithPermit}. */
  prepareDelegateWithPermit(
    params: DelegateWithPermitParams,
    options?: TxOptions
  ): Promise<PreparedTx> {
    return this.prepare('buyVoucherWithPermit', permitArgs(params), options);
  }

  /** Claims an unlocked unbond: calls `unstakeClaimTokens_newPOL(nonce)`. */
  claimUndelegated(params: ClaimUndelegatedParams, options?: TxOptions): Promise<TxResult> {
    return this.write('unstakeClaimTokens_newPOL', [params.nonce], options);
  }

  /** Unsigned {@link claimUndelegated}. */
  prepareClaimUndelegated(
    params: ClaimUndelegatedParams,
    options?: TxOptions
  ): Promise<PreparedTx> {
    return this.prepare('unstakeClaimTokens_newPOL', [params.nonce], options);
  }

  /** Starts unbonding: calls `sellVoucher_newPOL(amount, maxSharesToBurn)`. */
  undelegate(params: UndelegateParams, options?: TxOptions): Promise<TxResult> {
    return this.write('sellVoucher_newPOL', [params.amount, params.maxSharesToBurn], options);
  }

  /** Unsigned {@link undelegate}. */
  prepareUndelegate(params: UndelegateParams, options?: TxOptions): Promise<PreparedTx> {
    return this.prepare('sellVoucher_newPOL', [params.amount, params.maxSharesToBurn], options);
  }

  /** Re-delegates accrued rewards: calls `restakePOL()`. */
  restakeRewards(options?: TxOptions): Promise<TxResult> {
    return this.write('restakePOL', [], options);
  }

  /** Unsigned {@link restakeRewards}. */
  prepareRestakeRewards(options?: TxOptions): Promise<PreparedTx> {
    return this.prepare('restakePOL', [], options);
  }

  /** Withdraws accrued rewards: calls `withdrawRewardsPOL()`. */
  withdrawRewards(options?: TxOptions): Promise<TxResult> {
    return this.write('withdrawRewardsPOL', [], options);
  }

  /** Unsigned {@link withdrawRewards}. */
  prepareWithdrawRewards(options?: TxOptions): Promise<PreparedTx> {
    return this.prepare('withdrawRewardsPOL', [], options);
  }

  // --- reads --------------------------------------------------------

  /** Reads `exchangeRate()`. */
  getExchangeRate(options?: TxOptions): Promise<bigint> {
    return this.readBigInt('exchangeRate', [], options);
  }

  /** Reads `getLiquidRewards(user)`. */
  getLiquidRewards(params: { user: Hex }, options?: TxOptions): Promise<bigint> {
    return this.readBigInt('getLiquidRewards', [params.user], options);
  }

  /** Reads `minAmount()` — the smallest delegation the contract accepts. */
  getMinAmount(options?: TxOptions): Promise<bigint> {
    return this.readBigInt('minAmount', [], options);
  }

  /** Reads `balanceOf(user)` — the delegator's shares, not tokens. */
  getBalance(params: { user: Hex }, options?: TxOptions): Promise<bigint> {
    return this.readBigInt('balanceOf', [params.user], options);
  }

  /** Reads `getTotalStake(user)`. */
  async getTotalStake(params: { user: Hex }, options?: TxOptions): Promise<DelegatorStake> {
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

  /** Reads the legacy single-slot `unbonds(user)`. */
  getUnbond(params: { user: Hex }, options?: TxOptions): Promise<Unbond> {
    return this.readUnbond('unbonds', [params.user], options);
  }

  /** Reads `unbonds_new(user, nonce)`. */
  getUnbondNew(params: { user: Hex; nonce: bigint }, options?: TxOptions): Promise<Unbond> {
    return this.readUnbond('unbonds_new', [params.user, params.nonce], options);
  }

  /** Reads `unbondNonces(user)` — the nonce of the user's latest unbond. */
  getUnbondNonce(params: { user: Hex }, options?: TxOptions): Promise<bigint> {
    return this.readBigInt('unbondNonces', [params.user], options);
  }

  /** Reads `validatorId()`. */
  getValidatorId(options?: TxOptions): Promise<bigint> {
    return this.readBigInt('validatorId', [], options);
  }
}

function permitArgs(p: DelegateWithPermitParams): readonly unknown[] {
  return [p.amount, p.minSharesToMint, p.deadline, p.v, p.r, p.s];
}
