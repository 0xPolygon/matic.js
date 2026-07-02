/**
 * `RootChain` — typed wrapper around the parent-chain `RootChain`
 * contract. Composes a single `ContractCaller`; no inheritance.
 *
 * The methods exposed here are the small subset the bridge actually
 * uses: the last-child-block reader (used by every `isCheckpointed`
 * gate) and the binary-search slot finder. `POSBridgeHelpers` calls
 * the same `ContractCaller` directly when building exit payloads, so
 * this class is *not* the only entry point — but consumers of the
 * public surface (Stage 3's `POSClient.rootChain` getter) want a
 * stable typed handle, hence the dedicated class.
 */

import type { BlockTag, Hex, Adapter  } from '../adapter.js';
import type { Logger } from '../logger.js';

import { RootChainABI } from '../abi/index.js';
import { ContractCaller } from '../internal/contract-caller.js';
import { findCheckpointSlot } from './find_checkpoint_slot.js';

export interface RootChainConfig {
  adapter: Adapter;
  /** Resolves the deployed `RootChain` proxy address. */
  getAddress: () => Promise<Hex>;
  logger: Logger;
  defaultFrom?: Hex;
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

const DEFAULT_ROOT_CHAIN_BLOCK: BlockTag = 'safe';

export class RootChain {
  readonly #caller: ContractCaller;
  readonly #defaultBlock: BlockTag;

  constructor(config: RootChainConfig) {
    this.#defaultBlock = config.defaultBlock ?? DEFAULT_ROOT_CHAIN_BLOCK;
    this.#caller = new ContractCaller({
      adapter: config.adapter,
      getAddress: config.getAddress,
      abi: RootChainABI,
      isParent: true,
      logger: config.logger,
      defaultFrom: config.defaultFrom
    });
  }

  /** Underlying `ContractCaller` — wired into `POSBridgeHelpers`. */
  get caller(): ContractCaller {
    return this.#caller;
  }

  /**
   * Returns the highest child-chain block number that has been
   * checkpointed onto the parent chain. The bridge uses this as the
   * "is the burn tx safe to exit?" gate.
   */
  async getLastChildBlock(): Promise<bigint> {
    const v = await this.#caller.read<bigint | string>('getLastChildBlock', [], {
      blockTag: this.#defaultBlock
    });
    return BigInt(v);
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
    const blockTag = this.#defaultBlock;
    return findCheckpointSlot({
      childBlockNumber,
      readCurrentHeaderBlock: async () => {
        const v = await this.#caller.read<bigint | string>('currentHeaderBlock', [], { blockTag });
        return BigInt(v);
      },
      readHeaderBlocks: async (headerId: bigint) => {
        const headerBlock = await this.#caller.read<{
          start: bigint | string;
          end: bigint | string;
        }>('headerBlocks', [`0x${headerId.toString(16)}`], { blockTag });
        return {
          start: BigInt(headerBlock.start),
          end: BigInt(headerBlock.end)
        };
      }
    });
  }
}
