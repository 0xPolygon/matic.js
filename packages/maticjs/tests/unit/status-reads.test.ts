/**
 * Status reads answer with a reason, they don't throw. One method per
 * question: it returns the answer together with why, as a string-literal
 * `reason`, so a caller never combines two calls that can disagree. `is*` /
 * `has*` methods exist only for reasonless chain facts and always resolve a
 * boolean (an object is truthy, so it must never carry an `is*` name).
 * Unresolved dependencies (bad input, a transaction that does not exist,
 * library failures) still reject.
 *
 * Two registries are the gate, each kept in step with the source by a scan:
 * - every `is*` / `has*` method must resolve `false` when unmet and declare a
 *   boolean return type;
 * - every `get*Status` method must have a case per reason value (read from
 *   the exported reason unions) and return it without throwing.
 *
 * Only the RPC boundary is faked. Keccak, RLP, log selection, the exit-hash
 * packing and the SDK's own checks are the real code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Adapter, Hex, ReadRequest, Receipt, WriteRequest } from '../../src/adapter.ts';
import type { CheckpointStatus, DepositStatus } from '../../src/pos/bridge-status.ts';
import type { WithdrawStatus } from '../../src/pos/withdraw-status.ts';

import { LogEventSignature } from '../../src/constant.ts';
import {
  BurnTxNotCheckpointedError,
  NegativeIndexError,
  TransactionHashRequiredError,
  TransactionNotFoundError
} from '../../src/errors.ts';
import { noopLogger } from '../../src/logger.ts';
import { POSClient } from '../../src/pos-client.ts';
import { ERC20 } from '../../src/pos/erc20.ts';
import { ERC721 } from '../../src/pos/erc721.ts';
import { ERC1155 } from '../../src/pos/erc1155.ts';
import { RootChainManager } from '../../src/pos/root_chain_manager.ts';
import { BufferUtil } from '../../src/utils/buffer-utils.ts';
import { Keccak } from '../../src/utils/keccak.ts';

const ZERO_TOPIC = `0x${'00'.repeat(32)}`;
const ADDR: Hex = '0x1111111111111111111111111111111111111111';
const PREDICATE: Hex = '0x2222222222222222222222222222222222222222';
const hex32 = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const hexNum = (n: number): string => `0x${n.toString(16)}`;

const PENDING = hex32(0xa1);
const MINED_UNCHECKPOINTED = hex32(0xa2);
const MINED_CHECKPOINTED = hex32(0xa3);
const MISSING = hex32(0xa4);
const DEPOSIT_PENDING = hex32(0xb1);
const DEPOSIT_UNSYNCED = hex32(0xb2);
const DEPOSIT_SYNCED = hex32(0xb3);

const LAST_CHILD_BLOCK = 100;

/** A child-chain receipt carrying a burn log for every transfer signature. */
function rawReceipt(hash: string, blockNumber: number): Record<string, unknown> {
  const log = (topics: string[], logIndex: number): Record<string, unknown> => ({
    address: ADDR,
    data: '0x',
    topics,
    logIndex: hexNum(logIndex),
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash: hex32(0xb10c),
    blockNumber: hexNum(blockNumber)
  });
  return {
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash: hex32(0xb10c),
    blockNumber: hexNum(blockNumber),
    from: ADDR,
    to: ADDR,
    contractAddress: null,
    cumulativeGasUsed: '0x5208',
    gasUsed: '0x5208',
    status: '0x1',
    logsBloom: `0x${'00'.repeat(256)}`,
    logs: [
      log([LogEventSignature.Erc20Transfer, hex32(1), ZERO_TOPIC, hex32(7)], 0),
      log([LogEventSignature.Erc20Transfer, hex32(1), ZERO_TOPIC, hex32(8)], 3),
      log([LogEventSignature.Erc1155Transfer, hex32(1), hex32(1), ZERO_TOPIC], 1),
      log([LogEventSignature.Erc1155BatchTransfer, hex32(1), hex32(1), ZERO_TOPIC], 2)
    ]
  };
}

/**
 * One scripted chain behind a single adapter. `reads` records every
 * contract read so a test can assert what was NOT read.
 */
class ScriptedChain implements Adapter {
  readonly reads: string[] = [];
  readonly exited = new Set<string>();
  lastStateId = 0n;
  /** tx hash -> block number (null while pending). */
  readonly txs = new Map<string, number | null>();
  readonly parentReceipts = new Map<string, Receipt>();

