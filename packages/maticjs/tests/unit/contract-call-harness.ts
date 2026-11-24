import type { JsonRpcError, JsonRpcPayload, JsonRpcResult } from 'ethers';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { JsonRpcApiProvider, Network } from 'ethers';
import { BigNumber as v5BigNumber, providers as v5providers } from 'ethers-v5';
import { createPublicClient, custom, http } from 'viem';
import { describe, expect, it, vi } from 'vitest';

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
import type { NetworkAddresses } from '../../src/networks.ts';
import type { PlasmaAddresses } from '../../src/plasma/addresses.ts';

import {
  FailedStateSyncHashesABI,
  ReplayFailedStateSyncABI
} from '../../src/abi/failed-state-sync.ts';
import * as bridgeAbis from '../../src/abi/index.ts';
import * as plasmaAbis from '../../src/abi/plasma/index.ts';
import { StateReceiverABI } from '../../src/abi/StateReceiver.ts';
import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { isMaticjsError } from '../../src/errors.ts';
import { noopLogger } from '../../src/logger.ts';
import { PlasmaClient } from '../../src/plasma/plasma-client.ts';
import { POSClient } from '../../src/pos-client.ts';
import { __resetAddressCacheForTesting } from '../../src/services/address-service.ts';
import { StakingClient } from '../../src/staking/staking-client.ts';
import { cassetteAdapter, loadCassette } from './cassette-adapter.ts';

/**
 * Shared machinery for the contract-call characterisation suites.
 *
 * These suites pin what the SDK does today when it talks to a contract: the
 * exact request each public method hands to the adapter, the bytes that
 * reach the node through each real web3 library, and what the SDK makes of
 * every shape a read can come back in. They describe the code as it is, so a
 * refactor of the call path can be proven to leave requests and wire bytes
 * alone and to change results only where a row says so.
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
  /** Answers by `functionName`; each overrides the scenario-wide defaults. */
  answers?: ReadAnswers;
  /**
   * Another adapter that answers everything but writes: recorded RPC
   * responses, for the exit paths whose payload is built from a real burn.
   */
  delegate?: Adapter;
  /** Answers `request`; rejects when absent, so an unexpected RPC fails loudly. */
  rpc?: (method: string, params: readonly unknown[]) => unknown;
  /** Receipts by transaction hash; an unlisted hash has none. */
  receipts?: Readonly<Record<string, Receipt | null>>;
}

/**
 * An {@link Adapter} that stores every contract request the SDK makes and
 * answers reads from a table. Writes resolve at once with a fixed hash and
 * `prepareWrite` returns fixed calldata, because the requests are the subject,
 * not the encoding (the wire suite covers that).
 */
export class RecordingAdapter implements Adapter {
  private readonly config: RecordingAdapterConfig;

  constructor(config: RecordingAdapterConfig) {
    this.config = config;
  }

  getChainId(): Promise<number> {
    if (this.config.delegate !== undefined) return this.config.delegate.getChainId();
    return Promise.resolve(this.config.chainId ?? 1);
  }

