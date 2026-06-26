const fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response> = (() => {
  if (process.env.BUILD_ENV === 'node') {
    return require('node-fetch').default;
  }
  return window.fetch;
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

    return fetch(fullUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    }).then((res) => parseJsonResponse<T>(res, 'GET', fullUrl));
  }

  post(url = '', body) {
    const fullUrl = this.baseUrl + url;

    return fetch(fullUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: body ? JSON.stringify(body) : null
    }).then((res) => parseJsonResponse(res, 'POST', fullUrl));
  }
}
