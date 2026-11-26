import type { JsonRpcError, JsonRpcPayload, JsonRpcResult } from 'ethers';

import { JsonRpcApiProvider, Network } from 'ethers';
import { providers as v5providers } from 'ethers-v5';
import { createPublicClient, custom, http } from 'viem';

import type {
  Adapter,
  BlockTag,
  Hex,
  PreparedTx,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';

import * as bridgeAbis from '../../src/abi/index.ts';
import * as plasmaAbis from '../../src/abi/plasma/index.ts';
import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { isMaticjsError } from '../../src/errors.ts';

/**
 * Shared machinery for the contract-call unit tests: a recording adapter that
 * answers reads from a table, the request rows it produces, outcome-as-text
 * helpers, and the three real adapters over a stub JSON-RPC transport.
 */

// --- recording adapter ----------------------------------------------------------

export type Side = 'parent' | 'child';
export type RequestKind = 'read' | 'write' | 'prepareWrite' | 'estimateGas';

export type RecordedRequest =
  | { side: Side; kind: 'read'; req: ReadRequest }
  | { side: Side; kind: 'write' | 'prepareWrite' | 'estimateGas'; req: WriteRequest };

/** One ordered log shared by the parent and child adapters of a scenario. */
export class RequestLog {
  readonly entries: RecordedRequest[] = [];
}


export type ReadAnswer = unknown | ((req: ReadRequest) => unknown);
export type ReadAnswers = Readonly<Record<string, ReadAnswer>>;

export interface RecordingAdapterConfig {
  side: Side;
  log: RequestLog;
  chainId?: number;
  /** Answers by `functionName`; each overrides the defaults below. */
  answers?: ReadAnswers;
}

/**
 * An {@link Adapter} that stores every contract request the SDK makes and
 * answers reads from a table. Writes resolve at once with a fixed hash and
 * `prepareWrite` returns fixed calldata, because the requests are the subject,
 * not the encoding.
 */
export class RecordingAdapter implements Adapter {
  private readonly config: RecordingAdapterConfig;

  constructor(config: RecordingAdapterConfig) {
    this.config = config;
  }

  getChainId(): Promise<number> {
    return Promise.resolve(this.config.chainId ?? 1);
  }

  read(req: ReadRequest): Promise<unknown> {
    this.config.log.entries.push({ side: this.config.side, kind: 'read', req });
    // `in`, not `!== undefined`: an answer of `undefined` is a value a custom
    // adapter can return and a test can ask for.
    const scripted = this.config.answers;
    if (scripted !== undefined && req.functionName in scripted) {
      return answer(scripted[req.functionName], req);
    }
    if (req.functionName in DEFAULT_READ_ANSWERS) {
      return answer(DEFAULT_READ_ANSWERS[req.functionName], req);
    }
    return Promise.reject(new Error(`no answer scripted for read ${req.functionName}`));
  }

  write(req: WriteRequest): Promise<TxResult> {
    this.config.log.entries.push({ side: this.config.side, kind: 'write', req });
    return Promise.resolve({
      hash: FIXED_HASH,
      confirmed: () => Promise.resolve(FIXED_RECEIPT)
    });
  }

  prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    this.config.log.entries.push({ side: this.config.side, kind: 'prepareWrite', req });
    return Promise.resolve(
      req.value !== undefined
        ? { to: req.address, data: '0xfeed', value: req.value }
        : { to: req.address, data: '0xfeed' }
    );
  }

  estimateGas(req: WriteRequest): Promise<bigint> {
    this.config.log.entries.push({ side: this.config.side, kind: 'estimateGas', req });
    return Promise.resolve(21_000n);
  }

  getTransactionReceipt(_hash: string): Promise<Receipt | null> {
    return Promise.resolve(null);
  }

  keccak256(data: Uint8Array | string): string {
    return KECCAK_ADAPTER.keccak256(data);
  }

  request<T>(method: string, _params: readonly unknown[]): Promise<T> {
    return Promise.reject(new Error(`no RPC scripted for ${method}`));
  }
}

const answer = (value: ReadAnswer, req: ReadRequest): Promise<unknown> => {
  try {
    return Promise.resolve(typeof value === 'function' ? value(req) : value);
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
};

const FIXED_HASH: Hex = `0x${'ab'.repeat(32)}`;
const FIXED_RECEIPT: Receipt = {
  transactionHash: FIXED_HASH,
  status: 'success',
  blockNumber: 1n,
  logs: []
};

/** A stand-in for the adapters' own keccak: all three share one implementation. */
const KECCAK_ADAPTER = viemAdapter({
  public: createPublicClient({ transport: http('http://127.0.0.1:1') })
});

function viemKeccak(data: Uint8Array | string): string {
  return KECCAK_ADAPTER.keccak256(data);
}

// --- default read answers --------------------------------------------------------

export const ADDRESSES = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666',
  GasSwapper: '0x7777777777777777777777777777777777777777',
  MintableERC1155Predicate: '0x8888888888888888888888888888888888888888'
} as const satisfies Record<string, Hex>;