  constructor() {
    this.txs.set(PENDING, null);
    this.txs.set(MINED_UNCHECKPOINTED, LAST_CHILD_BLOCK + 50);
    this.txs.set(MINED_CHECKPOINTED, LAST_CHILD_BLOCK - 50);
    this.txs.set(DEPOSIT_PENDING, null);
    this.parentReceipts.set(DEPOSIT_UNSYNCED, depositReceipt(DEPOSIT_UNSYNCED, 5));
    this.parentReceipts.set(DEPOSIT_SYNCED, depositReceipt(DEPOSIT_SYNCED, 0));
  }

  getChainId(): Promise<number> {
    return Promise.resolve(1);
  }
  read(req: ReadRequest): Promise<unknown> {
    this.reads.push(req.functionName);
    switch (req.functionName) {
      case 'getLastChildBlock':
        return Promise.resolve(BigInt(LAST_CHILD_BLOCK));
      case 'processedExits':
        return Promise.resolve(this.exited.has(String(req.args?.[0])));
      case 'tokenToType':
        return Promise.resolve(hex32(1));
      case 'typeToPredicate':
        return Promise.resolve(PREDICATE);
      case 'getApproved':
        return Promise.resolve(ADDR);
      case 'lastStateId':
        return Promise.resolve(this.lastStateId);
      default:
        return Promise.resolve(false);
    }
  }
  write(_req: WriteRequest): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  prepareWrite(_req: WriteRequest): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  estimateGas(_req: WriteRequest): Promise<bigint> {
    return Promise.resolve(0n);
  }
  getTransactionReceipt(hash: string): Promise<Receipt | null> {
    return Promise.resolve(this.parentReceipts.get(hash) ?? null);
  }
  keccak256(data: Uint8Array | string): string {
    return BufferUtil.bufferToHex(Keccak.keccak256(BufferUtil.toBuffer(data)));
  }
  request<T>(method: string, params: readonly unknown[]): Promise<T> {
    const hash = String(params[0]);
    const block = this.txs.get(hash);
    const answer = ((): unknown => {
      if (method === 'eth_getTransactionByHash') {
        return block === undefined
          ? null
          : { hash, blockNumber: block === null ? null : hexNum(block) };
      }
      if (method === 'eth_getTransactionReceipt') {
        return block === undefined || block === null ? null : rawReceipt(hash, block);
      }
      throw new Error(`unscripted ${method}`);
    })();
    // The scripted answers are shaped per method above; `request` is
    // generic over the caller's expected shape.
    return Promise.resolve(answer as T);
  }
}

function depositReceipt(hash: Hex, stateId: number): Receipt {
  return {
    transactionHash: hash,
    status: 'success',
    blockNumber: 1n,
    logs: [
      {
        address: ADDR,
        topics: [LogEventSignature.StateSynced as Hex, hex32(stateId)],
        data: '0x',
        logIndex: 0
      }
    ]
  };
}

async function clientOn(chain: ScriptedChain): Promise<POSClient> {
  return POSClient.init({
    network: 'amoy',
    parent: chain,
    child: chain,
    addresses: {
      RootChainManager: ADDR,
      ERC20Predicate: PREDICATE,
      ERC721Predicate: PREDICATE,
      ERC1155Predicate: PREDICATE,
      EtherPredicate: PREDICATE,
      RootChain: ADDR,
      GasSwapper: ADDR
    }
  });
}

const rejection = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e
  );

type Ctx = { chain: ScriptedChain; pos: POSClient };

const bridgeOf = (pos: POSClient): BridgeShape => Reflect.get(pos, 'bridge') as BridgeShape;

/** The slice of the internal bridge the registry drives. */
interface BridgeShape {
  getWithdrawStatus: (h: string, s: string) => Promise<unknown>;
  getWithdrawStatusOnIndex: (h: string, i: number, s: string) => Promise<unknown>;
  getWithdrawStatusOnIndices: (h: string, i: number[], s: string) => Promise<unknown>;
  getCheckpointStatus: (h: string) => Promise<unknown>;
  getDepositStatus: (h: string) => Promise<unknown>;
}

// --- is* / has*: reasonless chain facts, always boolean ---------------------

