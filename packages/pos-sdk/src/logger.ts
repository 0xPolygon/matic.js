/**
 * Structural logger contract used everywhere inside `@polygonlabs/pos-sdk`.
 *
 * Why structural (not nominal)?
 *   The SDK is published to consumers who already own a logger — `pino`,
 *   `@polygonlabs/logger`, `winston`, a test stub, whatever. We must not force
 *   them to install another logging dep just to call us, and we must not
 *   force them to wrap their existing instance in an adapter. Defining
 *   `Logger` as a plain TypeScript interface means *any* object with these
 *   five methods can be passed in directly — a `pino.Logger` instance
 *   satisfies it without an `as Logger` cast.
 *
 * Why pino-shaped (`(obj, msg)` not `(msg, obj)`)?
 *   pino's call convention is `logger.info({ key: value }, 'msg')`, and
 *   most pino-derived loggers in the wild (`@polygonlabs/logger`, custom
 *   wrappers) match it. Adopting the same shape means a `pino.Logger`
 *   instance plugs in with zero glue. The legacy `console.log`-style
 *   `info('msg', { ... })` shape is deliberately *not* supported here —
 *   it encourages string concatenation over structured fields, which is
 *   the opposite of what production observability needs.
 *
 * Why no `child()` method?
 *   The SDK has a single, shallow logging context — there is no nesting deep
 *   enough to justify per-call-site child loggers. Consumers that want to
 *   attach request/job/correlation IDs to every SDK log line do it on their
 *   own logger before passing it in; we just call the methods we're given.
 *
 * Why zero runtime imports?
 *   Importing `pino` or `@polygonlabs/logger` here would defeat the point —
 *   every consumer would transitively pull in pino. The interface and the
 *   no-op default must compile to a tiny TS-only file with no runtime cost.
 */
export interface Logger {
  trace(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Default `Logger` used when a consumer does not pass one in. Every method
 * is a no-op so the SDK never writes to stdout/stderr by accident — the
 * consumer must explicitly opt into logging by injecting their own logger.
 */
export const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};
