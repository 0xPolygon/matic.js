/**
 * `StakingClient` — entry point for Polygon PoS validator and delegator
 * staking, served from `@polygonlabs/maticjs/staking`.
 *
 * Staking lives on the parent chain only (StakeManager, the per-validator
 * ValidatorShare proxies and both staking tokens are Ethereum / Sepolia
 * contracts), so the client takes a single `parent` adapter rather than
 * the bridge's parent + child pair. Addresses come from the same CDN
 * address index the bridge reads, through the same stale-while-revalidate
 * fetcher, so a protocol redeploy is picked up within the TTL.
 */

import type { Adapter, Hex } from '../adapter.js';
import type { Logger } from '../logger.js';
import type { Network, NetworkAddresses } from '../networks.js';
import type { AddressFetcher } from '../services/address-service.js';

import { POSBridgeError } from '../errors.js';
import { noopLogger } from '../logger.js';
import { createAddressFetcher } from '../services/address-service.js';
import { StakeManager } from './stake-manager.js';
import { StakingToken } from './staking-token.js';
import { ValidatorShare } from './validator-share.js';

/**
 * Parent chain id per network — the value of `Main.ChainId` in each
 * network's address index (Ethereum mainnet `1`, Sepolia `11155111`).
 * Every staking write is pinned to it so a wallet still connected to
 * Polygon is refused before broadcast.
 */
export const L1_CHAIN_ID: Record<Network, number> = {
  mainnet: 1,
  amoy: 11155111
};

export interface StakingClientConfig {
  /** Polygon network — `'mainnet'` or `'amoy'`. */
  network: Network;
  /**
   * Parent-chain (Ethereum / Sepolia) adapter, built with the factory
   * for your web3 library (`viemAdapter`, `ethersV5Adapter`,
   * `ethersV6Adapter`).
   */
  parent: Adapter;
  /** Optional structural logger; defaults to a no-op. */
  logger?: Logger;
  /**
   * Pre-resolved address index. When provided the SDK never reaches the
   * CDN; it must carry `StakeManager`, `MaticToken` and `PolToken`.
   */
  addresses?: NetworkAddresses;
  /** Override the CDN base URL (staging mirrors, air-gapped deployments). */
  addressIndexUrl?: string;
  /** Address cache TTL in milliseconds. Default 1 hour. Ignored with `addresses`. */
  addressTTLMs?: number;
  /** Invoked when a background address refresh fails; defaults to `logger.warn`. */
  onAddressRefreshError?: (err: Error) => void;
}

type StakingAddressKey = 'StakeManager' | 'MaticToken' | 'PolToken';

const STAKING_KEYS: readonly StakingAddressKey[] = ['StakeManager', 'MaticToken', 'PolToken'];

function missingStakingKeys(addresses: NetworkAddresses): StakingAddressKey[] {
  return STAKING_KEYS.filter((key) => addresses[key] === undefined);
}

function missingError(network: Network, missing: readonly StakingAddressKey[]): POSBridgeError {
  return new POSBridgeError(
    'CONTRACT_NOT_AVAILABLE_ON_NETWORK',
    `Address index for ${network} lacks staking contracts: ${missing.join(', ')}`,
    { network, missing: [...missing] }
  );
}

export class StakingClient {
  /** StakeManager proxy: validator writes and protocol reads. */
  readonly stakeManager: StakeManager;
  /** Legacy MATIC token (no permit). */
  readonly matic: StakingToken;
  /** POL token (EIP-2612 permit). */
  readonly pol: StakingToken;

  private readonly fetcher: AddressFetcher;
  private readonly parent: Adapter;
  private readonly logger: Logger;
  private readonly l1ChainId: number;

  private constructor(args: {
    fetcher: AddressFetcher;
    parent: Adapter;
    logger: Logger;
    l1ChainId: number;
    network: Network;
  }) {
    this.fetcher = args.fetcher;
    this.parent = args.parent;
    this.logger = args.logger;
    this.l1ChainId = args.l1ChainId;

    const { fetcher, network } = args;
    // Re-read on every call so TTL refreshes reach the callers; a refresh
    // that drops a key fails the call with the same typed error as init.
    const resolve = (key: StakingAddressKey) => async (): Promise<Hex> => {
      const value = (await fetcher.get())[key];
      if (value === undefined) throw missingError(network, [key]);
      return value;
    };
    const shared = { adapter: args.parent, logger: args.logger, l1ChainId: args.l1ChainId };
    const getStakeManagerAddress = resolve('StakeManager');

    this.stakeManager = new StakeManager({ ...shared, getAddress: getStakeManagerAddress });
    this.matic = new StakingToken({
      ...shared,
      getAddress: resolve('MaticToken'),
      getStakeManagerAddress,
      supportsPermit: false,
      tokenLabel: 'MaticToken'
    });
    this.pol = new StakingToken({
      ...shared,
      getAddress: resolve('PolToken'),
      getStakeManagerAddress,
      supportsPermit: true,
      tokenLabel: 'PolToken'
    });
  }

  /**
   * Build a `StakingClient`. Performs one foreground address-index fetch
   * so a misconfigured network, URL or override fails here rather than
   * on the first transaction.
   */
  static async init(config: StakingClientConfig): Promise<StakingClient> {
    const logger = config.logger ?? noopLogger;
    const fetcher = createAddressFetcher({
      network: config.network,
      baseUrl: config.addressIndexUrl,
      ttlMs: config.addressTTLMs,
      initial: config.addresses,
      // Same default as the bridge client: a silently failing refresh
      // loop is indistinguishable from a healthy one.
      onRefreshError:
        config.onAddressRefreshError ??
        ((err): void => {
          logger.warn({ err }, 'background address-index refresh failed; serving cached addresses');
        })
    });

    const missing = missingStakingKeys(await fetcher.get());
    if (missing.length > 0) throw missingError(config.network, missing);

    return new StakingClient({
      fetcher,
      parent: config.parent,
      logger,
      l1ChainId: L1_CHAIN_ID[config.network],
      network: config.network
    });
  }

  /**
   * Delegation handle for one validator. Pass the validator's
   * ValidatorShare proxy (from `stakeManager.getValidatorContract`).
   */
  validatorShare(address: Hex): ValidatorShare {
    return new ValidatorShare({
      adapter: this.parent,
      logger: this.logger,
      l1ChainId: this.l1ChainId,
      address
    });
  }

  /** The resolved address index, staking keys included. */
  getAddresses(): Promise<NetworkAddresses> {
    return this.fetcher.get();
  }
}
