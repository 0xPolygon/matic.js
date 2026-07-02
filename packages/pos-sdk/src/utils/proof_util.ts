import { BlockHeader } from '@ethereumjs/block';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Trie as TRIE } from '@ethereumjs/trie';
import { setLengthLeft } from '@ethereumjs/util';
import rlp from 'rlp';

import type { ITransactionReceipt, IBlockWithTransaction } from '../interfaces/index.js';

import { POSBridgeError } from '../errors.js';
import { withConcurrency } from '../internal/concurrency.js';
import { BufferUtil } from './buffer-utils.js';
import { concatBytes, utf8ToBytes } from './bytes.js';
import { Keccak } from './keccak.js';
import { MerkleTree } from './merkle_tree.js';

// Implementation adapted from Tom French's `matic-proofs` library used under MIT License
// https://github.com/TomAFrench/matic-proofs

/**
 * Minimal child-chain client surface used by the proof builders.
 *
 * Stage 2 narrows what `ProofUtil` requires from the matic (child)
 * client: just receipt fetching, the bor `getRootHash` RPC, and ABI
 * `encodeParameters`. Earlier versions accepted the entire legacy
 * `BaseWeb3Client` abstract class — most of whose surface was unused
 * by proof generation. The interface lives here (rather than in
 * `internal/`) so the only consumers — `ProofUtil` and the bridge
 * helpers — pick it up via a single import.
 */
export interface ProofChildClient {
  getTransactionReceipt(hash: string): Promise<ITransactionReceipt>;
  /**
   * Calls the bor-specific `bor_getRootHash` RPC (or its `eth_getRootHash`
   * alias) for the given block range. Returns the hash without 0x prefix
   * to match the legacy contract.
   */
  getRootHash(startBlock: number, endBlock: number): Promise<string>;
  /**
   * ABI-encode `params` against `types`. Matches web3's `encodeParameters`
   * signature; ethers v5/v6 wrappers map to `defaultAbiCoder.encode`.
   */
  encodeParameters(params: readonly unknown[], types: readonly string[]): string;
}

/**
 * Static suite of pure RLP / MPT proof helpers plus the small handful
 * of RPC-driven helpers that need a `ProofChildClient` injected.
 *
 * Stays a class with `static` methods (rather than free functions) for
 * source compatibility with the published 0.x surface — the captured
 * fixture tests under `tests/` import `ProofUtil` directly.
 */
