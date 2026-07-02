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

import type { Hex, Adapter, PreparedTx, TxResult  } from '../adapter.js';
import type {ContractCallerOptions} from '../internal/contract-caller.js';
import type { Logger } from '../logger.js';

import { RootChainManagerABI } from '../abi/index.js';
import { ContractCaller  } from '../internal/contract-caller.js';

export interface RootChainManagerConfig {
  adapter: Adapter;
  getAddress: () => Promise<Hex>;
  logger: Logger;
  defaultFrom?: Hex;
}

export class RootChainManager {
  readonly #caller: ContractCaller;

  constructor(config: RootChainManagerConfig) {
    this.#caller = new ContractCaller({
      adapter: config.adapter,
      getAddress: config.getAddress,
      abi: RootChainManagerABI,
      isParent: true,
      logger: config.logger,
      defaultFrom: config.defaultFrom
    });
  }

  /** Underlying `ContractCaller`, wired into `POSBridgeHelpers`. */
  get caller(): ContractCaller {
    return this.#caller;
  }

  /**
   * Deposit `depositData` against `tokenAddress` for `userAddress`.
   * The `depositData` shape is type-specific — ABI-encoded amount for
   * ERC-20, encoded tokenId for ERC-721, encoded tuple for ERC-1155.
   */
  deposit(
    userAddress: string,
    tokenAddress: string,
    depositData: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    return this.#caller.write('depositFor', [userAddress, tokenAddress, depositData], options);
  }

  /** Same as {@link deposit} but returns the unsigned `{ to, data, value? }`. */
  prepareDeposit(
    userAddress: string,
    tokenAddress: string,
    depositData: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return this.#caller.prepareWrite('depositFor', [userAddress, tokenAddress, depositData], options);
  }

  /** Submit an exit-payload built by `POSBridgeHelpers.buildExitPayload(...)`. */
  exit(
    exitPayload: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    return this.#caller.write('exit', [exitPayload], options);
  }

  /** Same as {@link exit} but returns the unsigned `{ to, data, value? }`. */
  prepareExit(
    exitPayload: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return this.#caller.prepareWrite('exit', [exitPayload], options);
  }

  /** True iff `exitHash` has already been processed. */
  isExitProcessed(exitHash: string): Promise<boolean> {
    return this.#caller.read<boolean>('processedExits', [exitHash]);
  }
}
