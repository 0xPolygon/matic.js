/**
 * `StakingToken` — the MATIC and POL ERC-20s as the staking flows use
 * them: balance, allowance and approval against the StakeManager proxy
 * (the contract that pulls tokens on delegate/stake), plus the POL
 * EIP-2612 permit helpers.
 *
 * Both tokens share one ABI: the ERC-20 surface (`approve`,
 * `balanceOf`, `allowance`) has identical selectors on MATIC and POL,
 * and the permit-only functions are only ever called when
 * `supportsPermit` is true.
 */

import type { Hex, PreparedTx, TxResult } from '../adapter.js';
import type { TxOptions } from '../types.js';
import type { PermitTypedData } from './permit.js';
import type { StakingContractConfig } from './stake-manager.js';

import { PolTokenABI } from '../abi/PolToken.js';
import { MAX_AMOUNT } from '../constant.js';
import {
  AddressLookupError,
  BridgeEventDecodeFailedError,
  PermitError,
  PermitNotSupportedError,
  StakingReadError,
  StakingWriteError,
  withOperation
} from '../errors.js';
import { ContractCaller } from '../internal/contract-caller.js';
import { buildPermitTypedData } from './permit.js';
import { pinChainId } from './stake-manager.js';

/** Permit lifetime when the caller does not pass one; matches the 3.x staking plugin. */
const DEFAULT_PERMIT_TTL_SECONDS = 1800;

export interface PreparePermitParams {
  /** The token holder who will sign. */
  owner: Hex;
  value: bigint;
  /** Defaults to the StakeManager proxy, which is what pulls tokens on delegation. */
  spender?: Hex;
  /** Unix seconds. Defaults to now + 30 minutes. */
  deadline?: bigint;
}

function toChainIdNumber(id: bigint): number {
  if (id > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BridgeEventDecodeFailedError('eip712Domain chainId exceeds the safe integer range', {
      info: {
        field: 'eip712Domain.chainId'
      }
    });
  }
  return Number(id);
}

/**
 * Every public method wraps a condition the SDK detects in one operation
 * error named for the call: `StakingReadError` for reads,
 * `StakingWriteError` for approvals and their `prepare*` twins,
 * `PermitError` for `preparePermit`, `AddressLookupError` for `getAddress`.
 * A wallet, node or library error is rethrown unchanged.
 */
export class StakingToken {
  /** `true` for POL; MATIC has no EIP-2612 `permit`. */
  readonly supportsPermit: boolean;
  readonly #caller: ContractCaller<typeof PolTokenABI>;
  private readonly l1ChainId: number;
  private readonly getStakeManagerAddress: () => Promise<Hex>;
  private readonly tokenLabel: string;

