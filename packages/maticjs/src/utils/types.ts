/**
 * Shared structural types for the bytes/keccak/MPT helpers. These are
 * intentionally framework-agnostic: ethereumjs ships a few of these and
 * the legacy code re-imported them; we declare them once here so the SDK
 * has a single source of truth.
 *
 * The 1.0 rewrite is `Uint8Array`-only — no Node `Buffer` anywhere in the
 * pipeline — so these interfaces describe `Uint8Array` producers. (A
 * `Buffer` *is* a `Uint8Array`, so BN-shaped consumer objects whose
 * `toBuffer()` returns a real `Buffer` still satisfy the structural type.)
 */

/** A `0x`-prefixed hex string. The high-level types in `adapter.ts` use the
 *  branded literal `\`0x\${string}\`` form; this looser alias is for buffer
 *  utilities that historically accepted any string and validated at the
 *  boundary. */
export type PrefixedHexString = string;

/** Object with a `toArray()` method — implemented by ethers v5's BigNumber
 *  and bn.js's BN instances. The buffer helpers accept these for
 *  interop with consumer-supplied values that pre-date the bigint
 *  switchover. */
export interface ITransformableToArray {
  toArray(): Uint8Array;
  toBuffer?(): Uint8Array;
}

/** Object with a `toBuffer()` method — symmetrical with `ITransformableToArray`. */
export interface ITransformableToBuffer {
  toBuffer(): Uint8Array;
  toArray?(): Uint8Array;
}
