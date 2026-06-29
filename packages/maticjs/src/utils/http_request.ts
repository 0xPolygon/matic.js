import { retryTransient } from './retry';

// node-fetch supports an `agent` option that the DOM lib's RequestInit lacks.
type FetchInit = RequestInit & { agent?: unknown };

const fetch: (input: RequestInfo, init?: FetchInit) => Promise<Response> = (() => {
  if (process.env.BUILD_ENV === 'node') {
    return require('node-fetch').default;
  }
  return window.fetch;
})();

// Force a non-keep-alive HTTP agent in the Node build. Node 19+ defaults http(s)
// agents to keepAlive:true; node-fetch then reuses a socket the upstream CDN
// (Cloudflare) has already idle-closed, and the next gzip response dies
// mid-decompression as `FetchError: Premature close` — observed 100% from CI,
// intermittently elsewhere. These network-config and ABI fetches run once per
// client init and are cached, so a fresh connection per request costs only a TLS
// handshake at startup. The browser build's `window.fetch` ignores `agent`, and
// node:http/https are required only inside the BUILD_ENV==='node' branch so they
// are never bundled for the browser.
const requestAgent: unknown = (() => {
  if (process.env.BUILD_ENV === 'node') {
    const httpAgent = new (require('http').Agent)({ keepAlive: false });
    const httpsAgent = new (require('https').Agent)({ keepAlive: false });
    return (parsedUrl: { protocol: string }) =>
      parsedUrl.protocol === 'http:' ? httpAgent : httpsAgent;
  }
  return undefined;
})();

// Fail with the HTTP status / body on a non-2xx or non-JSON response instead of
// letting a bare `res.json()` throw a context-free parse error.
async function parseJsonResponse<T>(res: Response, method: string, url: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    const snippet = text.slice(0, 200);
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${method} ${url}: ${snippet}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const contentType = res.headers.get('content-type') ?? 'unknown';
    const snippet = text.slice(0, 200);
    throw new Error(
      `Expected JSON from ${method} ${url} (content-type: ${contentType}) but parsing failed: ${snippet}`
    );
  }
}

export class HttpRequest {
  baseUrl = '';

  constructor(option: { baseUrl: string } | string = {} as any) {
    const normalized = typeof option === 'string' ? { baseUrl: option } : option;

    if (normalized.baseUrl) {
      this.baseUrl = normalized.baseUrl;
    }
  }

  get<T>(url = '', query = {}): Promise<T> {
    const fullUrl =
      this.baseUrl +
      url +
      Object.keys(query)
        .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
        .join('&');

    // Retry transient connection failures (a stale keep-alive socket surfaces
    // as a node-fetch "Premature close" / ECONNRESET while reading the body).
    return retryTransient(() =>
      fetch(fullUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        agent: requestAgent
      }).then((res) => parseJsonResponse<T>(res, 'GET', fullUrl))
    );
  }

  post(url = '', body) {
    const fullUrl = this.baseUrl + url;

    return retryTransient(() =>
      fetch(fullUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: body ? JSON.stringify(body) : null,
        agent: requestAgent
      }).then((res) => parseJsonResponse(res, 'POST', fullUrl))
    );
  }
}
