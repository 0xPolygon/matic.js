/**
 * Public surface of `@polygonlabs/pos-sdk` 1.0.
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
 *   - `@polygonlabs/pos-sdk/viem`      → `viemAdapter`
 *   - `@polygonlabs/pos-sdk/ethers-v5` → `ethersV5Adapter`
 *   - `@polygonlabs/pos-sdk/ethers-v6` → `ethersV6Adapter`
 * The main entry imports no viem / ethers value, so importing the SDK
 * never crashes when only one (or neither) library is installed.
 *
 * The `as const` ABIs (sourced from `@polygonlabs/meta` at build time)
 * are exposed at `@polygonlabs/pos-sdk/abi`. Pair them with
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
export type { POSBridgeErrorCode } from './errors.js';

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