interface BooleanEntry {
  /** Drive the method into the state it asks about being unmet. */
  unmet: (ctx: Ctx) => Promise<unknown>;
}

/** One entry per `is*` / `has*` method in `src`; the scan below keeps this in step. */
const BOOLEANS: Record<string, BooleanEntry> = {
  'ERC721.isApproved': { unmet: ({ pos }) => pos.parent.erc721(ADDR).isApproved(1n) },
  'ERC721.isApprovedAll': { unmet: ({ pos }) => pos.parent.erc721(ADDR).isApprovedAll(ADDR) },
  'ERC1155.isApprovedAll': { unmet: ({ pos }) => pos.parent.erc1155(ADDR).isApprovedAll(ADDR) },
  'RootChainManager.isExitProcessed': {
    unmet: ({ chain }) =>
      new RootChainManager({
        adapter: chain,
        getAddress: () => Promise.resolve(ADDR),
        logger: noopLogger
      }).isExitProcessed(hex32(9))
  }
};

// --- get*Status: the answer with its reason ---------------------------------

interface Case {
  /** The reason value this case reaches; null for the positive answer. */
  reason: string | null;
  run: (ctx: Ctx) => Promise<unknown>;
  expected: unknown;
  /** Make every `processedExits` read answer true before the call. */
  exitedOnChain?: boolean;
  /** Further scripting of the chain before the call. */
  script?: (chain: ScriptedChain) => void;
}

interface StatusEntry {
  /** The exported reason union this method's `reason` ranges over. */
  reasonType: string;
  cases: Case[];
}

const NOT_CHECKPOINTED: WithdrawStatus = { exited: false, reason: 'not-checkpointed' };
const PENDING_STATUS: WithdrawStatus = { exited: false, reason: 'pending' };
const NOT_EXITED: WithdrawStatus = { exited: false, reason: 'not-exited' };
const EXITED: WithdrawStatus = { exited: true };

/** The four withdraw outcomes for a read that takes a burn hash. */
const withdrawCases = ({
  read,
  wrap = (s) => s
}: {
  read: (ctx: Ctx, hash: string) => Promise<unknown>;
  wrap?: (s: WithdrawStatus) => unknown;
}): Case[] => [
  {
    reason: 'not-checkpointed',
    run: (ctx) => read(ctx, MINED_UNCHECKPOINTED),
    expected: wrap(NOT_CHECKPOINTED)
  },
  {
    reason: 'pending',
    run: (ctx) => read(ctx, PENDING),
    expected: wrap(PENDING_STATUS)
  },
  {
    reason: 'not-exited',
    run: (ctx) => read(ctx, MINED_CHECKPOINTED),
    expected: wrap(NOT_EXITED)
  },
  {
    reason: null,
    run: (ctx) => read(ctx, MINED_CHECKPOINTED),
    expected: wrap(EXITED),
    exitedOnChain: true
  }
];

const erc20Sig = LogEventSignature.Erc20Transfer;
const list = (s: WithdrawStatus): WithdrawStatus[] => [s, s];

const withdrawEntry = (cases: Case[]): StatusEntry => ({
  reasonType: 'WithdrawNotExitedReason',
  cases
});

const checkpointEntry: StatusEntry = {
  reasonType: 'CheckpointNotReachedReason',
  cases: [
    {
      reason: 'pending',
      run: ({ pos }) => pos.getCheckpointStatus(PENDING),
      expected: { checkpointed: false, reason: 'pending' } satisfies CheckpointStatus
    },
    {
      reason: 'not-checkpointed',
      run: ({ pos }) => pos.getCheckpointStatus(MINED_UNCHECKPOINTED),
      expected: { checkpointed: false, reason: 'not-checkpointed' } satisfies CheckpointStatus
    },
    {
      reason: null,
      run: ({ pos }) => pos.getCheckpointStatus(MINED_CHECKPOINTED),
      expected: { checkpointed: true } satisfies CheckpointStatus
    }
  ]
};

const depositEntry: StatusEntry = {
  reasonType: 'DepositNotSyncedReason',
  cases: [
    {
      reason: 'pending',
      run: ({ pos }) => pos.getDepositStatus(DEPOSIT_PENDING),
      expected: { deposited: false, reason: 'pending' } satisfies DepositStatus
    },
    {
      reason: 'not-synced',
      run: ({ pos }) => pos.getDepositStatus(DEPOSIT_UNSYNCED),
      expected: { deposited: false, reason: 'not-synced' } satisfies DepositStatus
    },
    {
      reason: null,
      run: ({ pos }) => pos.getDepositStatus(DEPOSIT_SYNCED),
      expected: { deposited: true } satisfies DepositStatus
    }
  ]
};

