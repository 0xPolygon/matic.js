// Interface barrel — kept lean after Stage 2's composition refactor.
//
// Removed:
//   - `error.ts`         (legacy IError; replaced by POSBridgeError class)
//   - `plugin.ts`        (legacy Web3 plugin runtime; deleted in Stage 0)
//   - `map_promise_option.ts` (helper deleted; concurrency lives on `withConcurrency`)
//   - `zkevm_client_config.ts`, `zkevm_contracts.ts` (Stage 7 — moved
//     to `@polygonlabs/zkevm-sdk`)
export * from './method.js';
export * from './transaction_config.js';
export * from './transaction_result.js';
export * from './transaction_option.js';
export * from './contract_init_param.js';
export * from './tx_receipt.js';
export * from './pos_client_config.js';
export * from './transaction_data.js';
export * from './block.js';
export * from './block_with_transaction.js';
export * from './rpc_request_payload.js';
export * from './rpc_response_payload.js';
export * from './base_client_config.js';
export * from './pos_contracts.js';
export * from './root_block_info.js';
export * from './allowance_transaction_option.js';
export * from './approve_transaction_option.js';
export * from './exit_transaction_option.js';
export * from './bridge_transaction_option.js';
