/**
 * Generic base shape every chain-specific client config extends.
 *
 * `provider` is `unknown` rather than `any` — the concrete provider
 * type is the consumer's responsibility (`viem.PublicClient`,
 * `ethers.providers.Provider`, etc.) and the SDK does not look at the
 * field directly.
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