export class ProofUtil {
  static async getFastMerkleProof(
    client: ProofChildClient,
    blockNumber: number,
    startBlock: number,
    endBlock: number
  ): Promise<string[]> {
    const merkleTreeDepth = Math.ceil(Math.log2(endBlock - startBlock + 1));

    // Generate the proof root-down, since the on-chain verifier consumes
    // it leaf-up. We `reverse()` once at the end.
    const reversedProof: string[] = [];

    const offset = startBlock;
    const targetIndex = blockNumber - offset;
    let leftBound = 0;
    let rightBound = endBlock - offset;
    for (let depth = 0; depth < merkleTreeDepth; depth += 1) {
      const nLeaves = 2 ** (merkleTreeDepth - depth);

      // The pivot leaf is the last leaf which is included in the left subtree
      const pivotLeaf = leftBound + nLeaves / 2 - 1;

      if (targetIndex > pivotLeaf) {
        // Get the root hash to the merkle subtree to the left
        const newLeftBound = pivotLeaf + 1;

        const subTreeMerkleRoot = await this.queryRootHash(
          client,
          offset + leftBound,
          offset + pivotLeaf
        );
        if (subTreeMerkleRoot === null) {
          throw new POSBridgeError(
            'ROOT_HASH_RPC_FAILED',
            `getRootHash returned null for [${offset + leftBound}, ${offset + pivotLeaf}]`,
            { startBlock: offset + leftBound, endBlock: offset + pivotLeaf }
          );
        }
        reversedProof.push(BufferUtil.bufferToHex(subTreeMerkleRoot));
        leftBound = newLeftBound;
      } else {
        // Things are more complex when querying to the right.
        // Root hash may come some layers down so we need to build a full tree by padding with zeros
        // Some trees may be completely empty

        const newRightBound = Math.min(rightBound, pivotLeaf);

        // Expect the merkle tree to have a height one less than the current layer
        const expectedHeight = merkleTreeDepth - (depth + 1);
        if (rightBound <= pivotLeaf) {
          // Tree is empty so we repeatedly hash zero to correct height
          const subTreeMerkleRoot = this.recursiveZeroHash(expectedHeight, client);
          reversedProof.push(subTreeMerkleRoot);
        } else {
          // Height of tree given by RPC node
          const subTreeHeight = Math.ceil(Math.log2(rightBound - pivotLeaf));

          // Find the difference in height between this and the subtree we want
          const heightDifference = expectedHeight - subTreeHeight;

          // For every extra layer we need to fill 2*n leaves filled with the merkle root of a zero-filled Merkle tree
          // We need to build a tree which has heightDifference layers

          // The first leaf will hold the root hash as returned by the RPC
          const remainingNodesHash = await this.queryRootHash(
            client,
            offset + pivotLeaf + 1,
            offset + rightBound
          );
          if (remainingNodesHash === null) {
            throw new POSBridgeError(
              'ROOT_HASH_RPC_FAILED',
              `getRootHash returned null for [${offset + pivotLeaf + 1}, ${offset + rightBound}]`,
              { startBlock: offset + pivotLeaf + 1, endBlock: offset + rightBound }
            );
          }

          // The remaining leaves will hold the merkle root of a zero-filled tree of height subTreeHeight
          const leafRoots = this.recursiveZeroHash(subTreeHeight, client);

          // Build a merkle tree of correct size for the subtree using these merkle roots
          const leaves = Array.from({ length: 2 ** heightDifference }, () =>
            BufferUtil.toBuffer(leafRoots)
          );
          leaves[0] = remainingNodesHash;
          const subTreeMerkleRoot = new MerkleTree(leaves).getRoot();
          reversedProof.push(BufferUtil.bufferToHex(subTreeMerkleRoot));
        }
        rightBound = newRightBound;
      }
    }

    return reversedProof.reverse();
  }

  static async buildBlockProof(
    client: ProofChildClient,
    startBlock: number,
    endBlock: number,
    blockNumber: number
  ): Promise<string> {
    const proof = await ProofUtil.getFastMerkleProof(client, blockNumber, startBlock, endBlock);
    return BufferUtil.bufferToHex(
      concatBytes(...proof.map((p) => BufferUtil.toBuffer(p)))
    );
  }

  /**
   * Returns the root hash as a `Uint8Array`, or `null` if the RPC call failed.
   *
   * Why catch and return `null`: the caller (`getFastMerkleProof`) has
   * specific recovery paths — empty subtrees use a synthetic zero-hash
   * tree instead of failing the whole proof. Bubbling the RPC error
   * here would prevent that recovery. Callers that genuinely need the
   * value (not the empty-tree case) check for `null` and throw
   * `POSBridgeError('ROOT_HASH_RPC_FAILED', …)` themselves.
   */
  static async queryRootHash(
    client: ProofChildClient,
    startBlock: number,
    endBlock: number
  ): Promise<Uint8Array | null> {
    try {
      const rootHash = await client.getRootHash(startBlock, endBlock);
      return BufferUtil.toBuffer(`0x${rootHash}`);
    } catch {
      // Recovery is the caller's responsibility — see jsdoc.
      return null;
    }
  }

  static recursiveZeroHash(n: number, client: ProofChildClient): string {
    if (n === 0) return '0x0000000000000000000000000000000000000000000000000000000000000000';
    const subHash = this.recursiveZeroHash(n - 1, client);
    return BufferUtil.bufferToHex(
      Keccak.keccak256(
        BufferUtil.toBuffer(client.encodeParameters([subHash, subHash], ['bytes32', 'bytes32']))
      )
    );
  }

