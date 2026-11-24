/**
 * `RootChain` — typed wrapper around the parent-chain `RootChain`
 * contract. Composes a single `ContractCaller`; no inheritance.
 *
 * The methods exposed here are the small subset the bridge actually
 * uses: the last-child-block reader (used by every `getCheckpointStatus`
 * gate) and the binary-search slot finder. `POSBridgeHelpers` calls
 * the same `ContractCaller` directly when building exit payloads, so
 * this class is *not* the only entry point — but consumers of the
 * public surface (the `POSClient.rootChain` getter) want a
 * stable typed handle, hence the dedicated class.
 */

import type { BlockTag, Hex, Adapter } from '../adapter.js';
import type { Logger } from '../logger.js';

import { RootChainABI } from '../abi/RootChain.js';
import { CheckpointReadError, withOperation } from '../errors.js';
import { ContractCaller } from '../internal/contract-caller.js';
import { findCheckpointSlot } from './find_checkpoint_slot.js';

interface RootChainWiring {
  adapter: Adapter;
  /** Resolves the deployed `RootChain` proxy address. */
  getAddress: () => Promise<Hex>;
  logger: Logger;
  defaultFrom?: Hex;
  /** Pinned id of the chain this contract is on; see `ContractCallerConfig.chainId`. */
  chainId?: number;
}

interface RootChainSettings {
  /**
   * L1 block tag every checkpoint read pins to. Defaults to `'safe'`:
   * reading `getLastChildBlock` / `currentHeaderBlock` / `headerBlocks`
   * at `'latest'` can observe an un-finalised checkpoint that is reorged
   * out before the exit payload reaches L1. All reads in
   * {@link findRootBlockFromChild} and {@link getLastChildBlock} share
   * this tag so the existence check and the header lookup observe a
   * consistent chain view.
   */
  defaultBlock?: BlockTag;
}

/**
 * Either the fields the handle builds its own caller from, or a caller built
 * elsewhere. The client builds it once and hands the same object to the
 * exit-proof builder, which is how they share it without the handle exposing it.
 */
export type RootChainConfig = RootChainSettings &
  (RootChainWiring | { caller: ContractCaller<typeof RootChainABI> });

const DEFAULT_ROOT_CHAIN_BLOCK: BlockTag = 'safe';

export class RootChain {
  readonly #caller: ContractCaller<typeof RootChainABI>;
  readonly defaultBlock: BlockTag;

  constructor(config: RootChainConfig) {
    this.defaultBlock = config.defaultBlock ?? DEFAULT_ROOT_CHAIN_BLOCK;
    if ('caller' in config) {
      const { caller } = config;
      this.#caller = caller;
    } else {
      this.#caller = new ContractCaller({
        adapter: config.adapter,
        getAddress: config.getAddress,
        abi: RootChainABI,
        isParent: true,
        logger: config.logger,
        defaultFrom: config.defaultFrom,
        chainId: config.chainId
      });
    }
  }

  /**
   * Returns the highest child-chain block number that has been
   * checkpointed onto the parent chain. The bridge uses this as the
   * "is the burn tx safe to exit?" gate.
   */
  async getLastChildBlock(): Promise<bigint> {
    return withOperation({
      error: CheckpointReadError,
      info: { operation: 'getLastChildBlock', mode: 'read', method: 'getLastChildBlock' },
      run: () => this.#caller.read('getLastChildBlock', [], { blockTag: this.defaultBlock })
    });
  }

  /**
   * Resolve the parent-chain header-block id that contains the given
   * child-chain block number. Wraps the binary-search helper.
   *
   * Both the existence check (`isCheckPointed_`) and the lookups
   * inside `findCheckpointSlot` should observe the same L1 block tag —
   * `defaultBlock` from the constructor is forwarded to every read
   * here so the search and the existence check see a consistent view.
   */
  async findRootBlockFromChild(childBlockNumber: bigint): Promise<bigint> {
    const blockTag = this.defaultBlock;
    return withOperation({
      error: CheckpointReadError,
      info: { operation: 'findRootBlockFromChild', mode: 'read' },
      run: () =>
        findCheckpointSlot({
          childBlockNumber,
          readCurrentHeaderBlock: () => this.#caller.read('currentHeaderBlock', [], { blockTag }),
          readHeaderBlocks: async (headerId: bigint) => {
            const [, start, end] = await this.#caller.read('headerBlocks', [headerId], {
              blockTag
            });
            return { start, end };
          }
        })
    });
  }
}
