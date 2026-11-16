/**
 * The stale-refresh error hook must always receive an `Error`, even when
 * the refresh rejects with a value that cannot be turned into a string.
 * The fetch layer is replaced so the refresh can reject with such a value;
 * `httpGet` itself always rejects with an `Error`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NetworkAddresses } from '../../src/types.js';

import {
  __resetAddressCacheForTesting,
  createAddressFetcher
} from '../../src/services/address-service.js';

const INDEX: NetworkAddresses = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666'
};

const responses = vi.hoisted((): Array<() => Promise<unknown>> => []);

vi.mock('../../src/utils/http_request.js', () => ({
  httpGet: (): Promise<unknown> => {
    const next = responses.shift();
    return next === undefined ? Promise.reject(new Error('no response queued')) : next();
  }
}));

describe('createAddressFetcher onRefreshError', () => {
  beforeEach(() => {
    __resetAddressCacheForTesting();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('receives an Error when the refresh rejects with an unprintable value', async () => {
    const seen: Error[] = [];
    const f = createAddressFetcher({
      network: 'amoy',
      ttlMs: 10_000,
      onRefreshError: (err) => seen.push(err)
    });
    responses.push(() => Promise.resolve(INDEX));
    await f.get();

    vi.advanceTimersByTime(20_000);
    const unprintable: unknown = Object.create(null);
    responses.push(() => Promise.reject(unprintable));
    expect(await f.get()).deep.equals(INDEX);
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(seen).lengthOf(1);
    expect(seen[0]).property('name').equals('HttpRequestFailedError');
    expect(seen[0]).property('message').equals('non-Error value thrown');
  });
});
