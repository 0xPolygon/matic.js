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

import {
  AddressLookupError,
  ContractNotAvailableOnNetworkError,
  InitError,
  withOperation
} from '../errors.js';
import { noopLogger } from '../logger.js';
import { L1_CHAIN_ID } from '../networks.js';
import { createAddressFetcher, isIndexAddress } from '../services/address-service.js';
import { StakeManager } from './stake-manager.js';
import { StakingToken } from './staking-token.js';
import { ValidatorShare } from './validator-share.js';

/**
 * The three contracts the staking client calls. This is all a
 * staking-only `addresses` override has to carry: the bridge keys of
 * {@link NetworkAddresses} are never read by staking, so a consumer that
 * does not use the bridge need not invent placeholders for them.
 */
export interface StakingAddresses {
  /** Live StakeManager proxy (never the implementation). */
  StakeManager: Hex;
  /** Legacy MATIC staking token. */
  MaticToken: Hex;
  /** POL staking token. */
  PolToken: Hex;
}

/**
 * What the client resolves addresses from: the full bridge index (CDN,
 * mirror or full override), or the three staking addresses alone.
 */
type StakingAddressIndex = NetworkAddresses | StakingAddresses;

/**
 * What {@link StakingClient.getAddresses} returns: the resolved index
 * (full or staking-only) with the three staking keys guaranteed present.
 * `init` refuses an index without them, so callers never have to
 * re-check `StakeManager`, `MaticToken` or `PolToken` for `undefined`.
 */
export type ResolvedStakingAddresses = StakingAddressIndex & StakingAddresses;

interface StakingAddressSource {
  get(): Promise<StakingAddressIndex>;
}

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
   * Pre-resolved addresses. When provided the SDK never reaches the CDN.
   * Pass either the three staking addresses alone ({@link StakingAddresses})
   * or a full {@link NetworkAddresses} index that also carries
   * `StakeManager`, `MaticToken` and `PolToken`. An object with any bridge
   * key is validated as a full index, bridge keys included, exactly as
   * `POSClient` validates it; one without is checked for the three staking
   * keys only.
   */
  addresses?: NetworkAddresses | StakingAddresses;
  /** Override the CDN base URL (staging mirrors, air-gapped deployments). */
  addressIndexUrl?: string;
  /** Address cache TTL in milliseconds. Default 1 hour. Ignored with `addresses`. */
  addressTTLMs?: number;
  /** Invoked when a background address refresh fails; defaults to `logger.warn`. */
  onAddressRefreshError?: (err: Error) => void;
}

type StakingAddressKey = 'StakeManager' | 'MaticToken' | 'PolToken';

const STAKING_KEYS: readonly StakingAddressKey[] = ['StakeManager', 'MaticToken', 'PolToken'];

const BRIDGE_KEYS: readonly (keyof NetworkAddresses)[] = [
  'RootChainManager',
  'ERC20Predicate',
  'ERC721Predicate',
  'ERC1155Predicate',
  'EtherPredicate',
  'RootChain'
];

/**
 * A full index is recognised by any required bridge key, so a full index
 * with a typo'd or missing bridge key still fails the bridge parser
 * loudly instead of being quietly treated as staking-only.
 */
function isFullIndex(addresses: StakingAddressIndex): addresses is NetworkAddresses {
  return BRIDGE_KEYS.some((key) => key in addresses);
}

function missingStakingKeys(addresses: StakingAddressIndex): StakingAddressKey[] {
  return STAKING_KEYS.filter((key) => addresses[key] === undefined);
}

function hasStakingKeys(addresses: StakingAddressIndex): addresses is ResolvedStakingAddresses {
  return missingStakingKeys(addresses).length === 0;
}

function missingError(
  network: Network,
  missing: readonly StakingAddressKey[]
): ContractNotAvailableOnNetworkError {
  return new ContractNotAvailableOnNetworkError(
    `Address index for ${network} lacks staking contracts: ${missing.join(', ')}`,
    { info: { network, missing: [...missing] } }
  );
}

/**
 * Fixed source for a staking-only override. Validated with the same
 * address shape check as the index parser: an absent or malformed key
 * fails init with `ContractNotAvailableOnNetworkError`, as it would for a
 * full index lacking it. The plain-JS consumers this override serves get
 * no help from the types.
 */
function stakingOnlySource(network: Network, override: StakingAddresses): StakingAddressSource {
  const missing = STAKING_KEYS.filter((key) => !isIndexAddress(override[key]));
  if (missing.length > 0) throw missingError(network, missing);
  const fixed: StakingAddresses = {
    StakeManager: override.StakeManager,
    MaticToken: override.MaticToken,
    PolToken: override.PolToken
  };
  // Fresh copy per call, as the bridge fetcher does: callers must not be
  // able to mutate the client's view.
  return { get: () => Promise.resolve({ ...fixed }) };
}

export class StakingClient {
  /** StakeManager proxy: validator writes and protocol reads. */
  readonly stakeManager: StakeManager;
  /** Legacy MATIC token (no permit). */
  readonly matic: StakingToken;
  /** POL token (EIP-2612 permit). */
  readonly pol: StakingToken;

  private readonly fetcher: StakingAddressSource;
  private readonly parent: Adapter;
  private readonly logger: Logger;
  private readonly l1ChainId: number;
  private readonly network: Network;

  private constructor(args: {
    fetcher: StakingAddressSource;
    parent: Adapter;
    logger: Logger;
    l1ChainId: number;
    network: Network;
  }) {
    this.fetcher = args.fetcher;
    this.parent = args.parent;
    this.logger = args.logger;
    this.l1ChainId = args.l1ChainId;
    this.network = args.network;

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
    return withOperation({
      error: InitError,
      info: { operation: 'init', mode: 'init' },
      run: async () => {
        const logger = config.logger ?? noopLogger;
        const override = config.addresses;
        const fetcher: StakingAddressSource =
          override !== undefined && !isFullIndex(override)
            ? stakingOnlySource(config.network, override)
            : createAddressFetcher({
                network: config.network,
                baseUrl: config.addressIndexUrl,
                ttlMs: config.addressTTLMs,
                initial: override,
                // Same default as the bridge client: a silently failing refresh
                // loop is indistinguishable from a healthy one.
                onRefreshError:
                  config.onAddressRefreshError ??
                  ((err): void => {
                    logger.warn(
                      { err },
                      'background address-index refresh failed; serving cached addresses'
                    );
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

  /**
   * The resolved addresses: the full index, or only the three staking
   * addresses when the client was built from a staking-only override.
   * The staking keys are always present; a background refresh that drops
   * one rejects here with the same `ContractNotAvailableOnNetworkError`
   * cause a staking call would carry.
   */
  async getAddresses(): Promise<ResolvedStakingAddresses> {
    return withOperation({
      error: AddressLookupError,
      info: { operation: 'getAddresses', mode: 'read' },
      run: async () => {
        const addresses = await this.fetcher.get();
        if (!hasStakingKeys(addresses)) {
          throw missingError(this.network, missingStakingKeys(addresses));
        }
        return addresses;
      }
    });
  }
}
