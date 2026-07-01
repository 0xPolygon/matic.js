/**
 * Adapter-backed implementation of {@link BridgeChildClient}.
 *
 * # What this replaces
 *
 * The legacy SDK threaded `BaseWeb3Client` (an abstract class with
 * library-specific subclasses for ethers and web3) into `ExitUtil` and
 * the proof builders. Stage 2 narrowed the consumed surface to
 * `BridgeChildClient` — six methods — and Stage 3 supplies a single
 * library-agnostic implementation built on `Adapter.request` and
 * `Adapter.keccak256`.
 *
 * # Why one implementation, not three
 *
 * The bridge flows talk to the matic (child) chain via plain
 * JSON-RPC: `eth_getTransactionByHash`, `eth_getTransactionReceipt`,
 * `eth_getBlockByNumber`, plus the bor-specific `bor_getRootHash`.
 * Every adapter library exposes a raw RPC primitive (viem's `request`,
 * ethers v5/v6's `send`); routing through `Adapter.request` lets us
 * write the parsing once and avoid three near-identical translation
 * layers. The two helpers that aren't simple RPC calls —
 * `encodeParameters` (specific bytes32×bytes32 case) and `soliditySha3`
 * (Solidity-packed keccak) — are implemented inline here from
 * primitives, with no dependency on the consumer's library.
 *
 * # Receipt shape
 *
 * The bridge's proof builders need the legacy {@link ITransactionReceipt}
 * shape, which carries fields the slim `Adapter.Receipt` strips
 * (`cumulativeGasUsed`, `transactionIndex`, `logsBloom`, `type`). We
 * fetch the raw RPC response and parse it ourselves rather than
 * widening `Receipt` — the bridge is the only consumer of these extra
 * fields and they would otherwise leak into every adapter
 * implementation.
 */

import type { Adapter } from '../adapter.js';
import type {
  IBlockWithTransaction,
  ILog,
  ITransactionData,
  ITransactionReceipt
} from '../interfaces/index.js';
import type { BridgeChildClient } from './pos-bridge-helpers.js';

import { POSBridgeError } from '../errors.js';

/**
 * Build a `BridgeChildClient` that talks to the matic (child) chain via
 * the supplied {@link Adapter}'s raw RPC primitive.
 */
export function createBridgeChildClient(adapter: Adapter): BridgeChildClient {
  return {
    getTransactionReceipt(hash: string): Promise<ITransactionReceipt> {
      return adapter
        .request<RawReceipt | null>('eth_getTransactionReceipt', [hash])
        .then((raw) => {
          if (raw === null) {
            throw new POSBridgeError(
              'TRANSACTION_HASH_REQUIRED',
              `No receipt for transaction ${hash}`,
              { transactionHash: hash }
            );
          }
          return parseReceipt(raw);
        });
    },

    getTransaction(hash: string): Promise<{ blockNumber: number }> {
      return adapter
        .request<RawTransaction | null>('eth_getTransactionByHash', [hash])
        .then((raw) => {
          if (raw === null || raw.blockNumber === null) {
            throw new POSBridgeError(
              'TRANSACTION_HASH_REQUIRED',
              `Transaction ${hash} is not yet mined`,
              { transactionHash: hash }
            );
          }
          return { blockNumber: hexToNumber(raw.blockNumber) };
        });
    },

    getBlockWithTransaction(
      blockNumberOrHash: number | string
    ): Promise<IBlockWithTransaction> {
      const isHash =
        typeof blockNumberOrHash === 'string' && blockNumberOrHash.length === 66;
      const method = isHash ? 'eth_getBlockByHash' : 'eth_getBlockByNumber';
      const tag =
        typeof blockNumberOrHash === 'number'
          ? numberToHex(blockNumberOrHash)
          : blockNumberOrHash.startsWith('0x')
            ? blockNumberOrHash
            : numberToHex(Number(blockNumberOrHash));
      return adapter
        .request<RawBlock | null>(method, [tag, true])
        .then((raw) => {
          if (raw === null) {
            throw new POSBridgeError(
              'BRIDGE_EVENT_DECODE_FAILED',
              `Block ${String(blockNumberOrHash)} not found`,
              { blockNumberOrHash: String(blockNumberOrHash) }
            );
          }
          return parseBlock(raw);
        });
    },

    getRootHash(startBlock: number, endBlock: number): Promise<string> {
      // bor_getRootHash returns a hex string WITHOUT a 0x prefix in
      // bor's RPC; some proxies normalise to 0x-prefixed. Strip
      // defensively so downstream callers see the bare hex.
      return adapter
        .request<string>('bor_getRootHash', [startBlock, endBlock])
        .then((hash) => stripHexPrefix(hash));
    },

    encodeParameters(
      params: readonly unknown[],
      types: readonly string[]
    ): string {
      return encodeBytes32Pair(params, types);
    },

    soliditySha3(...args: unknown[]): string {
      return solidityPackedKeccak(adapter, args);
    }
  };
}

