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
 * `sanitiseError` walks an error and its `cause` chain and replaces
 * every `?token=<value>` / `&token=<value>` with `?token=***` /
 * `&token=***`. The visible `***` is intentional (better than silent
 * removal — operators can see the redaction happened, and the URL
 * remains parseable for debugging).
 *
 * # Contract
 *
 * - **Non-mutating.** Original error objects are unchanged. Returned
 *   errors are fresh `Error` instances with the same prototype chain.
 * - **Cause-chain aware.** `error.cause` is recursively sanitised; a
 *   `WeakSet` guards against circular refs (some libraries set
 *   `err.cause = err` to bridge older runtimes).
 * - **Pass-through for non-Errors.** If you pass a string, number, or
 *   plain object, you get it back unchanged. Sanitisation is only
 *   attempted on `Error` instances; the type system reflects this via
 *   the `unknown -> unknown` signature.
 * - **Stack preserved.** The original `.stack` is copied verbatim; it
 *   may still contain the URL but typically references file paths and
 *   line numbers, not request URLs. Callers who care about that should
 *   sanitise upstream.
 */

const TOKEN_RE = /([?&])token=[^&\s]+/g;
const TOKEN_REPLACE = '$1token=***';

const sanitiseString = (s: string): string => s.replace(TOKEN_RE, TOKEN_REPLACE);

/**
 * Reconstruct an `Error` (or subclass) with a sanitised message and a
 * sanitised `cause` chain. Preserves prototype, name, stack, and any
 * own enumerable properties whose string values also need cleaning.
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

  // Copy own enumerable properties; sanitise nested string values.
  for (const key of Object.keys(err)) {
    if (key === 'message' || key === 'stack' || key === 'cause') continue;
    const value = (err as unknown as Record<string, unknown>)[key];
    (out as unknown as Record<string, unknown>)[key] =
      typeof value === 'string' ? sanitiseString(value) : value;
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
