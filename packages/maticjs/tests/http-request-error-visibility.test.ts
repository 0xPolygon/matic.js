import type { Server } from 'node:http';

/**
 * Regression tests for HTTP error visibility in HttpRequest.
 *
 * Background
 * ----------
 * `ABIManager.init()` resolves network metadata by GETting
 * `<abiStoreUrl>/<network>/<version>/index.json`. The previous `HttpRequest.get`
 * did a bare `res.json()` with no status check, so:
 *
 *   - a non-2xx response (e.g. a CDN 403/429) made `res.json()` throw a
 *     context-free "Unexpected token <" — the status was lost; and
 *   - `Web3SideChainClient.init` then *discarded* that error entirely and
 *     rethrew the generic "network X - vY is not supported".
 *
 * The net effect was that any transport/CDN problem was undiagnosable. These
 * tests pin the fixed behaviour: the status and a body snippet survive.
 */
import { createServer } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HttpRequest } from '../src/utils/http_request';

let server: Server;
let baseUrl: string;
// Per-request knobs the test server reads to shape its response.
let nextStatus = 200;
let nextContentType = 'application/json';
let nextBody = '{}';

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(nextStatus, { 'content-type': nextContentType });
    res.end(nextBody);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${addr.port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

describe('HttpRequest.get error visibility', () => {
  it('surfaces the HTTP status and body on a non-2xx response', async () => {
    nextStatus = 403;
    nextContentType = 'text/html';
    nextBody = '<html><body>Forbidden by edge</body></html>';

    await expect(new HttpRequest(baseUrl).get('index.json')).rejects.toThrow(
      /HTTP 403[\s\S]*Forbidden by edge/
    );
  });

  it('reports a non-JSON 2xx body instead of a context-free parse error', async () => {
    nextStatus = 200;
    nextContentType = 'text/html';
    nextBody = '<html><body>rate limited</body></html>';

    await expect(new HttpRequest(baseUrl).get('index.json')).rejects.toThrow(
      /Expected JSON[\s\S]*content-type: text\/html[\s\S]*rate limited/
    );
  });

  it('still returns parsed JSON on a normal 2xx response', async () => {
    nextStatus = 200;
    nextContentType = 'application/json';
    nextBody = JSON.stringify({ Main: { Contracts: {} } });

    const result = await new HttpRequest(baseUrl).get<{ Main: unknown }>('index.json');
    expect(result).toHaveProperty('Main');
  });
});
