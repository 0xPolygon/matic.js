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
 * replacing every `?token=<value>` / `&token=<value>` with
 * `?token=***` / `&token=***`. The visible `***` is intentional (better
 * than silent removal — operators can see the redaction happened, and
 * the URL remains parseable for debugging).
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
 * `POSBridgeError`s this SDK mints with URLs in `message`/`info` — and
 * needs no specific logging stack.
 *
 * # Contract
 *
 * - **Non-mutating.** Original error objects (and their nested `info`
 *   objects/arrays) are unchanged; sanitised copies are returned.
 * - **Cause-chain aware.** `error.cause` is recursively sanitised; a
 *   `WeakSet` guards against circular refs (some libraries set
 *   `err.cause = err` to bridge older runtimes).
 * - **Pass-through for non-Errors.** If you pass a string, number, or
 *   plain object at the TOP level, you get it back unchanged.
 *   Sanitisation is only attempted on `Error` instances; the type
 *   system reflects this via the `unknown -> unknown` signature.
 */

const TOKEN_RE = /([?&])token=[^&\s]+/g;
const TOKEN_REPLACE = '$1token=***';

/**
 * String-level redactor: `?token=<v>` / `&token=<v>` → `token=***`.
 * Exported for the SDK's own error-minting sites (`httpGet`) so URLs
 * are redacted BEFORE they are embedded in a message or `info` — the
 * error then never holds the secret, rather than relying on every
 * consumer to run {@link sanitiseError} before logging.
 */
export const redactTokens = (s: string): string => s.replace(TOKEN_RE, TOKEN_REPLACE);

const sanitiseString = redactTokens;

/**
 * Deep-sanitise an arbitrary own-property value: strings are redacted,
 * arrays element-wise, plain objects recursively (fresh copies — the
 * original error's `info` object must not be aliased into the clone),
 * nested `Error` values through {@link walk}. Class instances other
 * than Error/Array/plain-object (BigInt wrappers, Dates, providers…)
 * pass through by reference: rebuilding them could break their
 * invariants, and token URLs live in strings, arrays, and plain bags.
 */
const sanitiseValue = (value: unknown, seen: WeakSet<object>): unknown => {
  if (typeof value === 'string') return sanitiseString(value);
  if (value instanceof Error) return walk(value, seen);
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((entry) => sanitiseValue(entry, seen));
  }
  if (typeof value === 'object' && value !== null) {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      if (seen.has(value)) return value;
      seen.add(value);
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        out[key] = sanitiseValue(entry, seen);
      }
      return out;
    }
  }
  return value;
};

/**
 * Reconstruct an `Error` (or subclass) with a sanitised message and a
 * sanitised `cause` chain. Preserves prototype, name, stack, and deep-
 * sanitises every own enumerable property (see {@link sanitiseValue}).
 */
const cloneError = (err: Error, seen: WeakSet<object>): Error => {
  const proto = Object.getPrototypeOf(err) as object | null;
  // Construct via Object.create so subclasses (TypeError, custom VErrors)
  // keep their prototype without invoking constructors that may have
  // required arguments we don't have.
  const out = Object.create(proto) as Error;
  out.message = sanitiseString(err.message);
  if (err.name) out.name = err.name;
  if (err.stack) out.stack = sanitiseString(err.stack);

  // Deep-copy own enumerable properties with sanitisation. This covers
  // VError `info` objects (where the SDK itself records request URLs),
  // string arrays (viem `metaMessages`), and nested request objects
  // (ethers v6 `info.requestUrl`) — the shapes a shallow strings-only
  // pass silently leaked.
  for (const key of Object.keys(err)) {
    if (key === 'message' || key === 'stack' || key === 'cause') continue;
    const value = (err as unknown as Record<string, unknown>)[key];
    (out as unknown as Record<string, unknown>)[key] = sanitiseValue(value, seen);
  }

  // Walk the cause chain.
  if ('cause' in err && err.cause !== undefined) {
    out.cause = walk(err.cause, seen);
  }

  return out;
};

const walk = (value: unknown, seen: WeakSet<object>): unknown => {
  if (value instanceof Error) {
    if (seen.has(value)) return value;
    seen.add(value);
    return cloneError(value, seen);
  }
  return value;
};

/**
 * Strip RPC `token=...` query params from an error and its cause chain.
 *
 * Returns the input unchanged when it isn't an `Error`. When it is an
 * `Error`, returns a fresh sanitised copy — never mutates the input.
 */
export const sanitiseError = (err: unknown): unknown => walk(err, new WeakSet());
