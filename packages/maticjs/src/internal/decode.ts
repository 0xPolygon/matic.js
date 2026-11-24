/**
 * The one place a value read from a contract becomes an SDK value.
 *
 * The three web3 libraries return different raw values for the same
 * `eth_call` result: ethers v5 gives a `BigNumber` for a `uint256` and a
 * `number` for a `uint8`, viem and ethers v6 give a `bigint`, and a
 * multi-output read is a plain array on viem and a `Result` on ethers. The
 * adapters hand those through untouched (changing that would change what the
 * public `Adapter.read` returns), so this module is what makes a read come
 * out the same on all three, and what rejects a value that does not match the
 * ABI instead of letting it travel on and fail somewhere unrelated.
 *
 * It is driven by the ABI's own `outputs` at run time. `abi-types.ts` derives
 * the compile-time types from the same ABI; the agreement test over every
 * vendored function is what pins the two together.
 *
 * A mismatch throws `BridgeEventDecodeFailedError` with no `cause`: the value
 * is judged malformed by this code, so the failure is the SDK's own, not a
 * library error being wrapped.
 */

import type { Hex } from '../adapter.js';
import type { BridgeEventDecodeFailedInfo } from '../errors.js';
import type { Abi, AbiParameter } from './abi-types.js';

import { BridgeEventDecodeFailedError } from '../errors.js';

const DECIMAL = /^-?[0-9]+$/;
const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const INTEGER_TYPE = /^(u?)int([0-9]*)$/;
const FIXED_BYTES_TYPE = /^bytes([0-9]+)$/;
const ARRAY_TYPE = /^(.*)\[([0-9]*)\]$/;

/** The failure every check below ends in; `info` carries only keys the error already declares. */
const reject = ({
  message,
  info
}: {
  message: string;
  info: BridgeEventDecodeFailedInfo;
}): never => {
  throw new BridgeEventDecodeFailedError(message, { info });
};

/** A value of the wrong kind: records `typeof` it, never the value itself. */
const rejectValue = ({
  message,
  field,
  value
}: {
  message: string;
  field: string;
  value: unknown;
}): never => reject({ message, info: { field, valueType: typeof value } });

/** Range of an ABI integer type, from its width (`uint` and `int` are 256 bits). */
const integerRange = ({ type }: { type: string }): { min: bigint; max: bigint } | undefined => {
  const match = INTEGER_TYPE.exec(type);
  if (match === null) return undefined;
  const [, unsigned, width] = match;
  const bits = BigInt(width === undefined || width === '' ? 256 : width);
  if (unsigned === 'u') return { min: 0n, max: 2n ** bits - 1n };
  return { min: -(2n ** (bits - 1n)), max: 2n ** (bits - 1n) - 1n };
};

/** The decimal text of a value that is an object, or `undefined` when it has none. */
const decimalTextOf = (value: object): string | undefined => {
  if (Array.isArray(value)) return undefined;
  // `String()` runs the library's own `toString`, which an ethers v5
  // `BigNumber` answers with its decimal digits. An object without one
  // (`Object.create(null)`) throws, and is simply not a number.
  let text: string;
  try {
    text = String(value);
  } catch {
    return undefined;
  }
  return DECIMAL.test(text) ? text : undefined;
};

/**
 * One integer of an ABI integer type, as `bigint`. Accepts what the three
 * libraries return: a `bigint`, a safe-integer `number`, a decimal or `0x`
 * string, or an object whose string form is a decimal (an ethers v5
 * `BigNumber`). The result must fit the type's range, so a negative
 * `uint256` or a `uint8` of 300 is rejected like any other mismatch.
 */
export const decodeInteger = ({
  type,
  value,
  field
}: {
  type: string;
  value: unknown;
  field: string;
}): bigint => {
  const range = integerRange({ type });
  if (range === undefined) {
    throw new Error(`internal invariant: ${type} is not an ABI integer type`);
  }
  const parsed = parseInteger(value);
  if (parsed === undefined) {
    return rejectValue({ message: `${field} is not an integer`, field, value });
  }
  if (parsed < range.min || parsed > range.max) {
    return rejectValue({ message: `${field} is out of range for ${type}`, field, value });
  }
  return parsed;
};

const parseInteger = (value: unknown): bigint | undefined => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  if (typeof value === 'string') {
    return DECIMAL.test(value) || HEX_QUANTITY.test(value) ? BigInt(value) : undefined;
  }
  if (typeof value === 'object' && value !== null) {
    const text = decimalTextOf(value);
    return text === undefined ? undefined : BigInt(text);
  }
  return undefined;
};

/** One `address`: `0x` and 40 hex digits, exactly. */
export const decodeAddress = ({ value, field }: { value: unknown; field: string }): Hex => {
  if (typeof value === 'string' && ADDRESS.test(value)) {
    const hex: Hex = `0x${value.slice(2)}`;
    return hex;
  }
  return rejectValue({ message: `${field} is not a 0x address`, field, value });
};

/** One `bool`: a boolean, never a string such as `'false'` that is truthy. */
export const decodeBool = ({ value, field }: { value: unknown; field: string }): boolean => {
  if (typeof value === 'boolean') return value;
  return rejectValue({ message: `${field} is not a boolean`, field, value });
};

/** One `string`. */
export const decodeString = ({ value, field }: { value: unknown; field: string }): string => {
  if (typeof value === 'string') return value;
  return rejectValue({ message: `${field} is not a string`, field, value });
};

/**
 * One `bytes` or `bytesN`: `0x` and whole bytes, and for `bytesN` exactly N
 * of them, since an ABI decode never yields a shorter fixed-size value.
 */
