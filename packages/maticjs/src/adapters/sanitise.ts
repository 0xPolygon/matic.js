/**
 * RPC token redactor for error messages.
 *
 * Polygon's internal eRPC proxy and many public RPC providers carry
 * authentication tokens in URL query strings (`?token=...&...` or
 * `&token=...`). When an upstream RPC error bubbles up — viem's
 * `HttpRequestError`, ethers v5/v6 `FetchError`, plain `fetch` failures —
 * the URL is interpolated into the error message. If the SDK consumer
 * logs that error to Datadog/Sentry/stdout, the token leaks.
 *
 * `sanitiseError` deep-walks an error — message, stack, own enumerable
 * properties (including VError `info` objects, string arrays like viem's
 * `metaMessages`, and nested request objects), and the `cause` chain —
 * replacing the value of every `token=` query parameter with `***`. The
 * visible `***` is intentional (better than silent removal — operators
 * can see the redaction happened, and the URL remains parseable for
 * debugging).
 *
 * # Relationship to `@polygonlabs/verror` / `@polygonlabs/logger`
 *
 * verror ≥ 1.1.0 auto-sanitises RPC fetch errors inside `serializeError`
 * / `toJSON`, and `@polygonlabs/logger` ≥ 3.0.0 applies the same in its
 * `err` serializer — but that layer is FINGERPRINT-GATED: it fires only
 * when the cause chain contains a recognised ethers v5/v6 or viem fetch
 * error, and it deliberately never deep-scrubs generic `info` values.
 * `sanitiseError` is the logger-agnostic layer for everything else:
 * it redacts token query params on ANY error shape — including the
 * errors this SDK mints with URLs in `message`/`info` — and
 * needs no specific logging stack.
 *
 * # Contract
 *
 * - **Non-mutating.** Original error objects (and their nested `info`
 *   objects/arrays) are unchanged; sanitised copies are returned.
 * - **Cause-chain aware.** `error.cause` is recursively sanitised, whether
 *   it is an `Error` or a plain object (a wallet's JSON-RPC error body).
 *   Each original object maps to exactly one copy, so circular refs (some
 *   libraries set `err.cause = err`) come back pointing at the copy, never
 *   at the token-bearing original.
 * - **Pass-through for non-Errors.** If you pass a string, number, or
 *   plain object at the TOP level, you get it back unchanged.
 *   Sanitisation is only attempted on `Error` instances; the type
 *   system reflects this via the `unknown -> unknown` signature.
 */

/**
 * The parameter may be `?`, `&`, `#` or `;` separated, or percent-encoded
 * (`%3F` / `%26`, `%3D`), because providers echo URLs back in all those
 * forms. The value stops at whitespace and at the quote, bracket and
 * separator characters that follow a URL inside a message or a JSON body,
 * so the text after the URL (a revert reason, a `; root cause:` suffix)
 * is kept.
 */
const TOKEN_RE = /((?:[?&#;]|%3F|%26)token(?:=|%3D))[^&\s"'<>()[\]{},;#]+/gi;
const TOKEN_REPLACE = '$1***';

/**
 * String-level redactor: the value of every `token=` parameter → `***`.
 * Exported for the SDK's own error-minting sites (`httpGet`) so URLs
 * are redacted BEFORE they are embedded in a message or `info` — the
 * error then never holds the secret, rather than relying on every
 * consumer to run {@link sanitiseError} before logging.
 */
export const redactTokens = (s: string): string => s.replace(TOKEN_RE, TOKEN_REPLACE);

const sanitiseString = redactTokens;

/** Original object → its sanitised copy, so a shared or circular reference stays one copy. */
type Copies = Map<object, unknown>;

/**
 * Deep-sanitise an arbitrary value: strings are redacted, arrays
 * element-wise, plain objects recursively (fresh copies — the original
 * error's `info` object must not be aliased into the clone), nested
 * `Error` values through {@link cloneError}. Bigints and other primitives
 * pass through unchanged. Class instances other than Error/Array/plain
 * object (Dates, providers…) pass through by reference: rebuilding them
 * could break their invariants, and token URLs live in strings, arrays,
 * and plain bags.
 */
const sanitiseValue = (value: unknown, copies: Copies): unknown => {
  if (typeof value === 'string') return sanitiseString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (copies.has(value)) return copies.get(value);
  if (value instanceof Error) return cloneError(value, copies);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    copies.set(value, out);
    for (const entry of value) out.push(sanitiseValue(entry, copies));
    return out;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  copies.set(value, out);
  for (const [key, entry] of Object.entries(value)) {
    out[key] = sanitiseValue(entry, copies);
  }
  return out;
};

/**
 * Deep-redact any value (strings, arrays, plain objects, nested errors).
 * The SDK's error classes run their `info` and their `toJSON` output
 * through this so a token never reaches a log line.
 */
export const redactDeep = (value: unknown): unknown => sanitiseValue(value, new Map());

/** Sets an own property on a clone, keeping the source's enumerability. */
const defineOwn = ({
  target,
  key,
  value,
  enumerable
}: {
  target: object;
  key: string;
  value: unknown;
  enumerable: boolean;
}): void => {
  Object.defineProperty(target, key, { value, enumerable, writable: true, configurable: true });
};

/**
 * Reconstruct an `Error` (or subclass) with a sanitised message, stack and
 * `cause`. Keeps the prototype (so `instanceof`, a library's own methods
 * and the SDK classes' `toJSON` still work) and deep-sanitises every own
 * enumerable property — `name`, `code`, `info`, `error`, `type`,
 * `shortMessage`, viem's `metaMessages` and the rest.
 */
const cloneError = (err: Error, copies: Copies): Error => {
  // Object.create rather than the constructor: subclasses (TypeError,
  // the SDK's own classes, viem's) keep their prototype without invoking
  // a constructor that needs arguments we don't have.
  const out: Error = Object.create(Object.getPrototypeOf(err));
  copies.set(err, out);
  defineOwn({ target: out, key: 'message', value: sanitiseString(err.message), enumerable: false });
  if (err.stack !== undefined) {
    defineOwn({ target: out, key: 'stack', value: sanitiseString(err.stack), enumerable: false });
  }
  if (err.name && out.name !== err.name) {
    defineOwn({ target: out, key: 'name', value: err.name, enumerable: false });
  }

  for (const key of Object.keys(err)) {
    if (key === 'message' || key === 'stack' || key === 'cause') continue;
    const value: unknown = Reflect.get(err, key);
    defineOwn({ target: out, key, value: sanitiseValue(value, copies), enumerable: true });
  }

  if (err.cause !== undefined) {
    defineOwn({
      target: out,
      key: 'cause',
      value: sanitiseValue(err.cause, copies),
      enumerable: Object.getOwnPropertyDescriptor(err, 'cause')?.enumerable ?? false
    });
  }

  return out;
};

/**
 * Strip RPC `token=...` query params from an error and its cause chain.
 *
 * Returns the input unchanged when it isn't an `Error`. When it is an
 * `Error`, returns a fresh sanitised copy — never mutates the input.
 */
export const sanitiseError = (err: unknown): unknown =>
  err instanceof Error ? cloneError(err, new Map()) : err;
