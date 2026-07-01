/**
 * Unit tests for the internal `ProofApiClient`.
 *
 * The only boundary mocked is `globalThis.fetch` — the HTTP edge. URL
 * composition, the network-segment mapping (mainnet → matic / amoy →
 * amoy), and the response parsing/normalisation are all real code under
 * test. No chain logic is mocked because the client has none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POSBridgeError } from '../../src/errors.ts';
import { ProofApiClient } from '../../src/internal/proof-api-client.ts';

interface FetchCall {
  url: string;
}

const calls: FetchCall[] = [];

function mockFetch(
  responder: (url: string) => { status?: number; body: unknown }
): void {
  vi.stubGlobal('fetch', (url: string) => {
    calls.push({ url });
    const { status = 200, body } = responder(url);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      json: () => Promise.resolve(body)
    } as Response);
  });
}

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProofApiClient — URL construction + network mapping', () => {
  it('maps mainnet to the `matic` network segment', async () => {
    mockFetch(() => ({ body: { message: 'ok', result: '0xpayload' } }));
    const client = new ProofApiClient({
      baseUrl: 'https://proof-generator.polygon.technology',
      network: 'mainnet'
    });
    await client.getExitPayload('0xburn', '0xsig');
    expect(calls[0]?.url).to.equal(
      'https://proof-generator.polygon.technology/api/v1/matic/exit-payload/0xburn?eventSignature=0xsig'
    );
  });

  it('keeps the `amoy` segment for amoy', async () => {
    mockFetch(() => ({ body: { message: 'ok', result: '0xpayload' } }));
    const client = new ProofApiClient({ baseUrl: 'https://example.test', network: 'amoy' });
    await client.getExitPayload('0xburn', '0xsig');
    expect(calls[0]?.url).to.equal(
      'https://example.test/api/v1/amoy/exit-payload/0xburn?eventSignature=0xsig'
    );
  });

  it('strips a trailing slash from the base URL', async () => {
    mockFetch(() => ({ body: { message: 'ok', result: '0xpayload' } }));
    const client = new ProofApiClient({ baseUrl: 'https://example.test/', network: 'amoy' });
    await client.getExitPayload('0xburn', '0xsig');
    expect(calls[0]?.url).to.equal(
      'https://example.test/api/v1/amoy/exit-payload/0xburn?eventSignature=0xsig'
    );
  });

  it('appends tokenIndex only when provided', async () => {
    mockFetch(() => ({ body: { message: 'ok', result: '0xpayload' } }));
    const client = new ProofApiClient({ baseUrl: 'https://example.test', network: 'amoy' });
    await client.getExitPayload('0xburn', '0xsig', 2);
    expect(calls[0]?.url).to.contain('&tokenIndex=2');
  });

  it('builds the all-exit-payloads and fast-merkle-proof routes', async () => {
    mockFetch((url) =>
      url.includes('all-exit-payloads')
        ? { body: { message: 'ok', result: ['0xa', '0xb'] } }
        : { body: { proof: '0xproof' } }
    );
    const client = new ProofApiClient({ baseUrl: 'https://example.test', network: 'amoy' });
    await client.getAllExitPayloads('0xburn', '0xsig');
    await client.getFastMerkleProof(10, 20, 15);
    expect(calls[0]?.url).to.equal(
      'https://example.test/api/v1/amoy/all-exit-payloads/0xburn?eventSignature=0xsig'
    );
    expect(calls[1]?.url).to.equal(
      'https://example.test/api/v1/amoy/fast-merkle-proof?start=10&end=20&number=15'
    );
  });
});

describe('ProofApiClient — response parsing/normalisation', () => {
  it('returns the result string for a single exit payload', async () => {
    mockFetch(() => ({ body: { message: 'ok', result: '0xdeadbeef' } }));
    const client = new ProofApiClient({ baseUrl: 'https://example.test', network: 'amoy' });
    expect(await client.getExitPayload('0xburn', '0xsig')).to.equal('0xdeadbeef');
  });

  it('normalises block-included hex AND decimal values to bigint', async () => {
    mockFetch(() => ({
      body: { headerBlockNumber: '0x2710', start: '20001', end: 30000 }
    }));
    const client = new ProofApiClient({ baseUrl: 'https://example.test', network: 'amoy' });
    const res = await client.getBlockIncluded(25500);
    expect(res).to.not.equal(null);
    expect(res?.headerBlockNumber).to.equal(10000n);
    expect(res?.start).to.equal(20001n);
    expect(res?.end).to.equal(30000n);
  });

  it('surfaces a 404 from block-included as null (not-checkpointed signal)', async () => {
    mockFetch(() => ({ status: 404, body: { error: true, message: 'No block found' } }));
    const client = new ProofApiClient({ baseUrl: 'https://example.test', network: 'amoy' });
    expect(await client.getBlockIncluded(999)).to.equal(null);
  });

  it('throws POSBridgeError on a non-404 error from block-included', async () => {
    mockFetch(() => ({ status: 500, body: { error: true } }));
    const client = new ProofApiClient({ baseUrl: 'https://example.test', network: 'amoy' });
    await expect(client.getBlockIncluded(999)).rejects.toBeInstanceOf(POSBridgeError);
  });
});
