/**
 * Bytes / hex coercion helpers used across the proof-building pipeline.
 *
 * # Why a BufferUtil class
 *
 * The legacy SDK had these as free functions in `utils/`; the class form
 * is preserved purely so that consumer call sites that already imported
 * `BufferUtil` keep working. Every method is `static`; there is no state
 * and no reason to instantiate one.
 *
 * # Uint8Array, not Buffer
 *
 * The 1.0 rewrite drops Node's `Buffer` so the SDK runs unchanged in
 * browsers and Node >= 20. The conversion helpers produce and accept
 * `Uint8Array`; `toBuffer` keeps the name (consumer source-compat) but
 * returns a `Uint8Array`. Hex <-> bytes goes through
 * `ethereum-cryptography`'s `hexToBytes` / `bytesToHex`.
 *
 * # bigint, not BN
 *
 * Stage 2 retired the BN.js wrapper. `toBuffer` accepts native `bigint`
 * directly and refuses negative values via `POSBridgeError` — the legacy
 * surface used to do the same with BN.js's `isNeg()` check.
 */

import type { ITransformableToArray, ITransformableToBuffer, PrefixedHexString } from './types.js';

import { POSBridgeError } from '../errors.js';
import { bytesToHex, hexToBytes } from './bytes.js';

export type ToBufferInputTypes =
  | PrefixedHexString
  | number
  | bigint
  | Uint8Array
  | number[]
  | ITransformableToArray
  | ITransformableToBuffer
  | null
  | undefined;

export class BufferUtil {
  static intToHex = function (i: number): string {
    if (!Number.isSafeInteger(i) || i < 0) {
      throw new POSBridgeError(
        'INVALID_NUMERIC_VALUE',
        `Received an invalid integer type: ${i}`,
        { value: i }
      );
    }
    return `0x${i.toString(16)}`;
  };

  static padToEven(value: string): string {
    let a = value;

    if (typeof a !== 'string') {
      throw new POSBridgeError(
        'INVALID_HEX_STRING',
        `[padToEven] value must be type 'string', received ${typeof a}`,
        { received: typeof a }
      );
    }

    if (a.length % 2) a = `0${a}`;

    return a;
  }

  static isHexPrefixed(str: string): boolean {
    if (typeof str !== 'string') {
      throw new POSBridgeError(
        'INVALID_HEX_STRING',
        `[isHexPrefixed] input must be type 'string', received type ${typeof str}`,
        { received: typeof str }
      );
    }

    return str[0] === '0' && str[1] === 'x';
  }

  static stripHexPrefix = (str: string): string => {
    if (typeof str !== 'string') {
      throw new POSBridgeError(
        'INVALID_HEX_STRING',
        `[stripHexPrefix] input must be type 'string', received ${typeof str}`,
        { received: typeof str }
      );
    }

    return BufferUtil.isHexPrefixed(str) ? str.slice(2) : str;
  };

  /**
   * Converts a non-negative number to a `Uint8Array`.
   */
  static intToBuffer = function (i: number): Uint8Array {
    const hex = BufferUtil.intToHex(i);
    return hexToBytes(BufferUtil.padToEven(hex.slice(2)));
  };

  static isHexString(value: string, length?: number): boolean {
    if (typeof value !== 'string' || !value.match(/^0x[0-9A-Fa-f]*$/)) return false;

    if (length && value.length !== 2 + 2 * length) return false;

    return true;
  }

  /**
   * Convert any of the accepted input types to a `Uint8Array`. Throws a
   * structured `POSBridgeError` when the input cannot be represented
   * (negative bigint, malformed hex, unknown shape).
   *
   * Array / `Uint8Array` inputs are copied (not viewed) to match the
   * legacy `Buffer.from(...)` behaviour — callers rely on the result
   * being independent of the source.
   */
  static toBuffer = function (v: ToBufferInputTypes): Uint8Array {
    if (v === null || v === undefined) {
      return new Uint8Array(0);
    }

    if (v instanceof Uint8Array) {
      return Uint8Array.from(v);
    }

    if (Array.isArray(v)) {
      return Uint8Array.from(v);
    }

    if (typeof v === 'string') {
      if (!BufferUtil.isHexString(v)) {
        throw new POSBridgeError(
          'INVALID_HEX_STRING',
          `Cannot convert string to bytes. toBuffer only supports 0x-prefixed hex strings and this string was given: ${v}`,
          { value: v }
        );
      }
      return hexToBytes(BufferUtil.padToEven(BufferUtil.stripHexPrefix(v)));
    }

    if (typeof v === 'number') {
      return BufferUtil.intToBuffer(v);
    }

    if (typeof v === 'bigint') {
      if (v < 0n) {
        throw new POSBridgeError(
          'NEGATIVE_BIG_NUMBER',
          `Cannot convert negative bigint to bytes. Given: ${v}`,
          { value: v.toString() }
        );
      }
      // Encode as the minimal big-endian byte array (matches BN's default behaviour).
      const hex = v.toString(16);
      const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
      return hexToBytes(padded);
    }

    // Structural fallbacks for ethers v5 BigNumber / bn.js BN, which
    // expose `.toArray()` or `.toBuffer()`. Consumers that pass these
    // values are expected to live alongside the bigint surface during
    // the migration window; future stages can drop these branches.
    if (typeof (v as ITransformableToArray).toArray === 'function') {
      return Uint8Array.from((v as ITransformableToArray).toArray());
    }

    if (typeof (v as ITransformableToBuffer).toBuffer === 'function') {
      return Uint8Array.from((v as ITransformableToBuffer).toBuffer());
    }

    throw new POSBridgeError(
      'BUFFER_TYPE_REQUIRED',
      'invalid type for toBuffer; expected hex string, number, bigint, Uint8Array, or BN-shaped object',
      { received: typeof v }
    );
  };

  /**
   * Converts a `Uint8Array` into a `0x`-prefixed hex `String`.
   */
  static bufferToHex = function (buf: Uint8Array): string {
    const normalized = BufferUtil.toBuffer(buf);
    return '0x' + bytesToHex(normalized);
  };
}
