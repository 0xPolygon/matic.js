import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { keccak256 } from 'viem';

import type {
  Adapter,
  Hex,
  PreparedTx,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';
import type { NetworkAddresses } from '../../src/networks.ts';

/**
 * An {@link Adapter} that replays RPC responses recorded by
 * `scripts/record-exit-fixture.mjs`, so the exit-payload construction can be
 * checked byte for byte with no network and no node.
 *
 * Responses are keyed by method plus canonicalised params. A request with no
 * recorded response throws {@link CassetteMissError}, a plain test error, so
 * a change that makes the SDK ask for something new fails loudly instead of
 * going out to a live endpoint. There is no network code in this file.
 *
 * The recorder carries the same `canonicalKey` and bigint tagging; change
 * them together.
 */

export class CassetteMissError extends Error {
  constructor(key: string) {
    super(`cassette has no recorded response for: ${key}`);
    this.name = 'CassetteMissError';
  }
}

/** Recorded responses for one chain, by canonical key. */
export type CassetteSide = Readonly<Record<string, unknown>>;

export interface Cassette {
  readonly network: string;
  readonly burnTxHash: string;
  readonly addresses: NetworkAddresses;
  readonly parent: CassetteSide;
  readonly child: CassetteSide;
}

/** Method plus params, with object keys sorted and bigints tagged. */
export function canonicalKey(method: string, params: unknown): string {
  const sorted = (v: unknown): unknown => {
    if (typeof v === 'bigint') return { $bigint: v.toString() };
    if (Array.isArray(v)) return v.map(sorted);
    if (v !== null && typeof v === 'object') {
      const record = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((k) => [k, sorted(record[k])])
      );
    }
    return v;
  };
  return `${method} ${JSON.stringify(sorted(params))}`;
}

/** Turns `{ "$bigint": "123" }` tags back into bigints, at any depth. */
function revive(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(revive);
  if (v !== null && typeof v === 'object') {
    const record = v as Record<string, unknown>;
    const tagged = record['$bigint'];
    if (typeof tagged === 'string' && Object.keys(record).length === 1) return BigInt(tagged);
    return Object.fromEntries(Object.entries(record).map(([k, x]) => [k, revive(x)]));
  }
  return v;
}

export function loadCassette(name: string): Cassette {
  const path = join(__dirname, '..', 'fixtures', 'exits', 'cassettes', name);
  return JSON.parse(readFileSync(path, 'utf8')) as Cassette;
}

/** A rejection, never a synchronous throw, as a real adapter's calls behave. */
const settle = <T>(run: () => T): Promise<T> =>
  new Promise((resolve, reject) => {
    try {
      resolve(run());
    } catch (err) {
      reject(err);
    }
  });

const readOnly = (): never => {
  throw new Error('cassette adapter is read-only');
};

export function cassetteAdapter(side: CassetteSide): Adapter {
  const replay = (method: string, params: unknown): unknown => {
    const key = canonicalKey(method, params);
    if (!(key in side)) throw new CassetteMissError(key);
    return revive(side[key]);
  };

  return {
    getChainId: () => settle(() => replay('getChainId', []) as number),
    read: (req: ReadRequest) =>
      settle(() =>
        replay('read', {
          address: req.address.toLowerCase(),
          functionName: req.functionName,
          args: req.args ?? [],
          blockTag: req.blockTag ?? null
        })
      ),
    request: <T>(method: string, params: readonly unknown[]): Promise<T> =>
      settle(() => replay('request', { method, params }) as T),
    getTransactionReceipt: (hash: string) =>
      settle(() => replay('getTransactionReceipt', [hash.toLowerCase()]) as Receipt | null),
    keccak256: (data: Uint8Array | string): string =>
      keccak256(
        typeof data === 'string' ? ((data.startsWith('0x') ? data : `0x${data}`) as Hex) : data
      ),
    write: (_req: WriteRequest): Promise<TxResult> => settle(readOnly),
    prepareWrite: (_req: WriteRequest): Promise<PreparedTx> => settle(readOnly),
    estimateGas: (_req: WriteRequest): Promise<bigint> => settle(readOnly)
  };
}
