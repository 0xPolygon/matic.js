/**
 * Cross-environment byte primitives for the proof / merkle / RLP pipeline.
 *
 * # Why this module exists
 *
 * The 1.0 rewrite drops Node's `Buffer` so the SDK runs unchanged in
 * modern browsers and Node >= 20. `Buffer` is Node-only; relying on it
 * forces consumers to ship a polyfill. `Uint8Array`, `TextEncoder`, and
 * `DataView` are available everywhere, and `ethereum-cryptography`
 * (already a dependency — pure `@noble` `Uint8Array` code) supplies the
 * hex / utf8 / concat primitives.
 *
 * This file re-exports those primitives from a single place and adds the
 * one helper `ethereum-cryptography` does not provide: a byte-exact
 * replacement for `Buffer.compare`. The merkle tree sorts and compares
 * leaves with `Buffer.compare`; its lexicographic-on-unsigned-bytes
 * ordering is load-bearing for on-chain proof verification, so
 * `compareBytes` replicates it precisely.
 */

import { bytesToHex, concatBytes, equalsBytes, hexToBytes, utf8ToBytes } from 'ethereum-cryptography/utils';

export { bytesToHex, concatBytes, equalsBytes, hexToBytes, utf8ToBytes };

/**
 * Byte-exact replacement for Node's `Buffer.compare(a, b)`.
 *
 * Returns `-1` if `a < b`, `1` if `a > b`, `0` if equal — comparing
 * unsigned byte values left-to-right, and treating the shorter array as
 * less when it is a prefix of the longer. This is exactly the ordering
 * `Buffer.compare` produces; the merkle tree depends on it to locate a
 * leaf's index and to compare a computed root against the expected root.
 */
export function compareBytes(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  if (a.length < b.length) return -1;
  if (a.length > b.length) return 1;
  return 0;
}
