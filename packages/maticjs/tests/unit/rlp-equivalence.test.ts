/**
 * RLP encoding equivalence: `@ethereumjs/rlp` against fixtures captured
 * from the legacy `rlp@3.0.0` package it replaced.
 *
 * Every byte of an exit payload is consensus-relevant, so swapping the RLP
 * implementation is only acceptable if it produces identical bytes for
 * every input shape the SDK encodes. The cases below enumerate those
 * shapes (see the comment on each family for the call site it mirrors).
 *
 * This file first ran as a differential test with both packages installed,
 * asserting identical encode output and identical decode structure for every
 * case. The legacy package's output was captured as the literal fixtures
 * below, so the file stays a regression guard now that `rlp` is gone.
 * Short encodings are pinned as full hex; long ones as byte length plus
 * keccak-256 digest, which is just as strict without kilobytes of hex.
 * Decode is pinned through the round trip: RLP is a bijection on canonical
 * encodings, so a decode that re-encodes to the pinned bytes is the decode.
 */

import type { Input, NestedUint8Array } from '@ethereumjs/rlp';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MerklePatriciaTrie } from '@ethereumjs/mpt';
import { RLP } from '@ethereumjs/rlp';
import { describe, expect, it } from 'vitest';

import type {
  IBlockWithTransaction,
  ILog,
  ITransactionReceipt
} from '../../src/interfaces/index.js';

import { BufferUtil } from '../../src/utils/buffer-utils.js';
import { bytesToHex, concatBytes, hexToBytes } from '../../src/utils/bytes.js';
import { Keccak } from '../../src/utils/keccak.js';
import { ProofUtil } from '../../src/utils/proof_util.js';

/** Deterministic byte pattern so every fixture is reproducible. */
const seq = (length: number, mul: number, add: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i * mul + add) & 0xff);

