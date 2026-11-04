/**
 * `StakeManager` — validator-side staking writes and protocol reads,
 * bound to the live StakeManager **proxy** (never the implementation:
 * state lives behind the proxy, and the implementation address changes
 * on every upgrade).
 *
 * Every method takes a params object so a missing or reordered field
 * is a compile error. That matters most for `stakeFor`, whose five
 * on-chain arguments include two adjacent `bytes`/`bool` slots that a
 * positional call can silently swap or drop.
 */

import type { Adapter, Hex, PreparedTx, TxResult } from '../adapter.js';
import type { Logger } from '../logger.js';
import type { TxOptions } from '../types.js';

import { StakeManagerABI } from '../abi/StakeManager.js';
import { POSBridgeError } from '../errors.js';
import { ContractCaller } from '../internal/contract-caller.js';

/**
 * Wiring every staking contract wrapper receives from `StakingClient`.
 * Internal: consumers obtain wrappers from `StakingClient.init`.
 */
export interface StakingContractConfig {
  adapter: Adapter;
  /** Resolves the contract address; re-reads the address index so TTL refreshes are picked up. */
  getAddress: () => Promise<Hex>;
  logger: Logger;
  /** Parent chain id every write is pinned to unless the caller overrides `chainId`. */
  l1ChainId: number;
}

/**
 * Pin a write to the network's parent chain. The adapters refuse to
 * broadcast when the wallet's chain differs from `chainId`, so a wallet
 * left on Polygon cannot send a staking tx to the wrong network. A
 * caller-supplied `chainId` still wins (forks, custom deployments).
 */
export function pinChainId(options: TxOptions | undefined, l1ChainId: number): TxOptions {
  return { ...options, chainId: options?.chainId ?? l1ChainId };
}

/**
 * Coerce one decoded integer to `bigint`. viem and ethers v6 return
 * `bigint`; ethers v5 returns a `BigNumber`, whose string form is a
 * decimal quantity.
 */
export function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' || typeof value === 'string') return BigInt(value);
  if (typeof value === 'object' && value !== null) return BigInt(String(value));
  throw new POSBridgeError('BRIDGE_EVENT_DECODE_FAILED', `${field} is not a numeric value`, {
    field,
    valueType: typeof value
  });
}

/** Narrow one decoded address to `Hex`. */
export function toHexAddress(value: unknown, field: string): Hex {
  if (typeof value === 'string' && value.startsWith('0x')) {
    const hex: Hex = `0x${value.slice(2)}`;
    return hex;
  }
  throw new POSBridgeError('BRIDGE_EVENT_DECODE_FAILED', `${field} is not a 0x address`, {
    field,
    valueType: typeof value
  });
}

/**
 * Return a multi-output read as a positional array. All three
 * adapters decode multi-output functions positionally (viem as a plain
 * array, ethers as a `Result`, which extends `Array`), so fields are
 * read by index in ABI output order.
 */
export function toTuple(value: unknown, minLength: number, field: string): readonly unknown[] {
  if (Array.isArray(value) && value.length >= minLength) return value;
  throw new POSBridgeError(
    'BRIDGE_EVENT_DECODE_FAILED',
    `${field} did not decode to a tuple of at least ${minLength} fields`,
    { field, minLength }
  );
}

/** One entry of StakeManager's `validators(uint256)` mapping. */
export interface ValidatorInfo {
  amount: bigint;
  reward: bigint;
  activationEpoch: bigint;
  deactivationEpoch: bigint;
  jailTime: bigint;
  signer: Hex;
  contractAddress: Hex;
  status: bigint;
  commissionRate: bigint;
  lastCommissionUpdate: bigint;
  delegatorsReward: bigint;
  delegatedAmount: bigint;
  initialRewardPerStake: bigint;
}

/** Arguments of `stakeFor` / `stakeForMatic`, in on-chain order. */
export interface StakeForParams {
  /** Address that will own the validator NFT. */
  user: Hex;
  amount: bigint;
  heimdallFee: bigint;
  acceptDelegation: boolean;
  signerPubkey: Hex;
}

export interface MigrateDelegationParams {
  fromValidatorId: bigint;
  toValidatorId: bigint;
  amount: bigint;
}

export interface RestakeParams {
  validatorId: bigint;
  amount: bigint;
  stakeRewards: boolean;
}

/**
 * `heimdallFee`, not `amount`: the same name `stakeFor` uses for this
 * quantity, so a fee can't be mistaken for (or swapped with) a stake
 * amount at a call site.
 */
export interface TopUpHeimdallFeeParams {
  user: Hex;
  heimdallFee: bigint;
}

export interface ValidatorIdParams {
  validatorId: bigint;
}

export interface UpdateCommissionRateParams {
  validatorId: bigint;
  commissionRate: bigint;
}

export interface UpdateSignerParams {
  validatorId: bigint;
  signerPubkey: Hex;
}

function stakeForArgs(p: StakeForParams): readonly unknown[] {
  return [p.user, p.amount, p.heimdallFee, p.acceptDelegation, p.signerPubkey];
}

