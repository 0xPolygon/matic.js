/**
 * URL resolution and redaction shared by the SDK's consumer-configurable
 * HTTP endpoints (`proofGenerationApiUrl`, `addressIndexUrl`).
 *
 * Both endpoints are consumer-supplied, so either can carry a path prefix
 * (a gateway mount) and its own query string (an API key). Appending a
 * route to such a base as text puts the route after the base's `?`, so a
 * keyed base could never work; and a key in the query must never reach
 * an error's message or `info`, because those end up in consumer logs.
 */

import { redactTokens } from '../adapters/sanitise.js';

/**
 * The slice of the WHATWG `URL` API the SDK uses. The SDK compiles
 * against `lib: es2023` with no DOM or Node globals, and the declaration
 * build of the main entry does not see `@types/node`'s global `URL`, so
 * the constructor every supported runtime (Node >= 20, browsers) provides
 * is declared here at module scope rather than through ambient types.
 */
export interface WhatwgUrl {
  pathname: string;
  search: string;
  readonly href: string;
  readonly searchParams: {
    append(name: string, value: string): void;
    forEach(callback: (value: string, name: string) => void): void;
  };
}
declare const URL: new (url: string, base?: WhatwgUrl) => WhatwgUrl;

/** Parse an absolute URL; throws the runtime's own error when it is not one. */
export function parseAbsoluteUrl(url: string): WhatwgUrl {
  return new URL(url);
}

/**
 * Resolve `relativePath` under `base`, keeping the base's path prefix and
 * query params.
 *
 * `new URL(rel, base)` replaces the base's last path segment unless the
 * base path ends in `/`, which would drop a prefix such as `/proofs`. So
 * the base path is normalised to exactly one trailing slash (extra
 * slashes would yield `//api`), and `relativePath` must not start with
 * `/`, which would discard the base path entirely. A relative reference
 * with a path never inherits the base's query, so the base's params are
 * copied onto the result.
 */
export function resolveUnderBase(base: WhatwgUrl, relativePath: string): WhatwgUrl {
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  const url = new URL(relativePath, base);
  base.searchParams.forEach((value, key) => {
    url.searchParams.append(key, value);
  });
  return url;
}

/**
 * Replace every query value with `***`. A configured base URL may carry
 * credentials under any param name, not just the `token` that
 * `redactTokens` knows, so no value is assumed public. Used where only
 * text is at hand: an unparseable base URL, or a response body snippet.
 */
export function redactQueryValues(s: string): string {
  return redactTokens(s).replace(/([?&])([^=&\s#?]+)=([^&\s#]*)/g, '$1$2=***');
}

/** A request URL, plus the form of it that is safe to put in an error. */
export interface RequestUrl {
  href: string;
  safe: string;
}

/**
 * Build the URL for one request — `relativePath` resolved under `base`
 * (see {@link resolveUnderBase}) plus the SDK's own `params` — together
 * with its error-safe form.
 *
 * Redaction goes by where a param came from, not by its name: the base's
 * params are the consumer's (possibly credentials, under any name, even
 * one the SDK also uses such as `start`), the appended ones are the
 * SDK's (public, and what makes a failed request diagnosable). Matching
 * names on the finished href cannot tell `?start=<key>&start=5` apart,
 * so the safe form is built separately from a copy of the base whose
 * values are all `***`, through the same steps as the real one.
 */
export function buildRequestUrl(
  base: WhatwgUrl,
  relativePath: string,
  params: Record<string, string | number> = {}
): RequestUrl {
  const redactedBase = new URL(base.href);
  const baseNames: string[] = [];
  base.searchParams.forEach((_value, name) => {
    baseNames.push(name);
  });
  redactedBase.search = '';
  for (const name of baseNames) {
    redactedBase.searchParams.append(name, '***');
  }
  const build = (from: WhatwgUrl): string => {
    const url = resolveUnderBase(from, relativePath);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.append(key, String(value));
    }
    return url.href;
  };
  return { href: build(base), safe: redactTokens(build(redactedBase)) };
}
