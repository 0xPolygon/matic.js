/**
 * The Plasma client's addresses: their type, the parser that reads them out
 * of the address index, the validator for an `addresses` override, and the
 * cache they are fetched into.
 *
 * Plasma has its own parsed shape and its own cache rather than sharing the
 * bridge's. A refresh that is fine for one parser and not for the other (an
 * index that drops a Plasma key but keeps every PoS key, or the reverse) must
 * change only the client whose parser rejects it. A separate store gives
 * that: a refresh that drops a Plasma key affects only this client. The cost
 * is one extra index fetch per cache TTL in a process that runs a
 * `PlasmaClient` beside a `POSClient`.
 */
import type { Network } from '../networks.js';

import { ContractNotAvailableOnNetworkError } from '../errors.js';
import {
  asIndexObject,
  createAddressIndexStore,
  createIndexFetcher,
  isIndexAddress,
  isNestedIndex,
  readIndexPath,
  SHARED_NESTED_INDEX_PATHS
} from '../services/address-service.js';

/**
 * Everything the Plasma client calls, and all a `PlasmaClient` `addresses`
 * override has to carry: the PoS bridge keys are never read by Plasma, so a
 * consumer that does not use the PoS bridge need not invent placeholders for
 * them.
 */
export interface PlasmaAddresses {
  /**
   * The checkpoint contract every exit proof is checked against. It is the
   * same contract the PoS bridge reads, and not the PoS `RootChainManager`.
   */
  RootChain: `0x${string}`;
  DepositManager: `0x${string}`;
  WithdrawManager: `0x${string}`;
  /** The burn-only ERC-20 predicate Plasma exits start through. */
  PlasmaERC20Predicate: `0x${string}`;
  ExitNFT: `0x${string}`;
  /** Legacy MATIC token: the token behind the child native-token contract. */
  MaticToken: `0x${string}`;
  PolToken: `0x${string}`;
}

export type PlasmaAddressKey = keyof PlasmaAddresses;

/** The keys a Plasma `addresses` override and a fetched index must carry. */
export const PLASMA_ADDRESS_KEYS = [
  'RootChain',
  'DepositManager',
  'WithdrawManager',
  'PlasmaERC20Predicate',
  'ExitNFT',
  'MaticToken',
  'PolToken'
] as const satisfies readonly PlasmaAddressKey[];

/**
 * Where the CDN's nested index keeps each Plasma address. The three the
 * bridge parser also reads come from the one shared table, so the two cannot
 * drift on which entry is the live proxy. `DepositManagerProxy` and
 * `WithdrawManagerProxy` are the live contracts, not the `DepositManager` and
 * `WithdrawManager` implementation entries beside them; the Plasma predicate
 * is the index's `Contracts.ERC20Predicate`, a different contract from the PoS
 * `POSContracts.ERC20PredicateProxy`.
 */
const NESTED_PLASMA_PATHS = {
  ...SHARED_NESTED_INDEX_PATHS,
  DepositManager: ['Main', 'Contracts', 'DepositManagerProxy'],
  WithdrawManager: ['Main', 'Contracts', 'WithdrawManagerProxy'],
  PlasmaERC20Predicate: ['Main', 'Contracts', 'ERC20Predicate'],
  ExitNFT: ['Main', 'Contracts', 'ExitNFT']
} as const satisfies Record<PlasmaAddressKey, readonly string[]>;

const addressOrUndefined = (value: unknown): `0x${string}` | undefined =>
  isIndexAddress(value) ? value : undefined;

/**
 * Build `PlasmaAddresses` from one value per key, or throw
 * `ContractNotAvailableOnNetworkError` naming every key whose value is absent
 * or not an address. The single place the seven keys are checked, shared by
 * the index parser and the override validator.
 */
function completePlasmaAddresses(params: {
  network: Network;
  found: Readonly<Record<PlasmaAddressKey, unknown>>;
  describeMissing: (missing: readonly PlasmaAddressKey[]) => string;
}): PlasmaAddresses {
  const { network, found, describeMissing } = params;
  const RootChain = addressOrUndefined(found.RootChain);
  const DepositManager = addressOrUndefined(found.DepositManager);
  const WithdrawManager = addressOrUndefined(found.WithdrawManager);
  const PlasmaERC20Predicate = addressOrUndefined(found.PlasmaERC20Predicate);
  const ExitNFT = addressOrUndefined(found.ExitNFT);
  const MaticToken = addressOrUndefined(found.MaticToken);
  const PolToken = addressOrUndefined(found.PolToken);
  if (
    RootChain === undefined ||
    DepositManager === undefined ||
    WithdrawManager === undefined ||
    PlasmaERC20Predicate === undefined ||
    ExitNFT === undefined ||
    MaticToken === undefined ||
    PolToken === undefined
  ) {
    const missing = PLASMA_ADDRESS_KEYS.filter(
      (key) => addressOrUndefined(found[key]) === undefined
    );
    throw new ContractNotAvailableOnNetworkError(describeMissing(missing), {
      info: { network, missing: [...missing] }
    });
  }
  return {
    RootChain,
    DepositManager,
    WithdrawManager,
    PlasmaERC20Predicate,
    ExitNFT,
    MaticToken,
    PolToken
  };
}

