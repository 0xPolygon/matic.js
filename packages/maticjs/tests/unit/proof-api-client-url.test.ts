/**
 * `proofGenerationApiUrl` is consumer-supplied, so it can carry a path
 * prefix (a gateway mount) and its own query string (an API key). Routes
 * used to be appended to it as text, which put the route after the `?` of
 * a keyed base. These tests pin where the route and each param land for
 * every base shape. Only `fetch` is stubbed; the URL is captured from it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POSBridgeError } from '../../src/errors.ts';
import { ProofApiClient } from '../../src/internal/proof-api-client.ts';

const requested: string[] = [];

beforeEach(() => {
  requested.length = 0;
  vi.stubGlobal('fetch', (input: string) => {
    requested.push(input);
    const body = input.includes('fast-merkle-proof')
      ? { proof: `0x${'ab'.repeat(32).repeat(4)}` }
      : input.includes('all-exit-payloads')
        ? { message: 'ok', result: ['0xaa'] }
        : { message: 'ok', result: '0xdeadbeef' };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const exitPayloadUrl = async (baseUrl: string): Promise<URL> => {
  await new ProofApiClient({ baseUrl, network: 'amoy' }).getExitPayload('0xburn', '0xsig');
  return new URL(requested[0] ?? '');
};

describe('ProofApiClient — request URL resolution against the base', () => {
  it('appends the route to a base without a trailing slash', async () => {
    const url = await exitPayloadUrl('https://example.test');
    expect(url.href).equal(
      'https://example.test/api/v1/amoy/exit-payload/0xburn?eventSignature=0xsig'
    );
  });

  it('appends the route to a base with a trailing slash', async () => {
    const url = await exitPayloadUrl('https://example.test/');
    expect(url.href).equal(
      'https://example.test/api/v1/amoy/exit-payload/0xburn?eventSignature=0xsig'
    );
  });

  it('keeps a base query string and puts the route in the pathname', async () => {
    const url = await exitPayloadUrl('https://example.test?key=abc');
    expect(url.pathname).equal('/api/v1/amoy/exit-payload/0xburn');
    expect(url.searchParams.get('key')).equal('abc');
    expect(url.searchParams.get('eventSignature')).equal('0xsig');
  });

  it('keeps a base path prefix together with a base query string', async () => {
    const url = await exitPayloadUrl('https://example.test/proofs/v2?key=abc');
    expect(url.pathname).equal('/proofs/v2/api/v1/amoy/exit-payload/0xburn');
    expect(url.searchParams.get('key')).equal('abc');
  });

  it('keeps a base path prefix that ends in a slash', async () => {
    const url = await exitPayloadUrl('https://example.test/proofs/');
    expect(url.pathname).equal('/proofs/api/v1/amoy/exit-payload/0xburn');
  });

  it('combines base params with every request param', async () => {
    const client = new ProofApiClient({
      baseUrl: 'https://example.test/gw?key=abc&tenant=t1',
      network: 'mainnet'
    });
    await client.getExitPayload('0xburn', '0xsig', 2);
    await client.getAllExitPayloads('0xburn', '0xsig');
    await client.getFastMerkleProof(10, 25, 15);
    expect(requested).deep.equal([
      'https://example.test/gw/api/v1/matic/exit-payload/0xburn?key=abc&tenant=t1&eventSignature=0xsig&tokenIndex=2',
      'https://example.test/gw/api/v1/matic/all-exit-payloads/0xburn?key=abc&tenant=t1&eventSignature=0xsig',
      'https://example.test/gw/api/v1/matic/fast-merkle-proof?key=abc&tenant=t1&start=10&end=25&number=15'
    ]);
  });

  it('keeps base params on a route with no request params', async () => {
    vi.stubGlobal('fetch', (input: string) => {
      requested.push(input);
      return Promise.resolve(
        new Response(JSON.stringify({ headerBlockNumber: '1', start: '1', end: '2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    });
    const client = new ProofApiClient({ baseUrl: 'https://example.test?key=abc', network: 'amoy' });
    await client.getBlockIncluded(2);
    expect(requested[0]).equal('https://example.test/api/v1/amoy/block-included/2?key=abc');
  });

  it('rejects an unparseable base with the typed HTTP failure', async () => {
    const client = new ProofApiClient({ baseUrl: 'not a url', network: 'amoy' });
    const err: unknown = await client.getExitPayload('0xburn', '0xsig').then(
      () => null,
      (e: unknown) => e
    );
    expect(err).instanceOf(POSBridgeError);
    expect(err).property('code', 'HTTP_REQUEST_FAILED');
    expect(requested).length(0);
  });
});

describe('ProofApiClient — a keyed base URL never leaks into errors', () => {
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

  it('redacts the key in a malformed-response validation error', async () => {
    respondWith(200, { message: 'ok' });
    const client = new ProofApiClient({
      baseUrl: 'https://example.test/gw?key=secret123',
      network: 'amoy'
    });
    const err = await caught(client.getExitPayload('0xburn', '0xsig'));
    expect(requested[0]).contain('key=secret123');
    expectNoSecret(err);
    expect(err).nested.property(
      'info.url',
      'https://example.test/gw/api/v1/amoy/exit-payload/0xburn?key=***&eventSignature=0xsig'
    );
  });

  it('redacts the key in a malformed payload and a malformed proof', async () => {
    const client = new ProofApiClient({
      baseUrl: 'https://example.test?key=secret123',
      network: 'amoy'
    });
    respondWith(200, { message: 'ok', result: 'not-hex' });
    expectNoSecret(await caught(client.getExitPayload('0xburn', '0xsig')));
    respondWith(200, { proof: '0x1234' });
    expectNoSecret(await caught(client.getFastMerkleProof(10, 25, 15)));
    respondWith(200, { headerBlockNumber: 'x', start: '1', end: '2' });
    expectNoSecret(await caught(client.getBlockIncluded(2)));
  });

  it('redacts the key in an HTTP failure raised by the fetch layer', async () => {
    respondWith(500, { error: 'boom' });
    const client = new ProofApiClient({
      baseUrl: 'https://example.test?key=secret123',
      network: 'amoy'
    });
    expectNoSecret(await caught(client.getAllExitPayloads('0xburn', '0xsig')));
  });

  it('redacts the key of an unparseable base', async () => {
    const client = new ProofApiClient({ baseUrl: 'not a url?key=secret123', network: 'amoy' });
    expectNoSecret(await caught(client.getExitPayload('0xburn', '0xsig')));
  });
});
