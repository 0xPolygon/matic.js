import type { RootChainManager, RootChain, GasSwapper } from '../pos/index.js';

/**
 * Wiring map exposed by the legacy `POSClient.contracts_` getter.
 *
 * Stage 2 dropped `exitUtil` from this map — the helper class was
 * folded into `internal/pos-bridge-helpers.ts` (which is not part of
 * the public surface). Stage 3 redesigns this interface alongside
 * the new `POSClient` orchestrator.
 */
export interface IPOSContracts {
  rootChainManager: RootChainManager;
  rootChain: RootChain;
  gasSwapper?: GasSwapper;
}