export const USER: Hex = '0x00000000000000000000000000000000000000a1';
export const OTHER: Hex = '0x00000000000000000000000000000000000000b2';
export const TOKEN_TYPE: Hex = `0x${'0'.repeat(63)}1`;

/** What every read answers unless a scenario overrides it. */
export const DEFAULT_READ_ANSWERS: ReadAnswers = {
  balanceOf: 100n,
  allowance: 7n,
  tokenOfOwnerByIndex: 42n,
  getApproved: ADDRESSES.ERC721Predicate,
  isApprovedForAll: true,
  tokenToType: TOKEN_TYPE,
  typeToPredicate: ADDRESSES.ERC20Predicate,
  processedExits: false,
  getLastChildBlock: 1_000_000n,
  currentHeaderBlock: 20_000n,
  headerBlocks: [`0x${'11'.repeat(32)}`, 1n, 1_000_000n, 1n, OTHER],
  lastStateId: 5n,
  failedStateSyncHashes: `0x${'0'.repeat(64)}`,
  failedStateSyncs: '0x'
};

// --- request rows ---------------------------------------------------------------

export interface TaggedValue {
  type: string;
  value: unknown;
}

export interface RequestRow {
  side: Side;
  kind: RequestKind;
  contract: string;
  address: string;
  functionName: string;
  args: TaggedValue[];
  blockTag?: unknown;
  from?: string;
  value?: unknown;
  gasLimit?: unknown;
  maxFeePerGas?: unknown;
  maxPriorityFeePerGas?: unknown;
  nonce?: number;
  chainId?: number;
}

/** A bigint is tagged as in `cassette-adapter.ts`, so JSON keeps it apart from a number. */
const tagBigint = (n: bigint): { $bigint: string } => ({ $bigint: n.toString() });

/** A value and its JavaScript type, recursively, in a form JSON can hold. */
export const tagged = (v: unknown): TaggedValue => {
  if (typeof v === 'bigint') return { type: 'bigint', value: tagBigint(v) };
  if (Array.isArray(v)) return { type: 'array', value: v.map(tagged) };
  if (v === null) return { type: 'null', value: null };
  if (v === undefined) return { type: 'undefined', value: null };
  if (typeof v === 'object') {
    return {
      type: 'object',
      value: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tagged(x)]))
    };
  }
  if (typeof v === 'string' && v.length > LONG_STRING) {
    return { type: 'string', value: { $keccak256: viemKeccak(v), length: v.length } };
  }
  return { type: typeof v, value: v };
};

/**
 * A string this long is an exit payload (kilobytes of proof, hex). It is pinned
 * by the keccak-256 of the bytes it stands for and its length, so the fixture stays reviewable and any change to
 * a byte still shows.
 */
const LONG_STRING = 200;

const optionalBigint = (v: bigint | undefined): { $bigint: string } | undefined =>
  v === undefined ? undefined : tagBigint(v);

const blockTagValue = (tag: BlockTag | undefined): unknown =>
  typeof tag === 'bigint' ? tagBigint(tag) : (tag ?? null);

const BRIDGE_ABI_NAMES: ReadonlyArray<readonly [string, unknown]> = [
  ...Object.entries(bridgeAbis),
  ...Object.entries(plasmaAbis)
];

/** The exported name of the ABI a request was made against. */
export const abiNameOf = (abi: unknown): string => {
  const exact = BRIDGE_ABI_NAMES.find(([, candidate]) => candidate === abi);
  if (exact !== undefined) return exact[0];
  throw new Error('a request was made against an ABI that is not one of the SDK ABIs');
};

export const rowOf = (entry: RecordedRequest): RequestRow => {
  const { req } = entry;
  const row: RequestRow = {
    side: entry.side,
    kind: entry.kind,
    contract: abiNameOf(req.abi),
    address: req.address,
    functionName: req.functionName,
    args: (req.args ?? []).map(tagged)
  };
  if (entry.kind === 'read') {
    row.blockTag = blockTagValue(entry.req.blockTag);
    return row;
  }
  const w = entry.req;
  const optional = {
    from: w.from,
    value: optionalBigint(w.value),
    gasLimit: optionalBigint(w.gasLimit),
    maxFeePerGas: optionalBigint(w.maxFeePerGas),
    maxPriorityFeePerGas: optionalBigint(w.maxPriorityFeePerGas),
    nonce: w.nonce,
    chainId: w.chainId
  };
  return Object.assign(
    row,
    Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined))
  );
};

// --- result outcomes ------------------------------------------------------------

