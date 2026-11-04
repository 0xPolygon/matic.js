/**
 * Address fetcher with stale-while-revalidate TTL caching.
 *
 * Why this exists, in one paragraph: long-running services (indexers,
 * APIs) need to pick up Polygon contract redeployments without restart,
 * while every individual call site needs near-zero address-resolution
 * cost. The classic "fetch once at startup" model fails the first
 * requirement; the classic "fetch every call" model fails the second.
 * Stale-while-revalidate gives both: cached values are served
 * synchronously inside the TTL window, and outside the window the cached
 * value is still served immediately while a single background fetch
 * refreshes the cache for the next caller. A network failure during the
 * background refresh never propagates to the caller — the existing
 * cached value continues to be served, and the failure surfaces via the
 * optional `onRefreshError` hook.
 *
 * The cache is keyed by `${baseUrl}/${network}` (not just network) so
 * multi-tenant deployments pointing at different mirrors stay isolated.
 * Inflight refreshes are de-duplicated: a second caller arriving while a
 * background refresh is still pending shares the in-flight promise
 * rather than firing a second request. Inflight entries are evicted on
 * rejection so a transient error doesn't permanently wedge the cache.
 *
 * `opts.initial` short-circuits the cache entirely — when provided, the
 * fetcher never reaches the network. This is the path used in
 * staging / air-gapped deployments and in tests where the consumer
 * already knows the addresses.
 */

import type { Network, NetworkAddresses } from '../networks.js';

import { POSBridgeError } from '../errors.js';
import { ADDRESS_INDEX_PATH, ADDRESS_INDEX_URL } from '../networks.js';
import { httpGet } from '../utils/http_request.js';

export interface AddressFetcher {
  get(): Promise<NetworkAddresses>;
}

export interface CreateAddressFetcherOptions {
  network: Network;
  /** Override the CDN base URL. Defaults to `ADDRESS_INDEX_URL`. */
  baseUrl?: string;
  /** Cache TTL in milliseconds. Defaults to `DEFAULT_TTL_MS` (1 hour). */
  ttlMs?: number;
  /**
   * If provided, `get()` returns this synchronously and the fetcher
   * never makes a network call. Use for staging, air-gapped, or test
   * deployments where the consumer already has the addresses.
   */
  initial?: NetworkAddresses;
  /**
   * Invoked when a *background* refresh fails. Background refreshes
   * never propagate errors to the caller because a stale value is
   * better than a 500. The first foreground fetch (when the cache is
   * cold) still throws on failure — this hook is for stale-revalidate
   * failures only.
   */
  onRefreshError?: (err: Error) => void;
}

/** 1 hour. Picked because contract redeployments are rare; a longer TTL
 *  would defer pickup of an emergency redeploy beyond what consumers
 *  expect, a shorter TTL would multiply CDN traffic without benefit. */
export const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  addresses: NetworkAddresses;
  fetchedAt: number;
}

/**
 * Module-level cache shared across every `createAddressFetcher` call in
 * the same process. Keyed by `${baseUrl}/${network}` so two fetchers
 * pointing at the same endpoint share the same cached value (saves
 * redundant fetches on instance churn) but two fetchers pointing at
 * different endpoints stay isolated.
 */
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<NetworkAddresses>>();

function cacheKey(baseUrl: string, network: Network): string {
  return `${baseUrl}/${network}`;
}

function indexUrl(baseUrl: string, network: Network): string {
  // Per-network path segments, NOT `${network}/v1`: the CDN's layout
  // follows the legacy SDK's separate network/version config values, so
  // amoy lives at `testnet/amoy` and `amoy/v1` does not exist (see
  // ADDRESS_INDEX_PATH).
  return `${baseUrl}/${ADDRESS_INDEX_PATH[network]}/index.json`;
}

/**
 * Performs (or joins) the network fetch for the given key. Inflight
 * de-duplication: if a fetch for this key is already in flight, return
 * the same promise. Evict the inflight entry on both fulfilment and
 * rejection so the next caller can retry on failure.
 */
