/**
 * Unit tests for ProofUtil.getReceiptBytes RLP encoding.
 *
 * Bug — non-canonical encoding of cumulativeGasUsed = 0
 *   getReceiptBytes used to wrap every receipt field in BufferUtil.toBuffer
 *   before passing to rlp.encode. For an integer field whose value is 0,
 *   BufferUtil.toBuffer(0) returns <Buffer 00>, which RLP-encodes to the
 *   single byte 0x00 (per spec: bytes < 0x80 encode as themselves). The
 *   canonical RLP encoding of integer 0 is the empty byte string 0x80.
 *
 *   Bor (go-ethereum) writes receiptsRoot using the canonical encoding, so
 *   the leaf hash produced from the buggy encoding never matches the trie
 *   root for blocks where cumulativeGasUsed = 0 — i.e. Bor system-tx-only
 *   blocks. On-chain MPT verifiers (Plasma ERC20PredicateBurnOnly, Portal
 *   MerklePatriciaProof.verify) revert with INVALID_RECEIPT_MERKLE_PROOF.
 *
 *   The fix is to pass the integer directly to rlp.encode (which canonically
 *   encodes 0 → 0x80) instead of pre-converting via BufferUtil.toBuffer.
 *
 * Tests are organised in three layers:
 *   - synthetic legacy receipts (untyped, type='0x0') for fast iteration;
 *   - synthetic typed receipts (type='0x7f', the production repro shape);
 *   - the real Amoy block 37337056 burn-tx receipt as a captured fixture,
 *     verifying the full encoding pipeline against the on-chain receiptsRoot.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Trie } from '@ethereumjs/trie';
import { bytesToHex } from 'ethereum-cryptography/utils';
import rlp from 'rlp';
import { describe, expect, it } from 'vitest';

import type { ITransactionReceipt } from '../src/interfaces/index.js';

import { ProofUtil } from '../src/utils/proof_util.js';

const HEX_BLOOM_256 = '0x' + '00'.repeat(256);

const baseReceipt = (
  overrides: Partial<ITransactionReceipt> = {}
): ITransactionReceipt => ({
  transactionHash: '0x' + '00'.repeat(32),
  transactionIndex: 0,
  blockHash: '0x' + '00'.repeat(32),
  blockNumber: 0,
  from: '0x' + '00'.repeat(20),
  to: '0x' + '00'.repeat(20),
  contractAddress: '0x' + '00'.repeat(20),
  cumulativeGasUsed: 0,
  gasUsed: 0,
  status: true,
  logsBloom: HEX_BLOOM_256,
  root: '',
  type: '0x0',
  logs: [],
  ...overrides
});

/** Decode the encoded receipt body, transparently skipping any EIP-2718 type prefix. */
function decodeReceiptBody(bytes: Uint8Array): unknown[] {
  // Typed receipts: a leading byte < 0xc0 is the EIP-2718 type prefix; the
  // RLP list starts at byte 1. Legacy receipts begin with the RLP list header
  // (0xc0..0xff).
  const first = bytes[0]!;
  const body = first >= 0xc0 ? bytes : bytes.subarray(1);
  return rlp.decode(body) as unknown as unknown[];
}

