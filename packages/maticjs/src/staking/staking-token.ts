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

import { PolTokenABI } from '../abi/index.js';
import { MAX_AMOUNT } from '../constant.js';
import { POSBridgeError } from '../errors.js';
import { ContractCaller } from '../internal/contract-caller.js';
import { buildPermitTypedData } from './permit.js';
import { pinChainId, toBigInt, toHexAddress, toTuple } from './stake-manager.js';

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

function toChainIdNumber(value: unknown): number {
  const id = toBigInt(value, 'eip712Domain.chainId');
  if (id > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new POSBridgeError(
      'BRIDGE_EVENT_DECODE_FAILED',
      'eip712Domain chainId exceeds the safe integer range',
      {
        field: 'eip712Domain.chainId'
      }
    );
  }
  return Number(id);
}

export class StakingToken {
  /** `true` for POL; MATIC has no EIP-2612 `permit`. */
  readonly supportsPermit: boolean;
  private readonly caller: ContractCaller;
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
    this.caller = new ContractCaller({
      adapter: config.adapter,
      getAddress: config.getAddress,
      abi: PolTokenABI,
      isParent: true,
      logger: config.logger
    });
  }

  /** The token address currently resolved from the address index. */
  getAddress(): Promise<Hex> {
    return this.caller.getContractAddress();
  }

  private async readBigInt(
    method: string,
    args: readonly unknown[],
    options?: TxOptions
  ): Promise<bigint> {
    return toBigInt(await this.caller.read<unknown>(method, args, options), method);
  }

  private assertPermit(method: string): void {
    if (!this.supportsPermit) {
      throw new POSBridgeError(
        'PERMIT_NOT_SUPPORTED',
        `${this.tokenLabel} does not implement EIP-2612 permit`,
        {
          token: this.tokenLabel,
          method
        }
      );
    }
  }

  // --- writes -------------------------------------------------------

  /** Calls `approve(stakeManager, amount)`. */
  async approveStakeManager(params: { amount: bigint }, options?: TxOptions): Promise<TxResult> {
    const spender = await this.getStakeManagerAddress();
    return this.caller.write(
      'approve',
      [spender, params.amount],
      pinChainId(options, this.l1ChainId)
    );
  }

  /** Unsigned {@link approveStakeManager}. */
  async prepareApproveStakeManager(
    params: { amount: bigint },
    options?: TxOptions
  ): Promise<PreparedTx> {
    const spender = await this.getStakeManagerAddress();
    return this.caller.prepareWrite(
      'approve',
      [spender, params.amount],
      pinChainId(options, this.l1ChainId)
    );
  }

  /** Calls `approve(stakeManager, 2^256 - 1)`. */
  approveMaxForStakeManager(options?: TxOptions): Promise<TxResult> {
    return this.approveStakeManager({ amount: MAX_AMOUNT }, options);
  }

  /** Unsigned {@link approveMaxForStakeManager}. */
  prepareApproveMaxForStakeManager(options?: TxOptions): Promise<PreparedTx> {
    return this.prepareApproveStakeManager({ amount: MAX_AMOUNT }, options);
  }

  // --- reads --------------------------------------------------------

  /** Reads `balanceOf(user)`. */
  getBalance(params: { user: Hex }, options?: TxOptions): Promise<bigint> {
    return this.readBigInt('balanceOf', [params.user], options);
  }

  /** Reads `allowance(owner, stakeManager)`. */
  async getAllowanceForStakeManager(params: { owner: Hex }, options?: TxOptions): Promise<bigint> {
    const spender = await this.getStakeManagerAddress();
    return this.readBigInt('allowance', [params.owner, spender], options);
  }

  /** Reads the EIP-2612 `nonces(owner)`. Throws `PERMIT_NOT_SUPPORTED` on MATIC. */
  async getNonce(params: { owner: Hex }, options?: TxOptions): Promise<bigint> {
    this.assertPermit('getNonce');
    return this.readBigInt('nonces', [params.owner], options);
  }

  /**
   * Build the EIP-712 typed data for a POL `permit`, for the consumer to
   * sign with its own wallet. The domain is read from the token's
   * `eip712Domain()` rather than hardcoded, so a token upgrade that
   * changes name or version cannot silently produce signatures the
   * contract rejects. Throws `PERMIT_NOT_SUPPORTED` on MATIC.
   */
  async preparePermit(params: PreparePermitParams, options?: TxOptions): Promise<PermitTypedData> {
    this.assertPermit('preparePermit');
    const [domainRaw, nonce, spender] = await Promise.all([
      this.caller.read<unknown>('eip712Domain', [], options),
      this.readBigInt('nonces', [params.owner], options),
      params.spender === undefined ? this.getStakeManagerAddress() : Promise.resolve(params.spender)
    ]);
    // Outputs: [fields, name, version, chainId, verifyingContract, salt, extensions]
    const d = toTuple(domainRaw, 5, 'eip712Domain');
    const name = d[1];
    const version = d[2];
    if (typeof name !== 'string' || typeof version !== 'string') {
      throw new POSBridgeError(
        'BRIDGE_EVENT_DECODE_FAILED',
        'eip712Domain name/version are not strings',
        {
          field: 'eip712Domain'
        }
      );
    }
    const deadline =
      params.deadline ?? BigInt(Math.floor(Date.now() / 1000) + DEFAULT_PERMIT_TTL_SECONDS);
    return buildPermitTypedData({
      domain: {
        name,
        version,
        chainId: toChainIdNumber(d[3]),
        verifyingContract: toHexAddress(d[4], 'eip712Domain.verifyingContract')
      },
      owner: params.owner,
      spender,
      value: params.value,
      nonce,
      deadline
    });
  }
}
