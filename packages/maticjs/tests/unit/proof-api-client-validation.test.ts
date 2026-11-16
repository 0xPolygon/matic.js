/**
 * The proof API's responses feed the exit payload byte-for-byte: the
 * fast path returns `result` as the payload, and the slow path RLP-encodes
 * `proof` into the payload. `@ethereumjs/rlp` encodes ANY string — a
 * non-hex string is UTF-8 encoded, an odd-length hex string is zero-padded
 * — so a malformed body must be rejected here, where the shape is known,
 * rather than silently encoded into an exit payload that can never verify.
 * A thrown `HttpRequestFailedError` is what the bridge helpers catch to fall back
 * to local construction, so rejecting is the documented degrade path.
 */
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
    it(`rejects ${label} with HttpRequestFailedError`, async () => {
      mockFetch({ proof });
      const err = await rejects(client().getFastMerkleProof(10, 20, 15));
      expect(err).property('name').equals('HttpRequestFailedError');
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
    it(`rejects ${label} with HttpRequestFailedError`, async () => {
      mockFetch({ message: 'ok', result });
      const err = await rejects(client().getExitPayload('0xburn', '0xsig'));
      expect(err).property('name').equals('HttpRequestFailedError');
    });

    it(`rejects ${label} inside all-exit-payloads with HttpRequestFailedError`, async () => {
      mockFetch({ message: 'ok', result: ['0xdeadbeef', result] });
      const err = await rejects(client().getAllExitPayloads('0xburn', '0xsig'));
      expect(err).property('name').equals('HttpRequestFailedError');
    });
  }
});

describe('ProofApiClient — block-included response validation', () => {
  it('rejects non-numeric fields with HttpRequestFailedError instead of a bare SyntaxError', async () => {
    mockFetch({ headerBlockNumber: 'garbage', start: '1', end: '2' });
    const err = await rejects(client().getBlockIncluded(1));
    expect(err).property('name').equals('HttpRequestFailedError');
    // `BigInt`'s own SyntaxError is kept as the cause, not dropped.
    expect(err).property('cause').instanceOf(SyntaxError);
    expect(err).nested.property('info.field').equals('headerBlockNumber');
  });

  it('rejects a negative or inverted range with HttpRequestFailedError', async () => {
    mockFetch({ headerBlockNumber: '1', start: '30', end: '20' });
    const err = await rejects(client().getBlockIncluded(25));
    expect(err).property('name').equals('HttpRequestFailedError');
  });
});

/**
 * Recorded with a read-only GET of the production API
 * (`/api/v1/matic/block-included/97394752`) on 2026-11-16. `start`, `end`
 * and `createdAt` are ethers-BigNumber JSON; `headerBlockNumber` is a hex
 * string and `blockNumber` a decimal string.
 */
const recordedBlockIncluded: unknown = JSON.parse(
  readFileSync(
    new URL('../fixtures/proof-api/mainnet-block-included-97394752.json', import.meta.url),
    'utf8'
  )
);

describe('ProofApiClient — block-included wire shapes', () => {
  it('accepts the recorded production response (BigNumber JSON start/end)', async () => {
    mockFetch(recordedBlockIncluded);
    const res = await client().getBlockIncluded(97394752);
    expect(res).property('headerBlockNumber').equals(1169890000n);
    expect(res).property('start').equals(97394598n);
    expect(res).property('end').equals(97396133n);
  });

  it('accepts plain JSON numbers', async () => {
    mockFetch({ headerBlockNumber: 10_000, start: 20_001, end: 30_000 });
    const res = await client().getBlockIncluded(25_500);
    expect(res).property('headerBlockNumber').equals(10_000n);
    expect(res).property('start').equals(20_001n);
    expect(res).property('end').equals(30_000n);
  });

  for (const [label, start, causeType] of [
    ['BigNumber JSON with non-hex `hex`', { type: 'BigNumber', hex: '0xzz' }, SyntaxError],
    ['BigNumber JSON without `hex`', { type: 'BigNumber' }, TypeError],
    ['BigNumber JSON with a numeric `hex`', { type: 'BigNumber', hex: 97394598 }, TypeError],
    ['an object of another type', { type: 'FixedNumber', hex: '0x05ce1fa6' }, TypeError],
    ['an object with no type', { hex: '0x05ce1fa6' }, TypeError],
    ['null', null, TypeError],
    ['a boolean', true, TypeError],
    ['a fractional number', 1.5, RangeError]
  ] as const) {
    it(`rejects ${label} with HttpRequestFailedError`, async () => {
      mockFetch({
        headerBlockNumber: '0x45bb1ad0',
        start,
        end: { type: 'BigNumber', hex: '0x05ce25a5' }
      });
      const err = await rejects(client().getBlockIncluded(97394752));
      expect(err).property('name').equals('HttpRequestFailedError');
      expect(err).nested.property('info.field').equals('start');
      expect(err).property('cause').instanceOf(causeType);
    });
  }

  it('records a rejected object value as JSON, not [object Object]', async () => {
    mockFetch({ headerBlockNumber: '1', start: { type: 'Other', hex: '0x1' }, end: '2' });
    const err = await rejects(client().getBlockIncluded(1));
    expect(err).nested.property('info.value').equals('{"type":"Other","hex":"0x1"}');
  });
});