const hex0x = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`;

/** Literal pin: full hex for short encodings, length + keccak-256 for long ones. */
const FULL_HEX_LIMIT = 96;
const fingerprint = (encoded: Uint8Array): string =>
  encoded.length <= FULL_HEX_LIMIT
    ? bytesToHex(encoded)
    : `len=${encoded.length} keccak256=${bytesToHex(Keccak.keccak256(encoded))}`;

/** Decoded RLP as nested hex strings, for structural comparison. */
type HexTree = string | HexTree[];
const hexTree = (value: Uint8Array | NestedUint8Array): HexTree =>
  value instanceof Uint8Array ? bytesToHex(value) : value.map((v) => hexTree(v));

/** Decode, assert the round trip reproduces the input bytes, return the structure. */
const decodeChecked = (encoded: Uint8Array): HexTree => {
  const decoded = RLP.decode(encoded);
  expect(bytesToHex(RLP.encode(decoded))).to.equal(bytesToHex(encoded));
  return hexTree(decoded);
};

/** Return the message `fn` throws (or a non-throw marker). */
const thrownMessage = (fn: () => unknown): string => {
  try {
    fn();
    return '<did not throw>';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

// ---------------------------------------------------------------------------
// Input families
// ---------------------------------------------------------------------------

const ADDRESS = seq(20, 7, 0x11);
const HASH_A = seq(32, 13, 0x01);
const HASH_B = seq(32, 29, 0x80);
const BLOOM = seq(256, 3, 0x00);
const BLOB_1000 = seq(1000, 1, 0x00);

/**
 * Scalars: `transactionIndex` (proof_util.ts getReceiptProof, three sites),
 * `cumulativeGasUsed` (getReceiptBytes), `headerNumber` / `blockNumber` /
 * `timestamp` / `logIndex` (pos-bridge-helpers.ts encodePayload). Bigints and
 * `null` are included because the `Input` type admits them and null appears
 * in the `raw()` of in-memory trie branch nodes. `NaN` is what the RPC parser's
 * `hexToNumber` yields for malformed hex, and numbers above 2^53 can arrive as
 * `headerNumber` from the proof API; both encoded identically under rlp@3.
 */
const SCALAR_CASES: ReadonlyArray<readonly [string, Input]> = [
  ['number 0', 0],
  ['number 1', 1],
  ['number 127', 127],
  ['number 128', 128],
  ['number 255', 255],
  ['number 256', 256],
  ['number 65535', 65535],
  ['number 2^31', 2 ** 31],
  ['number MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
  ['number NaN', Number.NaN],
  ['number 2^53 + 2', 2 ** 53 + 2],
  ['number 1e21', 1e21],
  ['bigint 0n', 0n],
  ['bigint 1n', 1n],
  ['bigint 2^64', 2n ** 64n],
  ['bigint 2^256 - 1', 2n ** 256n - 1n],
  ['null', null],
  ['undefined', undefined]
];

/**
 * Strings: every `BufferUtil.bufferToHex(...)` element of encodePayload, the
 * block proof (built locally: always even-length lowercase; from the proof
 * API: any string), and the utf-8 path taken by a non-hex string.
 */
const STRING_CASES: ReadonlyArray<readonly [string, Input]> = [
  ["hex '0x'", '0x'],
  ["hex '0x0'", '0x0'],
  ["hex '0x00'", '0x00'],
  ["hex '0x1'", '0x1'],
  ["hex '0x01'", '0x01'],
  ["hex '0x0001'", '0x0001'],
  ['hex odd length', '0xabc'],
  ['hex upper case', '0xABCDEF'],
  ['hex 20-byte address', hex0x(ADDRESS)],
  ['hex 32-byte hash', hex0x(HASH_A)],
  ['hex 256-byte bloom', hex0x(BLOOM)],
  ['hex 1000-byte blob', hex0x(BLOB_1000)],
  ['utf-8 non-hex string', 'matic-bor-receipt-'],
  ['utf-8 decimal string', '1731000000'],
  ['empty string', '']
];

/** Raw bytes: the `BufferUtil.toBuffer(...)` elements of getReceiptBytes. */
const BYTES_CASES: ReadonlyArray<readonly [string, Input]> = [
  ['bytes length 0', new Uint8Array(0)],
  ['bytes 0x00', Uint8Array.of(0x00)],
  ['bytes 0x7f', Uint8Array.of(0x7f)],
  ['bytes 0x80', Uint8Array.of(0x80)],
  ['bytes length 55', seq(55, 5, 0x40)],
  ['bytes length 56', seq(56, 5, 0x40)],
  ['bytes length 1000', BLOB_1000]
];

/** Mirrors `ProofUtil.getReceiptBytes`: [status, cumulativeGasUsed, bloom, logs]. */
const receiptTuple = (opts: {
  status: string;
  cumulativeGasUsed: number;
  logs: ReadonlyArray<{ topics: Uint8Array[]; data: Uint8Array }>;
}): Input => [
  BufferUtil.toBuffer(opts.status),
  opts.cumulativeGasUsed,
  BLOOM,
  opts.logs.map((l) => [ADDRESS, l.topics, l.data])
];

/** Mirrors `encodePayload` in pos-bridge-helpers.ts (ten elements). */
const payloadTuple = (opts: {
  headerNumber: number;
  blockProof: string;
  timestamp: number | string;
  path: Uint8Array;
  logIndex: number;
}): Input => [
  opts.headerNumber,
  opts.blockProof,
  89_890_779,
  opts.timestamp,
  hex0x(HASH_A),
  hex0x(HASH_B),
  hex0x(seq(300, 11, 0x07)),
  hex0x(seq(600, 17, 0x03)),
  hex0x(concatBytes(Uint8Array.of(0x00), opts.path)),
  opts.logIndex
];

const LIST_CASES: ReadonlyArray<readonly [string, Input]> = [
  ['empty list', []],
  ['nested empty lists', [[], [[]]]],
  ['list of null', [null, null]],
  [
    'receipt: success, three logs',
    receiptTuple({
      status: '0x1',
      cumulativeGasUsed: 0x21000,
      logs: [
        { topics: [HASH_A, HASH_B, seq(32, 3, 0)], data: seq(64, 9, 1) },
        { topics: [HASH_B], data: seq(32, 1, 5) },
        { topics: [HASH_A, HASH_A], data: new Uint8Array(0) }
      ]
    })
  ],
  [
    'receipt: failed, cumulativeGasUsed 0, empty log list',
    receiptTuple({ status: '0x', cumulativeGasUsed: 0, logs: [] })
  ],
  [
    'receipt: log with empty topics',
    receiptTuple({
      status: '0x1',
      cumulativeGasUsed: 1,
      logs: [{ topics: [], data: seq(10, 1, 0) }]
    })
  ],
  [
    'payload: empty block proof, path rlp(0), logIndex 0',
    payloadTuple({
      headerNumber: 1_063_040_000,
      blockProof: '0x',
      timestamp: 1_731_000_000,
      path: Uint8Array.of(0x80),
      logIndex: 0
    })
  ],
  [
    'payload: 12-hash block proof, path rlp(5), logIndex 1',
    payloadTuple({
      headerNumber: 1_063_040_000,
      blockProof: hex0x(seq(32 * 12, 23, 0x09)),
      timestamp: 1_731_000_000,
      path: Uint8Array.of(0x05),
      logIndex: 1
    })
  ],
  [
    'payload: path rlp(128), logIndex 300, decimal-string timestamp',
    payloadTuple({
      headerNumber: 0,
      blockProof: hex0x(HASH_A),
      timestamp: '1731000000',
      path: Uint8Array.of(0x81, 0x80),
      logIndex: 300
    })
  ]
];

const ENCODE_CASES: ReadonlyArray<readonly [string, Input]> = [
  ...SCALAR_CASES,
  ...STRING_CASES,
  ...BYTES_CASES,
  ...LIST_CASES
];

// ---------------------------------------------------------------------------
// Trie stacks: the `parentNodes` value encoded at pos-bridge-helpers.ts
// (`RLP.encode(receiptParentNodes as never)`), produced by
// `result.stack.map((s) => s.raw())` in ProofUtil.getReceiptProof.
// ---------------------------------------------------------------------------

const syntheticLog = (i: number, j: number): ILog => ({
  address: hex0x(seq(20, i + 1, j)),
  data: hex0x(seq((i + j) % 70, 3, i)),
  topics: Array.from({ length: (i + j) % 4 }, (_, k) => hex0x(seq(32, k + 1, i + j))),
  logIndex: j,
  transactionHash: hex0x(seq(32, 1, i)),
  transactionIndex: i,
  blockHash: hex0x(HASH_B),
  blockNumber: 1000
});

const syntheticReceipt = (i: number): ITransactionReceipt => ({
  transactionHash: hex0x(seq(32, 1, i)),
  transactionIndex: i,
  blockHash: hex0x(HASH_B),
  blockNumber: 1000,
  from: hex0x(ADDRESS),
  to: hex0x(ADDRESS),
  contractAddress: '',
  cumulativeGasUsed: i * 21_000,
  gasUsed: 21_000,
  status: i % 7 !== 3,
  logsBloom: hex0x(seq(256, i + 1, 0)),
  root: '',
  // Mix legacy and EIP-2718 typed receipts: they take different value paths.
  type: i % 2 === 0 ? '0x0' : '0x2',
  logs: Array.from({ length: i % 4 }, (_, j) => syntheticLog(i, j))
});

const syntheticBlock = (receipts: ITransactionReceipt[]): IBlockWithTransaction => ({
  size: 0,
  difficulty: 0,
  uncles: [],
  number: 1000,
  hash: hex0x(HASH_B),
  parentHash: hex0x(HASH_A),
  nonce: '0x0000000000000000',
  sha3Uncles: hex0x(HASH_A),
  logsBloom: hex0x(BLOOM),
  transactionsRoot: hex0x(HASH_A),
  stateRoot: hex0x(HASH_A),
  receiptsRoot: hex0x(HASH_A),
  miner: hex0x(ADDRESS),
  extraData: '0x',
  gasLimit: 30_000_000,
  gasUsed: 0,
  timestamp: 1_731_000_000,
  transactions: receipts.map((r) => ({
    transactionHash: r.transactionHash,
    nonce: 0,
    blockHash: r.blockHash,
    blockNumber: r.blockNumber,
    transactionIndex: r.transactionIndex,
    from: r.from,
    to: r.to,
    value: '0x0',
    gasPrice: '0x0',
    gas: 21_000,
    input: '0x'
  }))
});

const RECEIPTS_140 = Array.from({ length: 140 }, (_, i) => syntheticReceipt(i));

/** Stacks proved through the SDK's own getReceiptProof (receipts supplied, no RPC). */
const PROVED_INDICES = [0, 1, 5, 127, 128, 139];

const parentNodesFor = async (index: number): Promise<Input> => {
  const receipt = RECEIPTS_140[index];
  if (receipt === undefined) throw new Error(`no synthetic receipt ${index}`);
  const proof = await ProofUtil.getReceiptProof(
    receipt,
    syntheticBlock(RECEIPTS_140),
    // The client is only used when receipts are not supplied.
    {
      getTransactionReceipt: () => Promise.reject(new Error('unused')),
      getRootHash: () => Promise.reject(new Error('unused')),
      encodeParameters: () => {
        throw new Error('unused');
      }
    },
    Infinity,
    RECEIPTS_140
  );
  return proof.parentNodes as Input;
};

/**
 * Embedded (inline) child nodes: only appear when a node serialises to
 * under 32 bytes, which receipt values (>= 256-byte bloom) never do. Not
 * reachable from the SDK; kept so every `raw()` shape is covered.
 */
const embeddedStack = async (): Promise<Input> => {
  const trie = new MerklePatriciaTrie();
  await trie.put(Uint8Array.of(0x01), Uint8Array.of(0x0a));
  await trie.put(Uint8Array.of(0x02), Uint8Array.of(0x0b));
  await trie.put(Uint8Array.of(0x12), Uint8Array.of(0x0c));
  const result = await trie.findPath(Uint8Array.of(0x02), true);
  return result.stack.map((s) => s.raw());
};

// ---------------------------------------------------------------------------
// Real mainnet exit payloads (read-only fixtures)
// ---------------------------------------------------------------------------

const EXIT_FIXTURES = ['erc20-burn-1.json', 'erc721-burn-1.json', 'erc1155-burn-1.json'];

const readExitPayloadHex = (name: string): string => {
  const raw: unknown = JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'exits', name), 'utf8')
  );
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('expectedPayloadHex' in raw) ||
    typeof raw.expectedPayloadHex !== 'string'
  ) {
    throw new Error(`fixture ${name} has no expectedPayloadHex`);
  }
  return raw.expectedPayloadHex;
};

const asBytes = (value: HexTree | undefined): Uint8Array => {
  if (typeof value !== 'string') throw new Error('expected a byte string');
  return hexToBytes(value);
};
const asNumber = (value: HexTree | undefined): number => {
  const bytes = asBytes(value);
  return bytes.length === 0 ? 0 : Number(BigInt(hex0x(bytes)));
};

// ---------------------------------------------------------------------------
// Fixtures captured from rlp@3.0.0 before the swap
// ---------------------------------------------------------------------------

/** Encode fingerprints, keyed by case name. */
const EXPECTED: Readonly<Record<string, string>> = {
  'number 0': '80',
  'number 1': '01',
  'number 127': '7f',
  'number 128': '8180',
  'number 255': '81ff',
  'number 256': '820100',
  'number 65535': '82ffff',
  'number 2^31': '8480000000',
  'number MAX_SAFE_INTEGER': '871fffffffffffff',
  'number NaN': '80',
  'number 2^53 + 2': '8720000000000002',
  'number 1e21': '893635c9adc5dea00000',
  'bigint 0n': '80',
  'bigint 1n': '01',
  'bigint 2^64': '89010000000000000000',
  'bigint 2^256 - 1': 'a0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  null: '80',
  undefined: '80',
  "hex '0x'": '80',
  "hex '0x0'": '00',
  "hex '0x00'": '00',
  "hex '0x1'": '01',
  "hex '0x01'": '01',
  "hex '0x0001'": '820001',
  'hex odd length': '820abc',
  'hex upper case': '83abcdef',
  'hex 20-byte address': '9411181f262d343b424950575e656c737a81888f96',
  'hex 32-byte hash': 'a0010e1b2835424f5c697683909daab7c4d1deebf805121f2c394653606d7a8794',
  'hex 256-byte bloom':
    'len=259 keccak256=eb31c96a9fe2f567ee4503ee18ac65a630bed941995c1203495e1d95e1142d3d',
  'hex 1000-byte blob':
    'len=1003 keccak256=096af573707dca19c4c926751883786dce7147a8673efddb4cdf17b75e59c83b',
  'utf-8 non-hex string': '926d617469632d626f722d726563656970742d',
  'utf-8 decimal string': '8a31373331303030303030',
  'empty string': '80',
  'bytes length 0': '80',
  'bytes 0x00': '00',
  'bytes 0x7f': '7f',
  'bytes 0x80': '8180',
  'bytes length 55':
    'b740454a4f54595e63686d72777c81868b90959a9fa4a9aeb3b8bdc2c7ccd1d6dbe0e5eaeff4f9fe03080d12171c21262b30353a3f44494e',
  'bytes length 56':
    'b83840454a4f54595e63686d72777c81868b90959a9fa4a9aeb3b8bdc2c7ccd1d6dbe0e5eaeff4f9fe03080d12171c21262b30353a3f44494e53',
  'bytes length 1000':
    'len=1003 keccak256=096af573707dca19c4c926751883786dce7147a8673efddb4cdf17b75e59c83b',
  'empty list': 'c0',
  'nested empty lists': 'c3c0c1c0',
  'list of null': 'c28080',
  'receipt: success, three logs':
    'len=642 keccak256=c9ebd465b7fb0c38510d97a5577fa25ea1d5691d150195abbbcb8e4e6fbdf841',
  'receipt: failed, cumulativeGasUsed 0, empty log list':
    'len=265 keccak256=f3b4ff48be4f6f5cfc1c9cb5c0445b445f715bff9eb2d3649de4a9e517cffd41',
  'receipt: log with empty topics':
    'len=299 keccak256=25fd01059904ea69b1a672b6b5c55f1286d8b70cc43830468c0cb53fbb160c71',
  'payload: empty block proof, path rlp(0), logIndex 0':
    'len=995 keccak256=909423793d216a2ea8c0b18cc75f35ee0cb8ccd62dc41545bd58ecd0f87900a1',
  'payload: 12-hash block proof, path rlp(5), logIndex 1':
    'len=1381 keccak256=4b073b1452c800528c93471418da154be6cd0f55e1ecc4c8ab952dbecf15d80b',
  'payload: path rlp(128), logIndex 300, decimal-string timestamp':
    'len=1032 keccak256=bed5a2337ee79e1c8da2a838984c6328749248d37a18ddd041774f6851851078'
};

/** Trie-stack fingerprints, keyed by case name. */
const EXPECTED_STACKS: Readonly<Record<string, string>> = {
  'proof 0': 'len=666 keccak256=95b047d27e146e632e54fa7827db1a7af0105954c178cecfac9d222c40c3cbd9',
  'proof 1': 'len=1145 keccak256=b677d61ef3152c1950ea61a1b919767f2f96c4ef44f5765a5307dd8f4f765569',
  'proof 5': 'len=1151 keccak256=afd2d40e4e69b5f97629187e270f3ca786629f47ec38832e56131724d8b5613d',
  'proof 127':
    'len=1506 keccak256=d49abc4e1831e1ed6e26839d3b2567e7dfdf66e0af843fddc7a80b9b069778a1',
  'proof 128':
    'len=1108 keccak256=78d8695e308f0362d3cc7a1ad47396ca7ad365000343fc640faf15f35c4bcac6',
  'proof 139':
    'len=1389 keccak256=9be87049ff6b2e4d2ac0e58216efdbf2a039093e0c9f9af24e96f8b437aa7513',
  embedded:
    'f842e8d580c2200ac2200b8080808080808080808080808080c2320c808080808080808080808080808080d580c2200ac2200b8080808080808080808080808080c2200b'
};

/** Error messages both implementations raised on malformed RLP (identical text). */
const filler = (n: number): number[] => new Array<number>(n).fill(0x41);
const MALFORMED_CASES: ReadonlyArray<readonly [string, Uint8Array, string]> = [
  [
    'extra zeros in a long string length',
    Uint8Array.from([0xb9, 0x00, 0x38, ...filler(56)]),
    'invalid RLP: extra zeros'
  ],
  [
    'long string length byte missing',
    Uint8Array.from([0xb8]),
    'invalid RLP: not enough bytes for string length'
  ],
  [
    'long form used for a short string',
    Uint8Array.from([0xb8, 0x37, ...filler(55)]),
    'invalid RLP: expected string length to be greater than 55'
  ],
  [
    'truncated string',
    Uint8Array.from([0x83, 0x01]),
    'invalid RLP (safeSlice): end slice of Uint8Array out-of-bounds'
  ],
  [
    'truncated list',
    Uint8Array.from([0xc2, 0x01]),
    'invalid RLP (safeSlice): end slice of Uint8Array out-of-bounds'
  ],
  [
    'long form used for a short list',
    Uint8Array.from([0xf8, 0x37, ...filler(55)]),
    'invalid RLP: encoded list too short'
  ],
  [
    'list length larger than the data',
    Uint8Array.from([0xf8, 0x38, 0x01]),
    'invalid RLP: total length is larger than the data'
  ],
  ['trailing bytes', Uint8Array.from([0x01, 0x02]), 'invalid RLP: remainder must be zero'],
  [
    'single byte below 0x80 with a prefix',
    Uint8Array.from([0x81, 0x01]),
    'invalid RLP encoding: invalid prefix, single byte < 0x80 are not prefixed'
  ]
];

describe('RLP encoding equivalence', () => {
  describe('encode: equal to the fixture captured from rlp@3', () => {
    it.each(ENCODE_CASES)('%s', (name, input) => {
      expect(fingerprint(RLP.encode(input))).to.equal(EXPECTED[name]);
    });
  });

  describe('decode: round trip reproduces the fixture bytes', () => {
    it.each(ENCODE_CASES)('%s', (_name, input) => {
      decodeChecked(RLP.encode(input));
    });
  });

  describe('trie stacks from getReceiptProof', () => {
    it.each(PROVED_INDICES)('parentNodes for transactionIndex %i', async (index) => {
      const encoded = RLP.encode(await parentNodesFor(index));
      expect(fingerprint(encoded)).to.equal(EXPECTED_STACKS[`proof ${index}`]);
      decodeChecked(encoded);
    });

    it('legacy receipt leaf value decodes to the four receipt fields (proof_util.ts getPrfValue)', () => {
      // Only legacy (untyped) receipts are decoded by the SDK.
      const receipt = RECEIPTS_140[4];
      if (receipt === undefined) throw new Error('missing receipt');
      expect(ProofUtil.isTypedReceipt(receipt)).to.equal(false);
      const leaf = ProofUtil.getReceiptBytes(receipt);
      const tree = decodeChecked(leaf);
      expect(tree).to.have.length(4);
    });

    it('embedded child nodes (not reachable from the SDK; shape coverage)', async () => {
      const encoded = RLP.encode(await embeddedStack());
      expect(fingerprint(encoded)).to.equal(EXPECTED_STACKS['embedded']);
      decodeChecked(encoded);
    });
  });

  describe('real mainnet exit payloads', () => {
    it.each(EXIT_FIXTURES)('%s re-encodes byte-for-byte from SDK-shaped inputs', (name) => {
      const payloadHex = readExitPayloadHex(name);
      const tree = decodeChecked(hexToBytes(payloadHex.slice(2)));
      if (!Array.isArray(tree) || tree.length !== 10) throw new Error('not a 10-element payload');
      const parentNodesTree = decodeChecked(asBytes(tree[7]));
      expect(Array.isArray(parentNodesTree)).to.equal(true);

      // Rebuild exactly what encodePayload passes: numbers for the integer
      // fields, `0x` hex strings for the byte fields, and the parent nodes as
      // nested Uint8Arrays encoded in a nested call.
      const toNested = (t: HexTree): Input =>
        typeof t === 'string' ? hexToBytes(t) : t.map((c) => toNested(c));
      const rebuilt = RLP.encode([
        asNumber(tree[0]),
        hex0x(asBytes(tree[1])),
        asNumber(tree[2]),
        asNumber(tree[3]),
        hex0x(asBytes(tree[4])),
        hex0x(asBytes(tree[5])),
        hex0x(asBytes(tree[6])),
        hex0x(RLP.encode(toNested(parentNodesTree))),
        hex0x(asBytes(tree[8])),
        asNumber(tree[9])
      ]);
      expect(hex0x(rebuilt)).to.equal(payloadHex);
    });
  });

  describe('malformed input: rejected with the same message rlp@3 raised', () => {
    it.each(MALFORMED_CASES)('%s', (_name, bytes, message) => {
      expect(thrownMessage(() => RLP.decode(bytes))).to.equal(message);
    });
  });

  // A negative headerNumber (possible only from a malformed proof-API
  // response) was rejected by rlp@3 with this exact message.
  it('encode(-1) throws the same message rlp@3 raised', () => {
    expect(thrownMessage(() => RLP.encode(-1))).to.equal(
      'Invalid integer as argument, must be unsigned!'
    );
  });

  /*
   * Inputs on which the two implementations disagreed in the differential
   * run. None changes a byte the SDK produces from well-formed data; each
   * case records the legacy behaviour and why it does not matter.
   */
  describe('known divergences', () => {
    // proof_util.ts decodes only a trie leaf value, which is always a
    // Uint8Array. A falsy non-array input never reaches `decode`.
    it('decode(0) and decode(0n) throw (legacy returned empty bytes; SDK never calls this)', () => {
      for (const value of [0, 0n]) {
        expect(thrownMessage(() => RLP.decode(value))).to.equal('Invalid byte sequence');
      }
    });

    // The only string the SDK encodes that it did not produce itself with
    // `bufferToHex` is the block proof returned by the optional proof API
    // (encodePayload, second element). These are malformed values that a
    // well-behaved API never returns: the legacy parser silently accepted
    // some of them (parseInt reads a valid prefix), the new one rejects them.
    it.each([
      ['0x1g', '01', 'hex string expected, got non-hex character "1g" at index 0'],
      ['0x-1', '81ff', 'hex string expected, got non-hex character "-1" at index 0'],
      ['0x 1', '01', 'hex string expected, got non-hex character " 1" at index 0'],
      ['0x+1', '01', 'hex string expected, got non-hex character "+1" at index 0'],
      ['0x12 ', '820102', 'hex string expected, got non-hex character "2 " at index 2']
    ])('encode(%j) throws (legacy silently yielded %s)', (input, _legacyHex, newMessage) => {
      expect(thrownMessage(() => RLP.encode(input))).to.equal(newMessage);
    });

    // A doubled prefix is the reverse case: rlp@3 threw 'Invalid byte
    // sequence' on both of these; the new parser strips both prefixes.
    it("encode('0x0x12') strips the prefix twice and yields 12 (legacy threw)", () => {
      expect(bytesToHex(RLP.encode('0x0x12'))).to.equal('12');
    });

    it("encode('0x0x') strips the prefix twice and yields 80 (legacy threw)", () => {
      expect(bytesToHex(RLP.encode('0x0x'))).to.equal('80');
    });
  });
});
