import { VError } from '@polygonlabs/verror';

/**
 * Discriminator codes for {@link POSBridgeError}.
 *
 * The set is intentionally **closed** — every failure mode the SDK raises
 * has a code here, and consumer code is expected to switch on this union
 * rather than parsing error messages. Adding a new failure mode means
 * adding a new code to this union; the TypeScript exhaustiveness check
 * forces every `switch` to be revisited at the call site.
 *
 * Names mirror the legacy `ErrorHelper.throw(code, …)` keys from the 0.x
 * `@maticnetwork/maticjs` package, so any consumer dashboards, alerts, or
 * log queries keyed off the old strings continue to match without rework.
 */
export type POSBridgeErrorCode =
  | 'BURN_TX_NOT_CHECKPOINTED'
  | 'EIP1559_NOT_SUPPORTED'
  | 'PROOF_API_NOT_SET'
  | 'INVALID_TOKEN_TYPE'
  | 'CONTRACT_NOT_AVAILABLE_ON_NETWORK'
  | 'TX_OPTION_NOT_OBJECT'
  | 'UNSUPPORTED_NETWORK'
  | 'WEB3_CLIENT_NOT_INITIALIZED'
  | 'ROOT_HASH_RPC_FAILED'
  | 'INVALID_HEX_STRING'
  | 'NEGATIVE_BIG_NUMBER'
  | 'INVALID_NUMERIC_VALUE'
  | 'BUFFER_TYPE_REQUIRED'
  | 'UNSUPPORTED_KECCAK_BIT_WIDTH'
  | 'MERKLE_TREE_REQUIRES_LEAVES'
  | 'MERKLE_TREE_DEPTH_EXCEEDED'
  | 'STATE_SYNCED_EVENT_NOT_FOUND'
  | 'PROOF_NODE_KEY_MISMATCH'
  | 'TRANSACTION_HASH_REQUIRED'
  | 'BATCH_SIZE_LIMIT_EXCEEDED'
  | 'LOG_NOT_FOUND_IN_RECEIPT'
  | 'NEGATIVE_INDEX'
  | 'INDEX_OUT_OF_BOUNDS'
  | 'BRIDGE_EVENT_DECODE_FAILED'
  | 'NULL_SPENDER_ADDRESS'
  | 'ALLOWED_ON_NON_NATIVE_TOKENS'
  | 'ONLY_ALLOWED_ON_MAINNET';

/**
 * Single error class raised by `@polygonlabs/pos-sdk`.
 *
 * ## Why a class — and why VError
 *
 * Consumers narrow with `instanceof POSBridgeError` to distinguish SDK
 * failures from arbitrary thrown values without parsing message strings.
 * Extending [`VError`][verror] (rather than `Error` directly) gives
 * consumers a standard error-composition surface they can rely on:
 *
 * - `findCauseByName(err, 'X')` / `findCauseByType(err, X)` walk the
 *   cause chain to locate a specific failure deep inside a wrapped error.
 * - `VError.info(err)` / `info(err)` return the merged structured
 *   `info` payload across the full chain — useful for attaching debug
 *   data without polluting the human-readable message.
 * - `fullStack(err)` renders the complete cause-chain stack trace.
 *
 * VError is a TypeScript-first, browser-friendly port of Joyent's
 * canonical Node `verror` library — same composition primitives, same
 * `findCauseByName` / `info` / `fullStack` API. The package has zero
 * runtime dependencies and ships ESM, so the SDK is safe to bundle for
 * both Node and the browser.
 *
 * ## Why `name = 'POSBridgeError'`
 *
 * The pinned runtime name lets any error-aggregator that groups by
 * class name (Sentry, Datadog APM, custom log middleware) cluster every
 * SDK failure together regardless of which `code` was raised. The
 * `as const` override is VError's convention for named subclasses, and
 * the standard pattern Joyent's `verror` documents.
 *
 * ## Relationship to legacy `ErrorHelper.throw()`
 *
 * The 0.x SDK threw plain `Error` instances assembled by an
 * `ErrorHelper.throw(code, ...)` helper. Consumers had to regex the
 * message to extract the code, which made downstream aggregation
 * brittle and forced ad-hoc branching on substrings. This class
 * replaces that pattern: the same code keys are preserved (so existing
 * consumer queries keep matching) but they are now a typed
 * discriminator on a dedicated error class, with optional structured
 * `info` for debug data and the standard `cause` chain for the
 * underlying error.
 *
 * @example
 * Switch on `error.code` to branch on the specific failure mode. Each
 * member of {@link POSBridgeErrorCode} should be a `case` — TypeScript's
 * exhaustiveness check guarantees no failure mode is silently dropped.
 *
 * [verror]: https://www.npmjs.com/package/@polygonlabs/verror
 */
export class POSBridgeError extends VError {
  override readonly name = 'POSBridgeError' as const;

  /**
   * Stable discriminator. Switch on this — never on the human-readable
   * message — and let TypeScript exhaustiveness-check the cases.
   */
  public readonly code: POSBridgeErrorCode;

  constructor(
    code: POSBridgeErrorCode,
    message: string,
    info?: Record<string, unknown>,
    options?: { cause?: Error }
  ) {
    super(message, { cause: options?.cause, info });
    this.code = code;
  }

  /**
   * VError's `toJSON` returns the standard `{ name, message, info, … }`
   * shape; we extend it with `code` so the discriminator survives a
   * `JSON.stringify` round-trip. Without this override, consumers
   * persisting errors as JSON (logs, audit records, queue payloads)
   * would lose the discriminator and have to re-derive it from
   * `instanceof` checks before serialising.
   */
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), code: this.code };
  }
}
