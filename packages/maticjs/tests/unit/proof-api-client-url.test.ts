import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `proofGenerationApiUrl` is consumer-supplied, so it can carry a path
 * prefix (a gateway mount) and its own query string (an API key). Routes
 * used to be appended to it as text, which put the route after the `?` of
 * a keyed base. These tests pin where the route and each param land for
 * every base shape. Only `fetch` is stubbed; the URL is captured from it.
 */
import { VError } from '@polygonlabs/verror';

import { isMaticjsError } from '../../src/errors.ts';
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
    expect(err).property('name', 'HttpRequestFailedError');
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
    if (!isMaticjsError(err) || !(err instanceof Error)) return;
    expect(err.message).not.contain('secret123');
    expect(JSON.stringify(VError.info(err))).not.contain('secret123');
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

describe('ProofApiClient — base params are redacted whatever their name', () => {
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

  const expectRedacted = (err: unknown, secret: string, visible: string[]): void => {
    if (!isMaticjsError(err) || !(err instanceof Error)) return;
    expect(err.message).not.contain(secret);
    expect(JSON.stringify(VError.info(err))).not.contain(secret);
    expect(JSON.stringify(err)).not.contain(secret);
    for (const fragment of visible) {
      expect(JSON.stringify(VError.info(err))).contain(fragment);
    }
  };

  // Each SDK request param, a call that sends it, and the readable form
  // the request's own value must keep in the error.
  const cases: {
    name: string;
    call: (c: ProofApiClient) => Promise<unknown>;
    visible: string;
    malformed: unknown;
  }[] = [
    {
      name: 'eventSignature',
      call: (c) => c.getAllExitPayloads('0xburn', '0xsig'),
      visible: 'eventSignature=0xsig',
      malformed: { message: 'ok' }
    },
    {
      name: 'tokenIndex',
      call: (c) => c.getExitPayload('0xburn', '0xsig', 2),
      visible: 'tokenIndex=2',
      malformed: { message: 'ok' }
    },
    {
      name: 'start',
      call: (c) => c.getFastMerkleProof(10, 25, 15),
      visible: 'start=10',
      malformed: { proof: '0x1234' }
    },
    {
      name: 'end',
      call: (c) => c.getFastMerkleProof(10, 25, 15),
      visible: 'end=25',
      malformed: { proof: '0x1234' }
    },
    {
      name: 'number',
      call: (c) => c.getFastMerkleProof(10, 25, 15),
      visible: 'number=15',
      malformed: { proof: '0x1234' }
    }
  ];

  for (const { name, call, visible, malformed } of cases) {
    const client = (): ProofApiClient =>
      new ProofApiClient({
        baseUrl: `https://example.test/gw?${name}=secret123`,
        network: 'amoy'
      });

    it(`redacts a base \`${name}\` in a validation error and keeps the request's \`${name}\``, async () => {
      respondWith(200, malformed);
      const err = await caught(call(client()));
      expect(requested[0]).contain(`${name}=secret123`);
      expectRedacted(err, 'secret123', [`${name}=***`, visible]);
    });

    it(`redacts a base \`${name}\` in an HTTP failure and keeps the request's \`${name}\``, async () => {
      respondWith(500, { error: 'boom' });
      const err = await caught(call(client()));
      expectRedacted(err, 'secret123', [`${name}=***`, visible]);
      expect(err).property('message').contain(visible);
    });
  }

  it('redacts a base param that collides with a request param in the exact URL', async () => {
    respondWith(200, { proof: '0x1234' });
    const client = new ProofApiClient({
      baseUrl: 'https://example.test/gw?start=secret123&key=k1',
      network: 'mainnet'
    });
    const err = await caught(client.getFastMerkleProof(10, 25, 15));
    expect(err).nested.property(
      'info.url',
      'https://example.test/gw/api/v1/matic/fast-merkle-proof?start=***&key=***&start=10&end=25&number=15'
    );
  });

  it('redacts an encoded base value in both its encoded and decoded forms', async () => {
    respondWith(500, { error: 'boom' });
    const client = new ProofApiClient({
      baseUrl: 'https://example.test/gw?number=s%3Dcr%26t%20val',
      network: 'amoy'
    });
    const err = await caught(client.getFastMerkleProof(10, 25, 15));
    for (const form of ['s%3Dcr%26t', 's=cr&t', 'cr%26t', 't+val', 't%20val', 't val']) {
      expect(err).property('message').not.contain(form);
      expect(JSON.stringify(err)).not.contain(form);
    }
    expect(err).nested.property('info.url').contain('number=***&start=10');
  });

  it('leaves the error URL unchanged for a base with no query', async () => {
    respondWith(200, { proof: '0x1234' });
    const client = new ProofApiClient({ baseUrl: 'https://example.test/gw', network: 'amoy' });
    const err = await caught(client.getFastMerkleProof(10, 25, 15));
    expect(err).nested.property(
      'info.url',
      'https://example.test/gw/api/v1/amoy/fast-merkle-proof?start=10&end=25&number=15'
    );
  });
});
