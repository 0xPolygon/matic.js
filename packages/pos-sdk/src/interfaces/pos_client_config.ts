import type { IBaseClientConfig } from './base_client_config.js';

export interface IPOSERC1155Address {
  mintablePredicate?: string;
}

export interface IPOSClientConfig extends IBaseClientConfig {
  rootChainManager?: string;
  rootChain?: string;
  erc1155?: IPOSERC1155Address;
  rootChainDefaultBlock?: string;
  gasSwapper?: string;
}
