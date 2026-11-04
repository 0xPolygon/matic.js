/**
 * Unit tests for `createAddressFetcher`.
 *
 * The fetcher's job is the stale-while-revalidate cache layer between
 * the SDK and the address-index CDN. The chain is NEVER mocked — the
 * fetcher doesn't talk to the chain at all. What's mocked here is the
 * upstream HTTP fetch (via `vi.stubGlobal('fetch', ...)`), since the
 * fetcher's behaviour is defined relative to that fetch's timing and
 * outcome.
 *
 * The mocked fetch is a controllable promise: tests can resolve it on
 * demand, simulate failure, advance vi's fake clock past the TTL, and
 * assert the cache served stale-then-refreshed correctly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NetworkAddresses } from '../../src/types.js';

import {
  __resetAddressCacheForTesting,
  createAddressFetcher,
  DEFAULT_TTL_MS
} from '../../src/services/address-service.js';

const FAKE_INDEX_V1: NetworkAddresses = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666'
};

const FAKE_INDEX_V2: NetworkAddresses = {
  ...FAKE_INDEX_V1,
  RootChainManager: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
};

interface MockFetchHandle {
  /** Number of times the mocked fetch has been invoked. */
  readonly callCount: () => number;
  /** Resolve the *pending* request with the supplied payload. */
  resolveNext(value: NetworkAddresses): Promise<void>;
  /** Reject the *pending* request with the supplied error. */
  rejectNext(err: Error): Promise<void>;
}

interface PendingRequest {
  url: string;
  /** Resolves with the body the fetcher will see; tracked by the harness. */
  done: Promise<void>;
  resolve: (value: Response) => void;
  reject: (reason: Error) => void;
}

/**
 * Drain microtasks until every queued continuation has had a chance to
 * run. A single `await Promise.resolve()` only advances by one tick;
 * the fetcher's chain (`fetch().json() → .then(parse) → cache.set →
 * .finally`) needs several. This count is empirical — chosen to be
 * comfortably larger than the deepest chain length.
 */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/**
 * Install a controllable mock fetch as the global. Returns a handle the
 * test can use to advance the response queue. The mock returns a
 * `Promise<Response>`-shaped object whose `.ok` and `.json()` follow the
 * fetcher's expectations.
 *
 * `resolveNext` / `rejectNext` return a promise that settles only after
 * the fetcher's downstream chain has finished propagating — including
 * the cache write on success and the `onRefreshError` callback on
 * failure. Tests `await` this so assertions against post-refresh state
 * never race.
 */
function installMockFetch(): MockFetchHandle {
  const pending: PendingRequest[] = [];
  let calls = 0;

  vi.stubGlobal('fetch', (url: string) => {
    calls++;
    return new Promise<Response>((resolve, reject) => {
      pending.push({ url, resolve, reject, done: Promise.resolve() });
    });
  });

  return {
    callCount: () => calls,
    async resolveNext(value: NetworkAddresses): Promise<void> {
      const next = pending.shift();
      if (next === undefined) {
        throw new Error('resolveNext called with no pending request');
      }
      const text = async (): Promise<string> => JSON.stringify(value);
      next.resolve({ ok: true, text } as unknown as Response);
      await drainMicrotasks();
    },
    async rejectNext(err: Error): Promise<void> {
      const next = pending.shift();
      if (next === undefined) {
        throw new Error('rejectNext called with no pending request');
      }
      next.reject(err);
      await drainMicrotasks();
    }
  };
}