/** A value as one line of text, so an outcome is one comparable string. */
export const show = (v: unknown): string => {
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[${v.map(show).join(', ')}]`;
  if (typeof v === 'object' && v !== null) {
    return `{${Object.entries(v)
      .map(([k, x]) => `${k}: ${show(x)}`)
      .join(', ')}}`;
  }
  return JSON.stringify(v);
};

/**
 * What a call did, as one line. A returned value reads `value <v>`. A throw
 * reads `threw <class name>`. An SDK error is wrapped by the public method's
 * operation error, so its line names the whole chain, outermost first, and
 * ends with the `info` that names the field (the part a consumer can act on).
 * The class name, not the message, is the pin, because messages are prose.
 */
export const outcomeOf = async ({
  run,
  project = show
}: {
  run: () => Promise<unknown>;
  project?: (value: unknown) => string;
}): Promise<string> => {
  try {
    return `value ${project(await run())}`;
  } catch (err) {
    if (!(err instanceof Error)) return `threw non-error ${show(err)}`;
    const chain: Error[] = [err];
    let link: Error = err;
    while (isMaticjsError(link) && link.cause instanceof Error) {
      link = link.cause;
      chain.push(link);
    }
    const last = chain[chain.length - 1] ?? err;
    const names = chain.map((e) => e.name).join(' > ');
    const info = isMaticjsError(last) ? pickInfo(Reflect.get(last, 'info')) : '';
    return `threw ${names}${info}`;
  }
};

/** The `info` keys that say which value was malformed, and nothing that is a test constant. */
const INFO_KEYS: readonly string[] = ['field', 'valueType', 'length', 'minLength', 'resultType'];

const pickInfo = (info: unknown): string => {
  if (typeof info !== 'object' || info === null) return '';
  const picked = Object.fromEntries(
    Object.entries(info).filter(([k, v]) => INFO_KEYS.includes(k) && v !== undefined)
  );
  return Object.keys(picked).length === 0 ? '' : ` ${show(picked)}`;
};

// --- the three real adapters over a stub transport -------------------------------

export interface StubNode {
  chainId: number;
  /** Answers one JSON-RPC call; throwing makes the node report an error. */
  rpc: (method: string, params: readonly unknown[]) => unknown;
}

export type LibraryName = 'viem' | 'ethers v5' | 'ethers v6';

export const LIBRARIES: readonly LibraryName[] = ['viem', 'ethers v5', 'ethers v6'];

class V5StubProvider extends v5providers.StaticJsonRpcProvider {
  private readonly node: StubNode;

  constructor(node: StubNode) {
    super('http://stub.invalid', { chainId: node.chainId, name: 'stub' });
    this.node = node;
  }

  override send(method: string, params: unknown[]): Promise<unknown> {
    try {
      return Promise.resolve(this.node.rpc(method, params));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

class V6StubProvider extends JsonRpcApiProvider {
  private readonly node: StubNode;

  constructor(node: StubNode) {
    super(Network.from(node.chainId), { staticNetwork: true, batchMaxCount: 1 });
    this.node = node;
  }

  override _send(
    payload: JsonRpcPayload | JsonRpcPayload[]
  ): Promise<Array<JsonRpcResult | JsonRpcError>> {
    const batch = Array.isArray(payload) ? payload : [payload];
    return Promise.resolve(
      batch.map((p) => {
        try {
          return {
            id: p.id,
            result: this.node.rpc(p.method, Array.isArray(p.params) ? p.params : [])
          };
        } catch (err) {
          return { id: p.id, error: { code: -32000, message: String(err) } };
        }
      })
    );
  }
}

/** The real adapter for `library`, talking to a node that is a function. */
export const adapterOver = ({
  library,
  node
}: {
  library: LibraryName;
  node: StubNode;
}): Adapter => {
  if (library === 'viem') {
    const transport = custom({
      request: ({ method, params }: { method: string; params?: unknown }) =>
        Promise.resolve(node.rpc(method, Array.isArray(params) ? params : []))
    });
    return viemAdapter({ public: createPublicClient({ transport }) });
  }
  if (library === 'ethers v5') return ethersV5Adapter({ provider: new V5StubProvider(node) });
  return ethersV6Adapter({ provider: new V6StubProvider(node) });
};

export function quantity(n: bigint | number): string {
  return `0x${n.toString(16)}`;
}
export const rowsOf = (log: RequestLog): RequestRow[] => log.entries.map(rowOf);

// --- staking addresses --------------------------------------------------------------

export const STAKING_ADDRESSES = {
  StakeManager: '0x7777777777777777777777777777777777777777',
  MaticToken: '0x8888888888888888888888888888888888888888',
  PolToken: '0x9999999999999999999999999999999999999999'
} as const satisfies Record<string, Hex>;

export const VALIDATOR_SHARE: Hex = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
