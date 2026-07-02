/**
 * Supported PoS bridge networks.
 *
 * The CDN at `ADDRESS_INDEX_URL` exposes one address index per network at
 * `<baseUrl>/<network>/v1/index.json`. New networks are added here once the
 * Polygon ops team publishes a corresponding index.
 */
export type Network = 'mainnet' | 'amoy';

/**
 * Shape of the address index returned by the CDN.
 *
 * `GasSwapper` is optional — it isn't deployed on every network. All other
 * contracts are required for any consumer that uses the bridge.
 *
 * Addresses are typed as `\`0x\${string}\`` (viem's `Address` shape) so they
 * compose with viem's typed contract calls without an extra cast.
 */
export interface NetworkAddresses {
  RootChainManager: `0x${string}`;
  ERC20Predicate: `0x${string}`;
  ERC721Predicate: `0x${string}`;
  ERC1155Predicate: `0x${string}`;
  EtherPredicate: `0x${string}`;
  RootChain: `0x${string}`;
  GasSwapper?: `0x${string}`;
  /**
   * Mintable-ERC-1155 predicate. Optional — only some networks deploy a
   * dedicated predicate for mint-on-exit ERC-1155 tokens. When absent,
   * `ERC1155.approveAllForMintable` throws
   * `POSBridgeError('CONTRACT_NOT_AVAILABLE_ON_NETWORK')`.
   */
  MintableERC1155Predicate?: `0x${string}`;
}

/**
 * Default base URL for the CDN-hosted address index. Override per
 * `POSClient.init` for staging, mirrors, or air-gapped deployments.
 *
 * Concrete URLs resolve as `${ADDRESS_INDEX_URL}/${network}/v1/index.json`.
 */
export const ADDRESS_INDEX_URL = 'https://static.polygon.technology/network';

/**
 * Child-chain `StateReceiver` system contract.
 *
 * This is a Polygon genesis (predeployed) contract that lives at a fixed,
 * deterministic address baked into the bor genesis block — `0x…1001` on
 * BOTH mainnet and Amoy. Genesis system contracts never redeploy, so the
 * address is a compile-time constant rather than something fetched from
 * the CDN address index (which is why it is NOT part of
 * {@link NetworkAddresses}). `isDeposited` reads `lastStateId()` here to
 * confirm a deposit's state-sync has landed on the child chain.
 */
export const STATE_RECEIVER_ADDRESS = '0x0000000000000000000000000000000000001001' as const;
