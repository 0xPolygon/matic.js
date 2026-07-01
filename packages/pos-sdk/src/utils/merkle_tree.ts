import { zeros } from '@ethereumjs/util';

import { POSBridgeError } from '../errors.js';
import { compareBytes, concatBytes } from './bytes.js';
import { Keccak } from './keccak.js';

const sha3 = Keccak.keccak256;

/**
 * In-memory binary Merkle tree used for the bridge's exit-payload
 * construction.
 *
 * # Why this implementation, not `@ethereumjs/trie`'s
 *
 * The bridge predicates verify against a binary keccak tree padded to
 * `2^ceil(log2(n))` leaves with zero hashes — not a Patricia trie. The
 * hashing scheme (`keccak256(left || right)`) and zero-padding are the
 * exact format the on-chain `MerklePatriciaProof` library expects, so
 * any shared implementation must produce these specific bytes.
 *
 * # Why `Uint8Array`, not `Buffer`
 *
 * The 1.0 rewrite is cross-environment: it runs unchanged in browsers and
 * Node >= 20, neither of which should require a `Buffer` polyfill. Leaves
 * and layers are `Uint8Array`; `concatBytes` / `compareBytes` (from
 * `./bytes.js`) replace `Buffer.concat` / `Buffer.compare` with
 * byte-identical semantics — `compareBytes` reproduces `Buffer.compare`'s
 * lexicographic-on-unsigned-bytes ordering exactly, which the leaf-index
 * lookup and the root-equality check depend on.
 */
export class MerkleTree {
  leaves: Uint8Array[];
  layers: Uint8Array[][];

  constructor(leaves: Uint8Array[] = []) {
    if (leaves.length < 1) {
      throw new POSBridgeError('MERKLE_TREE_REQUIRES_LEAVES', 'At least 1 leaf required');
    }

    const depth = Math.ceil(Math.log(leaves.length) / Math.log(2));
    if (depth > 20) {
      throw new POSBridgeError(
        'MERKLE_TREE_DEPTH_EXCEEDED',
        'Depth must be 20 or less',
        { depth }
      );
    }

    this.leaves = leaves.concat(
      Array.from({ length: Math.pow(2, depth) - leaves.length }, () =>
        zeros(32)
      )
    );
    this.layers = [this.leaves];
    this.createHashes(this.leaves);
  }

  createHashes(nodes: Uint8Array[]): boolean {
    if (nodes.length === 1) {
      return false;
    }

    const treeLevel: Uint8Array[] = [];
    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i] as Uint8Array;
      const right = nodes[i + 1] as Uint8Array;

      const data = concatBytes(left, right);
      treeLevel.push(sha3(data));
    }

    // Carry over any final unpaired node so an odd-sized layer still
    // produces a valid parent layer (the on-chain verifier matches this
    // behaviour).
    if (nodes.length % 2 === 1) {
      treeLevel.push(nodes[nodes.length - 1] as Uint8Array);
    }

    this.layers.push(treeLevel);
    this.createHashes(treeLevel);
    return true;
  }

  getLeaves(): Uint8Array[] {
    return this.leaves;
  }

  getLayers(): Uint8Array[][] {
    return this.layers;
  }

  getRoot(): Uint8Array {
    const top = this.layers[this.layers.length - 1] as Uint8Array[];
    return top[0] as Uint8Array;
  }

  getProof(leaf: Uint8Array): Uint8Array[] {
    let index = -1;
    for (let i = 0; i < this.leaves.length; i++) {
      if (compareBytes(leaf, this.leaves[i] as Uint8Array) === 0) {
        index = i;
      }
    }

    const proof: Uint8Array[] = [];
    if (index <= this.getLeaves().length) {
      let siblingIndex: number;
      for (let i = 0; i < this.layers.length - 1; i++) {
        if (index % 2 === 0) {
          siblingIndex = index + 1;
        } else {
          siblingIndex = index - 1;
        }
        index = Math.floor(index / 2);
        const layer = this.layers[i] as Uint8Array[];
        proof.push(layer[siblingIndex] as Uint8Array);
      }
    }
    return proof;
  }

  verify(value: Uint8Array, index: number, root: Uint8Array, proof: Uint8Array[]): boolean {
    if (!Array.isArray(proof) || !value || !root) {
      return false;
    }

    let hash = value;
    let currentIndex = index;
    for (let i = 0; i < proof.length; i++) {
      const node = proof[i] as Uint8Array;
      if (currentIndex % 2 === 0) {
        hash = sha3(concatBytes(hash, node));
      } else {
        hash = sha3(concatBytes(node, hash));
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    return compareBytes(hash, root) === 0;
  }
}
