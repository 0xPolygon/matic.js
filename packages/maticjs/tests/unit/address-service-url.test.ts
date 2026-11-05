/**
 * `addressIndexUrl` is consumer-supplied, so it can carry a trailing
 * slash, a path prefix (a mirror mount) and its own query string (an API
 * key). The index path used to be appended to it as text, which doubled a
 * trailing slash and put the path after the `?` of a keyed base. These
 * tests pin where the index path and the base's params land for every base
 * shape, and that a key never reaches an error. Only `fetch` is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NetworkAddresses } from '../../src/types.js';

import { POSBridgeError } from '../../src/errors.ts';
import {
  __resetAddressCacheForTesting,
  createAddressFetcher
} from '../../src/services/address-service.ts';

const INDEX: NetworkAddresses = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666'
};

const requested: string[] = [];

const respondWith = (status: number, body: unknown): void => {
  vi.stubGlobal('fetch', (input: string) => {
    requested.push(input);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    );
  });
};

beforeEach(() => {
  __resetAddressCacheForTesting();
  requested.length = 0;
  respondWith(200, INDEX);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const indexUrlFor = async (
  baseUrl: string | undefined,
  network: 'mainnet' | 'amoy' = 'amoy'
): Promise<string | undefined> => {
  await createAddressFetcher({ network, baseUrl }).get();
  return requested[0];
};

const caught = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e
  );

const expectNoSecret = (err: unknown): void => {
  expect(err).instanceOf(POSBridgeError);
  if (!(err instanceof POSBridgeError)) return;
  expect(err.message).not.contain('secret123');
  expect(JSON.stringify(err.info)).not.contain('secret123');
  expect(JSON.stringify(err)).not.contain('secret123');
};

describe('createAddressFetcher — index URL resolution against the base', () => {
  it('keeps the default public URL byte-identical', async () => {
    expect(await indexUrlFor(undefined, 'amoy')).equal(
      'https://static.polygon.technology/network/testnet/amoy/index.json'
    );
    __resetAddressCacheForTesting();
    requested.length = 0;
    expect(await indexUrlFor(undefined, 'mainnet')).equal(
      'https://static.polygon.technology/network/mainnet/v1/index.json'
    );
  });

  it('appends the index path to a base without a trailing slash', async () => {
    expect(await indexUrlFor('https://example.test/net')).equal(
      'https://example.test/net/testnet/amoy/index.json'
    );
  });

  it('appends the index path to a base with a trailing slash', async () => {
    expect(await indexUrlFor('https://example.test/net/')).equal(
      'https://example.test/net/testnet/amoy/index.json'
    );
  });

  it('keeps a base query string and puts the index path in the pathname', async () => {
    expect(await indexUrlFor('https://example.test/net?key=secret123')).equal(
      'https://example.test/net/testnet/amoy/index.json?key=secret123'
    );
  });

  it('keeps a multi-segment path prefix together with a base query string', async () => {
    expect(await indexUrlFor('https://example.test/gw/net/?key=secret123&v=2')).equal(
      'https://example.test/gw/net/testnet/amoy/index.json?key=secret123&v=2'
    );
  });
});

describe('createAddressFetcher — a keyed base URL never leaks into errors', () => {
  it('redacts the key in an HTTP failure raised by the fetch layer', async () => {
    respondWith(500, { error: 'boom' });
    const fetcher = createAddressFetcher({
      network: 'amoy',
      baseUrl: 'https://example.test/net?key=secret123'
    });
    const err = await caught(fetcher.get());
    expect(requested[0]).contain('key=secret123');
    expectNoSecret(err);
    expect(err).nested.property(
      'info.url',
      'https://example.test/net/testnet/amoy/index.json?key=***'
    );
  });

  it('redacts the key in a network-layer failure', async () => {
    vi.stubGlobal('fetch', (input: string) => {
      requested.push(input);
      return Promise.reject(new TypeError('fetch failed'));
    });
    const fetcher = createAddressFetcher({
      network: 'amoy',
      baseUrl: 'https://example.test/net?key=secret123'
    });
    expectNoSecret(await caught(fetcher.get()));
  });

  it('rejects an unparseable base with the typed HTTP failure and redacts its key', async () => {
    const fetcher = createAddressFetcher({ network: 'amoy', baseUrl: 'not a url?key=secret123' });
    const err = await caught(fetcher.get());
    expect(err).property('code', 'HTTP_REQUEST_FAILED');
    expectNoSecret(err);
    expect(requested).length(0);
  });
});