function fetchAddresses(
  key: string,
  url: string,
  parse: (raw: unknown) => NetworkAddresses
): Promise<NetworkAddresses> {
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = httpGet<unknown>(url)
    .then((raw) => {
      const addresses = parse(raw);
      cache.set(key, { addresses, fetchedAt: Date.now() });
      return addresses;
    })
    .finally(() => {
      // Evict on both paths so a transient error doesn't wedge the
      // cache, and a successful fetch doesn't keep the inflight slot
      // alive past completion.
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

/**
 * Full 20-byte-address shape check, not just a `0x` prefix — the fetched
 * index is remote input feeding every write's destination, so a
 * truncated, padded, or non-hex value must fail parsing rather than
 * reach a contract call.
 */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Narrow an unknown value to a 0x-address string or throw with the full key path. */
function requireAddress(value: unknown, path: string): `0x${string}` {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) {
    throw new POSBridgeError(
      'BRIDGE_EVENT_DECODE_FAILED',
      `address index: missing or invalid '${path}'`,
      { key: path, received: typeof value }
    );
  }
  return value as `0x${string}`;
}

/** Optional variant of {@link requireAddress}: undefined when absent/invalid. */
function optionalAddress(value: unknown): `0x${string}` | undefined {
  return typeof value === 'string' && ADDRESS_RE.test(value) ? (value as `0x${string}`) : undefined;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/**
 * Parse the CDN's NESTED index shape — the same files
 * `@maticnetwork/maticjs` 3.9.x reads (`Main.POSContracts.*Proxy`,
 * `Main.Contracts.RootChainProxy`). Selection is Proxy-entry by
 * Proxy-entry what the legacy SDK used:
 *
 * - the *Proxy entries are the LIVE contracts (what users approve,
 *   what on-chain `typeToPredicate` returns); the implementation
 *   twins next to them are inert delegation targets — wiring those
 *   would send approvals to contracts that never pull tokens;
 * - `GasSwapper` has no Proxy variant and exists only on mainnet;
 * - `MintableERC1155PredicateProxy` mirrors the legacy
 *   `erc1155.ts` read.
 */
function parseNestedIndex(obj: Record<string, unknown>): NetworkAddresses {
  const main = asRecord(obj.Main);
  const pos = asRecord(main.POSContracts);
  const contracts = asRecord(main.Contracts);

  const out: NetworkAddresses = {
    RootChainManager: requireAddress(pos.RootChainManagerProxy, 'Main.POSContracts.RootChainManagerProxy'),
    ERC20Predicate: requireAddress(pos.ERC20PredicateProxy, 'Main.POSContracts.ERC20PredicateProxy'),
    ERC721Predicate: requireAddress(pos.ERC721PredicateProxy, 'Main.POSContracts.ERC721PredicateProxy'),
    ERC1155Predicate: requireAddress(pos.ERC1155PredicateProxy, 'Main.POSContracts.ERC1155PredicateProxy'),
    EtherPredicate: requireAddress(pos.EtherPredicateProxy, 'Main.POSContracts.EtherPredicateProxy'),
    RootChain: requireAddress(contracts.RootChainProxy, 'Main.Contracts.RootChainProxy')
  };
  const gasSwapper = optionalAddress(pos.GasSwapper);
  if (gasSwapper !== undefined) out.GasSwapper = gasSwapper;
  const mintable1155 = optionalAddress(pos.MintableERC1155PredicateProxy);
  if (mintable1155 !== undefined) out.MintableERC1155Predicate = mintable1155;
  return out;
}

/**
 * Parse a FLAT `NetworkAddresses`-shaped object — the `config.addresses`
 * override, or a custom `addressIndexUrl` mirror that serves the
 * pre-flattened shape instead of replicating the CDN layout.
 */
function parseFlatIndex(obj: Record<string, unknown>): NetworkAddresses {
  const out: NetworkAddresses = {
    RootChainManager: requireAddress(obj.RootChainManager, 'RootChainManager'),
    ERC20Predicate: requireAddress(obj.ERC20Predicate, 'ERC20Predicate'),
    ERC721Predicate: requireAddress(obj.ERC721Predicate, 'ERC721Predicate'),
    ERC1155Predicate: requireAddress(obj.ERC1155Predicate, 'ERC1155Predicate'),
    EtherPredicate: requireAddress(obj.EtherPredicate, 'EtherPredicate'),
    RootChain: requireAddress(obj.RootChain, 'RootChain')
  };
  const gasSwapper = optionalAddress(obj.GasSwapper);
  if (gasSwapper !== undefined) out.GasSwapper = gasSwapper;
  const mintable1155 = optionalAddress(obj.MintableERC1155Predicate);
  if (mintable1155 !== undefined) out.MintableERC1155Predicate = mintable1155;
  return out;
}

/**
 * The CDN response is `unknown`-typed at the network boundary. This
 * narrows it to `NetworkAddresses` and throws if a required field is
 * missing or shaped wrong.
 *
 * Two accepted shapes, discriminated on the `Main` key:
 * - NESTED — the live CDN's legacy-maticjs layout (the canonical
 *   source; see {@link parseNestedIndex});
 * - FLAT — a pre-resolved `NetworkAddresses` object (the
 *   `config.addresses` override and pre-flattened mirrors; see
 *   {@link parseFlatIndex}).
 */
function parseAddressIndex(raw: unknown): NetworkAddresses {
  if (raw === null || typeof raw !== 'object') {
    throw new POSBridgeError(
      'BRIDGE_EVENT_DECODE_FAILED',
      'address index: expected JSON object, got ' + typeof raw,
      { received: typeof raw }
    );
  }
  const obj = raw as Record<string, unknown>;
  return 'Main' in obj ? parseNestedIndex(obj) : parseFlatIndex(obj);
}

/**
 * Build an `AddressFetcher` for the given network. See module
 * docstring for caching semantics.
 */
export function createAddressFetcher(opts: CreateAddressFetcherOptions): AddressFetcher {
  const { network, initial, onRefreshError } = opts;
  const baseUrl = opts.baseUrl ?? ADDRESS_INDEX_URL;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  // initial-override path: never touches the cache or network. The
  // caller has supplied the addresses and is responsible for their
  // freshness — but NOT for their shape: the override goes through the
  // same validation as a fetched index, so a typo'd key or non-address
  // value fails loudly at init instead of surfacing later as an opaque
  // revert against address `undefined`. TypeScript types don't protect
  // the plain-JS consumers this override exists for.
  if (initial !== undefined) {
    const validated = parseAddressIndex(initial);
    const fixed: AddressFetcher = {
      get(): Promise<NetworkAddresses> {
        // Fresh copy per call: handing out one shared object would let
        // one consumer's mutation silently corrupt every other caller's
        // view of the bridge addresses.
        return Promise.resolve({ ...validated });
      }
    };
    return fixed;
  }

  const key = cacheKey(baseUrl, network);
  const url = indexUrl(baseUrl, network);

  const fetcher: AddressFetcher = {
    async get(): Promise<NetworkAddresses> {
      const entry = cache.get(key);
      const now = Date.now();

      // Cold cache: block the caller on the first fetch. Errors here
      // *do* propagate — the caller gets nothing if the very first
      // request fails.
      if (entry === undefined) {
        return { ...(await fetchAddresses(key, url, parseAddressIndex)) };
      }

      // Fresh cache: serve synchronously, no network. Fresh copy per
      // call — the cached object must never be exposed to mutation.
      if (now - entry.fetchedAt < ttlMs) {
        return { ...entry.addresses };
      }

      // Stale cache: serve the stale value immediately, but kick off
      // a background refresh so the next caller sees fresh data.
      // Errors during this refresh never reach the current caller —
      // they surface via `onRefreshError` instead. We deliberately
      // don't await; the returned promise from fetchAddresses is the
      // mechanism, not a signal to the caller.
      //
      // Only the caller that STARTS a refresh wires the error hook:
      // every stale `get()` during one in-flight refresh shares the same
      // promise (inflight dedup), so attaching the hook per caller would
      // fire it N times for a single failed refresh — hook spam exactly
      // when the CDN is having a bad day. One `.catch` on the shared
      // promise also marks the rejection handled for all callers.
      const alreadyRefreshing = inflight.has(key);
      const refresh = fetchAddresses(key, url, parseAddressIndex);
      if (!alreadyRefreshing) {
        void refresh.catch((err: unknown) => {
          if (onRefreshError) {
            // The hook signature accepts plain `Error` so consumers can
            // forward it to a logger without an instanceof narrowing;
            // rare non-Error throws are flattened to a typed sentinel.
            const wrapped =
              err instanceof Error
                ? err
                : new POSBridgeError('HTTP_REQUEST_FAILED', String(err), { raw: err });
            onRefreshError(wrapped);
          }
        });
      }
      return { ...entry.addresses };
    }
  };
  return fetcher;
}

/**
 * Test-only escape hatch. Production code never calls this — caches
 * are process-lifetime by design. Vitest suites that exercise
 * cache-aware behaviours call this in `beforeEach` so prior test
 * state doesn't leak.
 */
export function __resetAddressCacheForTesting(): void {
  cache.clear();
  inflight.clear();
}