/** One entry per `get*Status` method in `src`; the scan below keeps this in step. */
const STATUS_READS: Record<string, StatusEntry> = {
  'POSClient.getWithdrawStatus': withdrawEntry(
    withdrawCases({ read: ({ pos }, h) => pos.getWithdrawStatus(h, erc20Sig) })
  ),
  'POSClient.getWithdrawStatusOnIndex': withdrawEntry(
    withdrawCases({ read: ({ pos }, h) => pos.getWithdrawStatusOnIndex(h, erc20Sig, 0) })
  ),
  'POSClient.getCheckpointStatus': checkpointEntry,
  'POSClient.getDepositStatus': depositEntry,
  'ERC20.getWithdrawExitStatus': withdrawEntry(
    withdrawCases({ read: ({ pos }, h) => pos.parent.erc20(ADDR).getWithdrawExitStatus(h) })
  ),
  'ERC721.getWithdrawExitStatus': withdrawEntry(
    withdrawCases({ read: ({ pos }, h) => pos.parent.erc721(ADDR).getWithdrawExitStatus(h) })
  ),
  'ERC721.getWithdrawExitStatusOnIndex': withdrawEntry(
    withdrawCases({
      read: ({ pos }, h) => pos.parent.erc721(ADDR).getWithdrawExitStatusOnIndex(h, 0)
    })
  ),
  'ERC721.getWithdrawExitStatusOnIndices': withdrawEntry(
    withdrawCases({
      read: ({ pos }, h) => pos.parent.erc721(ADDR).getWithdrawExitStatusOnIndices(h, [0, 1]),
      wrap: list
    })
  ),
  'ERC1155.getWithdrawExitStatus': withdrawEntry(
    withdrawCases({ read: ({ pos }, h) => pos.parent.erc1155(ADDR).getWithdrawExitStatus(h) })
  ),
  'ERC1155.getWithdrawExitStatusMany': withdrawEntry(
    withdrawCases({ read: ({ pos }, h) => pos.parent.erc1155(ADDR).getWithdrawExitStatusMany(h) })
  ),
  'POSBridgeHelpers.getWithdrawStatus': withdrawEntry(
    withdrawCases({ read: ({ pos }, h) => bridgeOf(pos).getWithdrawStatus(h, erc20Sig) })
  ),
  'POSBridgeHelpers.getWithdrawStatusOnIndex': withdrawEntry(
    withdrawCases({ read: ({ pos }, h) => bridgeOf(pos).getWithdrawStatusOnIndex(h, 0, erc20Sig) })
  ),
  'POSBridgeHelpers.getWithdrawStatusOnIndices': withdrawEntry(
    withdrawCases({
      read: ({ pos }, h) => bridgeOf(pos).getWithdrawStatusOnIndices(h, [0, 1], erc20Sig),
      wrap: list
    })
  ),
  'POSBridgeHelpers.getCheckpointStatus': {
    reasonType: 'CheckpointNotReachedReason',
    cases: checkpointEntry.cases.map((c) => ({
      ...c,
      run: ({ pos }: Ctx) => bridgeOf(pos).getCheckpointStatus(hashOfCheckpointCase(c))
    }))
  },
  'POSBridgeHelpers.getDepositStatus': {
    reasonType: 'DepositNotSyncedReason',
    cases: depositEntry.cases.map((c) => ({
      ...c,
      run: ({ pos }: Ctx) => bridgeOf(pos).getDepositStatus(hashOfDepositCase(c))
    }))
  }
};

function hashOfCheckpointCase(c: Case): string {
  if (c.reason === 'pending') return PENDING;
  return c.reason === 'not-checkpointed' ? MINED_UNCHECKPOINTED : MINED_CHECKPOINTED;
}
function hashOfDepositCase(c: Case): string {
  if (c.reason === 'pending') return DEPOSIT_PENDING;
  return c.reason === 'not-synced' ? DEPOSIT_UNSYNCED : DEPOSIT_SYNCED;
}