// ---------------------------------------------------------------------
// RPC response shapes
// ---------------------------------------------------------------------

interface RawReceipt {
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  blockNumber: string;
  from: string;
  to: string | null;
  contractAddress: string | null;
  cumulativeGasUsed: string;
  gasUsed: string;
  logs?: RawLog[];
  status: string;
  logsBloom: string;
  root?: string;
  type?: string;
}

interface RawLog {
  address: string;
  data: string;
  topics: string[];
  logIndex: string;
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  blockNumber: string;
}

interface RawTransaction {
  hash: string;
  nonce: string;
  blockHash: string | null;
  blockNumber: string | null;
  transactionIndex: string | null;
  from: string;
  to: string | null;
  value: string;
  gasPrice: string;
  gas: string;
  input: string;
}

interface RawBlock {
  size: string;
  difficulty: string;
  totalDifficulty: string;
  uncles: string[];
  number: string;
  hash: string;
  parentHash: string;
  nonce: string;
  sha3Uncles: string;
  logsBloom: string;
  transactionsRoot: string;
  stateRoot: string;
  receiptsRoot: string;
  miner: string;
  extraData: string;
  gasLimit: string;
  gasUsed: string;
  timestamp: string;
  baseFeePerGas?: string;
  transactions: RawTransaction[];
}

// ---------------------------------------------------------------------
// Parsers — RPC hex strings → legacy interface shapes
// ---------------------------------------------------------------------

const parseReceipt = (raw: RawReceipt): ITransactionReceipt => ({
  transactionHash: raw.transactionHash,
  transactionIndex: hexToNumber(raw.transactionIndex),
  blockHash: raw.blockHash,
  blockNumber: hexToNumber(raw.blockNumber),
  from: raw.from,
  to: raw.to ?? '',
  contractAddress: raw.contractAddress ?? '',
  cumulativeGasUsed: hexToNumber(raw.cumulativeGasUsed),
  gasUsed: hexToNumber(raw.gasUsed),
  logs: (raw.logs ?? []).map(parseLog),
  // status: '0x1' / '0x0' from the wire; legacy interface stores boolean.
  status: hexToNumber(raw.status) === 1,
  logsBloom: raw.logsBloom,
  root: raw.root ?? '',
  // Type field appears on EIP-2718 typed receipts; legacy clients always
  // expected a string here so default to '0x0' when absent.
  type: raw.type ?? '0x0'
});

const parseLog = (raw: RawLog): ILog => ({
  address: raw.address,
  data: raw.data,
  topics: raw.topics,
  logIndex: hexToNumber(raw.logIndex),
  transactionHash: raw.transactionHash,
  transactionIndex: hexToNumber(raw.transactionIndex),
  blockHash: raw.blockHash,
  blockNumber: hexToNumber(raw.blockNumber)
});

const parseBlock = (raw: RawBlock): IBlockWithTransaction => ({
  size: hexToNumber(raw.size),
  difficulty: hexToNumber(raw.difficulty),
  totalDifficulty: hexToNumber(raw.totalDifficulty),
  uncles: raw.uncles,
  number: hexToNumber(raw.number),
  hash: raw.hash,
  parentHash: raw.parentHash,
  nonce: raw.nonce,
  sha3Uncles: raw.sha3Uncles,
  logsBloom: raw.logsBloom,
  transactionsRoot: raw.transactionsRoot,
  stateRoot: raw.stateRoot,
  receiptsRoot: raw.receiptsRoot,
  miner: raw.miner,
  extraData: raw.extraData,
  gasLimit: hexToNumber(raw.gasLimit),
  gasUsed: hexToNumber(raw.gasUsed),
  timestamp: hexToNumber(raw.timestamp),
  baseFeePerGas: raw.baseFeePerGas,
  transactions: raw.transactions.map(parseTransaction)
});

const parseTransaction = (raw: RawTransaction): ITransactionData => ({
  // Legacy `transactionHash` was the field name here; on the wire it's `hash`.
  transactionHash: raw.hash,
  nonce: hexToNumber(raw.nonce),
  blockHash: raw.blockHash,
  blockNumber: raw.blockNumber === null ? null : hexToNumber(raw.blockNumber),
  transactionIndex:
    raw.transactionIndex === null ? null : hexToNumber(raw.transactionIndex),
  from: raw.from,
  to: raw.to,
  value: raw.value,
  gasPrice: raw.gasPrice,
  gas: hexToNumber(raw.gas),
  input: raw.input
});