export class StakeManager {
  private readonly caller: ContractCaller;
  private readonly l1ChainId: number;

  constructor(config: StakingContractConfig) {
    this.l1ChainId = config.l1ChainId;
    this.caller = new ContractCaller({
      adapter: config.adapter,
      getAddress: config.getAddress,
      abi: StakeManagerABI,
      isParent: true,
      logger: config.logger
    });
  }

  /** The StakeManager proxy address currently resolved from the address index. */
  getAddress(): Promise<Hex> {
    return this.caller.getContractAddress();
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

  // --- writes -------------------------------------------------------

  /** Calls `migrateDelegation(fromValidatorId, toValidatorId, amount)`. */
  migrateDelegation(params: MigrateDelegationParams, options?: TxOptions): Promise<TxResult> {
    return this.write(
      'migrateDelegation',
      [params.fromValidatorId, params.toValidatorId, params.amount],
      options
    );
  }

  /** Unsigned {@link migrateDelegation}. */
  prepareMigrateDelegation(
    params: MigrateDelegationParams,
    options?: TxOptions
  ): Promise<PreparedTx> {
    return this.prepare(
      'migrateDelegation',
      [params.fromValidatorId, params.toValidatorId, params.amount],
      options
    );
  }

  /** Calls `restakePOL(validatorId, amount, stakeRewards)`. */
  restake(params: RestakeParams, options?: TxOptions): Promise<TxResult> {
    return this.write(
      'restakePOL',
      [params.validatorId, params.amount, params.stakeRewards],
      options
    );
  }

  /** Unsigned {@link restake}. */
  prepareRestake(params: RestakeParams, options?: TxOptions): Promise<PreparedTx> {
    return this.prepare(
      'restakePOL',
      [params.validatorId, params.amount, params.stakeRewards],
      options
    );
  }

  /** Calls `withdrawRewardsPOL(validatorId)`. */
  withdrawValidatorRewards(params: ValidatorIdParams, options?: TxOptions): Promise<TxResult> {
    return this.write('withdrawRewardsPOL', [params.validatorId], options);
  }

  /** Unsigned {@link withdrawValidatorRewards}. */
  prepareWithdrawValidatorRewards(
    params: ValidatorIdParams,
    options?: TxOptions
  ): Promise<PreparedTx> {
    return this.prepare('withdrawRewardsPOL', [params.validatorId], options);
  }

  /** Calls `topUpForFee(user, heimdallFee)`. */
  topUpHeimdallFee(params: TopUpHeimdallFeeParams, options?: TxOptions): Promise<TxResult> {
    return this.write('topUpForFee', [params.user, params.heimdallFee], options);
  }

  /** Unsigned {@link topUpHeimdallFee}. */
  prepareTopUpHeimdallFee(
    params: TopUpHeimdallFeeParams,
    options?: TxOptions
  ): Promise<PreparedTx> {
    return this.prepare('topUpForFee', [params.user, params.heimdallFee], options);
  }

  /** Calls `unstakePOL(validatorId)`. */
  unstake(params: ValidatorIdParams, options?: TxOptions): Promise<TxResult> {
    return this.write('unstakePOL', [params.validatorId], options);
  }

  /** Unsigned {@link unstake}. */
  prepareUnstake(params: ValidatorIdParams, options?: TxOptions): Promise<PreparedTx> {
    return this.prepare('unstakePOL', [params.validatorId], options);
  }

  /** Calls `unstakeClaimPOL(validatorId)`. */
  claimUnstaked(params: ValidatorIdParams, options?: TxOptions): Promise<TxResult> {
    return this.write('unstakeClaimPOL', [params.validatorId], options);
  }

  /** Unsigned {@link claimUnstaked}. */
  prepareClaimUnstaked(params: ValidatorIdParams, options?: TxOptions): Promise<PreparedTx> {
    return this.prepare('unstakeClaimPOL', [params.validatorId], options);
  }

  /** Calls the legacy MATIC `stakeFor(user, amount, heimdallFee, acceptDelegation, signerPubkey)`. */
  stakeForMatic(params: StakeForParams, options?: TxOptions): Promise<TxResult> {
    return this.write('stakeFor', stakeForArgs(params), options);
  }

  /** Unsigned {@link stakeForMatic}. */
  prepareStakeForMatic(params: StakeForParams, options?: TxOptions): Promise<PreparedTx> {
    return this.prepare('stakeFor', stakeForArgs(params), options);
  }

  /** Calls `stakeForPOL(user, amount, heimdallFee, acceptDelegation, signerPubkey)`. */
  stakeFor(params: StakeForParams, options?: TxOptions): Promise<TxResult> {
    return this.write('stakeForPOL', stakeForArgs(params), options);
  }

  /** Unsigned {@link stakeFor}. */
  prepareStakeFor(params: StakeForParams, options?: TxOptions): Promise<PreparedTx> {
    return this.prepare('stakeForPOL', stakeForArgs(params), options);
  }

  /** Calls `updateCommissionRate(validatorId, newCommissionRate)`. */
  updateCommissionRate(params: UpdateCommissionRateParams, options?: TxOptions): Promise<TxResult> {
    return this.write('updateCommissionRate', [params.validatorId, params.commissionRate], options);
  }

  /** Unsigned {@link updateCommissionRate}. */
  prepareUpdateCommissionRate(
    params: UpdateCommissionRateParams,
    options?: TxOptions
  ): Promise<PreparedTx> {
    return this.prepare(
      'updateCommissionRate',
      [params.validatorId, params.commissionRate],
      options
    );
  }

  /** Calls `updateSigner(validatorId, signerPubkey)`. */
  updateSigner(params: UpdateSignerParams, options?: TxOptions): Promise<TxResult> {
    return this.write('updateSigner', [params.validatorId, params.signerPubkey], options);
  }

  /** Unsigned {@link updateSigner}. */
  prepareUpdateSigner(params: UpdateSignerParams, options?: TxOptions): Promise<PreparedTx> {
    return this.prepare('updateSigner', [params.validatorId, params.signerPubkey], options);
  }

  // --- reads --------------------------------------------------------

  /** Reads `validators(validatorId)`. */
  async getValidator(params: ValidatorIdParams, options?: TxOptions): Promise<ValidatorInfo> {
    const raw = await this.caller.read<unknown>('validators', [params.validatorId], options);
    const t = toTuple(raw, 13, 'validators');
    return {
      amount: toBigInt(t[0], 'validators.amount'),
      reward: toBigInt(t[1], 'validators.reward'),
      activationEpoch: toBigInt(t[2], 'validators.activationEpoch'),
      deactivationEpoch: toBigInt(t[3], 'validators.deactivationEpoch'),
      jailTime: toBigInt(t[4], 'validators.jailTime'),
      signer: toHexAddress(t[5], 'validators.signer'),
      contractAddress: toHexAddress(t[6], 'validators.contractAddress'),
      status: toBigInt(t[7], 'validators.status'),
      commissionRate: toBigInt(t[8], 'validators.commissionRate'),
      lastCommissionUpdate: toBigInt(t[9], 'validators.lastCommissionUpdate'),
      delegatorsReward: toBigInt(t[10], 'validators.delegatorsReward'),
      delegatedAmount: toBigInt(t[11], 'validators.delegatedAmount'),
      initialRewardPerStake: toBigInt(t[12], 'validators.initialRewardPerStake')
    };
  }

  /** Reads `getValidatorContract(validatorId)` — the validator's ValidatorShare proxy. */
  async getValidatorContract(params: ValidatorIdParams, options?: TxOptions): Promise<Hex> {
    const raw = await this.caller.read<unknown>(
      'getValidatorContract',
      [params.validatorId],
      options
    );
    return toHexAddress(raw, 'getValidatorContract');
  }

  /**
   * Reads `getValidatorId(user)`. On-chain this resolves the owner of
   * the validator NFT, not the signer key.
   */
  getValidatorId(params: { user: Hex }, options?: TxOptions): Promise<bigint> {
    return this.readBigInt('getValidatorId', [params.user], options);
  }

  /** Reads `delegatedAmount(validatorId)`. */
  getDelegatedAmount(params: ValidatorIdParams, options?: TxOptions): Promise<bigint> {
    return this.readBigInt('delegatedAmount', [params.validatorId], options);
  }

  /** Reads `validatorStake(validatorId)`. */
  getValidatorStake(params: ValidatorIdParams, options?: TxOptions): Promise<bigint> {
    return this.readBigInt('validatorStake', [params.validatorId], options);
  }

  /** Reads `minDeposit()`. */
  getMinDeposit(options?: TxOptions): Promise<bigint> {
    return this.readBigInt('minDeposit', [], options);
  }

  /** Reads `minHeimdallFee()`. */
  getMinHeimdallFee(options?: TxOptions): Promise<bigint> {
    return this.readBigInt('minHeimdallFee', [], options);
  }

  /** Reads `WITHDRAWAL_DELAY()`, in epochs. */
  getWithdrawalDelay(options?: TxOptions): Promise<bigint> {
    return this.readBigInt('WITHDRAWAL_DELAY', [], options);
  }

  /** Reads `CHECKPOINT_REWARD()`. */
  getCheckpointReward(options?: TxOptions): Promise<bigint> {
    return this.readBigInt('CHECKPOINT_REWARD', [], options);
  }

  /** Reads `locked()`. */
  async isLocked(options?: TxOptions): Promise<boolean> {
    const raw = await this.caller.read<unknown>('locked', [], options);
    if (typeof raw !== 'boolean') {
      throw new POSBridgeError('BRIDGE_EVENT_DECODE_FAILED', 'locked is not a boolean', {
        field: 'locked',
        valueType: typeof raw
      });
    }
    return raw;
  }

  /** Reads `currentEpoch()`. */
  getCurrentEpoch(options?: TxOptions): Promise<bigint> {
    return this.readBigInt('currentEpoch', [], options);
  }

  /** Reads `currentValidatorSetTotalStake()`. */
  getTotalStaked(options?: TxOptions): Promise<bigint> {
    return this.readBigInt('currentValidatorSetTotalStake', [], options);
  }
}