// --- source scans -----------------------------------------------------------

const SRC = join(__dirname, '..', '..', 'src');

interface Declared {
  name: string;
  /** Text between the closing `)` of the parameter list and the body `{`. */
  returnType: string;
}

/** Every async method whose name matches `pattern`, as `Class.method`. */
function methodsInSource(pattern: RegExp): Declared[] {
  const found: Declared[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts')) scan(path);
    }
  };
  const scan = (path: string): void => {
    const lines = readFileSync(path, 'utf8').split('\n');
    let cls = '';
    lines.forEach((line, at) => {
      const c = /^(?:export )?class (\w+)/.exec(line);
      if (c?.[1] !== undefined) cls = c[1];
      const m = /^ {2}(?:async )?(\w+)\s*[(<]/.exec(line);
      const method = m?.[1];
      if (method === undefined || !pattern.test(method) || cls === '') return;
      // The signature may span lines; read up to the line that opens the body.
      let signature = line;
      for (let i = at + 1; !/\{\s*$/.test(signature) && i < lines.length; i++) {
        signature += `\n${lines[i] ?? ''}`;
      }
      const ret = /\)\s*:\s*([^{]+?)\s*\{\s*$/.exec(signature);
      found.push({ name: `${cls}.${method}`, returnType: ret?.[1] ?? '' });
    });
  };
  walk(SRC);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** The literal members of each exported `*Reason` union, read from the source. */
function reasonUnions(): Map<string, string[]> {
  const unions = new Map<string, string[]>();
  for (const file of ['withdraw-status.ts', 'bridge-status.ts']) {
    const text = readFileSync(join(SRC, 'pos', file), 'utf8');
    for (const m of text.matchAll(/export type (\w+Reason) =\s*([^;]+);/g)) {
      const literals = [...(m[2] ?? '').matchAll(/'([^']+)'/g)].map((l) => l[1] ?? '');
      unions.set(m[1] ?? '', literals);
    }
  }
  return unions;
}

const IS_OR_HAS = /^(?:is|has)[A-Z]\w*$/;
const GET_STATUS = /^get\w*Status\w*$/;

describe('is* / has* methods are reasonless chain facts that resolve a boolean', () => {
  it('has a registry entry for every is*/has* method in src, and no stale ones', () => {
    expect(Object.keys(BOOLEANS).sort()).deep.equal(
      methodsInSource(IS_OR_HAS)
        .map((d) => d.name)
        .sort()
    );
  });

  it('declares Promise<boolean> or boolean as the return type of every is*/has* method', () => {
    for (const d of methodsInSource(IS_OR_HAS)) {
      expect(['Promise<boolean>', 'boolean'], d.name).include(d.returnType);
    }
  });

  for (const [name, entry] of Object.entries(BOOLEANS)) {
    it(`${name} resolves false when the asked-about condition is unmet`, async () => {
      const chain = new ScriptedChain();
      const pos = await clientOn(chain);
      const settled = await entry.unmet({ chain, pos }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      expect(settled).not.property('error');
      expect(settled).property('value').equal(false);
    });
  }
});

describe('get*Status methods answer with a reason and do not throw', () => {
  it('has a registry entry for every get*Status method in src, and no stale ones', () => {
    expect(Object.keys(STATUS_READS).sort()).deep.equal(
      methodsInSource(GET_STATUS)
        .map((d) => d.name)
        .sort()
    );
  });

  it('has a case for every value of the reason union each method declares', () => {
    const unions = reasonUnions();
    for (const [name, entry] of Object.entries(STATUS_READS)) {
      const declared = unions.get(entry.reasonType);
      expect(declared, `${name}: ${entry.reasonType} not found in src/pos`).not.equal(undefined);
      const reached = new Set(entry.cases.map((c) => c.reason).filter((r) => r !== null));
      expect([...reached].sort(), name).deep.equal([...(declared ?? [])].sort());
      expect(
        entry.cases.some((c) => c.reason === null),
        `${name} needs a positive case`
      ).equal(true);
    }
  });

  it('exports every status type and reason union from the package root', () => {
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
    for (const type of [
      'WithdrawStatus',
      'WithdrawNotExitedReason',
      'CheckpointStatus',
      'CheckpointNotReachedReason',
      'DepositStatus',
      'DepositNotSyncedReason'
    ]) {
      expect(index, type).match(new RegExp(`\\b${type}\\b`));
    }
  });

  for (const [name, entry] of Object.entries(STATUS_READS)) {
    entry.cases.forEach((c, n) => {
      it(`${name} #${String(n + 1)} returns ${c.reason === null ? 'the positive answer' : `reason '${c.reason}'`} without throwing`, async () => {
        const chain = new ScriptedChain();
        if (c.exitedOnChain === true) {
          const original = chain.read.bind(chain);
          // Whatever key the SDK derives, an exited chain answers true to every processedExits read.
          chain.read = (req): Promise<unknown> =>
            req.functionName === 'processedExits' ? Promise.resolve(true) : original(req);
        }
        c.script?.(chain);
        const pos = await clientOn(chain);
        const settled = await c.run({ chain, pos }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        );
        expect(settled).not.property('error');
        expect(settled).property('value').deep.equal(c.expected);
      });
    });
  }
});

describe('the removed boolean twins stay removed', () => {
  it('has no is* sibling of a status read on any public surface', () => {
    const removed: Array<[string, object]> = [
      ['isWithdrawn', POSClient.prototype],
      ['isWithdrawnOnIndex', POSClient.prototype],
      ['isCheckpointed', POSClient.prototype],
      ['isDeposited', POSClient.prototype],
      ['isWithdrawExited', ERC20.prototype],
      ['isWithdrawExited', ERC721.prototype],
      ['isWithdrawExitedOnIndex', ERC721.prototype],
      ['isWithdrawExitedOnIndices', ERC721.prototype],
      ['isWithdrawExited', ERC1155.prototype],
      ['isWithdrawExitedMany', ERC1155.prototype]
    ];
    for (const [method, proto] of removed) {
      expect(proto, method).not.property(method);
    }
  });
});

describe('the status family never reads processedExits for an unchecked burn', () => {
  it('does not read processedExits when the burn is mined but not checkpointed', async () => {
    const chain = new ScriptedChain();
    const pos = await clientOn(chain);
    await pos.parent.erc721(ADDR).getWithdrawExitStatus(MINED_UNCHECKPOINTED);
    expect(chain.reads).not.include('processedExits');
  });

  it('does not read processedExits when the burn is still pending', async () => {
    const chain = new ScriptedChain();
    const pos = await clientOn(chain);
    await pos.getWithdrawStatus(PENDING, erc20Sig);
    expect(chain.reads).not.include('processedExits');
  });
});

describe('unresolved dependencies still reject', () => {
  it('rejects a transaction that does not exist, on every status read', async () => {
    const pos = await clientOn(new ScriptedChain());
    for (const call of [
      () => pos.getWithdrawStatus(MISSING, erc20Sig),
      () => pos.getWithdrawStatusOnIndex(MISSING, erc20Sig, 0),
      () => pos.getCheckpointStatus(MISSING),
      () => pos.getDepositStatus(MISSING)
    ]) {
      const err = await rejection(call());
      expect(err).property('name', 'BridgeStatusError');
      expect(TransactionNotFoundError.has(err)).equal(true);
    }
  });
  it('rejects an empty hash', async () => {
    const pos = await clientOn(new ScriptedChain());
    const err = await rejection(pos.getWithdrawStatus('', erc20Sig));
    expect(TransactionHashRequiredError.has(err)).equal(true);
  });
  it('rejects a negative index', async () => {
    const pos = await clientOn(new ScriptedChain());
    const err = await rejection(pos.getWithdrawStatusOnIndex(MINED_UNCHECKPOINTED, erc20Sig, -1));
    expect(NegativeIndexError.has(err)).equal(true);
  });
  it('rejects with the condition only where the method REQUIRES it', async () => {
    const pos = await clientOn(new ScriptedChain());
    const err = await rejection(pos.buildExitPayload(MINED_UNCHECKPOINTED, erc20Sig));
    expect(BurnTxNotCheckpointedError.has(err)).equal(true);
  });
});

describe('batch status reads', () => {
  it('return one status per index, all not-checkpointed', async () => {
    const pos = await clientOn(new ScriptedChain());
    expect(
      await pos.parent.erc721(ADDR).getWithdrawExitStatusOnIndices(MINED_UNCHECKPOINTED, [0, 1])
    ).deep.equal(Array(2).fill(NOT_CHECKPOINTED));
  });
});
