/**
 * Unit tests for `sanitiseError`.
 *
 * The sanitiser exists to keep RPC tokens out of consumer logs — viem,
 * ethers v5, and ethers v6 all interpolate the request URL into their
 * error messages, and the URL routinely carries a `?token=…` query
 * param when consumers route through Polygon's eRPC proxy. The tests
 * here cover the documented contract:
 *
 * - tokens are stripped from the error message;
 * - the cause chain is preserved (and is itself sanitised);
 * - circular cause chains do not blow the stack;
 * - subclass prototypes (TypeError, POSBridgeError, …) survive.
 */
import { describe, expect, it } from 'vitest';

import { POSBridgeError, sanitiseError } from '../../src/index.js';

describe('sanitiseError', () => {
  it('strips token=... query parameters from error messages', () => {
    const original = new Error(
      'http request to https://example.com/internal/evm/1?token=secret123&chainId=1 failed'
    );
    const cleaned = sanitiseError(original);
    expect(cleaned).instanceOf(Error);
    expect((cleaned as Error).message).match(/\?token=\*\*\*/);
    expect((cleaned as Error).message).not.match(/secret123/);
    // Original is untouched.
    expect(original.message).match(/secret123/);
  });

  it('strips token=... regardless of position (& or ?)', () => {
    const cleaned = sanitiseError(
      new Error('https://x?chainId=1&token=ABC&foo=bar')
    ) as Error;
    expect(cleaned.message).match(/&token=\*\*\*/);
    expect(cleaned.message).not.match(/ABC/);
  });

  it('preserves the original error cause', () => {
    // The cause is itself an Error, so sanitiseError must walk into it
    // (preserved as a sanitised copy, not dropped). The clone is a fresh
    // Error instance whose `message` was the original inner message
    // with the token redacted.
    const inner = new Error('inner with ?token=secret in url');
    const outer = new Error('outer wrap with no token', { cause: inner });
    const cleaned = sanitiseError(outer) as Error;
    expect(cleaned).property('cause').instanceOf(Error);
    const cleanedInner = cleaned.cause as Error;
    expect(cleanedInner.message).match(/\?token=\*\*\*/);
    expect(cleanedInner.message).not.match(/secret/);
  });

  it('handles nested errors (cause chain)', () => {
    const a = new Error('A url=https://x?token=aaa');
    const b = new Error('B url=https://x?token=bbb', { cause: a });
    const c = new Error('C url=https://x?token=ccc', { cause: b });
    const cleaned = sanitiseError(c) as Error;
    expect(cleaned.message).not.match(/ccc/);
    const causeB = cleaned.cause as Error;
    expect(causeB.message).not.match(/bbb/);
    const causeA = causeB.cause as Error;
    expect(causeA.message).not.match(/aaa/);
  });

  it('handles circular cause chains without infinite recursion', () => {
    // Some libraries set `err.cause = err` to bridge older runtimes; the
    // sanitiser must terminate even though the chain has no end.
    const e = new Error('loop ?token=loopval');
    (e as { cause?: unknown }).cause = e;
    const cleaned = sanitiseError(e) as Error;
    expect(cleaned.message).match(/\?token=\*\*\*/);
    // The cleaned error's cause must point somewhere — either the same
    // sanitised object or the original — but the call must have returned.
    expect(cleaned.cause).not.equals(undefined);
  });

  it('preserves error subclass prototypes (TypeError, custom POSBridgeError)', () => {
    const tErr = new TypeError('typed ?token=zzz here');
    const cleanedT = sanitiseError(tErr) as Error;
    expect(cleanedT).instanceOf(TypeError);
    expect(cleanedT.name).equals('TypeError');
    expect(cleanedT.message).not.match(/zzz/);

    const posErr = new POSBridgeError(
      'PROOF_API_NOT_SET',
      'pos url=https://x?token=zzz here'
    );
    // Tag an own-string property post-construction; sanitise must walk
    // into it (the documented behaviour for own enumerable string props).
    (posErr as unknown as Record<string, unknown>).extraUrl =
      'https://y?token=zzz';
    const cleanedP = sanitiseError(posErr);
    expect(cleanedP).instanceOf(POSBridgeError);
    const cleanedPos = cleanedP as POSBridgeError;
    expect(cleanedPos.name).equals('POSBridgeError');
    expect(cleanedPos.code).equals('PROOF_API_NOT_SET');
    expect(cleanedPos.message).match(/\?token=\*\*\*/);
    expect(cleanedPos)
      .property('extraUrl')
      .match(/\?token=\*\*\*/);
  });

  it('returns non-Error inputs unchanged', () => {
    expect(sanitiseError('plain string ?token=zzz')).equals('plain string ?token=zzz');
    expect(sanitiseError(42)).equals(42);
    expect(sanitiseError(null)).equals(null);
    expect(sanitiseError(undefined)).equals(undefined);
  });
});

describe('sanitiseError — deep shapes (info objects, arrays, nested requests)', () => {
  it('sanitises VError info values without aliasing the original info object', () => {
    const err = new POSBridgeError('HTTP_REQUEST_FAILED', 'GET failed', {
      url: 'https://rpc.example/evm/1?token=SECRET',
      status: 503
    });
    const cleaned = sanitiseError(err) as POSBridgeError;
    expect(cleaned.info).property('url').match(/\?token=\*\*\*/);
    expect(cleaned.info).property('status').equals(503);
    // Original untouched, and the clone must not share the info object.
    expect(err.info).property('url').contains('SECRET');
    expect(cleaned.info).not.equals(err.info);
  });

  it('sanitises string arrays (viem metaMessages shape)', () => {
    const err = new Error('request failed');
    (err as unknown as Record<string, unknown>).metaMessages = [
      'URL: https://rpc.example/evm/1?token=SECRET',
      'Request body: {}'
    ];
    const cleaned = sanitiseError(err) as Error & { metaMessages: string[] };
    expect(cleaned.metaMessages[0]).match(/\?token=\*\*\*/);
    expect(cleaned.metaMessages[1]).equals('Request body: {}');
  });

  it('sanitises nested plain objects (ethers v6 info.requestUrl shape)', () => {
    const err = new Error('server error');
    (err as unknown as Record<string, unknown>).info = {
      requestUrl: 'https://rpc.example/evm/1?token=SECRET',
      request: { url: 'https://rpc.example/evm/1?token=SECRET&x=1', method: 'POST' }
    };
    const cleaned = sanitiseError(err) as Error & {
      info: { requestUrl: string; request: { url: string; method: string } };
    };
    expect(cleaned.info.requestUrl).match(/\?token=\*\*\*/);
    expect(cleaned.info.request.url).match(/\?token=\*\*\*&x=1/);
    expect(cleaned.info.request.method).equals('POST');
  });

  it('passes non-plain class instances through by reference', () => {
    const err = new Error('x');
    const when = new Date(0);
    (err as unknown as Record<string, unknown>).when = when;
    const cleaned = sanitiseError(err) as Error & { when: Date };
    expect(cleaned.when).equals(when);
  });

  it('survives self-referencing info objects', () => {
    const err = new Error('x ?token=zzz');
    const info: Record<string, unknown> = { url: 'https://y?token=zzz' };
    info.self = info;
    (err as unknown as Record<string, unknown>).info = info;
    const cleaned = sanitiseError(err) as Error & { info: { url: string } };
    expect(cleaned.message).match(/\?token=\*\*\*/);
    expect(cleaned.info.url).match(/\?token=\*\*\*/);
  });
});
