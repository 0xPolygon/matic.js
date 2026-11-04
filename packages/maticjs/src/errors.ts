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
 * The names are new UPPER_SNAKE identifiers — they do NOT textually match
 * the 0.x `ERROR_TYPE` strings (which were lowercase snake, e.g.
 * `'burn_tx_not_checkpointed'`, on a `type` field of a plain thrown
 * object). For consumers migrating switches keyed on the old strings,
 * every error whose condition existed in 0.x ALSO carries the exact
 * legacy string on {@link POSBridgeError.type} — see
 * {@link LegacyErrorType}.
 */
export type POSBridgeErrorCode =
  | 'ALLOWED_ON_ROOT'
  | 'ALLOWED_ON_CHILD'
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
  | 'TRANSACTION_NOT_FOUND'
  | 'TRANSACTION_REVERTED'
  | 'TRANSACTION_REPLACED'
  | 'FEE_ESTIMATION_FAILED'
  | 'HTTP_REQUEST_FAILED'
  | 'BATCH_SIZE_LIMIT_EXCEEDED'
  | 'LOG_NOT_FOUND_IN_RECEIPT'
  | 'NEGATIVE_INDEX'
  | 'INDEX_OUT_OF_BOUNDS'
  | 'BRIDGE_EVENT_DECODE_FAILED'
  | 'NULL_SPENDER_ADDRESS'
  | 'ALLOWED_ON_NON_NATIVE_TOKENS'
  | 'ONLY_ALLOWED_ON_MAINNET';

/**
 * The 0.x `ERROR_TYPE` enum values, verbatim — including the two
 * historical typos (`transation_object_not_object`,
 * `allowed_on_non_native_token`), because the whole point of this type
 * is that strings consumers already switch on keep matching exactly.
 */
export type LegacyErrorType =
  | 'allowed_on_root'
  | 'allowed_on_child'
  | 'proof_api_not_set'
  | 'transation_object_not_object'
  | 'burn_tx_not_checkpointed'
  | 'eip-1559_not_supported'
  | 'null_spender_address'
  | 'allowed_on_non_native_token'
  | 'allowed_on_mainnet'
  | 'bridge_adapter_address_not_passed';

/**
 * New code → exact 0.x `ERROR_TYPE` string, for every condition that
 * existed in 0.x. Codes absent here are new failure modes with no 0.x
 * equivalent (the old SDK surfaced them as generic errors or not at
 * all). `CONTRACT_NOT_AVAILABLE_ON_NETWORK` maps to the old
 * `bridge_adapter_address_not_passed` because it is the successor of
 * that condition (bridge-adapter/GasSwapper address unavailable).
 */
const LEGACY_TYPE_BY_CODE: Partial<Record<POSBridgeErrorCode, LegacyErrorType>> = {
  ALLOWED_ON_ROOT: 'allowed_on_root',
  ALLOWED_ON_CHILD: 'allowed_on_child',
  PROOF_API_NOT_SET: 'proof_api_not_set',
  TX_OPTION_NOT_OBJECT: 'transation_object_not_object',
  BURN_TX_NOT_CHECKPOINTED: 'burn_tx_not_checkpointed',
  EIP1559_NOT_SUPPORTED: 'eip-1559_not_supported',
  NULL_SPENDER_ADDRESS: 'null_spender_address',
  ALLOWED_ON_NON_NATIVE_TOKENS: 'allowed_on_non_native_token',
  ONLY_ALLOWED_ON_MAINNET: 'allowed_on_mainnet',
  CONTRACT_NOT_AVAILABLE_ON_NETWORK: 'bridge_adapter_address_not_passed'
};

/**
 * Single error class raised by `@polygonlabs/maticjs`.
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
 * ## Relationship to the legacy `ErrorHelper`
 *
 * The 0.x SDK threw plain `{ message, type }` objects (not even `Error`
 * instances) assembled by an `ErrorHelper`, with `type` carrying a
 * lowercase-snake `ERROR_TYPE` string. This class replaces that
 * pattern with a typed `code` discriminator, structured `info`, and a
 * standard `cause` chain — and, for every condition that existed in
 * 0.x, ALSO carries the exact legacy string on the same `type` field
 * the old SDK used ({@link type}), so migrated consumer switches and
 * dashboards keyed on the old strings keep matching without rework.
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

  /**
   * The exact 0.x `ERROR_TYPE` string for this condition, when it
   * existed in `@maticnetwork/maticjs` (the old SDK threw plain
   * `{ message, type }` objects). Present so consumer switches written
   * against the old field and strings keep working unmodified through
   * the migration; absent on failure modes that are new in 1.0. New
   * code should switch on {@link code}.
   */
  public readonly type?: LegacyErrorType;

  constructor(
    code: POSBridgeErrorCode,
    message: string,
    info?: Record<string, unknown>,
    options?: { cause?: Error }
  ) {
    super(message, { cause: options?.cause, info });
    this.code = code;
    const legacy = LEGACY_TYPE_BY_CODE[code];
    if (legacy !== undefined) {
      this.type = legacy;
    }
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
    const base = super.toJSON();
    return {
      ...base,
      // `info` can hold bigints (TRANSACTION_REVERTED carries the receipt,
      // whose `blockNumber` is a bigint). `JSON.stringify` throws on a
      // bigint, which would turn logging the error into a second failure.
      // Emit them as decimal strings instead.
      ...('info' in base ? { info: bigintsToStrings(base.info) } : {}),
      code: this.code,
      ...(this.type === undefined ? {} : { type: this.type })
    };
  }
}

/**
 * Copy of `value` with every bigint replaced by its decimal string. Walks
 * arrays and plain objects only; anything else is returned as is.
 */
const bigintsToStrings = (value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(bigintsToStrings);
  if (value !== null && typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigintsToStrings(v)]));
    }
  }
  return value;
};