// ---------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------

function hexToNumber(hex: string): number {
  // Block / log / receipt indices fit comfortably in 53 bits.
  return Number.parseInt(stripHexPrefix(hex), 16);
}

function numberToHex(n: number): string {
  return `0x${n.toString(16)}`;
}

function stripHexPrefix(s: string): string {
  return s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
}

function pad32(hex: string): string {
  const stripped = stripHexPrefix(hex);
  if (stripped.length > 64) {
    throw new POSBridgeError(
      'INVALID_HEX_STRING',
      `value too long to pad to 32 bytes: ${hex}`,
      { length: stripped.length }
    );
  }
  return stripped.padStart(64, '0');
}

function uint256ToHex(value: number | bigint | string): string {
  let v: bigint;
  if (typeof value === 'bigint') v = value;
  else if (typeof value === 'number') v = BigInt(value);
  else v = BigInt(value);
  if (v < 0n) {
    throw new POSBridgeError(
      'NEGATIVE_BIG_NUMBER',
      'cannot encode negative value as uint256',
      { value: String(value) }
    );
  }
  return v.toString(16).padStart(64, '0');
}

// ---------------------------------------------------------------------
// Limited ABI helpers — only the patterns the bridge actually uses
// ---------------------------------------------------------------------

/**
 * `encodeParameters` for the bridge's exclusive use case:
 * `(bytes32, bytes32)` — used by `ProofUtil.queryRootHash` to combine
 * two subtree roots before hashing. ABI-encoded `(bytes32, bytes32)`
 * is just the concatenation of the two padded 32-byte values. A
 * general-purpose ABI encoder would pull in 50KB of dependency for one
 * usage; reject anything else here so a future caller doesn't silently
 * get wrong output.
 */
function encodeBytes32Pair(
  params: readonly unknown[],
  types: readonly string[]
): string {
  if (
    types.length !== 2 ||
    types[0] !== 'bytes32' ||
    types[1] !== 'bytes32'
  ) {
    throw new POSBridgeError(
      'BRIDGE_EVENT_DECODE_FAILED',
      'createBridgeChildClient.encodeParameters only supports (bytes32, bytes32)',
      { types: types.join(',') }
    );
  }
  if (params.length !== 2) {
    throw new POSBridgeError(
      'BRIDGE_EVENT_DECODE_FAILED',
      'expected exactly 2 params for (bytes32, bytes32)',
      { count: params.length }
    );
  }
  const [a, b] = params;
  if (typeof a !== 'string' || typeof b !== 'string') {
    throw new POSBridgeError(
      'BRIDGE_EVENT_DECODE_FAILED',
      'bytes32 params must be hex strings',
      { a: typeof a, b: typeof b }
    );
  }
  return `0x${pad32(a)}${pad32(b)}`;
}

/**
 * Solidity-packed keccak — replicates the `web3.utils.soliditySha3` shape
 * the legacy bridge code relied on. The bridge's only call site passes:
 *
 *   soliditySha3(blockNumber: number, hexConcat: string, logIndex: number)
 *
 * with the inferred types `uint256, bytes, uint256`. Packed encoding
 * (NOT abi.encode) means: numbers pad to 32 bytes; raw hex bytes pass
 * through without a length prefix. We support the inferred-shape that
 * the bridge uses and reject anything else with a clear error so a
 * future caller doesn't silently get wrong output.
 */
function solidityPackedKeccak(adapter: Adapter, args: readonly unknown[]): string {
  let packed = '';
  for (const arg of args) {
    if (typeof arg === 'number' || typeof arg === 'bigint') {
      // uint256 — 32-byte big-endian
      packed += uint256ToHex(arg);
    } else if (typeof arg === 'string') {
      if (!arg.startsWith('0x') && !arg.startsWith('0X')) {
        throw new POSBridgeError(
          'INVALID_HEX_STRING',
          'string args to soliditySha3 must be 0x-prefixed hex',
          { arg }
        );
      }
      // bytes — packed (no length prefix), raw hex
      packed += stripHexPrefix(arg);
    } else {
      throw new POSBridgeError(
        'BRIDGE_EVENT_DECODE_FAILED',
        `unsupported soliditySha3 arg type: ${typeof arg}`,
        { argType: typeof arg }
      );
    }
  }
  if (packed.length % 2 !== 0) {
    throw new POSBridgeError(
      'INVALID_HEX_STRING',
      'packed encoding produced odd-length hex',
      { length: packed.length }
    );
  }
  return adapter.keccak256(`0x${packed}`);
}