export const decodeBytes = ({
  type,
  value,
  field
}: {
  type: string;
  value: unknown;
  field: string;
}): Hex => {
  if (typeof value === 'string' && HEX_BYTES.test(value)) {
    const fixed = FIXED_BYTES_TYPE.exec(type);
    const size = fixed?.[1];
    if (size === undefined || value.length === 2 + 2 * Number(size)) {
      const hex: Hex = `0x${value.slice(2)}`;
      return hex;
    }
  }
  return rejectValue({ message: `${field} is not ${type} hex`, field, value });
};

/**
 * One value of any ABI type this SDK reads: the scalar types, and arrays of
 * them, fixed-size (`T[N]`) or not, to any depth. A tuple is the one thing it
 * does not know; that is a programming error in the ABI wiring, not a bad
 * value, so it is a plain `Error` rather than a decode failure.
 */
export const decodeAbiValue = ({
  type,
  value,
  field
}: {
  type: string;
  value: unknown;
  field: string;
}): unknown => {
  const array = ARRAY_TYPE.exec(type);
  if (array !== null) {
    const [, elementType = '', size = ''] = array;
    // Checked before the value: an empty `tuple[]` has no element to trip over,
    // and would otherwise pass as if the type were understood.
    assertSupported({ type: elementType, field });
    return decodeArray({ elementType, size, value, field });
  }
  if (type === 'address') return decodeAddress({ value, field });
  if (type === 'bool') return decodeBool({ value, field });
  if (type === 'string') return decodeString({ value, field });
  if (type === 'bytes' || FIXED_BYTES_TYPE.test(type)) return decodeBytes({ type, value, field });
  if (INTEGER_TYPE.test(type)) return decodeInteger({ type, value, field });
  return unsupported({ type, field });
};

const unsupported = ({ type, field }: { type: string; field: string }): never => {
  throw new Error(`internal invariant: ABI type ${type} at ${field} is not supported`);
};

/** Fails when the scalar at the bottom of `type`'s array dimensions is not one `decodeAbiValue` reads. */
const assertSupported = ({ type, field }: { type: string; field: string }): void => {
  const scalar = type.replace(/(\[[0-9]*\])+$/, '');
  const known =
    scalar === 'address' ||
    scalar === 'bool' ||
    scalar === 'string' ||
    scalar === 'bytes' ||
    FIXED_BYTES_TYPE.test(scalar) ||
    INTEGER_TYPE.test(scalar);
  if (!known) unsupported({ type, field });
};

const decodeArray = ({
  elementType,
  size,
  value,
  field
}: {
  elementType: string;
  size: string;
  value: unknown;
  field: string;
}): unknown[] => {
  if (!Array.isArray(value)) {
    return rejectValue({ message: `${field} is not an array`, field, value });
  }
  if (size !== '' && value.length !== Number(size)) {
    return reject({
      message: `${field} has ${value.length} elements, expected exactly ${size}`,
      info: { field, length: value.length, minLength: Number(size) }
    });
  }
  return value.map((element: unknown, index) =>
    decodeAbiValue({ type: elementType, value: element, field: `${field}[${index}]` })
  );
};

const isAbiParameter = (value: unknown): value is AbiParameter =>
  typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';

/** The `outputs` of the function, or `undefined` when `entry` is not a function named `method`. */
const outputsOf = ({
  entry,
  method
}: {
  entry: unknown;
  method: string;
}): readonly AbiParameter[] | undefined => {
  if (typeof entry !== 'object' || entry === null) return undefined;
  if (!('type' in entry) || entry.type !== 'function') return undefined;
  if (!('name' in entry) || entry.name !== method) return undefined;
  if (!('outputs' in entry) || !Array.isArray(entry.outputs)) return [];
  const outputs: readonly unknown[] = entry.outputs;
  return outputs.every(isAbiParameter) ? outputs : undefined;
};

/** `method.outputName` where the ABI names the output, `method.<index>` where it does not. */
const fieldOf = ({
  method,
  output,
  index
}: {
  method: string;
  output: AbiParameter;
  index: number;
}): string => `${method}.${output.name === undefined || output.name === '' ? index : output.name}`;

/**
 * Turn what an adapter's `read` returned into the SDK value the ABI's
 * `outputs` describe: the bare value for one output, a positional array for
 * several (viem returns an array, ethers a `Result`, which is one).
 *
 * `abi` is typed `Abi` and not `AbiFunction[]` because that is what a caller
 * holds; each entry is checked as it is looked at. A method the ABI does not
 * carry is a plain `Error`, as the ethers adapters already throw one.
 */
export const decodeAbiResult = ({
  abi,
  method,
  raw
}: {
  abi: Abi;
  method: string;
  raw: unknown;
}): unknown => {
  // First match: the only overloaded names the SDK has are writes.
  const outputs = abi.map((entry) => outputsOf({ entry, method })).find((o) => o !== undefined);
  if (outputs === undefined) {
    throw new Error(`internal invariant: the ABI has no function ${method}`);
  }
  const [only, ...rest] = outputs;
  if (only === undefined) return undefined;
  if (rest.length === 0) {
    return decodeAbiValue({
      type: only.type,
      value: raw,
      field: fieldOf({ method, output: only, index: 0 })
    });
  }
  if (!Array.isArray(raw)) {
    return rejectValue({
      message: `${method} did not decode to a tuple`,
      field: method,
      value: raw
    });
  }
  if (raw.length < outputs.length) {
    return reject({
      message: `${method} did not decode to a tuple of at least ${outputs.length} fields`,
      info: { field: method, length: raw.length, minLength: outputs.length }
    });
  }
  return outputs.map((output, index) =>
    decodeAbiValue({
      type: output.type,
      value: raw[index],
      field: fieldOf({ method, output, index })
    })
  );
};