  constructor(
    config: StakingContractConfig & {
      getStakeManagerAddress: () => Promise<Hex>;
      supportsPermit: boolean;
      /** Names the token in error messages and `info`. */
      tokenLabel: string;
    }
  ) {
    this.supportsPermit = config.supportsPermit;
    this.l1ChainId = config.l1ChainId;
    this.getStakeManagerAddress = config.getStakeManagerAddress;
    this.tokenLabel = config.tokenLabel;
    this.#caller = new ContractCaller({
      adapter: config.adapter,
      getAddress: config.getAddress,
      abi: PolTokenABI,
      isParent: true,
      logger: config.logger
    });
  }

  /** The token address currently resolved from the address index. */
  async getAddress(): Promise<Hex> {
    return withOperation({
      error: AddressLookupError,
      info: { operation: 'getAddress', mode: 'read' },
      run: () => this.#caller.getContractAddress()
    });
  }

  private assertPermit(method: string): void {
    if (!this.supportsPermit) {
      throw new PermitNotSupportedError(`${this.tokenLabel} does not implement EIP-2612 permit`, {
        info: {
          token: this.tokenLabel,
          method
        }
      });
    }
  }

  // --- writes -------------------------------------------------------

  /** Calls `approve(stakeManager, amount)`. */
  async approveStakeManager(params: { amount: bigint }, options?: TxOptions): Promise<TxResult> {
    return withOperation({
      error: StakingWriteError,
      info: { operation: 'approveStakeManager', mode: 'write', method: 'approve' },
      run: async () => {
        const spender = await this.getStakeManagerAddress();
        return this.#caller.write(
          'approve',
          [spender, params.amount],
          pinChainId(options, this.l1ChainId)
        );
      }
    });
  }

  /** Unsigned {@link approveStakeManager}. */
  async prepareApproveStakeManager(
    params: { amount: bigint },
    options?: TxOptions
  ): Promise<PreparedTx> {
    return withOperation({
      error: StakingWriteError,
      info: { operation: 'prepareApproveStakeManager', mode: 'prepare', method: 'approve' },
      run: async () => {
        const spender = await this.getStakeManagerAddress();
        return this.#caller.prepareWrite(
          'approve',
          [spender, params.amount],
          pinChainId(options, this.l1ChainId)
        );
      }
    });
  }

  /** Calls `approve(stakeManager, 2^256 - 1)`. */
  async approveMaxForStakeManager(options?: TxOptions): Promise<TxResult> {
    return withOperation({
      error: StakingWriteError,
      info: { operation: 'approveMaxForStakeManager', mode: 'write', method: 'approve' },
      run: () => this.approveStakeManager({ amount: MAX_AMOUNT }, options)
    });
  }

  /** Unsigned {@link approveMaxForStakeManager}. */
  async prepareApproveMaxForStakeManager(options?: TxOptions): Promise<PreparedTx> {
    return withOperation({
      error: StakingWriteError,
      info: { operation: 'prepareApproveMaxForStakeManager', mode: 'prepare', method: 'approve' },
      run: () => this.prepareApproveStakeManager({ amount: MAX_AMOUNT }, options)
    });
  }

  // --- reads --------------------------------------------------------

  /** Reads `balanceOf(user)`. */
  async getBalance(params: { user: Hex }, options?: TxOptions): Promise<bigint> {
    return withOperation({
      error: StakingReadError,
      info: { operation: 'getBalance', mode: 'read', method: 'balanceOf' },
      run: () => this.#caller.read('balanceOf', [params.user], options)
    });
  }

  /** Reads `allowance(owner, stakeManager)`. */
  async getAllowanceForStakeManager(params: { owner: Hex }, options?: TxOptions): Promise<bigint> {
    return withOperation({
      error: StakingReadError,
      info: { operation: 'getAllowanceForStakeManager', mode: 'read', method: 'allowance' },
      run: async () => {
        const spender = await this.getStakeManagerAddress();
        return this.#caller.read('allowance', [params.owner, spender], options);
      }
    });
  }

  /**
   * Reads the EIP-2612 `nonces(owner)`. On MATIC, rejects with a
   * `StakingReadError` caused by `PermitNotSupportedError`.
   */
  async getNonce(params: { owner: Hex }, options?: TxOptions): Promise<bigint> {
    return withOperation({
      error: StakingReadError,
      info: { operation: 'getNonce', mode: 'read', method: 'nonces' },
      run: async () => {
        this.assertPermit('getNonce');
        return this.#caller.read('nonces', [params.owner], options);
      }
    });
  }

  /**
   * Build the EIP-712 typed data for a POL `permit`, for the consumer to
   * sign with its own wallet. The domain is read from the token's
   * `eip712Domain()` rather than hardcoded, so a token upgrade that
   * changes name or version cannot silently produce signatures the
   * contract rejects. On MATIC, rejects with a `PermitError` caused by
   * `PermitNotSupportedError`.
   */
  async preparePermit(params: PreparePermitParams, options?: TxOptions): Promise<PermitTypedData> {
    return withOperation({
      error: PermitError,
      info: { operation: 'preparePermit', mode: 'prepare' },
      run: async () => {
        this.assertPermit('preparePermit');
        const [domain, nonce, spender] = await Promise.all([
          this.#caller.read('eip712Domain', [], options),
          this.#caller.read('nonces', [params.owner], options),
          params.spender === undefined
            ? this.getStakeManagerAddress()
            : Promise.resolve(params.spender)
        ]);
        // Outputs: [fields, name, version, chainId, verifyingContract, salt, extensions]
        const [, name, version, chainId, verifyingContract] = domain;
        const deadline =
          params.deadline ?? BigInt(Math.floor(Date.now() / 1000) + DEFAULT_PERMIT_TTL_SECONDS);
        return buildPermitTypedData({
          domain: {
            name,
            version,
            chainId: toChainIdNumber(chainId),
            verifyingContract
          },
          owner: params.owner,
          spender,
          value: params.value,
          nonce,
          deadline
        });
      }
    });
  }
}
