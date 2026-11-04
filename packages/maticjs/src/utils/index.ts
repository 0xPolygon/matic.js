// Utility re-exports kept after Stage 2's composition refactor.
//
// `proof_util` and `merkle_tree` carry the bridge's RLP / MPT primitives;
// `buffer-utils` and `keccak` are their dependencies. Everything else
// (`map_promise`, `web3_side_chain_client`, `base_token`, `error_helper`,
// `logger`, `legacy_stubs`, `converter`) was deleted in Stage 0 / Stage 2.
//
// `zkevm_bridge_client` lives on disk but is excluded from the compile
// pass via tsconfig — Stage 7 extracts the zkEVM flow into its own
// package and removes both this comment and the underlying file.
export * from './proof_util.js';
export * from './buffer-utils.js';
export * from './keccak.js';
export * from './merkle_tree.js';
export * from './types.js';
