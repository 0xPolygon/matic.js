import { keccak224, keccak384, keccak256 as k256, keccak512 } from 'ethereum-cryptography/keccak';

import { POSBridgeError } from '../errors.js';

/**
 * Static keccak helpers. Wraps the four width variants so the proof
 * pipeline can call `Keccak.keccak256(buf)` without a per-call import.
 *
 * # Why a class with statics
 *
 * Mirrors the legacy `Keccak` shape so existing call sites (and the
 * `merkle_tree.ts` reference at module scope) keep working without a
 * naming change. Every method is `static`; instantiation is meaningless.
 */
export class Keccak {
  /**
   * Throws a structured `POSBridgeError` if input is not a `Uint8Array`.
   */
  static assertIsBuffer = function (input: Uint8Array): void {
    if (!(input instanceof Uint8Array)) {
      throw new POSBridgeError(
        'BUFFER_TYPE_REQUIRED',
        `This method only supports Uint8Array but input was: ${String(input)}`,
        { received: typeof input }
      );
    }
  };

  /**
   * Creates a keccak hash of a `Uint8Array` input at the given bit width.
   *
   * The `ethereum-cryptography` keccak variants already return a
   * `Uint8Array`, so no wrapping is needed.
   */
  static keccak = function (a: Uint8Array, bits = 256): Uint8Array {
    Keccak.assertIsBuffer(a);
    switch (bits) {
      case 224: {
        return keccak224(a);
      }
      case 256: {
        return k256(a);
      }
      case 384: {
        return keccak384(a);
      }
      case 512: {
        return keccak512(a);
      }
      default: {
        throw new POSBridgeError(
          'UNSUPPORTED_KECCAK_BIT_WIDTH',
          `Invalid algorithm: keccak${bits}`,
          { bits }
        );
      }
    }
  };

  /**
   * Creates Keccak-256 hash of the input, alias for keccak(a, 256).
   */
  static keccak256 = function (a: Uint8Array): Uint8Array {
    return Keccak.keccak(a);
  };
}
