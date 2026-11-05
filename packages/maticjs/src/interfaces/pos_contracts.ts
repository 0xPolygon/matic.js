import type { RootChainManager, RootChain, GasSwapper } from '../pos/index.js';

/**
 * Wiring map exposed by the legacy `POSClient.contracts_` getter.
 *
 * `exitUtil` is no longer in this map — the helper class was
 * folded into `internal/pos-bridge-helpers.ts` (which is not part of
 * the public surface).
 */
export interface IPOSContracts {
  rootChainManager: RootChainManager;
  rootChain: RootChain;
  gasSwapper?: GasSwapper;
}
