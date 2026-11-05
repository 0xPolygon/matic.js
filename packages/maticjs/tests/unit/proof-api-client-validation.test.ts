/**
 * The proof API's responses feed the exit payload byte-for-byte: the
 * fast path returns `result` as the payload, and the slow path RLP-encodes
 * `proof` into the payload. `@ethereumjs/rlp` encodes ANY string — a
 * non-hex string is UTF-8 encoded, an odd-length hex string is zero-padded
 * — so a malformed body must be rejected here, where the shape is known,
 * rather than silently encoded into an exit payload that can never verify.
 * A thrown `POSBridgeError` is what the bridge helpers catch to fall back
 * to local construction, so rejecting is the documented degrade path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { POSBridgeError } from '../../src/errors.ts';
import { ProofApiClient } from '../../src/internal/proof-api-client.ts';

function mockFetch(body: unknown): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      text: () => Promise.resolve(JSON.stringify(body))
    } as unknown as Response)
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = (): ProofApiClient =>
  new ProofApiClient({ baseUrl: 'https://example.test', network: 'mainnet' });

const rejects = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e
  );

const WORD = 'ab'.repeat(32);

describe('ProofApiClient — fast-merkle-proof response validation', () => {
  // start=10, end=20 → 11 blocks → depth 4 → 4 × 32-byte words.
  it('accepts a well-formed proof of the expected depth', async () => {
    mockFetch({ proof: `0x${WORD.repeat(4)}` });
    expect(await client().getFastMerkleProof(10, 20, 15)).to.equal(`0x${WORD.repeat(4)}`);
  });

  it('accepts the empty proof of a single-block checkpoint', async () => {
    mockFetch({ proof: '0x' });
    expect(await client().getFastMerkleProof(10, 10, 10)).to.equal('0x');
  });

  for (const [label, proof] of [
    ['a non-hex string', 'not a proof'],
    ['odd-length hex', '0xabc'],
    ['an empty string', ''],
    ['a bare 0x for a multi-block range', '0x'],
    ['a proof that is not whole 32-byte words', `0x${WORD}ab`],
    ['a proof of the wrong depth', `0x${WORD.repeat(3)}`],
    ['an uppercase 0X prefix', `0X${WORD.repeat(4)}`]
  ] as const) {
    it(`rejects ${label} with HTTP_REQUEST_FAILED`, async () => {
      mockFetch({ proof });
      const err = await rejects(client().getFastMerkleProof(10, 20, 15));
      expect(err).instanceOf(POSBridgeError);
      expect(err).property('code').equals('HTTP_REQUEST_FAILED');
    });
  }
});

describe('ProofApiClient — exit-payload response validation', () => {
  it('accepts a hex payload', async () => {
    mockFetch({ message: 'ok', result: '0xdeadbeef' });
    expect(await client().getExitPayload('0xburn', '0xsig')).to.equal('0xdeadbeef');
  });

  for (const [label, result] of [
    ['a non-hex string', 'nope'],
    ['odd-length hex', '0xabc'],
    ['an empty payload', '0x']
  ] as const) {
    it(`rejects ${label} with HTTP_REQUEST_FAILED`, async () => {
      mockFetch({ message: 'ok', result });
      const err = await rejects(client().getExitPayload('0xburn', '0xsig'));
      expect(err).instanceOf(POSBridgeError);
      expect(err).property('code').equals('HTTP_REQUEST_FAILED');
    });

    it(`rejects ${label} inside all-exit-payloads with HTTP_REQUEST_FAILED`, async () => {
      mockFetch({ message: 'ok', result: ['0xdeadbeef', result] });
      const err = await rejects(client().getAllExitPayloads('0xburn', '0xsig'));
      expect(err).instanceOf(POSBridgeError);
      expect(err).property('code').equals('HTTP_REQUEST_FAILED');
    });
  }
});

describe('ProofApiClient — block-included response validation', () => {
  it('rejects non-numeric fields with HTTP_REQUEST_FAILED instead of a bare SyntaxError', async () => {
    mockFetch({ headerBlockNumber: 'garbage', start: '1', end: '2' });
    const err = await rejects(client().getBlockIncluded(1));
    expect(err).instanceOf(POSBridgeError);
    expect(err).property('code').equals('HTTP_REQUEST_FAILED');
  });

  it('rejects a negative or inverted range with HTTP_REQUEST_FAILED', async () => {
    mockFetch({ headerBlockNumber: '1', start: '30', end: '20' });
    const err = await rejects(client().getBlockIncluded(25));
    expect(err).instanceOf(POSBridgeError);
    expect(err).property('code').equals('HTTP_REQUEST_FAILED');
  });
});
