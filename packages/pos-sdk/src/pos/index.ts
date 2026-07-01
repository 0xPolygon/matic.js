/**
 * Public surface of the `pos/` directory after Stage 2's composition refactor.
 *
 * The legacy `POSClient extends BridgeClient<...>` is gone — Stage 3
 * builds the new top-level `POSClient` orchestrator. Until then, this
 * file simply re-exports the surviving typed wrappers so consumers can
 * import them by name:
 *
 *   import { ERC20, ERC721, ERC1155, RootChainManager, RootChain, GasSwapper }
 *     from '@polygonlabs/pos-sdk';
 *
 * `exit_util.ts` and `pos_token.ts` were folded into
 * `internal/pos-bridge-helpers.ts` and deleted from disk.
 */
export { ERC20 } from './erc20.js';
export type { ERC20Config } from './erc20.js';
export { ERC721 } from './erc721.js';
export type { ERC721Config } from './erc721.js';
export { ERC1155 } from './erc1155.js';
export type {
  ERC1155Config,
  POSERC1155DepositParam,
  POSERC1155DepositBatchParam,
  POSERC1155TransferParam
} from './erc1155.js';
export { RootChainManager } from './root_chain_manager.js';
export type { RootChainManagerConfig } from './root_chain_manager.js';
export { RootChain } from './root_chain.js';
export type { RootChainConfig } from './root_chain.js';
export { GasSwapper } from './gas_swapper.js';
export type { GasSwapperConfig } from './gas_swapper.js';
export { findCheckpointSlot } from './find_checkpoint_slot.js';
export type { CheckpointSlotInputs } from './find_checkpoint_slot.js';
