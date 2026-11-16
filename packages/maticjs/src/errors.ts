import { VError } from '@polygonlabs/verror';

import type { Hex, Receipt } from './adapter.js';
import type { ReplacementReason } from './internal/confirmation.js';
import type { Network } from './networks.js';
import type { DepositStatus } from './pos/bridge-status.js';

import { redactDeep, redactTokens, sanitiseError } from './adapters/sanitise.js';

/**
 * # Error model
 *
 * Every failure the SDK raises is a named `VError` subclass. There are two
 * families:
 *
 * - **Condition errors** say *what* went wrong (`TransactionRevertedError`,
 *   `BurnTxNotCheckpointedError`, …). Each carries a typed `info` payload.
 * - **Operation errors** say *which public SDK call* failed (`ExitError`,
 *   `DepositError`, …). Public methods throw one of these, with the condition
 *   error as its `cause`.
 *
 * Only conditions the SDK detects itself are raised this way. An error
 * thrown by the wallet, the RPC node or the client library (ethers, viem) is
 * not the SDK's: public methods and `confirmed()` rethrow it unchanged, the
 * same object, so the consumer handles it as that library documents.
 *
 * Recognise errors by `name` through the cause chain, never by `instanceof`:
 * a bundler that ends up with two copies of this package, or an error that
 * went through `JSON.stringify`, breaks `instanceof` but keeps `name`. That
 * is what the per-class `find` / `has` finders, {@link isMaticjsError} and
 * {@link rootCause} do.
 */

// ─── Names ──────────────────────────────────────────────────────────────────

// The name lists are values (not just a union type) so `MATICJS_ERROR_NAMES`
// can answer "is this one of ours?" at runtime for errors from another copy
// of the package, where `instanceof` cannot.
const CONDITION_NAMES = [
  'AllowedOnRootError',
  'AllowedOnChildError',
  'BurnTxNotCheckpointedError',
  'Eip1559NotSupportedError',
  'ProofApiNotSetError',
  'InvalidTokenTypeError',
  'ContractNotAvailableOnNetworkError',
  'TxOptionNotObjectError',
  'UnsupportedNetworkError',
  'Web3ClientNotInitializedError',
  'InvalidHexStringError',
  'NegativeBigNumberError',
  'InvalidNumericValueError',
  'BufferTypeRequiredError',
  'UnsupportedKeccakBitWidthError',
  'MerkleTreeRequiresLeavesError',
  'MerkleTreeDepthExceededError',
  'StateSyncedEventNotFoundError',
  'ProofNodeKeyMismatchError',
  'ReceiptsRootMismatchError',
  'TransactionHashRequiredError',
  'TransactionNotFoundError',
  'TransactionRevertedError',
  'TransactionReplacedError',
  'FeeEstimationFailedError',
  'HttpRequestFailedError',
  'BatchSizeLimitExceededError',
  'LogNotFoundInReceiptError',
  'NegativeIndexError',
  'IndexOutOfBoundsError',
  'BridgeEventDecodeFailedError',
  'NullSpenderAddressError',
  'OnlyAllowedOnMainnetError',
  'PermitNotSupportedError',
  'UntrustedPredicateError',
  'CheckpointRangeInvalidError',
  'DepositNotReplayableError'
] as const;

const OPERATION_NAMES = [
  'InitError',
  'AddressLookupError',
  'TokenReadError',
  'CheckpointReadError',
  'BridgeStatusError',
  'ProofBuildError',
  'ApproveError',
  'DepositError',
  'WithdrawStartError',
  'ExitError',
  'TransferError',
  'ConfirmationError',
  'StakingReadError',
  'StakingWriteError',
  'PermitError'
] as const;

/** Name of every condition error class. */
export type MaticjsConditionName = (typeof CONDITION_NAMES)[number];
/** Name of every operation error class. */
export type MaticjsOperationName = (typeof OPERATION_NAMES)[number];
/** Name of every error class this package raises. */
export type MaticjsErrorName = MaticjsConditionName | MaticjsOperationName;

/** Every value {@link MaticjsErrorName} can take, for runtime checks. */
export const MATICJS_ERROR_NAMES: ReadonlySet<MaticjsErrorName> = new Set<MaticjsErrorName>([
  ...CONDITION_NAMES,
  ...OPERATION_NAMES
]);

// String-keyed twins of the sets above: `ReadonlySet<MaticjsErrorName>.has`
// only accepts the union, and the value being tested is any string.
const ALL_NAME_SET: ReadonlySet<string> = new Set<string>(MATICJS_ERROR_NAMES);
const OPERATION_NAME_SET: ReadonlySet<string> = new Set<string>(OPERATION_NAMES);

/**
 * The 3.x `ERROR_TYPE` strings, verbatim, because consumers that switch on
 * `err.type` must keep matching byte for byte. Only conditions the 4.0 SDK
 * can still raise are listed: the 3.x `allowed_on_non_native_token` condition
 * no longer exists. `transation_object_not_object` keeps its 3.x typo.
 */
export type LegacyErrorType =
  | 'allowed_on_root'
  | 'allowed_on_child'
  | 'proof_api_not_set'
  | 'transation_object_not_object'
  | 'burn_tx_not_checkpointed'
  | 'eip-1559_not_supported'
  | 'null_spender_address'
  | 'allowed_on_mainnet'
  | 'bridge_adapter_address_not_passed';

// ─── Shared helpers ─────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Yields `err` and then each `.cause` below it. Follows any object-valued
 * `cause`, not only `Error` ones, so a chain that went through
 * `JSON.parse(JSON.stringify(err))` (where every link is a plain object) is
 * walked the same way as a live one.
 */
function* causeChain(err: unknown): Generator<Record<string, unknown>> {
  const seen = new Set<unknown>();
  let node = err;
  while (isRecord(node) && !seen.has(node)) {
    seen.add(node);
    yield node;
    node = node['cause'];
  }
}

/**
 * Copy of `value` that `JSON.stringify` cannot throw on: a bigint (a
 * receipt in `info` carries them) becomes its decimal string, an `Error`
 * becomes a plain object of its name, message and own fields (a bare
 * `Error` serialises as `{}` and would hide them), and a reference back to
 * an enclosing object becomes `'[Circular]'`. Walks arrays, plain objects
 * and errors; other class instances are left to their own `toJSON`.
 */
const toJsonSafe = (value: unknown, ancestors: Set<object> = new Set()): unknown => {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object' || value === null) return value;
  if (ancestors.has(value)) return '[Circular]';
  const proto: unknown = Object.getPrototypeOf(value);
  const isPlain = proto === Object.prototype || proto === null;
  if (!isPlain && !Array.isArray(value) && !(value instanceof Error)) return value;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => toJsonSafe(entry, ancestors));
    const fields = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonSafe(entry, ancestors)])
    );
    return value instanceof Error
      ? { name: value.name, message: value.message, ...fields }
      : fields;
  } finally {
    ancestors.delete(value);
  }
};

