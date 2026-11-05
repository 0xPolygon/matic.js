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

const NO_PUBLIC_PARAMS: ReadonlySet<string> = new Set();

/**
 * Replace every query value with `***` unless its name is in
 * `publicParams` — params the SDK added itself, whose values are public
 * and keep a failed request diagnosable. A configured base URL may carry
 * credentials under any param name, not just the `token` that
 * `redactTokens` knows, so everything else is treated as secret.
 */
export function redactQueryValues(
  s: string,
  publicParams: ReadonlySet<string> = NO_PUBLIC_PARAMS
): string {
  return redactTokens(s).replace(
    /([?&])([^=&\s#?]+)=([^&\s#]*)/g,
    (match: string, sep: string, name: string) =>
      publicParams.has(name) ? match : `${sep}${name}=***`
  );
}
