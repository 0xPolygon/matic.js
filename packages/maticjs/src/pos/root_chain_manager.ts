/**
 * `RootChainManager` — typed wrapper around the parent-chain
 * `RootChainManager` contract.
 *
 * This is the entry-point for every cross-chain operation: deposits
 * (every variant of `depositFor`), the global `exit` call, and the
 * `processedExits` map readback. The class composes a single
 * `ContractCaller`; the corresponding contract address is fetched via
 * `getAddress` so address-index TTL refreshes are honoured.
 */

import type { Hex, Adapter, PreparedTx, TxResult } from '../adapter.js';
import type { ContractCallerOptions } from '../internal/contract-caller.js';
import type { Logger } from '../logger.js';

import { RootChainManagerABI } from '../abi/index.js';
import { DepositError, ExitError, BridgeStatusError, withOperation } from '../errors.js';
import { ContractCaller } from '../internal/contract-caller.js';

export interface RootChainManagerConfig {
  adapter: Adapter;
  getAddress: () => Promise<Hex>;
  logger: Logger;
  defaultFrom?: Hex;
  /** Pinned id of the chain this contract is on; see `ContractCallerConfig.chainId`. */
  chainId?: number;
}

export class RootChainManager {
  /**
   * @internal — wiring hook for POSClient's construction of the bridge
   * helpers. ContractCaller is not part of the public API contract and
   * may change shape in any release; consumers should treat this
   * member as non-existent.
   */
  readonly caller: ContractCaller;

  constructor(config: RootChainManagerConfig) {
    this.caller = new ContractCaller({
      adapter: config.adapter,
      getAddress: config.getAddress,
      abi: RootChainManagerABI,
      isParent: true,
      logger: config.logger,
      defaultFrom: config.defaultFrom,
      chainId: config.chainId
    });
  }

  /**
   * Deposit `depositData` against `tokenAddress` for `userAddress`.
   * The `depositData` shape is type-specific — ABI-encoded amount for
   * ERC-20, encoded tokenId for ERC-721, encoded tuple for ERC-1155.
   */
  async deposit(
    userAddress: string,
    tokenAddress: string,
    depositData: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    return withOperation({
      error: DepositError,
      info: { operation: 'deposit', mode: 'write', tokenAddress, method: 'depositFor' },
      run: () => this.caller.write('depositFor', [userAddress, tokenAddress, depositData], options)
    });
  }

  /** Same as {@link deposit} but returns the unsigned `{ to, data, value? }`. */
  async prepareDeposit(
    userAddress: string,
    tokenAddress: string,
    depositData: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return withOperation({
      error: DepositError,
      info: { operation: 'prepareDeposit', mode: 'prepare', tokenAddress, method: 'depositFor' },
      run: () =>
        this.caller.prepareWrite('depositFor', [userAddress, tokenAddress, depositData], options)
    });
  }

  /** Submit an exit-payload built by `POSBridgeHelpers.buildExitPayload(...)`. */
  async exit(exitPayload: string, options: ContractCallerOptions = {}): Promise<TxResult> {
    return withOperation({
      error: ExitError,
      info: { operation: 'exit', mode: 'write', method: 'exit' },
      run: () => this.caller.write('exit', [exitPayload], options)
    });
  }

  /** Same as {@link exit} but returns the unsigned `{ to, data, value? }`. */
  async prepareExit(exitPayload: string, options: ContractCallerOptions = {}): Promise<PreparedTx> {
    return withOperation({
      error: ExitError,
      info: { operation: 'prepareExit', mode: 'prepare', method: 'exit' },
      run: () => this.caller.prepareWrite('exit', [exitPayload], options)
    });
  }

  /** True iff `exitHash` has already been processed. */
  async isExitProcessed(exitHash: string): Promise<boolean> {
    return withOperation({
      error: BridgeStatusError,
      info: { operation: 'isExitProcessed', mode: 'read', method: 'processedExits' },
      run: () => this.caller.read<boolean>('processedExits', [exitHash])
    });
  }
}