// ─── Shared plumbing ────────────────────────────────────────────────────────
//
// Every class extends VError directly and calls these helpers, rather than
// sharing a base class: a base would be one more type consumers could test
// with `instanceof`, which is exactly the check that breaks across package
// copies. Recognition goes through names only.

/** Base of every `info` payload; each class narrows it. */
export type ErrorInfo = Record<string, unknown>;

/** Options a condition-error constructor takes. */
export interface ErrorOptions<I extends ErrorInfo> {
  info?: I;
  cause?: Error;
}

/** Options for a condition error whose `info` is always present. */
export interface RequiredInfoErrorOptions<I extends ErrorInfo> {
  info: I;
  cause?: Error;
}

/** Replaces an own property VError set, keeping its enumerability. */
const replaceOwn = ({ target, key, value }: { target: object; key: string; value: unknown }) => {
  const enumerable = Object.getOwnPropertyDescriptor(target, key)?.enumerable ?? false;
  Object.defineProperty(target, key, { value, enumerable, writable: true, configurable: true });
};

/**
 * Runs at the end of every constructor. Library messages, and the objects
 * libraries hang off their errors, often embed the RPC URL with its
 * `?token=` secret, and whatever the error holds is printed by
 * `console.error` (`util.inspect`), `VError.fullStack` and loggers. So the
 * error is made secret-free before anyone can see it: the cause is
 * replaced by a redacted copy (identity with the thrown object is given up
 * for this), the message, `shortMessage` and every string in `info` are
 * redacted, and the stack is recaptured so its header carries the redacted
 * message. `info` keeps its shape and bigints; only strings change.
 */
const sealMessage = ({
  error,
  constructorOpt,
  appendRootCause = false
}: {
  error: VError;
  constructorOpt: NewableFunction;
  appendRootCause?: boolean;
}): void => {
  if (error.cause !== undefined) {
    replaceOwn({ target: error, key: 'cause', value: sanitiseError(error.cause) });
  }
  error.message = redactTokens(error.message);
  if (appendRootCause) {
    error.message = withRootMessage({ message: error.message, cause: error.cause });
  }
  replaceOwn({ target: error, key: 'shortMessage', value: redactTokens(error.shortMessage) });
  const info = redactDeep(error.info);
  if (isRecord(info)) replaceOwn({ target: error, key: 'info', value: info });
  // V8-only API, absent in Safari and Firefox. Those engines' `stack` holds
  // frames only, never the message, so skipping the recapture there leaks
  // nothing.
  if ('captureStackTrace' in Error && typeof Error.captureStackTrace === 'function') {
    Error.captureStackTrace(error, constructorOpt);
  }
};

/**
 * Every class's `toJSON`. VError's own `toJSON` already emits `name`; this
 * adds the legacy `type` of this error and of each error below it, makes
 * the output safe to stringify (see `toJsonSafe`), and redacts `?token=`
 * in every nested string, including causes VError's URL sanitiser does not
 * recognise.
 *
 * The `type`s are copied from the live chain because, when the chain holds
 * an RPC fetch error, VError serialises plain-`Error` copies of every link
 * and those copies carry no `type`. Both chains follow `cause` one `Error`
 * at a time, so they line up link for link.
 */
const safeJSON = ({
  error,
  json
}: {
  error: Error;
  json: Record<string, unknown>;
}): Record<string, unknown> => {
  const out = toJsonSafe(json);
  if (!isRecord(out)) return json;
  const seen = new Set<unknown>();
  let live: unknown = error;
  let link: unknown = out;
  while (isRecord(live) && isRecord(link) && !seen.has(live)) {
    seen.add(live);
    const type = live['type'];
    if (typeof type === 'string' && link['type'] === undefined) link['type'] = type;
    live = live['cause'];
    link = link['cause'];
  }
  const safe = redactDeep(out);
  return isRecord(safe) ? safe : out;
};

// ─── Finders ────────────────────────────────────────────────────────────────

/** The instance shape every class in this module has. */
type MaticjsErrorInstance = Error & { readonly name: MaticjsErrorName; readonly info: ErrorInfo };

/**
 * What a finder returns: the fields of the error that survive a second
 * package copy or a JSON round-trip, so it is safe to read from either.
 *
 * The type describes the live error. After a JSON round-trip every bigint
 * in `info` (a receipt's `blockNumber`, for example) is a decimal string,
 * because JSON has no bigint; convert with `BigInt(value)` when reading a
 * parsed error.
 *
 * Recognition is by name plus an object-valued `info`; for an operation
 * error, `info.operation` and `info.mode` must also be strings. A consumer's
 * own condition-named class (`TransactionNotFoundError`) that carries an
 * `info` object is indistinguishable from the SDK's, and every `VError`
 * subclass carries one (`info` defaults to `{}`), so name your own classes
 * apart.
 */
export type FoundError<E extends MaticjsErrorInstance> = {
  readonly name: E['name'];
  readonly message: string;
  readonly info: E['info'];
  readonly type?: E extends { readonly type: infer T } ? T : undefined;
  readonly cause?: unknown;
};

/**
 * An operation error's `info` names the public call and its mode. Checked
 * because `@polygonlabs/verror` gives every instance `info = {}`, so an
 * object-valued `info` alone does not tell a consumer's own `DepositError`
 * apart from the SDK's.
 */
const hasOperationInfo = (info: unknown): boolean =>
  isRecord(info) && typeof info['operation'] === 'string' && typeof info['mode'] === 'string';

/**
 * The one shape test behind `find`, `has`, {@link isMaticjsError} and
 * `withOperation`'s collapse: one of this package's names, a string
 * message, an object-valued `info` and, for an operation name, the
 * operation fields in it. Every SDK error has these, live or read back
 * from JSON; requiring `info` is what keeps out library errors that share a
 * generic name, such as viem's own `TransactionNotFoundError`.
 */
const hasMaticjsShape = (value: Record<string, unknown>): boolean => {
  const name = value['name'];
  if (typeof name !== 'string' || !ALL_NAME_SET.has(name)) return false;
  if (typeof value['message'] !== 'string' || !isRecord(value['info'])) return false;
  return !OPERATION_NAME_SET.has(name) || hasOperationInfo(value['info']);
};

const isFound = <E extends MaticjsErrorInstance>(
  value: Record<string, unknown>,
  name: E['name']
): value is FoundError<E> => value['name'] === name && hasMaticjsShape(value);

