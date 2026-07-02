/**
 * Public configuration types for `@polygonlabs/pos-sdk`.
 *
 * This module is the canonical surface consumers import from. Everything
 * here is either:
 *
 * - re-exported from one of the SDK's internal modules (so consumers
 *   never have to know which file the type lives in), or
 * - declared here when the public type doesn't exist anywhere internal
 *   (i.e., {@link POSClientConfig}).
 *
 * The matching value-side surface (the `POSClient` class, helpers,
 * errors) is exported from `index.ts`. Types belong here so type-only
 * imports stay cheap and don't force consumers to drag in runtime
 * dependencies.
 */

import type { POSClientConfig as _POSClientConfig } from './pos-client.js';

// Adapter primitives consumers compose against.
export type { Hex, TxResult, Receipt, ReceiptLog, PreparedTx } from './adapter.js';

// The parent/child client contract. Consumers construct an `Adapter`
// via a per-library factory (`viemAdapter` / `ethersV5Adapter` /
// `ethersV6Adapter`, each behind its own subpath) and pass it as
// `POSClientConfig.parent` / `.child`. Exposed so consumers can type
// their own adapter-holding wiring.
export type { Adapter } from './adapter.js';

// Networks supported by the address index (currently `'mainnet' | 'amoy'`).
// The `NetworkAddresses` shape is the index payload — opt in to
// supplying it directly via `POSClientConfig.addresses` in air-gapped
// or staging deployments.
export type { Network, NetworkAddresses } from './networks.js';

// Logger contract — structural, accepts any pino-shaped logger.
export type { Logger } from './logger.js';

// Per-call transaction overrides (gas limit, nonce, fee caps, sender).
// `TxOptions` is the public alias; `ContractCallerOptions` is the
// internal name and is re-exported under the new name to give the
// public surface a consumer-facing identity.
export type { ContractCallerOptions as TxOptions } from './internal/contract-caller.js';

// Top-level config for `POSClient.init`. Indirect re-export so the
// `POSClient` class sources the canonical definition.
export type POSClientConfig = _POSClientConfig;
