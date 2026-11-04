/**
 * Public surface of `@polygonlabs/maticjs` 1.0.
 *
 * Stage 3 collapses the previously-broad re-export to the minimal set
 * of named symbols a consumer actually needs:
 *
 * - `POSClient`               — top-level orchestrator; `POSClient.init(config)`
 * - `POSBridgeError` / type `POSBridgeErrorCode` — discriminated error class
 * - type `Logger`              — structural logger contract
 * - `noopLogger`               — explicit no-op default
 * - type `Network` / type `NetworkAddresses` — address-index targets
 * - type `POSClientConfig`     — top-level config
 * - type `Adapter`             — the parent/child client contract; the
 *                              return type of the per-library adapter
 *                              factories, exposed so consumers can type
 *                              their own wiring
 * - type `TxResult` / type `Receipt` / type `ReceiptLog` / type `Hex`
 *                              — write/read primitives
 * - type `TxOptions`           — per-call transaction overrides
 * - `sanitiseError`            — RPC-token redactor for consumer log middleware
 *
 * Adapters are NOT reached through this entry. Each lives behind its own
 * subpath so a consumer pulls in only the web3 library they use:
 *   - `@polygonlabs/maticjs/viem`      → `viemAdapter`
 *   - `@polygonlabs/maticjs/ethers-v5` → `ethersV5Adapter`
 *   - `@polygonlabs/maticjs/ethers-v6` → `ethersV6Adapter`
 * The main entry imports no viem / ethers value, so importing the SDK
 * never crashes when only one (or neither) library is installed.
 *
 * The `as const` ABIs (sourced from `@polygonlabs/meta` at build time)
 * are exposed at `@polygonlabs/maticjs/abi`. Pair them with
 * `pos.getAddresses()` and your own client to call contract methods the
 * SDK doesn't wrap directly (the escape hatch that replaces the 0.x
 * `.method(...)` accessor).
 *
 * Internal surface intentionally NOT exported:
 *   - `ContractCaller`, `POSBridgeHelpers`, the adapter classes
 *     (`ViemAdapter`, `EthersV5Adapter`, `EthersV6Adapter` — reach them
 *     via the subpath factories, not by class)
 *   - the legacy `interfaces/*` interface zoo, the abi barrel,
 *     `services/*`, `internal/*`, `utils/*`
 *
 * No `export default`. Every export is named so consumers' tree-shakers
 * see exactly what they pull in.
 */

// Top-level entry point.
export { POSClient } from './pos-client.js';

// Errors — single class, switch on `code`.
export { POSBridgeError } from './errors.js';
export type { LegacyErrorType, POSBridgeErrorCode } from './errors.js';

// Logger surface — bring your own pino-shaped logger, or use the no-op.
export { noopLogger } from './logger.js';
export type { Logger } from './logger.js';

// RPC-token sanitiser for consumer-side log middleware.
export { sanitiseError } from './adapters/index.js';

// Public types. Re-exported from `./types.js` so consumers have a
// single import target for everything type-only.
export type {
  Adapter,
  Hex,
  Network,
  NetworkAddresses,
  POSClientConfig,
  PreparedTx,
  Receipt,
  ReceiptLog,
  TxOptions,
  TxResult
} from './types.js';

// Named types for every value POSClient hands out, so consumers can
// annotate their own signatures (`function sweep(token: ERC20)`,
// `const ns: TokenNamespace = pos.parent`) without resorting to
// `ReturnType<...>` gymnastics. Exported as types only — instances are
// constructed exclusively through `POSClient.init`.
export type { TokenNamespace } from './pos-client.js';
export type { ERC20 } from './pos/erc20.js';
export type { ERC721 } from './pos/erc721.js';
export type {
  ERC1155,
  POSERC1155DepositBatchParam,
  POSERC1155DepositParam,
  POSERC1155TransferParam
} from './pos/erc1155.js';
export type { RootChain } from './pos/root_chain.js';
export type { RootChainManager } from './pos/root_chain_manager.js';
export type { BlockTag } from './adapter.js';

// Burn-event signatures for the flat exit helpers (`buildExitPayload`,
// `isWithdrawn`, …), which take the event signature as a parameter.
// Exported as a VALUE so consumers don't have to hand-copy 32-byte
// topic hashes out of a block explorer — `LogEventSignature.Erc20Transfer`
// et al. are the exact constants the SDK's own token classes pass.
export { LogEventSignature } from './constant.js';
