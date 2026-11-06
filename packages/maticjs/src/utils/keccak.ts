import { keccak_224, keccak_256, keccak_384, keccak_512 } from '@noble/hashes/sha3.js';

import { BufferTypeRequiredError, UnsupportedKeccakBitWidthError } from '../errors.js';

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
   * Throws a `BufferTypeRequiredError` if input is not a `Uint8Array`.
   */
  static assertIsBuffer = function (input: Uint8Array): void {
    if (!(input instanceof Uint8Array)) {
      throw new BufferTypeRequiredError(
        `This method only supports Uint8Array but input was: ${String(input)}`,
        { info: { received: typeof input } }
      );
    }
  };

  /**
   * Creates a keccak hash of a `Uint8Array` input at the given bit width.
   *
   * The `@noble/hashes` keccak variants already return a `Uint8Array`,
   * so no wrapping is needed. Input is checked here first, so a
   * non-`Uint8Array` fails with a `BufferTypeRequiredError` rather
   * than the library's own error.
   */
  static keccak = function (a: Uint8Array, bits = 256): Uint8Array {
    Keccak.assertIsBuffer(a);
    switch (bits) {
      case 224: {
        return keccak_224(a);
      }
      case 256: {
        return keccak_256(a);
      }
      case 384: {
        return keccak_384(a);
      }
      case 512: {
        return keccak_512(a);
      }
      default: {
        throw new UnsupportedKeccakBitWidthError(`Invalid algorithm: keccak${bits}`, {
          info: { bits }
        });
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
