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

import { POSBridgeError } from '../errors.js';

const HEAD_WORD = 32;

export function encodeAbiParameters(
  values: readonly unknown[],
  types: readonly string[]
): Hex {
  if (values.length !== types.length) {
    throw new POSBridgeError(
      'BRIDGE_EVENT_DECODE_FAILED',
      `encodeAbiParameters: ${values.length} values vs ${types.length} types`,
      { valueCount: values.length, typeCount: types.length }
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
  if (type === 'uint256') {
    return { dynamic: false, data: pad32(toHex(coerceUint(value))) };
  }
  if (type === 'uint256[]') {
    if (!Array.isArray(value)) {
      throw new POSBridgeError(
        'BRIDGE_EVENT_DECODE_FAILED',
        'uint256[] expected an array',
        { received: typeof value }
      );
    }
    const length = pad32(toHex(BigInt(value.length)));
    const elements = value.map((v) => pad32(toHex(coerceUint(v)))).join('');
    return { dynamic: true, data: length + elements };
  }
  if (type === 'bytes') {
    if (typeof value !== 'string') {
      throw new POSBridgeError(
        'BRIDGE_EVENT_DECODE_FAILED',
        'bytes expected a 0x-prefixed hex string',
        { received: typeof value }
      );
    }
    const stripped = stripHexPrefix(value);
    if (stripped.length % 2 !== 0) {
      throw new POSBridgeError(
        'INVALID_HEX_STRING',
        'bytes value has odd-length hex',
        { length: stripped.length }
      );
    }
    const byteLength = stripped.length / 2;
    const length = pad32(toHex(BigInt(byteLength)));
    // bytes are right-padded to a 32-byte boundary
    const padded = stripped.padEnd(Math.ceil(stripped.length / 64) * 64, '0');
    return { dynamic: true, data: length + padded };
  }
  throw new POSBridgeError(
    'BRIDGE_EVENT_DECODE_FAILED',
    `encodeAbiParameters: unsupported type "${type}"`,
    { type }
  );
}

function coerceUint(v: unknown): bigint {
  if (typeof v === 'bigint') return assertNonNeg(v);
  if (typeof v === 'number') return assertNonNeg(BigInt(v));
  if (typeof v === 'string') return assertNonNeg(BigInt(v));
  throw new POSBridgeError(
    'INVALID_NUMERIC_VALUE',
    `cannot coerce ${typeof v} to uint256`,
    { received: typeof v }
  );
}

function assertNonNeg(v: bigint): bigint {
  if (v < 0n) {
    throw new POSBridgeError(
      'NEGATIVE_BIG_NUMBER',
      'uint256 cannot be negative',
      { value: v.toString() }
    );
  }
  return v;
}

function toHex(v: bigint): string {
  return v.toString(16);
}

function pad32(hex: string): string {
  if (hex.length > 64) {
    throw new POSBridgeError(
      'INVALID_HEX_STRING',
      `value too long to pad to 32 bytes: 0x${hex}`,
      { length: hex.length }
    );
  }
  return hex.padStart(64, '0');
}

function stripHexPrefix(s: string): string {
  return s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
}