  /**
   * Build a receipt-trie proof for `receipt` against `block`.
   *
   * The proof is generated by inserting every receipt in the block into
   * a Patricia trie keyed by `rlp(transactionIndex)`, then walking the
   * trie to the receipt's leaf. The walked path becomes the proof.
   *
   * # Concurrency control
   *
   * Each receipt requires a separate `getTransactionReceipt` RPC. On
   * Polygon mainnet a busy block can contain 280+ transactions; firing
   * all 280 RPC calls at once trips rate limits and exhausts the
   * keep-alive pool. `proofConcurrency` caps in-flight calls.
   *
   * # Transient-error retry
   *
   * Node 19+ enables keep-alive on the global HTTPS agent by default;
   * stale sockets surface as `ECONNRESET`. The retry loop wraps every
   * receipt fetch in a 2-attempt budget with full-jitter exponential
   * backoff so a single stale connection does not fail the whole proof.
   */
  static async getReceiptProof(
    receipt: ITransactionReceipt,
    block: IBlockWithTransaction,
    client: ProofChildClient,
    proofConcurrency = Infinity,
    receiptsVal?: ITransactionReceipt[]
  ): Promise<{
    blockHash: Uint8Array;
    parentNodes: unknown;
    root: Uint8Array;
    path: Uint8Array;
    value: unknown;
  }> {
    const stateSyncTxHash = BufferUtil.bufferToHex(ProofUtil.getStateSyncTxHash(block));
    const receiptsTrie = new TRIE();

    let receipts: ITransactionReceipt[];
    if (!receiptsVal) {
      // Collect the tx hashes lazily so `withConcurrency` can throttle
      // the actual HTTP requests; eager construction would defeat the
      // limiter (see `tests/map-promise.test.ts` for the regression).
      const txHashes: string[] = [];
      for (const tx of block.transactions) {
        if (tx.transactionHash === stateSyncTxHash) {
          // Bor's state-sync receipt is not part of the receipts trie;
          // including it would mismatch the on-chain receiptsRoot.
          continue;
        }
        txHashes.push(tx.transactionHash);
      }

      receipts = await withConcurrency(
        Number.isFinite(proofConcurrency) ? proofConcurrency : txHashes.length,
        txHashes,
        (hash) => fetchReceiptWithRetry(client, hash)
      );
    } else {
      receipts = receiptsVal;
    }

    await Promise.all(
      receipts.map((siblingReceipt) => {
        const path = rlp.encode(siblingReceipt.transactionIndex);
        const rawReceipt = ProofUtil.getReceiptBytes(siblingReceipt);
        return receiptsTrie.put(path, rawReceipt);
      })
    );

    const result = await receiptsTrie.findPath(rlp.encode(receipt.transactionIndex), true);
    if (result.remaining.length > 0) {
      throw new POSBridgeError(
        'PROOF_NODE_KEY_MISMATCH',
        'Node does not contain the key',
        { transactionIndex: receipt.transactionIndex }
      );
    }

    const node = result.node;
    if (node === null) {
      throw new POSBridgeError(
        'PROOF_NODE_KEY_MISMATCH',
        'No leaf node found at the receipt path',
        { transactionIndex: receipt.transactionIndex }
      );
    }

    // `LeafNode.value()` returns the trie-stored bytes. The legacy SDK
    // dereferenced the property *without* calling it (a bug — it
    // accidentally captured the function reference and stringified it),
    // then tried RLP-decoding that string and silently fell back to the
    // intended call in a `catch`. The rewrite calls `.value()` directly.
    const leafValue = (node as { value(): Uint8Array }).value();
    const getPrfValue = (rec: ITransactionReceipt): unknown => {
      // Typed (EIP-2718) receipts are stored as opaque bytes — return
      // the raw value. Legacy receipts are RLP-encoded into the trie
      // value, so decode once for the on-chain verifier's path.
      if (ProofUtil.isTypedReceipt(rec)) {
        return leafValue;
      }
      return rlp.decode(leafValue);
    };
    return {
      blockHash: BufferUtil.toBuffer(receipt.blockHash),
      parentNodes: result.stack.map((s) => s.raw()),
      root: ProofUtil.getRawHeader(block).receiptTrie,
      path: rlp.encode(receipt.transactionIndex),
      value: getPrfValue(receipt)
    };
  }

  static isTypedReceipt(receipt: ITransactionReceipt): boolean {
    const hexType = toHex(receipt.type);
    return receipt.status != null && hexType !== '0x0' && hexType !== '0x';
  }