/** `find` for one class: the first link in the cause chain with its name. */
const finderFor =
  <E extends MaticjsErrorInstance>(name: E['name']) =>
  (err: unknown): FoundError<E> | null => {
    for (const link of causeChain(err)) {
      if (isFound<E>(link, name)) return link;
    }
    return null;
  };

/** `has` for one class: exactly `find(err) !== null`. */
const hasFor = (name: MaticjsErrorName) => {
  const find = finderFor(name);
  return (err: unknown): boolean => find(err) !== null;
};

// ─── Condition errors ───────────────────────────────────────────────────────

/** `typeof` results, recorded when a value had the wrong runtime type. */
export type TypeOfResult =
  | 'string'
  | 'number'
  | 'bigint'
  | 'boolean'
  | 'symbol'
  | 'undefined'
  | 'object'
  | 'function';

/** No `info` is attached. */
export type EmptyInfo = Record<string, never>;

export type ChainSideInfo = { action: string; isParent: boolean; tokenAddress: Hex };
export type BurnTxNotCheckpointedInfo = {
  burnTxHash?: string;
  lastChildBlock?: string;
  txBlockNumber?: number;
  childBlockNumber?: string;
};
export type TxOptionNotObjectInfo = {
  method: string;
  /** `typeof` the value, or `'null'` / `'array'`. */
  received: string;
};
export type Eip1559NotSupportedInfo = { chainId: number; isParent: boolean };
export type InvalidTokenTypeInfo = { tokenAddress: string };
export type ContractNotAvailableOnNetworkInfo = {
  action?: string;
  tokenAddress?: Hex;
  contract?: string;
  network?: Network;
  missing?: readonly string[];
};
export type UnsupportedNetworkInfo = { expected: number; actual: number };
export type Web3ClientNotInitializedInfo = { method?: string };
export type InvalidHexStringInfo = {
  length?: number;
  arg?: string;
  received?: TypeOfResult;
  value?: string;
  method?: string;
  response?: string;
};
export type NegativeBigNumberInfo = { value: string };
export type InvalidNumericValueInfo = {
  received?: TypeOfResult;
  value?: number;
  method?: string;
  response?: string;
  index?: number;
  proofConcurrency?: number;
};
export type BufferTypeRequiredInfo = { received: TypeOfResult };
export type UnsupportedKeccakBitWidthInfo = { bits: number };
export type MerkleTreeDepthExceededInfo = { depth: number };
export type TransactionHashInfo = { transactionHash: string };
export type ProofNodeKeyMismatchInfo = { transactionIndex: number };
export type ReceiptsRootMismatchInfo = {
  blockNumber: number;
  blockHash: string;
  expectedReceiptsRoot: string;
  computedReceiptsRoot: string;
};
export type TransactionHashRequiredInfo = {
  eventSignature: string;
  index?: number;
  indices?: readonly number[];
};
export type TransactionRevertedInfo = { transactionHash: Hex; receipt: Receipt };
export type TransactionReplacedInfo = {
  transactionHash: Hex;
  replacementHash: Hex;
  reason: ReplacementReason;
  receipt: Receipt;
};
export type FeeEstimationFailedInfo = {
  method: string;
  chainId: number;
  response?: string;
};
export type HttpRequestFailedInfo = {
  url?: string;
  status?: number;
  statusText?: string;
  bodySnippet?: string;
  contentType?: string;
  field?: string;
  value?: string;
  start?: string;
  end?: string;
  expectedWords?: number;
  proof?: string;
  payload?: string;
  raw?: unknown;
};
export type BatchSizeLimitExceededInfo = { count: number; min?: number; max: number };
export type LogNotFoundInReceiptInfo = { eventSignature: string; transactionHash: string };
export type NegativeIndexInfo = { index: number };
export type IndexOutOfBoundsInfo = { index: number; available: number };
export type BridgeEventDecodeFailedInfo = {
  field?: string;
  key?: string;
  type?: string;
  types?: string;
  blockNumberOrHash?: string;
  count?: number;
  length?: number;
  minLength?: number;
  valueCount?: number;
  typeCount?: number;
  received?: TypeOfResult;
  valueType?: TypeOfResult;
  resultType?: TypeOfResult;
  argType?: TypeOfResult;
  a?: TypeOfResult;
  b?: TypeOfResult;
};
export type NullSpenderAddressInfo = { tokenAddress: Hex };
export type OnlyAllowedOnMainnetInfo = { chainId: number };
export type PermitNotSupportedInfo = { token: string; method: string };
export type UntrustedPredicateInfo = { tokenAddress: string; predicate: string };
export type CheckpointRangeInvalidInfo = {
  start: string;
  end: string;
  txBlockNumber: number;
  reason: 'inverted' | 'not-containing' | 'too-large';
};
/** The status the SDK read before refusing to replay; branch on it as on `getDepositStatus`. */
export type DepositNotReplayableInfo = { transactionHash: string; status: DepositStatus };

