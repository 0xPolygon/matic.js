/**
 * Minimal ABI encoder for the bridge's `depositData` payload shapes.
 *
 * # Why not pull in viem / ethers
 *
 * viem and ethers are both OPTIONAL peer dependencies; relying on
 * either for ABI encoding inside the high-level bridge code would
 * force every consumer to install one or the other regardless of
 * which adapter they actually use. The bridge's deposit flows ABI-
 * encode a fixed, small set of shapes:
 *
 *   - `(uint256)`            — ERC-20 / ERC-721 single deposit amount
 *   - `(uint256[])`          — ERC-721 batch deposit
 *   - `(uint256[], uint256[], bytes)` — ERC-1155 batch deposit
 *   - `(address, bytes)`     — a state-sync record's hash preimage
 *
 * Implementing these from primitives is ~80 lines and avoids the peer
 * dep, so we do that. A general-purpose ABI encoder is intentionally
 * out of scope; unsupported types reject with a clear error.
 *
 * # Encoding rules (Solidity ABI v2)
 *
 * Static types (`uint256`) write 32 bytes inline. Dynamic types
 * (`uint256[]`, `bytes`) are split into a head and a tail: the head
 * stores an offset into the tail, and the tail stores the length plus
 * the data. For the `(uint256[], uint256[], bytes)` shape this means
 * three offsets in the head, then the three encoded blocks in the
 * tail in order.
 */

import type { Hex } from '../adapter.js';

import {
  BridgeEventDecodeFailedError,
  InvalidHexStringError,
  InvalidNumericValueError,
  NegativeBigNumberError
} from '../errors.js';

const HEAD_WORD = 32;

export function encodeAbiParameters(values: readonly unknown[], types: readonly string[]): Hex {
  if (values.length !== types.length) {
    throw new BridgeEventDecodeFailedError(
      `encodeAbiParameters: ${values.length} values vs ${types.length} types`,
      { info: { valueCount: values.length, typeCount: types.length } }
    );
  }

  // First pass: encode each value into hex (no head/tail layout yet).
  // For dynamic types we record the encoded bytes; the head will store
  // an offset that we compute once we know the head's total size.
  const encoded: { dynamic: boolean; data: string }[] = types.map((type, i) =>
    encodeOne(type, values[i])
  );

  // Head total size = one word per parameter (each is either an inline
  // value or a pointer to the tail).
  const headSize = types.length * HEAD_WORD;

  let head = '';
  let tail = '';
  let tailCursor = headSize;
  for (const part of encoded) {
    if (part.dynamic) {
      head += pad32(toHex(BigInt(tailCursor)));
      tail += part.data;
      tailCursor += part.data.length / 2;
    } else {
      head += part.data;
    }
  }

  return `0x${head}${tail}`;
}

function encodeOne(type: string, value: unknown): { dynamic: boolean; data: string } {
  if (type === 'address') {
    const stripped = typeof value === 'string' ? stripHexPrefix(value) : '';
    if (!/^[0-9a-fA-F]{40}$/.test(stripped)) {
      throw new InvalidHexStringError('address expected a 20-byte 0x-prefixed hex string', {
        info: { received: typeof value }
      });
    }
    return { dynamic: false, data: pad32(stripped.toLowerCase()) };
  }
  if (type === 'uint256') {
    return { dynamic: false, data: pad32(toHex(coerceUint(value))) };
  }
  if (type === 'uint256[]') {
    if (!Array.isArray(value)) {
      throw new BridgeEventDecodeFailedError('uint256[] expected an array', {
        info: { received: typeof value }
      });
    }
    const length = pad32(toHex(BigInt(value.length)));
    const elements = value.map((v) => pad32(toHex(coerceUint(v)))).join('');
    return { dynamic: true, data: length + elements };
  }
  if (type === 'bytes') {
    if (typeof value !== 'string') {
      throw new BridgeEventDecodeFailedError('bytes expected a 0x-prefixed hex string', {
        info: { received: typeof value }
      });
    }
    const stripped = stripHexPrefix(value);
    if (stripped.length % 2 !== 0) {
      throw new InvalidHexStringError('bytes value has odd-length hex', {
        info: { length: stripped.length }
      });
    }
    const byteLength = stripped.length / 2;
    const length = pad32(toHex(BigInt(byteLength)));
    // bytes are right-padded to a 32-byte boundary
    const padded = stripped.padEnd(Math.ceil(stripped.length / 64) * 64, '0');
    return { dynamic: true, data: length + padded };
  }
  throw new BridgeEventDecodeFailedError(`encodeAbiParameters: unsupported type "${type}"`, {
    info: { type }
  });
}

function coerceUint(v: unknown): bigint {
  if (typeof v === 'bigint') return assertNonNeg(v);
  if (typeof v === 'number') return assertNonNeg(BigInt(v));
  if (typeof v === 'string') return assertNonNeg(BigInt(v));
  throw new InvalidNumericValueError(`cannot coerce ${typeof v} to uint256`, {
    info: { received: typeof v }
  });
}

function assertNonNeg(v: bigint): bigint {
  if (v < 0n) {
    throw new NegativeBigNumberError('uint256 cannot be negative', {
      info: { value: v.toString() }
    });
  }
  return v;
}

function toHex(v: bigint): string {
  return v.toString(16);
}

function pad32(hex: string): string {
  if (hex.length > 64) {
    throw new InvalidHexStringError(`value too long to pad to 32 bytes: 0x${hex}`, {
      info: { length: hex.length }
    });
  }
  return hex.padStart(64, '0');
}

function stripHexPrefix(s: string): string {
  return s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
}

/**
 * Decodes a log `data` field that is exactly one ABI-encoded `bytes`
 * (`offset, length, payload`), as `StateSynced.data` is. Strict on the
 * layout so a malformed log fails here rather than hashing the wrong bytes.
 */
export function decodeBytesParameter(encoded: string): Hex {
  const hex = stripHexPrefix(encoded);
  const fail = (reason: string): never => {
    throw new BridgeEventDecodeFailedError(`cannot decode bytes parameter: ${reason}`, {
      info: { length: hex.length }
    });
  };
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length < 128) return fail('too short or not hex');
  if (BigInt(`0x${hex.slice(0, 64)}`) !== BigInt(HEAD_WORD)) return fail('offset is not 0x20');
  const byteLength = Number(BigInt(`0x${hex.slice(64, 128)}`));
  if (hex.length < 128 + byteLength * 2) return fail('payload shorter than its length word');
  return `0x${hex.slice(128, 128 + byteLength * 2)}`;
}
