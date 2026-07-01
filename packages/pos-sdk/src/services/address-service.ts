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
import { ADDRESS_INDEX_URL } from '../networks.js';
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
  return `${baseUrl}/${network}/v1/index.json`;
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
 * The CDN response is `unknown`-typed at the network boundary. This
 * narrows it to `NetworkAddresses` and throws if a required field is
 * missing or shaped wrong. Optional fields (currently just
 * `GasSwapper`) are passed through if present, omitted otherwise.
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
  const required = [
    'RootChainManager',
    'ERC20Predicate',
    'ERC721Predicate',
    'ERC1155Predicate',
    'EtherPredicate',
    'RootChain'
  ] as const;

  const out: Partial<NetworkAddresses> = {};
  for (const key of required) {
    const value = obj[key];
    if (typeof value !== 'string' || !value.startsWith('0x')) {
      throw new POSBridgeError(
        'BRIDGE_EVENT_DECODE_FAILED',
        `address index: missing or invalid '${key}'`,
        { key, received: typeof value }
      );
    }
    out[key] = value as `0x${string}`;
  }
  const gasSwapper = obj.GasSwapper;
  if (typeof gasSwapper === 'string' && gasSwapper.startsWith('0x')) {
    out.GasSwapper = gasSwapper as `0x${string}`;
  }
  return out as NetworkAddresses;
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
  // freshness.
  if (initial !== undefined) {
    const fixed: AddressFetcher = {
      get(): Promise<NetworkAddresses> {
        return Promise.resolve(initial);
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
        return fetchAddresses(key, url, parseAddressIndex);
      }

      // Fresh cache: serve synchronously, no network.
      if (now - entry.fetchedAt < ttlMs) {
        return entry.addresses;
      }

      // Stale cache: serve the stale value immediately, but kick off
      // a background refresh so the next caller sees fresh data.
      // Errors during this refresh never reach the current caller —
      // they surface via `onRefreshError` instead. We deliberately
      // don't await; the returned promise from fetchAddresses is the
      // mechanism, not a signal to the caller.
      void fetchAddresses(key, url, parseAddressIndex).catch((err: unknown) => {
        if (onRefreshError) {
          // The hook signature accepts plain `Error` so consumers can
          // forward it to a logger without an instanceof narrowing.
          // `err` is typed `unknown` here; coerce non-Error values via
          // `Object` wrapping to keep the failure surface uniform —
          // legitimate library errors already are Errors, and rare
          // cases like throwing a string are flattened to a sentinel.
          const wrapped =
            err instanceof Error ? err : Object.assign(new POSBridgeError(
              'ROOT_HASH_RPC_FAILED',
              String(err),
              { raw: err }
            ), {});
          onRefreshError(wrapped);
        }
      });
      return entry.addresses;
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
