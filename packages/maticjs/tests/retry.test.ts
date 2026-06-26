/**
 * Unit tests for the shared transient-retry helper.
 *
 * The classification must cover node-fetch's "Premature close" — a wrapped
 * FetchError that (verified against node-fetch 2.7.0 source) carries
 * `code === errno === 'ERR_STREAM_PREMATURE_CLOSE'` AND a "...: Premature close"
 * message. The previous inline predicate in proof_util.ts checked only a fixed
 * `code` list that omitted it, so the ABI/config metadata fetch failed
 * un-retried in CI. The real-FetchError case below pins the exact shape.
 */
import nodeFetch from 'node-fetch';
import { describe, expect, it } from 'vitest';

import { isTransientNetworkError, retryTransient } from '../src/utils/retry';

// node-fetch v2 is CommonJS; FetchError hangs off the default export.
const { FetchError } = nodeFetch as unknown as {
  FetchError: new (m: string, t: string, s?: unknown) => Error;
};

describe('isTransientNetworkError', () => {
  it('matches known transient codes (code or errno)', () => {
    expect(isTransientNetworkError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientNetworkError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTransientNetworkError({ errno: 'ENOTFOUND' })).toBe(true);
    expect(isTransientNetworkError({ code: 'ERR_STREAM_PREMATURE_CLOSE' })).toBe(true);
  });

  it("matches node-fetch's 'Premature close' / 'socket hang up' by message", () => {
    expect(
      isTransientNetworkError(
        new Error(
          'Invalid response body while trying to fetch https://static.polygon.technology/network/mainnet/v1/index.json: Premature close'
        )
      )
    ).toBe(true);
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true);
  });

  it('matches a REAL node-fetch FetchError for a premature close', () => {
    // Built exactly as node-fetch 2.7.0 does it (lib/index.js): an inner
    // stream error with code ERR_STREAM_PREMATURE_CLOSE, wrapped in a
    // `system` FetchError — whose ctor copies `code`/`errno` from the inner.
    const inner = Object.assign(new Error('Premature close'), {
      code: 'ERR_STREAM_PREMATURE_CLOSE'
    });
    const fetchErr = new FetchError(
      'Invalid response body while trying to fetch https://static.polygon.technology/network/mainnet/v1/index.json: Premature close',
      'system',
      inner
    );
    // Sanity-check the shape we're relying on, then the classification.
    expect(fetchErr).to.have.property('code', 'ERR_STREAM_PREMATURE_CLOSE');
    expect(fetchErr).to.have.property('errno', 'ERR_STREAM_PREMATURE_CLOSE');
    expect(isTransientNetworkError(fetchErr)).toBe(true);
  });

  it('does not match application errors (e.g. an HTTP status error)', () => {
    expect(isTransientNetworkError(new Error('HTTP 403 Forbidden for GET ...'))).toBe(false);
    expect(isTransientNetworkError({ code: 'EACCES' })).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError('nope')).toBe(false);
  });
});

describe('retryTransient', () => {
  it('retries a transient failure and then succeeds', async () => {
    let calls = 0;
    const result = await retryTransient(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error('Premature close');
        }
        return 'ok';
      },
      { baseDelayMs: 1, maxDelayMs: 2 }
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry a non-transient error', async () => {
    let calls = 0;
    await expect(
      retryTransient(async () => {
        calls += 1;
        throw new Error('HTTP 403 Forbidden');
      })
    ).rejects.toThrow(/403/);
    expect(calls).toBe(1);
  });

  it('gives up after the configured retries and rethrows the last error', async () => {
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls += 1;
          throw new Error('Premature close');
        },
        { retries: 2, baseDelayMs: 1, maxDelayMs: 2 }
      )
    ).rejects.toThrow(/Premature close/);
    expect(calls).toBe(3); // initial attempt + 2 retries
  });
});