describe('createAddressFetcher', () => {
  beforeEach(() => {
    __resetAddressCacheForTesting();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns config.initial without ever calling fetch when initial is provided', async () => {
    const handle = installMockFetch();
    const f = createAddressFetcher({ network: 'amoy', initial: FAKE_INDEX_V1 });
    const v = await f.get();
    expect(v).deep.equal(FAKE_INDEX_V1);
    expect(handle.callCount()).equals(0);
    // A second call still does not touch the network.
    await f.get();
    expect(handle.callCount()).equals(0);
  });

  it('blocks the first call until the fetch resolves', async () => {
    const handle = installMockFetch();
    const f = createAddressFetcher({ network: 'amoy' });
    const promise = f.get();

    // The single `get()` is in-flight; nothing has resolved yet.
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    // Yield once so the .then microtask would have fired if it could.
    await Promise.resolve();
    expect(resolved).equals(false);

    await handle.resolveNext(FAKE_INDEX_V1);
    expect(await promise).deep.equal(FAKE_INDEX_V1);
    expect(handle.callCount()).equals(1);
  });

  it('returns cached value immediately on subsequent calls within TTL', async () => {
    const handle = installMockFetch();
    const f = createAddressFetcher({ network: 'amoy' });
    const first = f.get();
    await handle.resolveNext(FAKE_INDEX_V1);
    await first;
    expect(handle.callCount()).equals(1);

    // Inside TTL — no new fetch.
    const second = await f.get();
    expect(second).deep.equal(FAKE_INDEX_V1);
    expect(handle.callCount()).equals(1);
  });

  it('returns stale value immediately AND triggers a background refresh when TTL has elapsed', async () => {
    const handle = installMockFetch();
    const f = createAddressFetcher({ network: 'amoy', ttlMs: 10_000 });
    const first = f.get();
    await handle.resolveNext(FAKE_INDEX_V1);
    await first;

    vi.advanceTimersByTime(20_000);

    // Stale path: the call returns immediately (no await on the fetch),
    // but the call count rises to 2 because the background refresh has
    // started.
    const stale = await f.get();
    expect(stale).deep.equal(FAKE_INDEX_V1);
    expect(handle.callCount()).equals(2);

    await handle.resolveNext(FAKE_INDEX_V2);
  });

  it('next get() after a successful background refresh returns the new value', async () => {
    const handle = installMockFetch();
    const f = createAddressFetcher({ network: 'amoy', ttlMs: 10_000 });
    const first = f.get();
    await handle.resolveNext(FAKE_INDEX_V1);
    await first;

    vi.advanceTimersByTime(20_000);
    const stale = await f.get();
    expect(stale).deep.equal(FAKE_INDEX_V1);
    await handle.resolveNext(FAKE_INDEX_V2);

    const fresh = await f.get();
    expect(fresh).deep.equal(FAKE_INDEX_V2);
  });

  it('keeps serving stale value when background refresh fails, calls onRefreshError', async () => {
    const handle = installMockFetch();
    const errors: Error[] = [];
    const f = createAddressFetcher({
      network: 'amoy',
      ttlMs: 10_000,
      onRefreshError: (err) => errors.push(err)
    });
    const first = f.get();
    await handle.resolveNext(FAKE_INDEX_V1);
    await first;

    vi.advanceTimersByTime(20_000);
    const stale = await f.get();
    expect(stale).deep.equal(FAKE_INDEX_V1);
    await handle.rejectNext(new Error('upstream went away'));

    expect(errors).lengthOf(1);
    expect(errors[0]).property('message').match(/upstream went away/);

    // Still serving the stale value; the failed refresh did not poison.
    const after = await f.get();
    expect(after).deep.equal(FAKE_INDEX_V1);
  });

  it('de-duplicates concurrent refreshes so only one in-flight fetch exists per cache key', async () => {
    const handle = installMockFetch();
    const f = createAddressFetcher({ network: 'amoy' });
    // Two concurrent first-get() calls — neither has a cache entry yet,
    // so both flow through the cold-path branch. The fetcher must
    // collapse them onto a single in-flight fetch.
    const a = f.get();
    const b = f.get();
    expect(handle.callCount()).equals(1);
    await handle.resolveNext(FAKE_INDEX_V1);
    expect(await a).deep.equal(FAKE_INDEX_V1);
    expect(await b).deep.equal(FAKE_INDEX_V1);
  });

  it('separate POSClient instances on different addressIndexUrls do not cross-contaminate', async () => {
    const handle = installMockFetch();
    const f1 = createAddressFetcher({ network: 'amoy', baseUrl: 'https://a.example' });
    const f2 = createAddressFetcher({ network: 'amoy', baseUrl: 'https://b.example' });

    const p1 = f1.get();
    const p2 = f2.get();
    // Two separate base URLs ⇒ two separate cache keys ⇒ two fetches.
    expect(handle.callCount()).equals(2);

    await handle.resolveNext(FAKE_INDEX_V1);
    await handle.resolveNext(FAKE_INDEX_V2);
    expect(await p1).deep.equal(FAKE_INDEX_V1);
    expect(await p2).deep.equal(FAKE_INDEX_V2);
  });

  it('default TTL is 1h (matches the documented value)', () => {
    expect(DEFAULT_TTL_MS).equals(60 * 60 * 1000);
  });
});