  read(req: ReadRequest): Promise<unknown> {
    this.config.log.entries.push({ side: this.config.side, kind: 'read', req });
    // `in`, not `!== undefined`: an answer of `undefined` is a shape a node can
    // produce and a table row can ask for.
    const scripted = this.config.answers;
    if (scripted !== undefined && req.functionName in scripted) {
      return answer(scripted[req.functionName], req);
    }
    if (this.config.delegate !== undefined) return this.config.delegate.read(req);
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

  getTransactionReceipt(hash: string): Promise<Receipt | null> {
    const scripted = this.config.receipts?.[hash];
    if (scripted !== undefined) return Promise.resolve(scripted);
    if (this.config.delegate !== undefined) return this.config.delegate.getTransactionReceipt(hash);
    return Promise.resolve(null);
  }

  keccak256(data: Uint8Array | string): string {
    if (this.config.delegate !== undefined) return this.config.delegate.keccak256(data);
    return viemKeccak(data);
  }

  request<T>(method: string, params: readonly unknown[]): Promise<T> {
    if (this.config.delegate !== undefined) return this.config.delegate.request<T>(method, params);
    const rpc = this.config.rpc;
    if (rpc === undefined) {
      return Promise.reject(new Error(`no RPC scripted for ${method}`));
    }
    try {
      return Promise.resolve(rpc(method, params) as T);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
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

/** The adapters' own keccak: all three share one implementation, so a stand-in must too. */
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

// --- request rows (fixtures) ----------------------------------------------------

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

const STATE_RECEIVER_COMBINED = JSON.stringify([
  ...StateReceiverABI,
  ...FailedStateSyncHashesABI,
  ...ReplayFailedStateSyncABI
]);

/**
 * The exported name of the ABI a request was made against. The state
 * receiver is built from three fragments into a fresh array, so it is
 * recognised by content.
 */
export const abiNameOf = (abi: unknown): string => {
  const exact = BRIDGE_ABI_NAMES.find(([, candidate]) => candidate === abi);
  if (exact !== undefined) return exact[0];
  if (JSON.stringify(abi) === STATE_RECEIVER_COMBINED) {
    return 'StateReceiverABI+FailedStateSyncHashesABI+ReplayFailedStateSyncABI';
  }
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

// --- fixture files --------------------------------------------------------------

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'contract-calls');

/**
 * Set to regenerate the committed fixtures from the code as it is now.
 * The fixtures are the specification of the SDK's current behaviour, so
 * regenerate only on a base the suites are meant to describe, and read the
 * diff before committing it: it is the full list of what changed.
 */
export const WRITE_FIXTURES_FLAG = 'WRITE_CONTRACT_CALL_FIXTURES';

/**
 * The committed fixture at `name`, or, when the flag is set, `actual` written
 * to it first. A missing file names the flag instead of failing obscurely.
 */
export const loadFixture = <T>({ name, actual }: { name: string; actual: T }): T => {
  const path = join(FIXTURE_DIR, name);
  if (process.env[WRITE_FIXTURES_FLAG] === '1') {
    writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
    return actual;
  }
  if (!existsSync(path)) {
    throw new Error(`fixture ${name} is missing: run once with ${WRITE_FIXTURES_FLAG}=1`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
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
export function hex32(n: bigint): Hex {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

/** Assert helper: two JSON-able values are equal, with a readable diff. */
export const expectSame = (actual: unknown, expected: unknown): void => {
  expect(actual).deep.equals(expected);
};

// --- coverage registry ----------------------------------------------------------

/** A contract method the SDK calls, and the request kinds the fixtures must hold for it. */
export type CoveredPair = readonly [
  contract: string,
  method: string,
  kinds: readonly RequestKind[]
];

export const READ: readonly RequestKind[] = ['read'];
export const WRITE: readonly RequestKind[] = ['write', 'prepareWrite'];

/**
 * The pairs in `pairs` that no fixture row covers, as readable strings. A
 * method that gains a call site without a fixture row, or a fixture that
 * loses its row, shows up here.
 */
export const uncoveredPairs = ({
  pairs,
  fixture
}: {
  pairs: readonly CoveredPair[];
  fixture: Readonly<Record<string, readonly RequestRow[]>>;
}): string[] => {
  const rows = Object.values(fixture).flat();
  return pairs.flatMap(([contract, method, kinds]) =>
    kinds
      .filter(
        (kind) =>
          !rows.some(
            (row) => row.contract === contract && row.functionName === method && row.kind === kind
          )
      )
      .map((kind) => `${contract}.${method} (${kind})`)
  );
};

/**
 * One scenario's recorded rows, in request order.
 *
 * `collapseReads` keeps only the first read of each contract, function, block
 * tag and argument-type signature. The exit paths binary-search the checkpoint
 * headers, so a recorded burn produces dozens of `headerBlocks` reads whose
 * arguments are data from the recording; the writes are what those scenarios
 * pin, and one read of each shape shows what the SDK asks for.
 */
export const rowsOf = (log: RequestLog, { collapseReads = false } = {}): RequestRow[] => {
  const rows = log.entries.map(rowOf);
  if (!collapseReads) return rows;
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (row.kind !== 'read') return true;
    const shape = JSON.stringify([
      row.side,
      row.contract,
      row.functionName,
      row.blockTag,
      row.args.map((a) => a.type)
    ]);
    if (seen.has(shape)) return false;
    seen.add(shape);
    return true;
  });
};

// --- staking answers --------------------------------------------------------------

export const STAKING_ADDRESSES = {
  StakeManager: '0x7777777777777777777777777777777777777777',
  MaticToken: '0x8888888888888888888888888888888888888888',
  PolToken: '0x9999999999999999999999999999999999999999'
} as const satisfies Record<string, Hex>;

export const VALIDATOR_SHARE: Hex = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';

/** A well-formed answer for each staking read: scalars are `3n`, tuples have their ABI's arity. */
export const STAKING_ANSWERS: ReadAnswers = {
  CHECKPOINT_REWARD: 3n,
  currentEpoch: 3n,
  currentValidatorSetTotalStake: 3n,
  delegatedAmount: 3n,
  getValidatorId: 3n,
  minDeposit: 3n,
  minHeimdallFee: 3n,
  validatorStake: 3n,
  WITHDRAWAL_DELAY: 3n,
  balanceOf: 3n,
  allowance: 3n,
  nonces: 3n,
  exchangeRate: 3n,
  getLiquidRewards: 3n,
  minAmount: 3n,
  unbondNonces: 3n,
  validatorId: 3n,
  locked: false,
  getValidatorContract: VALIDATOR_SHARE,
  validators: [1n, 2n, 3n, 4n, 5n, USER, VALIDATOR_SHARE, 1n, 8n, 9n, 10n, 11n, 12n],
  getTotalStake: [5n, 6n],
  unbonds: [7n, 8n],
  unbonds_new: [7n, 8n],
  eip712Domain: [
    '0x0f',
    'Polygon Ecosystem Token',
    '1',
    1n,
    STAKING_ADDRESSES.PolToken,
    `0x${'0'.repeat(64)}`,
    []
  ]
};

// --- plasma exit status world -------------------------------------------------------

/**
 * A scripted pair of chains for `getWithdrawStatus` on the Plasma bridge: one
 * checkpointed burn, a confirm transaction that started its exit, and an exit
 * token whose existence the caller chooses.
 *
 * The constants are written out rather than imported so a wrong constant in
 * the source cannot make the scenario agree with it.
 */
export const PLASMA_STATUS = (() => {
  const EXIT_STARTED = '0xaa5303fdad123ab5ecaefaf69137bf8632257839546d43a3b3dd148cc2879d6f';
  const WITHDRAW = '0xebff2602b3f468259e1e99f613fed6691f3a6526effe6ef3e768ba7ae7a36c4f';
  const MANAGER: Hex = '0x3333333333333333333333333333333333333333';
  const TOKEN: Hex = '0x7777777777777777777777777777777777777777';
  const BURNER: Hex = '0x00000000000000000000000000000000000000aa';
  const CHILD_TOKEN: Hex = '0x0000000000000000000000000000000000001010';
  const BURN: Hex = hex32(0xa3n);
  const CONFIRM: Hex = hex32(0xc1n);
  const BURN_BLOCK = 50n;
  const CONFIRM_BLOCK = 484n;
  const EXITABLE_AT = 1_000n;
  const BURN_INDEX = 200;
  const BURN_MASK = 0x81c8n;
  const EXIT_ID = (EXITABLE_AT << 128n) | (BURN_BLOCK << 33n) | (BURN_MASK << 1n);

  const burnReceipt = {
    transactionHash: BURN,
    transactionIndex: quantity(BURN_INDEX),
    blockHash: hex32(0xb10cn),
    blockNumber: quantity(BURN_BLOCK),
    from: ADDRESSES.RootChain,
    to: ADDRESSES.RootChain,
    contractAddress: null,
    cumulativeGasUsed: '0x5208',
    gasUsed: '0x5208',
    status: '0x1',
    logsBloom: `0x${'00'.repeat(256)}`,
    logs: [
      {
        address: CHILD_TOKEN,
        topics: [WITHDRAW, hex32(BigInt(TOKEN)), hex32(BigInt(BURNER))],
        data: hex32(10n ** 18n),
        blockNumber: quantity(BURN_BLOCK),
        transactionHash: BURN,
        transactionIndex: quantity(BURN_INDEX),
        blockHash: hex32(0xb10cn),
        logIndex: '0x0',
        removed: false
      }
    ]
  };

  const confirmReceipt: Receipt = {
    transactionHash: CONFIRM,
    status: 'success',
    blockNumber: CONFIRM_BLOCK,
    logs: [
      {
        address: MANAGER,
        topics: [EXIT_STARTED, hex32(BigInt(BURNER)), hex32(EXIT_ID), hex32(2n)],
        data: '0x',
        logIndex: 0
      }
    ]
  };

  return {
    burn: BURN,
    confirm: CONFIRM,
    manager: MANAGER,
    token: TOKEN,
    /** The child chain's answers to the burn-receipt lookups. */
    childRpc: (method: string, params: readonly unknown[]): unknown => {
      if (String(params[0]) !== BURN) throw new Error(`child chain: unscripted ${method}`);
      if (method === 'eth_getTransactionByHash') {
        return { hash: BURN, blockNumber: quantity(BURN_BLOCK) };
      }
      if (method === 'eth_getTransactionReceipt') return burnReceipt;
      throw new Error(`child chain: unscripted ${method}`);
    },
    /** The parent chain's answer to the head lookup, a block past the confirm. */
    parentRpc: (method: string, params: readonly unknown[]): unknown => {
      if (method === 'eth_getBlockByNumber' && params[0] === 'latest') {
        return { number: quantity(CONFIRM_BLOCK + 100n), timestamp: quantity(EXITABLE_AT) };
      }
      throw new Error(`parent chain: unscripted ${method}`);
    },
    confirmReceipt
  };
})();

// --- worlds: a client over recording adapters --------------------------------------

export interface SideOptions {
  answers?: RecordingAdapterConfig['answers'];
  receipts?: RecordingAdapterConfig['receipts'];
  chainId?: number;
}

export interface PosWorldOptions {
  network?: 'mainnet' | 'amoy';
  parent?: SideOptions;
  child?: SideOptions;
  addresses?: NetworkAddresses;
  /** Replay exit reads from a recorded burn instead of scripted answers. */
  cassette?: string;
  proofGenerationApiUrl?: string;
}

export interface PosWorld {
  pos: POSClient;
  log: RequestLog;
}

export const posWorld = async (options: PosWorldOptions = {}): Promise<PosWorld> => {
  const log = new RequestLog();
  const recorded = options.cassette === undefined ? undefined : loadCassette(options.cassette);
  __resetAddressCacheForTesting();
  const pos = await POSClient.init({
    network: options.network ?? 'mainnet',
    parent: new RecordingAdapter({
      side: 'parent',
      log,
      chainId: 1,
      ...options.parent,
      ...(recorded === undefined ? {} : { delegate: cassetteAdapter(recorded.parent) })
    }),
    child: new RecordingAdapter({
      side: 'child',
      log,
      chainId: 137,
      ...options.child,
      ...(recorded === undefined ? {} : { delegate: cassetteAdapter(recorded.child) })
    }),
    addresses: recorded === undefined ? (options.addresses ?? ADDRESSES) : recorded.addresses,
    ...(options.proofGenerationApiUrl === undefined
      ? {}
      : { proofGenerationApiUrl: options.proofGenerationApiUrl }),
    logger: noopLogger
  });
  return { pos, log };
};

export interface StakingWorld {
  staking: StakingClient;
  log: RequestLog;
}

export const stakingWorld = async (
  answers: ReadAnswers = STAKING_ANSWERS
): Promise<StakingWorld> => {
  const log = new RequestLog();
  __resetAddressCacheForTesting();
  const staking = await StakingClient.init({
    network: 'mainnet',
    parent: new RecordingAdapter({ side: 'parent', log, chainId: 1, answers }),
    addresses: STAKING_ADDRESSES,
    logger: noopLogger
  });
  return { staking, log };
};

export const PLASMA_ADDRESSES: PlasmaAddresses = {
  RootChain: '0x1111111111111111111111111111111111111111',
  DepositManager: '0x2222222222222222222222222222222222222222',
  WithdrawManager: '0x3333333333333333333333333333333333333333',
  PlasmaERC20Predicate: '0x5555555555555555555555555555555555555555',
  ExitNFT: '0x4444444444444444444444444444444444444444',
  MaticToken: '0x6666666666666666666666666666666666666666',
  PolToken: '0x7777777777777777777777777777777777777777'
};

export const PLASMA_QUEUE: Hex = '0x00000000000000000000000000000000000000e1';

/** A well-formed answer for each Plasma read. */
export const PLASMA_ANSWERS: ReadAnswers = {
  balanceOf: 100n,
  allowance: 7n,
  exitsQueues: PLASMA_QUEUE,
  currentSize: 3n,
  ON_FINALIZE_GAS_LIMIT: 300_000n,
  getLastChildBlock: 100n,
  exists: true
};

export interface PlasmaWorldOptions {
  cassette?: string;
  proofGenerationApiUrl?: string;
  /** Script the burn and confirm transactions `getWithdrawStatus` reads. */
  status?: boolean;
  /** Overrides the well-formed answers of both chains. */
  answers?: ReadAnswers;
}

export interface PlasmaWorld {
  plasma: PlasmaClient;
  log: RequestLog;
}

export const plasmaWorld = async (options: PlasmaWorldOptions = {}): Promise<PlasmaWorld> => {
  const log = new RequestLog();
  const recorded = options.cassette === undefined ? undefined : loadCassette(options.cassette);
  const answers = recorded === undefined ? { ...PLASMA_ANSWERS, ...options.answers } : {};
  const plasma = await PlasmaClient.init({
    network: 'mainnet',
    parent: new RecordingAdapter({
      side: 'parent',
      log,
      chainId: 1,
      answers,
      ...(options.status === true
        ? {
            rpc: PLASMA_STATUS.parentRpc,
            receipts: { [PLASMA_STATUS.confirm]: PLASMA_STATUS.confirmReceipt }
          }
        : {}),
      ...(recorded === undefined ? {} : { delegate: cassetteAdapter(recorded.parent) })
    }),
    child: new RecordingAdapter({
      side: 'child',
      log,
      chainId: 137,
      answers,
      ...(options.status === true ? { rpc: PLASMA_STATUS.childRpc } : {}),
      ...(recorded === undefined ? {} : { delegate: cassetteAdapter(recorded.child) })
    }),
    // Only RootChain is read from a recording, so it keeps its own address.
    addresses:
      recorded === undefined
        ? PLASMA_ADDRESSES
        : { ...PLASMA_ADDRESSES, RootChain: recorded.addresses.RootChain },
    ...(options.proofGenerationApiUrl === undefined
      ? {}
      : { proofGenerationApiUrl: options.proofGenerationApiUrl }),
    logger: noopLogger
  });
  return { plasma, log };
};

// --- the deposit records the state receiver holds ---------------------------------

export interface StateSyncRecord {
  transactionHash: Hex;
  stateSyncedLog: { address: Hex; topics: Hex[]; data: Hex; logIndex: string };
  childFailedStateSyncHash?: Hex;
  childFailedStateSyncPayload?: Hex;
}

const readRecord = (name: string): StateSyncRecord =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8')
  ) as StateSyncRecord;

/** Two committed mainnet failed deliveries: a hash record and a payload record. */
export const HASH_RECORD = readRecord('mainnet-state-sync-3212421.json');
export const PAYLOAD_RECORD = readRecord('mainnet-state-sync-3192364.json');

export const receiptOf = (record: StateSyncRecord): Receipt => ({
  transactionHash: record.transactionHash,
  status: 'success',
  blockNumber: 1n,
  logs: [
    {
      address: record.stateSyncedLog.address,
      topics: record.stateSyncedLog.topics,
      data: record.stateSyncedLog.data,
      logIndex: Number(record.stateSyncedLog.logIndex)
    }
  ]
});

/** A child chain on which the deposit's state sync failed, as a hash or as a payload. */
export const failedDelivery = (record: StateSyncRecord): SideOptions => ({
  answers: {
    lastStateId: BigInt(record.stateSyncedLog.topics[1] ?? '0x0'),
    failedStateSyncHashes: record.childFailedStateSyncHash ?? `0x${'0'.repeat(64)}`,
    failedStateSyncs: record.childFailedStateSyncPayload ?? '0x'
  }
});

// --- result-shape tables ---------------------------------------------------------

/** A public read under test: how to run it with one raw answer for the contract call. */
export interface TableRead {
  name: string;
  /** Replaces `{field}` in expected outcomes: the name an SDK error gives the value. */
  field?: string;
  run: (raw: unknown) => Promise<unknown>;
  /** Shortens a returned value for the table; defaults to the whole value. */
  project?: (value: unknown) => string;
}

/** A shape's name and what today's code makes of it. */
export type Row = readonly [shape: string, expected: string];

/**
 * The raw answers a read can come back in, by name. Rows refer to them by
 * name so a row stays on one line. `BigNumber` is the object ethers v5 returns
 * for every `uint256`.
 */
export const integerShapes = (n: bigint): Readonly<Record<string, unknown>> => ({
  bigint: n,
  'decimal string': n.toString(),
  'hex string': `0x${n.toString(16)}`,
  BigNumber: v5BigNumber.from(n.toString()),
  number: Number(n),
  undefined: undefined,
  null: null,
  'empty object': {},
  'non-numeric string': 'abc',
  'empty string': '',
  true: true,
  fraction: 1.5,
  'negative bigint': -1n,
  'unsafe number': 1e21,
  NaN: Number.NaN,
  'one-element array': [n]
});

/** The shapes of an integer answer, around the value `5`. */
export const INTEGER_SHAPES = integerShapes(5n);

/** The shapes of an address answer, given the one address a well-formed answer should match. */
export const addressShapes = (address: Hex): Readonly<Record<string, unknown>> => ({
  'matching address': address,
  'matching address, upper-case hex': `0x${address.slice(2).toUpperCase()}`,
  'other address': OTHER,
  'zero address': `0x${'0'.repeat(40)}`,
  undefined: undefined,
  null: null,
  number: 5,
  'empty object': {},
  'empty string': '',
  'non-hex string': 'abc',
  'short hex': '0x12',
  'bytes32 hex': hex32(5n)
});

export const BOOLEAN_SHAPES: Readonly<Record<string, unknown>> = {
  true: true,
  false: false,
  'string "true"': 'true',
  'string "false"': 'false',
  'number 1': 1,
  'number 0': 0,
  undefined: undefined,
  null: null,
  'empty object': {},
  'empty string': ''
};

/**
 * Registers one table: every row is run against every read in `reads`, so a
 * public read cannot be left out by sharing a table. A row's expected text is
 * today's outcome (see {@link outcomeOf}); the `// changes when the read is
 * decoded` comment on a row in the test file says it is allowed to change.
 */
export const registerTable = ({
  title,
  reads,
  rows,
  shapes
}: {
  title: string;
  reads: readonly TableRead[];
  rows: readonly Row[];
  shapes: Readonly<Record<string, unknown>>;
}): void => {
  describe(title, () => {
    describe.each(reads.map((r) => [r.name, r] as const))('%s', (_name, read) => {
      it.each(rows)('%s', async (shape, expected) => {
        if (!(shape in shapes)) throw new Error(`table "${title}" has no shape named "${shape}"`);
        const got = await outcomeOf({ run: () => read.run(shapes[shape]), project: read.project });
        expect(got).equals(expected.replaceAll('{field}', read.field ?? ''));
      });
    });
  });
};

// --- the proof-generation API -----------------------------------------------------

/** The exit payload the stubbed proof API answers with. */
export const FAST_PAYLOAD = `0x${'ef'.repeat(48)}`;

/**
 * Stubs `fetch` so the proof API answers every request with
 * {@link FAST_PAYLOAD}. Undo with `vi.unstubAllGlobals()`.
 */
export const stubProofApi = (): void => {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify({ message: 'ok', result: FAST_PAYLOAD }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
  );
};