describe('ProofUtil.getReceiptBytes — legacy receipts (status field via string trick)', () => {
  it('encodes cumulativeGasUsed = 0 as the empty byte string (0x80), not 0x00', () => {
    const bytes = ProofUtil.getReceiptBytes(baseReceipt({ cumulativeGasUsed: 0 }));
    const decoded = decodeReceiptBody(bytes);
    expect(decoded).to.have.length(4);
    const cumulativeGasUsedBytes = decoded[1] as Uint8Array;
    expect(
      cumulativeGasUsedBytes.length,
      'cumulativeGasUsed must decode to empty bytes (canonical 0)'
    ).to.equal(0);
  });

  it('encodes a non-zero cumulativeGasUsed without leading zero bytes', () => {
    const bytes = ProofUtil.getReceiptBytes(baseReceipt({ cumulativeGasUsed: 0x21000 }));
    const decoded = decodeReceiptBody(bytes);
    const cumulativeGasUsedBytes = decoded[1] as Uint8Array;
    expect(bytesToHex(cumulativeGasUsedBytes)).to.equal('021000');
  });

  it('produces a valid RLP receipt that round-trips via decode/encode unchanged', () => {
    const receipt = baseReceipt({ cumulativeGasUsed: 0 });
    const bytes = ProofUtil.getReceiptBytes(receipt);
    const decoded = rlp.decode(bytes);
    const reEncoded = rlp.encode(decoded);
    expect(bytesToHex(bytes)).to.equal(bytesToHex(reEncoded));
  });

  it('still encodes status=false canonically as 0x80 (regression guard for the string trick)', () => {
    // The status field uses '0x1'/'0x' string sentinels so that status=false
    // becomes an empty buffer → canonical 0x80. Combined with cumulativeGasUsed=0
    // both zero-valued integer fields must encode identically as the empty byte
    // string. A future refactor that changes either field should fail here.
    const bytes = ProofUtil.getReceiptBytes(
      baseReceipt({ status: false, cumulativeGasUsed: 0 })
    );
    const decoded = decodeReceiptBody(bytes);
    expect((decoded[0] as Uint8Array).length, 'status canonical 0').to.equal(0);
    expect((decoded[1] as Uint8Array).length, 'cumulativeGasUsed canonical 0').to.equal(0);
  });

  it('encodes a non-empty logs array correctly (regression guard for adjacent encoding)', () => {
    const log = {
      address: '0x' + '11'.repeat(20),
      topics: ['0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32)],
      data: '0x' + 'cc'.repeat(64),
      logIndex: 0,
      transactionHash: '0x' + '00'.repeat(32),
      transactionIndex: 0,
      blockHash: '0x' + '00'.repeat(32),
      blockNumber: 0
    };
    const bytes = ProofUtil.getReceiptBytes(
      baseReceipt({ cumulativeGasUsed: 0, logs: [log] })
    );
    const decoded = decodeReceiptBody(bytes) as [Uint8Array, Uint8Array, Uint8Array, unknown[]];
    expect(decoded[3], 'logs array preserved').to.have.length(1);
    const [encodedLog] = decoded[3] as Array<[Uint8Array, Uint8Array[], Uint8Array]>;
    expect(bytesToHex(encodedLog![0]), 'log address').to.equal('11'.repeat(20));
    expect(encodedLog![1], 'log topics').to.have.length(2);
    expect(bytesToHex(encodedLog![2]), 'log data').to.equal('cc'.repeat(64));
  });
});

describe('ProofUtil.getReceiptBytes — typed receipts (EIP-2718)', () => {
  it('encodes a type=0x7f receipt with cumulativeGasUsed=0 with the canonical body (production repro shape)', () => {
    // Block 37337056 on Amoy has a single tx of type=0x7f (Bor state-sync)
    // with status=1 and cumulativeGasUsed=0 — the exact shape that triggered
    // the production failure. The user's bug report observed the encoded
    // bytes start with `7ff90734 01 80 b9...` (canonical good) versus
    // `7ff90734 01 00 b9...` (current, buggy). We assert here that the new
    // encoding matches the canonical good prefix structurally.
    const bytes = ProofUtil.getReceiptBytes(
      baseReceipt({ type: '0x7f', cumulativeGasUsed: 0 })
    );
    expect(bytes[0], 'EIP-2718 type prefix preserved').to.equal(0x7f);
    const decoded = decodeReceiptBody(bytes);
    expect(decoded).to.have.length(4);
    expect((decoded[0] as Uint8Array)[0], 'status=true encoded as 0x01').to.equal(0x01);
    expect((decoded[1] as Uint8Array).length, 'cumulativeGasUsed=0 canonical').to.equal(0);
  });

  it('encodes a type=0x2 (EIP-1559) receipt with cumulativeGasUsed=0 canonically', () => {
    const bytes = ProofUtil.getReceiptBytes(
      baseReceipt({ type: '0x2', cumulativeGasUsed: 0 })
    );
    expect(bytes[0], 'type=0x02 prefix').to.equal(0x02);
    const decoded = decodeReceiptBody(bytes);
    expect((decoded[1] as Uint8Array).length, 'cumulativeGasUsed=0 canonical').to.equal(0);
  });
});

describe('ProofUtil.getReceiptBytes — Amoy block 37337056 (real on-chain fixture)', () => {
  // Block 37337056 on Amoy contains a single transaction (a type=0x7f Bor
  // state-sync receipt with cumulativeGasUsed = 0). The fixture is the live
  // RPC response captured once; the test runs offline against it. With the
  // fix, the encoded receipt's keccak hash, placed in a single-leaf Patricia
  // trie keyed by rlp(0), must match the on-chain `block.receiptsRoot`.
  // Without the fix, the cumulativeGasUsed=0 byte is non-canonical and the
  // resulting trie root mismatches.
  const fixture = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'amoy-block-37337056-receipt.json'), 'utf8')
  );
  const RECEIPTS_ROOT_HEX =
    'b25e9efe7b0a26e11f8927e2c85f57e62e195136270225c7d1f4a129bf3f475c';

  // The Amoy RPC returns hex-encoded numeric fields; coerce to the shape
  // ITransactionReceipt expects (cumulativeGasUsed: number, status: boolean).
  const receipt: ITransactionReceipt = {
    ...fixture,
    cumulativeGasUsed: parseInt(fixture.cumulativeGasUsed, 16),
    status: fixture.status === '0x1',
    transactionIndex: parseInt(fixture.transactionIndex, 16),
    blockNumber: parseInt(fixture.blockNumber, 16),
    gasUsed: parseInt(fixture.gasUsed, 16),
    type: fixture.type,
    logs: fixture.logs.map((l: { logIndex: string; transactionIndex: string; blockNumber: string; [k: string]: unknown }) => ({
      ...l,
      logIndex: parseInt(l.logIndex, 16),
      transactionIndex: parseInt(l.transactionIndex, 16),
      blockNumber: parseInt(l.blockNumber, 16)
    }))
  };

  it('the captured fixture preserves the production-failure shape (sanity check)', () => {
    expect(receipt.type).to.equal('0x7f');
    expect(receipt.status).to.equal(true);
    expect(receipt.cumulativeGasUsed).to.equal(0);
    expect(receipt.logs!).to.have.length(7);
  });

  it('encodes the receipt with canonical cumulativeGasUsed and produces a valid 7-log structure', () => {
    const bytes = ProofUtil.getReceiptBytes(receipt);
    expect(bytes[0], 'EIP-2718 type prefix 0x7f').to.equal(0x7f);
    const decoded = decodeReceiptBody(bytes);
    expect(decoded).to.have.length(4);
    expect((decoded[1] as Uint8Array).length, 'cumulativeGasUsed canonical 0').to.equal(0);
    expect((decoded[2] as Uint8Array).length, 'logsBloom 256 bytes').to.equal(256);
    expect(decoded[3], 'logs array preserved').to.have.length(7);
  });

  it("matches the on-chain receiptsRoot (single-leaf trie keyed by rlp(transactionIndex))", async () => {
    // For a 1-tx block, the Patricia trie has one leaf: key = rlp(0) = 0x80,
    // value = the encoded receipt. The trie root must equal block.receiptsRoot
    // captured at fixture-creation time. This is the strongest possible
    // verification of the encoding — any non-canonical byte anywhere in the
    // receipt produces a different keccak and a root mismatch.
    const bytes = ProofUtil.getReceiptBytes(receipt);
    const trie = new Trie();
    await trie.put(rlp.encode(receipt.transactionIndex), bytes);
    const rootHex = bytesToHex(trie.root());
    expect(rootHex).to.equal(RECEIPTS_ROOT_HEX);
  });
});
