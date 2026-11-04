/**
 * Generic base shape every chain-specific client config extends.
 *
 * Stage 2 narrows `provider: any` to `unknown` — the concrete provider
 * type is the consumer's responsibility (`viem.PublicClient`,
 * `ethers.providers.Provider`, etc.) and the SDK does not look at the
 * field directly. Stage 3 redesigns this interface in light of the
 * adapter layer.
 */
export interface IBaseClientConfig {
  network: string;
  version: string;
  parent?: {
    provider: unknown;
    defaultConfig: {
      from: string;
    };
  };
  child?: {
    provider: unknown;
    defaultConfig: {
      from: string;
    };
  };
  log?: boolean;
  proofConcurrency?: number;
}