  // getStateSyncTxHash returns block's tx hash for state-sync receipt
  // Bor blockchain includes extra receipt/tx for state-sync logs,
  // but it is not included in transactionRoot or receiptRoot.
  // So, while calculating proof, we have to exclude them.
  //
  // This is derived from block's hash and number
  // state-sync tx hash = keccak256("matic-bor-receipt-" + block.number + block.hash)
  static getStateSyncTxHash(block: { number: number | string; hash: string }): Uint8Array {
    return Keccak.keccak256(
      concatBytes(
        // prefix for bor receipt
        utf8ToBytes('matic-bor-receipt-'),
        setLengthLeft(BufferUtil.toBuffer(block.number), 8), // 8 bytes of block number (BigEndian)
        BufferUtil.toBuffer(block.hash) // block hash
      )
    );
  }

  static getReceiptBytes(receipt: ITransactionReceipt): Uint8Array {
    let encodedData = rlp.encode([
      BufferUtil.toBuffer(
        receipt.status !== undefined && receipt.status != null
          ? receipt.status
            ? '0x1'
            : '0x'
          : receipt.root
      ),
      // Pass the integer directly to rlp so 0 encodes as the canonical empty byte
      // string (0x80). Pre-converting via BufferUtil.toBuffer(0) yields <Buffer 00>,
      // which RLP-encodes to 0x00 — non-canonical. Bor uses the canonical form when
      // committing receiptsRoot, so the wrong encoding produces a leaf hash that
      // never matches the root for blocks where cumulativeGasUsed = 0 (Bor system-tx-
      // only blocks), and on-chain MPT verifiers revert.
      receipt.cumulativeGasUsed,
      BufferUtil.toBuffer(receipt.logsBloom),
      // encoded log array
      (receipt.logs ?? []).map((l) => {
        // [address, [topics array], data]
        return [
          BufferUtil.toBuffer(l.address),
          l.topics.map(BufferUtil.toBuffer),
          BufferUtil.toBuffer(l.data)
        ];
      })
    ]);
    if (ProofUtil.isTypedReceipt(receipt)) {
      encodedData = concatBytes(
        BufferUtil.toBuffer(receipt.type),
        encodedData
      );
    }
    return encodedData;
  }

  static getRawHeader(_block: IBlockWithTransaction): BlockHeader {
    const headerData = { ..._block, difficulty: toHex(_block.difficulty) };
    const common = new Common({
      chain: Chain.Mainnet,
      hardfork: Hardfork.London
    });
    return BlockHeader.fromHeaderData(headerData, {
      common: common,
      skipConsensusFormatValidation: true
    });
  }
}

/**
 * Coerce a hex / number / bigint to a `0x`-prefixed hex string. Local
 * helper because the legacy SDK threaded this through a `Converter.toHex`
 * that depended on BN.js — Stage 2 retired BN.js so the helper is inlined
 * here against the small set of input types `proof_util` actually sees.
 */
function toHex(value: number | string | bigint | undefined | null): string {
  if (value === undefined || value === null) return '0x';
  if (typeof value === 'string') {
    return value.startsWith('0x') ? value : `0x${BigInt(value).toString(16)}`;
  }
  if (typeof value === 'bigint') return `0x${value.toString(16)}`;
  return `0x${value.toString(16)}`;
}

/**
 * Wraps `getTransactionReceipt` with up to 2 retries on transient
 * network errors. See `ProofUtil.getReceiptProof` jsdoc for the full
 * rationale.
 */
async function fetchReceiptWithRetry(
  client: ProofChildClient,
  hash: string,
  remaining = 2
): Promise<ITransactionReceipt> {
  try {
    return await client.getTransactionReceipt(hash);
  } catch (err: unknown) {
    const e = err as { code?: string; errno?: string };
    const isTransient =
      e.code === 'ECONNRESET' ||
      e.code === 'ENOTFOUND' ||
      e.code === 'ECONNREFUSED' ||
      e.code === 'ETIMEDOUT' ||
      e.errno === 'ECONNRESET' ||
      e.errno === 'ENOTFOUND';
    if (remaining > 0 && isTransient) {
      const i = 2 - remaining;
      const delayMs = Math.random() * Math.min(250, 50 * Math.pow(2, i));
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return fetchReceiptWithRetry(client, hash, remaining - 1);
    }
    throw err;
  }
}