/** A root-chain-only method was called on a child-chain token. */
export class AllowedOnRootError extends VError {
  override readonly name = 'AllowedOnRootError' as const;
  readonly type = 'allowed_on_root' as const;
  declare readonly info: ChainSideInfo;
  static readonly find = finderFor<AllowedOnRootError>('AllowedOnRootError');
  static readonly has = hasFor('AllowedOnRootError');
  constructor(message: string, options: RequiredInfoErrorOptions<ChainSideInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A child-chain-only method was called on a root-chain token. */
export class AllowedOnChildError extends VError {
  override readonly name = 'AllowedOnChildError' as const;
  readonly type = 'allowed_on_child' as const;
  declare readonly info: ChainSideInfo;
  static readonly find = finderFor<AllowedOnChildError>('AllowedOnChildError');
  static readonly has = hasFor('AllowedOnChildError');
  constructor(message: string, options: RequiredInfoErrorOptions<ChainSideInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** The burn transaction is not yet covered by a checkpoint on the root chain. */
export class BurnTxNotCheckpointedError extends VError {
  override readonly name = 'BurnTxNotCheckpointedError' as const;
  readonly type = 'burn_tx_not_checkpointed' as const;
  declare readonly info: BurnTxNotCheckpointedInfo;
  static readonly find = finderFor<BurnTxNotCheckpointedError>('BurnTxNotCheckpointedError');
  static readonly has = hasFor('BurnTxNotCheckpointedError');
  constructor(message: string, options?: ErrorOptions<BurnTxNotCheckpointedInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** EIP-1559 fee fields were requested on a chain without EIP-1559. */
export class Eip1559NotSupportedError extends VError {
  override readonly name = 'Eip1559NotSupportedError' as const;
  readonly type = 'eip-1559_not_supported' as const;
  declare readonly info: Eip1559NotSupportedInfo;
  static readonly find = finderFor<Eip1559NotSupportedError>('Eip1559NotSupportedError');
  static readonly has = hasFor('Eip1559NotSupportedError');
  constructor(message: string, options: RequiredInfoErrorOptions<Eip1559NotSupportedInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A fast exit was requested but no proof API URL is configured. */
export class ProofApiNotSetError extends VError {
  override readonly name = 'ProofApiNotSetError' as const;
  readonly type = 'proof_api_not_set' as const;
  declare readonly info: EmptyInfo;
  static readonly find = finderFor<ProofApiNotSetError>('ProofApiNotSetError');
  static readonly has = hasFor('ProofApiNotSetError');
  constructor(message: string, options?: ErrorOptions<EmptyInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** The token address does not belong to the predicate type expected. */
export class InvalidTokenTypeError extends VError {
  override readonly name = 'InvalidTokenTypeError' as const;
  declare readonly info: InvalidTokenTypeInfo;
  static readonly find = finderFor<InvalidTokenTypeError>('InvalidTokenTypeError');
  static readonly has = hasFor('InvalidTokenTypeError');
  constructor(message: string, options: RequiredInfoErrorOptions<InvalidTokenTypeInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A contract the call needs has no address on this network. */
export class ContractNotAvailableOnNetworkError extends VError {
  override readonly name = 'ContractNotAvailableOnNetworkError' as const;
  readonly type = 'bridge_adapter_address_not_passed' as const;
  declare readonly info: ContractNotAvailableOnNetworkInfo;
  static readonly find = finderFor<ContractNotAvailableOnNetworkError>(
    'ContractNotAvailableOnNetworkError'
  );
  static readonly has = hasFor('ContractNotAvailableOnNetworkError');
  constructor(message: string, options?: ErrorOptions<ContractNotAvailableOnNetworkInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** Transaction options were passed as something other than a plain object. */
export class TxOptionNotObjectError extends VError {
  override readonly name = 'TxOptionNotObjectError' as const;
  readonly type = 'transation_object_not_object' as const;
  declare readonly info: TxOptionNotObjectInfo;
  static readonly find = finderFor<TxOptionNotObjectError>('TxOptionNotObjectError');
  static readonly has = hasFor('TxOptionNotObjectError');
  constructor(message: string, options: RequiredInfoErrorOptions<TxOptionNotObjectInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** The signer or provider is connected to a different chain than configured. */
export class UnsupportedNetworkError extends VError {
  override readonly name = 'UnsupportedNetworkError' as const;
  declare readonly info: UnsupportedNetworkInfo;
  static readonly find = finderFor<UnsupportedNetworkError>('UnsupportedNetworkError');
  static readonly has = hasFor('UnsupportedNetworkError');
  constructor(message: string, options: RequiredInfoErrorOptions<UnsupportedNetworkInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A write was attempted through an adapter that has no signer. */
export class Web3ClientNotInitializedError extends VError {
  override readonly name = 'Web3ClientNotInitializedError' as const;
  declare readonly info: Web3ClientNotInitializedInfo;
  static readonly find = finderFor<Web3ClientNotInitializedError>('Web3ClientNotInitializedError');
  static readonly has = hasFor('Web3ClientNotInitializedError');
  constructor(message: string, options?: ErrorOptions<Web3ClientNotInitializedInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A value that must be hex was not, or had the wrong length. */
export class InvalidHexStringError extends VError {
  override readonly name = 'InvalidHexStringError' as const;
  declare readonly info: InvalidHexStringInfo;
  static readonly find = finderFor<InvalidHexStringError>('InvalidHexStringError');
  static readonly has = hasFor('InvalidHexStringError');
  constructor(message: string, options?: ErrorOptions<InvalidHexStringInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A value that must be non-negative was negative. */
export class NegativeBigNumberError extends VError {
  override readonly name = 'NegativeBigNumberError' as const;
  declare readonly info: NegativeBigNumberInfo;
  static readonly find = finderFor<NegativeBigNumberError>('NegativeBigNumberError');
  static readonly has = hasFor('NegativeBigNumberError');
  constructor(message: string, options: RequiredInfoErrorOptions<NegativeBigNumberInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A numeric argument or response was not a valid number. */
export class InvalidNumericValueError extends VError {
  override readonly name = 'InvalidNumericValueError' as const;
  declare readonly info: InvalidNumericValueInfo;
  static readonly find = finderFor<InvalidNumericValueError>('InvalidNumericValueError');
  static readonly has = hasFor('InvalidNumericValueError');
  constructor(message: string, options?: ErrorOptions<InvalidNumericValueInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A byte buffer was required. */
export class BufferTypeRequiredError extends VError {
  override readonly name = 'BufferTypeRequiredError' as const;
  declare readonly info: BufferTypeRequiredInfo;
  static readonly find = finderFor<BufferTypeRequiredError>('BufferTypeRequiredError');
  static readonly has = hasFor('BufferTypeRequiredError');
  constructor(message: string, options: RequiredInfoErrorOptions<BufferTypeRequiredInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** Keccak was asked for a bit width it does not implement. */
export class UnsupportedKeccakBitWidthError extends VError {
  override readonly name = 'UnsupportedKeccakBitWidthError' as const;
  declare readonly info: UnsupportedKeccakBitWidthInfo;
  static readonly find = finderFor<UnsupportedKeccakBitWidthError>(
    'UnsupportedKeccakBitWidthError'
  );
  static readonly has = hasFor('UnsupportedKeccakBitWidthError');
  constructor(message: string, options: RequiredInfoErrorOptions<UnsupportedKeccakBitWidthInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A Merkle tree was built from zero leaves. */
export class MerkleTreeRequiresLeavesError extends VError {
  override readonly name = 'MerkleTreeRequiresLeavesError' as const;
  declare readonly info: EmptyInfo;
  static readonly find = finderFor<MerkleTreeRequiresLeavesError>('MerkleTreeRequiresLeavesError');
  static readonly has = hasFor('MerkleTreeRequiresLeavesError');
  constructor(message: string, options?: ErrorOptions<EmptyInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A Merkle tree would exceed the supported depth. */
export class MerkleTreeDepthExceededError extends VError {
  override readonly name = 'MerkleTreeDepthExceededError' as const;
  declare readonly info: MerkleTreeDepthExceededInfo;
  static readonly find = finderFor<MerkleTreeDepthExceededError>('MerkleTreeDepthExceededError');
  static readonly has = hasFor('MerkleTreeDepthExceededError');
  constructor(message: string, options: RequiredInfoErrorOptions<MerkleTreeDepthExceededInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** The deposit transaction has no `StateSynced` event to check against. */
export class StateSyncedEventNotFoundError extends VError {
  override readonly name = 'StateSyncedEventNotFoundError' as const;
  declare readonly info: TransactionHashInfo;
  static readonly find = finderFor<StateSyncedEventNotFoundError>('StateSyncedEventNotFoundError');
  static readonly has = hasFor('StateSyncedEventNotFoundError');
  constructor(message: string, options: RequiredInfoErrorOptions<TransactionHashInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** The receipt proof's key does not match the transaction index. */
export class ProofNodeKeyMismatchError extends VError {
  override readonly name = 'ProofNodeKeyMismatchError' as const;
  declare readonly info: ProofNodeKeyMismatchInfo;
  static readonly find = finderFor<ProofNodeKeyMismatchError>('ProofNodeKeyMismatchError');
  static readonly has = hasFor('ProofNodeKeyMismatchError');
  constructor(message: string, options: RequiredInfoErrorOptions<ProofNodeKeyMismatchInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** The receipts root rebuilt from the block's receipts does not match the header. */
export class ReceiptsRootMismatchError extends VError {
  override readonly name = 'ReceiptsRootMismatchError' as const;
  declare readonly info: ReceiptsRootMismatchInfo;
  static readonly find = finderFor<ReceiptsRootMismatchError>('ReceiptsRootMismatchError');
  static readonly has = hasFor('ReceiptsRootMismatchError');
  constructor(message: string, options: RequiredInfoErrorOptions<ReceiptsRootMismatchInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A transaction hash argument was missing. */
export class TransactionHashRequiredError extends VError {
  override readonly name = 'TransactionHashRequiredError' as const;
  declare readonly info: TransactionHashRequiredInfo;
  static readonly find = finderFor<TransactionHashRequiredError>('TransactionHashRequiredError');
  static readonly has = hasFor('TransactionHashRequiredError');
  constructor(message: string, options: RequiredInfoErrorOptions<TransactionHashRequiredInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** The chain does not know the transaction. */
export class TransactionNotFoundError extends VError {
  override readonly name = 'TransactionNotFoundError' as const;
  declare readonly info: TransactionHashInfo;
  static readonly find = finderFor<TransactionNotFoundError>('TransactionNotFoundError');
  static readonly has = hasFor('TransactionNotFoundError');
  constructor(message: string, options: RequiredInfoErrorOptions<TransactionHashInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** The transaction was mined and reverted. The receipt is in `info.receipt`. */
export class TransactionRevertedError extends VError {
  override readonly name = 'TransactionRevertedError' as const;
  declare readonly info: TransactionRevertedInfo;
  static readonly find = finderFor<TransactionRevertedError>('TransactionRevertedError');
  static readonly has = hasFor('TransactionRevertedError');
  constructor(message: string, options: RequiredInfoErrorOptions<TransactionRevertedInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A different transaction was mined at this transaction's nonce. */
export class TransactionReplacedError extends VError {
  override readonly name = 'TransactionReplacedError' as const;
  declare readonly info: TransactionReplacedInfo;
  static readonly find = finderFor<TransactionReplacedError>('TransactionReplacedError');
  static readonly has = hasFor('TransactionReplacedError');
  constructor(message: string, options: RequiredInfoErrorOptions<TransactionReplacedInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** The fee data needed to price a transaction could not be read. */
export class FeeEstimationFailedError extends VError {
  override readonly name = 'FeeEstimationFailedError' as const;
  declare readonly info: FeeEstimationFailedInfo;
  static readonly find = finderFor<FeeEstimationFailedError>('FeeEstimationFailedError');
  static readonly has = hasFor('FeeEstimationFailedError');
  constructor(message: string, options: RequiredInfoErrorOptions<FeeEstimationFailedInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** An HTTP call (proof API, address index) failed or returned an unusable body. */
export class HttpRequestFailedError extends VError {
  override readonly name = 'HttpRequestFailedError' as const;
  declare readonly info: HttpRequestFailedInfo;
  static readonly find = finderFor<HttpRequestFailedError>('HttpRequestFailedError');
  static readonly has = hasFor('HttpRequestFailedError');
  constructor(message: string, options?: ErrorOptions<HttpRequestFailedInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A batch call was given too few or too many items. */
export class BatchSizeLimitExceededError extends VError {
  override readonly name = 'BatchSizeLimitExceededError' as const;
  declare readonly info: BatchSizeLimitExceededInfo;
  static readonly find = finderFor<BatchSizeLimitExceededError>('BatchSizeLimitExceededError');
  static readonly has = hasFor('BatchSizeLimitExceededError');
  constructor(message: string, options: RequiredInfoErrorOptions<BatchSizeLimitExceededInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** The receipt has no log with the expected event signature. */
export class LogNotFoundInReceiptError extends VError {
  override readonly name = 'LogNotFoundInReceiptError' as const;
  declare readonly info: LogNotFoundInReceiptInfo;
  static readonly find = finderFor<LogNotFoundInReceiptError>('LogNotFoundInReceiptError');
  static readonly has = hasFor('LogNotFoundInReceiptError');
  constructor(message: string, options: RequiredInfoErrorOptions<LogNotFoundInReceiptInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** An index argument was negative. */
export class NegativeIndexError extends VError {
  override readonly name = 'NegativeIndexError' as const;
  declare readonly info: NegativeIndexInfo;
  static readonly find = finderFor<NegativeIndexError>('NegativeIndexError');
  static readonly has = hasFor('NegativeIndexError');
  constructor(message: string, options: RequiredInfoErrorOptions<NegativeIndexInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** An index argument was past the end of the matching logs. */
export class IndexOutOfBoundsError extends VError {
  override readonly name = 'IndexOutOfBoundsError' as const;
  declare readonly info: IndexOutOfBoundsInfo;
  static readonly find = finderFor<IndexOutOfBoundsError>('IndexOutOfBoundsError');
  static readonly has = hasFor('IndexOutOfBoundsError');
  constructor(message: string, options: RequiredInfoErrorOptions<IndexOutOfBoundsInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** On-chain or HTTP data did not decode into the expected shape. */
export class BridgeEventDecodeFailedError extends VError {
  override readonly name = 'BridgeEventDecodeFailedError' as const;
  declare readonly info: BridgeEventDecodeFailedInfo;
  static readonly find = finderFor<BridgeEventDecodeFailedError>('BridgeEventDecodeFailedError');
  static readonly has = hasFor('BridgeEventDecodeFailedError');
  constructor(message: string, options?: ErrorOptions<BridgeEventDecodeFailedInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** The token has no spender address for the requested approval. */
export class NullSpenderAddressError extends VError {
  override readonly name = 'NullSpenderAddressError' as const;
  readonly type = 'null_spender_address' as const;
  declare readonly info: NullSpenderAddressInfo;
  static readonly find = finderFor<NullSpenderAddressError>('NullSpenderAddressError');
  static readonly has = hasFor('NullSpenderAddressError');
  constructor(message: string, options: RequiredInfoErrorOptions<NullSpenderAddressInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** The method exists only on mainnet. */
export class OnlyAllowedOnMainnetError extends VError {
  override readonly name = 'OnlyAllowedOnMainnetError' as const;
  readonly type = 'allowed_on_mainnet' as const;
  declare readonly info: OnlyAllowedOnMainnetInfo;
  static readonly find = finderFor<OnlyAllowedOnMainnetError>('OnlyAllowedOnMainnetError');
  static readonly has = hasFor('OnlyAllowedOnMainnetError');
  constructor(message: string, options: RequiredInfoErrorOptions<OnlyAllowedOnMainnetInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** The staking token has no EIP-2612 `permit`. */
export class PermitNotSupportedError extends VError {
  override readonly name = 'PermitNotSupportedError' as const;
  declare readonly info: PermitNotSupportedInfo;
  static readonly find = finderFor<PermitNotSupportedError>('PermitNotSupportedError');
  static readonly has = hasFor('PermitNotSupportedError');
  constructor(message: string, options: RequiredInfoErrorOptions<PermitNotSupportedInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** The RootChainManager named a predicate that is not in the address index, so no approval was sent to it. */
export class UntrustedPredicateError extends VError {
  override readonly name = 'UntrustedPredicateError' as const;
  declare readonly info: UntrustedPredicateInfo;
  static readonly find = finderFor<UntrustedPredicateError>('UntrustedPredicateError');
  static readonly has = hasFor('UntrustedPredicateError');
  constructor(message: string, options: RequiredInfoErrorOptions<UntrustedPredicateInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A checkpoint range does not contain the burn's block, is inverted, or is larger than any real checkpoint. */
export class CheckpointRangeInvalidError extends VError {
  override readonly name = 'CheckpointRangeInvalidError' as const;
  declare readonly info: CheckpointRangeInvalidInfo;
  static readonly find = finderFor<CheckpointRangeInvalidError>('CheckpointRangeInvalidError');
  static readonly has = hasFor('CheckpointRangeInvalidError');
  constructor(message: string, options: RequiredInfoErrorOptions<CheckpointRangeInvalidInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/**
 * `replayDeposit` / `prepareReplayDeposit` was asked to replay a deposit
 * that is not in a replayable state. `info.status` is the status the SDK
 * read, the same shape `getDepositStatus` returns: branch on it as you
 * would there. The message says what to do next.
 */
export class DepositNotReplayableError extends VError {
  override readonly name = 'DepositNotReplayableError' as const;
  declare readonly info: DepositNotReplayableInfo;
  static readonly find = finderFor<DepositNotReplayableError>('DepositNotReplayableError');
  static readonly has = hasFor('DepositNotReplayableError');
  constructor(message: string, options: RequiredInfoErrorOptions<DepositNotReplayableInfo>) {
    super(message, options);
    sealMessage({ error: this, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

// ─── Root cause ─────────────────────────────────────────────────────────────

/**
 * The error at the bottom of an SDK error's cause chain: the fetch or
 * parser error inside an SDK condition (the network failure under an
 * `HttpRequestFailedError`, the `SyntaxError` under an
 * `InvalidHexStringError`). Errors from the wallet, the RPC node or the
 * client library are not wrapped, so they need no unwrapping: read their
 * fields (`code`, `4001`) on the thrown error itself. Applied to such an
 * error, `rootCause` still walks into it and returns the library's own
 * nested error.
 *
 * Follows `.cause` to the deepest `Error`, or to an object-valued non-`Error`
 * cause below it (a wallet's bare JSON-RPC error body), which is always the
 * last link. Then it hops structurally from that link: to its object-valued
 * `info.error`, else to its object-valued `error`, and repeats on whatever
 * it lands on until neither is present. The hops exist because ethers never
 * sets `.cause`: v6 keeps the raw provider error at `info.error`
 * (`ACTION_REJECTED`, `CALL_EXCEPTION`) or at `error` (`UNKNOWN_ERROR`), and
 * v5 keeps it at `error`, where over an HTTP provider it is v5's own
 * `SERVER_ERROR`, which holds the node's error one `error` further down
 * (`UNPREDICTABLE_GAS_LIMIT` → `SERVER_ERROR` → `{ code: 3 }`). The hops
 * are decided by shape, not by library or error name, so they work the same
 * on a second copy of any library.
 *
 * The result is `unknown` because the hop can land on a plain object (the
 * JSON-RPC error body), not an `Error`. Returns `null` when `err` is not an
 * `Error`.
 *
 * Known gap: when the wallet's message matches "user denied", ethers v5
 * throws its own `ACTION_REJECTED` error and discards the wallet's error, so
 * no `4001` is reachable there; only the text-free `ACTION_REJECTED` is.
 */
export const rootCause = (err: unknown): unknown => {
  if (!(err instanceof Error)) return null;
  const seen = new Set<object>([err]);
  let deepest: object = err;
  while (deepest instanceof Error) {
    const next: unknown = deepest.cause;
    if (!isRecord(next) || seen.has(next)) break;
    seen.add(next);
    deepest = next;
  }
  return hopToLibraryError(deepest);
};

/**
 * Most hops `rootCause` makes below the cause chain. The deepest nesting
 * observed is two (ethers v5 over HTTP); the cap leaves room for a wrapper
 * or two more while bounding the walk on a structure that mints a fresh
 * object on every read, which the cycle check alone cannot stop.
 */
const MAX_LIBRARY_HOPS = 8;

const hopToLibraryError = (link: object): unknown => {
  const seen = new Set<object>([link]);
  let node: object = link;
  for (let hop = 0; hop < MAX_LIBRARY_HOPS; hop++) {
    const info: unknown = 'info' in node ? node.info : undefined;
    const raw: unknown = 'error' in node ? node.error : undefined;
    const next: unknown = isRecord(info) && isRecord(info['error']) ? info['error'] : raw;
    if (!isRecord(next) || seen.has(next)) break;
    seen.add(next);
    node = next;
  }
  return node;
};

/**
 * True when `err`, or any error in its cause chain, was raised by this
 * package. Matches by name and an object-valued `info`, plus string
 * `info.operation` and `info.mode` for an operation error (the same test as
 * each class's `find`), so it also recognises errors from another copy of
 * the package and errors read back from JSON, and ignores library errors
 * that share a generic name but carry no `info`.
 *
 * A consumer's own `VError` that reuses a condition name matches too, since
 * every `VError` carries an `info` object (`{}` by default); name your own
 * classes apart. One that reuses an operation name (`DepositError`) does
 * not, unless its `info` also has string `operation` and `mode`.
 */
export const isMaticjsError = (err: unknown): boolean => {
  for (const link of causeChain(err)) {
    if (hasMaticjsShape(link)) return true;
  }
  return false;
};

// ─── Operation errors ───────────────────────────────────────────────────────

/** Which kind of public call an operation error came from. */
export type OperationMode = 'write' | 'prepare' | 'read' | 'confirm' | 'init';

/** `info` on every operation error. */
export type OperationInfo = {
  /** The public method that failed, e.g. `completeWithdraw`. */
  operation: string;
  mode: OperationMode;
  tokenAddress?: string;
  /** Address of the contract the call targeted, where it is already known (e.g. a validator's share contract). */
  contractAddress?: string;
  chainId?: number;
  transactionHash?: string;
  burnTxHash?: string;
  method?: string;
  isFast?: boolean;
  index?: number;
};

/** Options every operation-error constructor takes. */
export interface OperationErrorOptions {
  info: OperationInfo;
  cause?: Error;
}

/**
 * Appends the root message below an operation's condition when the cause
 * chain's own messages left it out, so the reason the call failed is always
 * in the top-level message. Both sides are compared redacted, so a
 * token-bearing root message is not appended a second time.
 */
const withRootMessage = ({ message, cause }: { message: string; cause: unknown }): string => {
  const root = rootCause(cause);
  const rootMessage = isRecord(root) ? root['message'] : undefined;
  if (typeof rootMessage !== 'string' || rootMessage === '') return message;
  const safeMessage = redactTokens(message);
  const safeRoot = redactTokens(rootMessage);
  return safeMessage.includes(safeRoot) ? safeMessage : `${safeMessage}; root cause: ${safeRoot}`;
};

/** The cause's own one-line summary (`shortMessage`), when it has one. */
const causeShortMessage = (cause: Error | undefined): string | undefined => {
  const short: unknown =
    cause !== undefined && 'shortMessage' in cause ? cause.shortMessage : undefined;
  return typeof short === 'string' && short !== '' ? short : undefined;
};

/**
 * What an operation error passes to `VError`. When the cause has a
 * `shortMessage` (an SDK condition's own message, without its causes'),
 * the message is built from it and the cause is attached afterwards by
 * `sealOperationMessage`, so the condition's cause chain is not repeated in
 * full; `withRootMessage` then adds the root's text once. Without a
 * `shortMessage`, VError appends the cause chain's messages as usual.
 */
const operationSuperArgs = (
  options: OperationErrorOptions
): [message: string, options: OperationErrorOptions] => {
  const failed = `${options.info.operation} failed`;
  const short = causeShortMessage(options.cause);
  return short === undefined ? [failed, options] : [`${failed}: ${short}`, { info: options.info }];
};

/**
 * Operation errors are what public methods throw. The message is
 * `<operation> failed: <cause summary>`, where the summary is the cause's
 * `shortMessage` or else its cause chain's messages, plus the root message
 * when that left it out (see `withRootMessage`); the SDK condition that
 * stopped the call is the `cause`.
 */
const sealOperationMessage = ({
  error,
  options,
  constructorOpt
}: {
  error: VError;
  options: OperationErrorOptions;
  constructorOpt: NewableFunction;
}): void => {
  if (error.cause === undefined && options.cause !== undefined) {
    // Non-enumerable, as VError itself sets it.
    Object.defineProperty(error, 'cause', {
      value: options.cause,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  replaceOwn({ target: error, key: 'shortMessage', value: `${options.info.operation} failed` });
  sealMessage({ error, constructorOpt, appendRootCause: true });
};

/** `POSClient.init` / `StakingClient.init` failed. */
export class InitError extends VError {
  override readonly name = 'InitError' as const;
  declare readonly info: OperationInfo;
  static readonly find = finderFor<InitError>('InitError');
  static readonly has = hasFor('InitError');
  constructor(options: OperationErrorOptions) {
    super(...operationSuperArgs(options));
    sealOperationMessage({ error: this, options, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A contract-address lookup failed. */
export class AddressLookupError extends VError {
  override readonly name = 'AddressLookupError' as const;
  declare readonly info: OperationInfo;
  static readonly find = finderFor<AddressLookupError>('AddressLookupError');
  static readonly has = hasFor('AddressLookupError');
  constructor(options: OperationErrorOptions) {
    super(...operationSuperArgs(options));
    sealOperationMessage({ error: this, options, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A token balance, allowance or ownership read failed. */
export class TokenReadError extends VError {
  override readonly name = 'TokenReadError' as const;
  declare readonly info: OperationInfo;
  static readonly find = finderFor<TokenReadError>('TokenReadError');
  static readonly has = hasFor('TokenReadError');
  constructor(options: OperationErrorOptions) {
    super(...operationSuperArgs(options));
    sealOperationMessage({ error: this, options, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A checkpoint read on the root chain failed. */
export class CheckpointReadError extends VError {
  override readonly name = 'CheckpointReadError' as const;
  declare readonly info: OperationInfo;
  static readonly find = finderFor<CheckpointReadError>('CheckpointReadError');
  static readonly has = hasFor('CheckpointReadError');
  constructor(options: OperationErrorOptions) {
    super(...operationSuperArgs(options));
    sealOperationMessage({ error: this, options, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A deposit, checkpoint or exit status check failed. */
export class BridgeStatusError extends VError {
  override readonly name = 'BridgeStatusError' as const;
  declare readonly info: OperationInfo;
  static readonly find = finderFor<BridgeStatusError>('BridgeStatusError');
  static readonly has = hasFor('BridgeStatusError');
  constructor(options: OperationErrorOptions) {
    super(...operationSuperArgs(options));
    sealOperationMessage({ error: this, options, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** Building an exit payload or block proof failed. */
export class ProofBuildError extends VError {
  override readonly name = 'ProofBuildError' as const;
  declare readonly info: OperationInfo;
  static readonly find = finderFor<ProofBuildError>('ProofBuildError');
  static readonly has = hasFor('ProofBuildError');
  constructor(options: OperationErrorOptions) {
    super(...operationSuperArgs(options));
    sealOperationMessage({ error: this, options, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** An approval failed. */
export class ApproveError extends VError {
  override readonly name = 'ApproveError' as const;
  declare readonly info: OperationInfo;
  static readonly find = finderFor<ApproveError>('ApproveError');
  static readonly has = hasFor('ApproveError');
  constructor(options: OperationErrorOptions) {
    super(...operationSuperArgs(options));
    sealOperationMessage({ error: this, options, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A deposit failed. */
export class DepositError extends VError {
  override readonly name = 'DepositError' as const;
  declare readonly info: OperationInfo;
  static readonly find = finderFor<DepositError>('DepositError');
  static readonly has = hasFor('DepositError');
  constructor(options: OperationErrorOptions) {
    super(...operationSuperArgs(options));
    sealOperationMessage({ error: this, options, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** Starting a withdrawal (the child-chain burn) failed. */
export class WithdrawStartError extends VError {
  override readonly name = 'WithdrawStartError' as const;
  declare readonly info: OperationInfo;
  static readonly find = finderFor<WithdrawStartError>('WithdrawStartError');
  static readonly has = hasFor('WithdrawStartError');
  constructor(options: OperationErrorOptions) {
    super(...operationSuperArgs(options));
    sealOperationMessage({ error: this, options, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** Completing a withdrawal (the root-chain exit) failed. */
export class ExitError extends VError {
  override readonly name = 'ExitError' as const;
  declare readonly info: OperationInfo;
  static readonly find = finderFor<ExitError>('ExitError');
  static readonly has = hasFor('ExitError');
  constructor(options: OperationErrorOptions) {
    super(...operationSuperArgs(options));
    sealOperationMessage({ error: this, options, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A token transfer failed. */
export class TransferError extends VError {
  override readonly name = 'TransferError' as const;
  declare readonly info: OperationInfo;
  static readonly find = finderFor<TransferError>('TransferError');
  static readonly has = hasFor('TransferError');
  constructor(options: OperationErrorOptions) {
    super(...operationSuperArgs(options));
    sealOperationMessage({ error: this, options, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** `TxResult.confirmed()` rejected. */
export class ConfirmationError extends VError {
  override readonly name = 'ConfirmationError' as const;
  declare readonly info: OperationInfo;
  static readonly find = finderFor<ConfirmationError>('ConfirmationError');
  static readonly has = hasFor('ConfirmationError');
  constructor(options: OperationErrorOptions) {
    super(...operationSuperArgs(options));
    sealOperationMessage({ error: this, options, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A staking read failed. */
export class StakingReadError extends VError {
  override readonly name = 'StakingReadError' as const;
  declare readonly info: OperationInfo;
  static readonly find = finderFor<StakingReadError>('StakingReadError');
  static readonly has = hasFor('StakingReadError');
  constructor(options: OperationErrorOptions) {
    super(...operationSuperArgs(options));
    sealOperationMessage({ error: this, options, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** A staking write failed. */
export class StakingWriteError extends VError {
  override readonly name = 'StakingWriteError' as const;
  declare readonly info: OperationInfo;
  static readonly find = finderFor<StakingWriteError>('StakingWriteError');
  static readonly has = hasFor('StakingWriteError');
  constructor(options: OperationErrorOptions) {
    super(...operationSuperArgs(options));
    sealOperationMessage({ error: this, options, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

/** Preparing an EIP-2612 permit failed. */
export class PermitError extends VError {
  override readonly name = 'PermitError' as const;
  declare readonly info: OperationInfo;
  static readonly find = finderFor<PermitError>('PermitError');
  static readonly has = hasFor('PermitError');
  constructor(options: OperationErrorOptions) {
    super(...operationSuperArgs(options));
    sealOperationMessage({ error: this, options, constructorOpt: new.target });
  }
  override toJSON(): Record<string, unknown> {
    return safeJSON({ error: this, json: super.toJSON() });
  }
}

// ─── Boundary wrapping ──────────────────────────────────────────────────────

/** A concrete operation-error class, as `withOperation` takes it. */
export type OperationErrorClass = new (options: OperationErrorOptions) => Error;

type OperationErrorLike = Error & { info: OperationInfo };

// The same test `find` / `has` use, so a public method collapses exactly the
// errors a consumer's `DepositError.has(err)` would call operation errors.
const isOperationErrorLike = (err: unknown): err is OperationErrorLike =>
  err instanceof Error && OPERATION_NAME_SET.has(err.name) && isRecord(err) && hasMaticjsShape(err);

/**
 * A message for a thrown non-`Error`: its own `message` when it has one,
 * else `String(value)`. Never throws, because it runs while an error is
 * already being reported: `String` throws on a null-prototype object or a
 * throwing `toString`, and that would replace the real failure.
 */
export const thrownValueMessage = (value: unknown): string => {
  try {
    if (isRecord(value) && typeof value['message'] === 'string') return value['message'];
    return String(value);
  } catch {
    return 'non-Error value thrown';
  }
};

/**
 * True when `err` itself is an error this package raised (a condition or an
 * operation error, from any copy of the package). Only these are wrapped by
 * `withOperation`; everything else is someone else's error.
 */
const isSdkError = (err: unknown): err is Error & { info: ErrorInfo } =>
  err instanceof Error && isRecord(err) && hasMaticjsShape(err);

/**
 * Runs `run` and rethrows an SDK error from it as `error`, the operation
 * error of the public method being called. `run` is invoked inside the
 * `try`, so a synchronous throw also becomes a rejection.
 *
 * Anything else, an error from the wallet, the RPC node or the client
 * library, or a thrown non-`Error`, is rethrown unchanged by identity. Those
 * are the consumer's own library's errors, already documented by that
 * library; wrapping them would hide the codes (`4001`, `CALL_EXCEPTION`)
 * consumers already branch on.
 *
 * An operation error thrown from inside (a public method calling another)
 * is collapsed rather than nested: its `info` is merged under ours and its
 * cause kept, so the consumer sees one operation layer, named after the
 * method they called.
 */
export const withOperation = async <T>({
  error,
  info,
  run
}: {
  error: OperationErrorClass;
  info: OperationInfo;
  run: () => T | Promise<T>;
}): Promise<T> => {
  try {
    return await run();
  } catch (err) {
    if (!isSdkError(err)) throw err;
    if (isOperationErrorLike(err)) {
      const inner: unknown = err.cause;
      // An outer key left `undefined` (an optional field the caller did not
      // know) must not erase what the inner operation recorded.
      const merged: OperationInfo = { ...err.info };
      for (const [key, value] of Object.entries(info)) {
        if (value !== undefined) Reflect.set(merged, key, value);
      }
      throw new error({ info: merged, cause: inner instanceof Error ? inner : undefined });
    }
    throw new error({ info, cause: err });
  }
};