/**
 * Parse a fetched address index into `PlasmaAddresses`. Accepts the CDN's
 * nested layout and a flat mirror shaped like `PlasmaAddresses`; reads only
 * the Plasma entries, so an index whose PoS entries are missing or malformed
 * still parses. A missing or malformed Plasma entry throws
 * `ContractNotAvailableOnNetworkError` naming every such key.
 */
export function parsePlasmaIndex(params: { network: Network; raw: unknown }): PlasmaAddresses {
  const { network, raw } = params;
  const index = asIndexObject(raw);
  const nested = isNestedIndex(index);
  const read = (key: PlasmaAddressKey): unknown =>
    nested ? readIndexPath({ index, path: NESTED_PLASMA_PATHS[key] }) : index[key];
  return completePlasmaAddresses({
    network,
    found: {
      RootChain: read('RootChain'),
      DepositManager: read('DepositManager'),
      WithdrawManager: read('WithdrawManager'),
      PlasmaERC20Predicate: read('PlasmaERC20Predicate'),
      ExitNFT: read('ExitNFT'),
      MaticToken: read('MaticToken'),
      PolToken: read('PolToken')
    },
    describeMissing: (missing) =>
      `Address index for ${network} lacks Plasma contracts: ${missing.join(', ')}`
  });
}

/**
 * Validate an `addresses` override with the same address shape check the
 * index parser applies, and return a fresh copy with any other key dropped.
 * An absent or malformed key throws `ContractNotAvailableOnNetworkError`
 * naming every such key. The types do not protect the plain-JS consumers this
 * override serves, and a bad value would otherwise surface as an opaque
 * revert against address `undefined`.
 */
export function parsePlasmaAddresses(params: {
  network: Network;
  addresses: Readonly<Partial<Record<PlasmaAddressKey, unknown>>>;
}): PlasmaAddresses {
  const { network, addresses } = params;
  return completePlasmaAddresses({
    network,
    found: {
      RootChain: addresses.RootChain,
      DepositManager: addresses.DepositManager,
      WithdrawManager: addresses.WithdrawManager,
      PlasmaERC20Predicate: addresses.PlasmaERC20Predicate,
      ExitNFT: addresses.ExitNFT,
      MaticToken: addresses.MaticToken,
      PolToken: addresses.PolToken
    },
    describeMissing: (missing) =>
      `Plasma addresses for ${network} lack valid entries: ${missing.join(', ')}`
  });
}

/**
 * The Plasma client's own cache. No other module reads or fills it.
 */
const plasmaStore = createAddressIndexStore<PlasmaAddresses>();

export interface PlasmaAddressSource {
  get(): Promise<PlasmaAddresses>;
}

/**
 * Where a `PlasmaClient` gets its addresses: the validated override, fixed
 * for the client's life, or the address index fetched into the Plasma store
 * with stale-while-revalidate caching. A refresh whose index lacks a Plasma
 * key is rejected before it is cached, so the last good addresses keep being
 * served and `onRefreshError` fires, exactly as for the bridge clients.
 */
export function createPlasmaAddressSource(params: {
  network: Network;
  /** The override; when given, the index is never fetched. */
  addresses: Readonly<Partial<Record<PlasmaAddressKey, unknown>>> | undefined;
  baseUrl: string | undefined;
  ttlMs: number | undefined;
  onRefreshError: (err: Error) => void;
}): PlasmaAddressSource {
  const { network, addresses, baseUrl, ttlMs, onRefreshError } = params;
  if (addresses !== undefined) {
    const fixed = parsePlasmaAddresses({ network, addresses });
    // A fresh copy per call, so a caller cannot mutate the client's view.
    return { get: () => Promise.resolve({ ...fixed }) };
  }
  return createIndexFetcher({
    store: plasmaStore,
    parse: (raw) => parsePlasmaIndex({ network, raw }),
    network,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    onRefreshError
  });
}
