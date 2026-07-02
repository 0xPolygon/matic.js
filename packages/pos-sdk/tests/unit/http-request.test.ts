import { afterEach, describe, expect, it, vi } from 'vitest';

import { POSBridgeError } from '../../src/errors.ts';
import { httpGet } from '../../src/utils/http_request.ts';

/**
 * Pins the diagnosability contract of `httpGet`: every failure mode a
 * CDN/WAF can produce must surface as a `POSBridgeError` that says WHY —
 * URL, status, and a body snippet — never a bare, context-free
 * `SyntaxError`. This is the 1.0 counterpart of the 0.x fix that made
 * metadata-fetch failures diagnosable.
 */

function stubFetch(res: {
  ok: boolean;
  status?: number;
  statusText?: string;
  contentType?: string | null;
  body: string;
}): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve({
      ok: res.ok,
      status: res.status ?? (res.ok ? 200 : 500),
      statusText: res.statusText ?? (res.ok ? 'OK' : 'Internal Server Error'),
      headers: { get: () => res.contentType ?? null },
      text: () => Promise.resolve(res.body)
    } as unknown as Response)
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('httpGet', () => {
  it('parses a JSON 2xx body', async () => {
    stubFetch({ ok: true, contentType: 'application/json', body: '{"a":1}' });
    const out = await httpGet<{ a: number }>('https://x.test/index.json');
    expect(out).deep.equals({ a: 1 });
  });

  it('surfaces status and body snippet on non-2xx', async () => {
    stubFetch({ ok: false, status: 503, statusText: 'Service Unavailable', body: 'upstream capacity exceeded' });
    const err = await httpGet('https://x.test/index.json').then(
      () => null,
      (e: unknown) => e
    );
    expect(err).instanceOf(POSBridgeError);
    const posErr = err as POSBridgeError;
    expect(posErr.code).equals('ROOT_HASH_RPC_FAILED');
    expect(posErr.message).contains('503');
    expect(posErr.message).contains('upstream capacity exceeded');
    expect(posErr.info).property('bodySnippet').contains('capacity');
  });

  it('surfaces content-type and snippet when a 2xx body is not JSON', async () => {
    stubFetch({ ok: true, contentType: 'text/html', body: '<html><body>Checking your browser…</body></html>' });
    const err = await httpGet('https://x.test/index.json').then(
      () => null,
      (e: unknown) => e
    );
    expect(err).instanceOf(POSBridgeError);
    const posErr = err as POSBridgeError;
    expect(posErr.code).equals('ROOT_HASH_RPC_FAILED');
    expect(posErr.message).contains('not JSON');
    expect(posErr.message).contains('text/html');
    expect(posErr.message).contains('Checking your browser');
  });
});
