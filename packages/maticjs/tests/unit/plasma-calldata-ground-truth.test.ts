import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JsonRpcProvider, Network } from 'ethers';
import { providers } from 'ethers-v5';
import {
  createPublicClient,
  decodeAbiParameters,
  http,
  parseAbiParameters,
  toFunctionSelector
} from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Hex, PreparedTx } from '../../src/adapter.ts';
import type { PlasmaAddresses } from '../../src/plasma/addresses.ts';
import type { PlasmaChildERC20, PlasmaParentERC20 } from '../../src/plasma/erc20.ts';
import type { Cassette } from './cassette-adapter.ts';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { PlasmaERC20 } from '../../src/plasma/erc20.ts';
import { PlasmaClient } from '../../src/plasma/plasma-client.ts';
import { cassetteAdapter, loadCassette } from './cassette-adapter.ts';

/**
 * Calldata ground truth: the proof that the Plasma surface encodes every
 * write exactly as the 3.x Plasma plugin did.
 *
 * `calldata-3x.json` holds the `to`, `data` and `value` the 3.x plugin
 * returned for fixed inputs (captured with `returnTransaction: true`;
 * nothing signed or broadcast). Each entry is prepared here through the
 * public `prepareXxx` surface under all three adapters and must match
 * byte for byte. The selector is also checked against a hand-written
 * signature, so a same-shaped but differently named function cannot pass.
 *
 * The adapters do the encoding. Reads (the queue size behind
 * `processExits`, and everything the confirm's exit payload is built
 * from) are answered by recorded data, so there is no network: the
 * confirm entry replays the cassette recorded for the burn named in its
 * `burnTxHash` field.
 *
 * Coverage is enforced twice. Every fixture entry gets a case under every
 * adapter. And every public write on the Plasma classes (found by
 * reflection: a method with a `prepareXxx` sibling) must be listed in
 * COVERAGE against a fixture entry, or be declared as having none, so a
 * write added later fails by name instead of shipping unchecked.
 *
 * A mismatch means the encoding changed. Never re-record the fixtures to
 * make this pass; see `tests/fixtures/plasma/README.md`.
 */

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'plasma');
const UNROUTABLE = 'http://127.0.0.1:1';
const PROOF_API = 'https://proof.example.test';
/** Any address works: the preparing paths never read the exit token contract. */
const EXIT_NFT: Hex = '0x4444444444444444444444444444444444444444';
/** What every scripted `exitsQueues` read answers: a token with an exit queue. */
const QUEUE: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// --- fixture loading (validated, not cast) ------------------------------

type Json = unknown;

function isRecord(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(obj: Json, key: string): Json {
  if (!isRecord(obj) || !(key in obj)) throw new Error(`fixture: missing ${key}`);
  return obj[key];
}

function str(obj: Json, key: string): string {
  const v = field(obj, key);
  if (typeof v !== 'string') throw new Error(`fixture: ${key} is not a string`);
  return v;
}

function hex(obj: Json, key: string): Hex {
  const v = str(obj, key);
  if (!/^0x[0-9a-fA-F]*$/.test(v)) throw new Error(`fixture: ${key} is not hex`);
  return `0x${v.slice(2)}`;
}

function int(obj: Json, key: string): bigint {
  const v = field(obj, key);
  if (typeof v !== 'string' && typeof v !== 'number') {
    throw new Error(`fixture: ${key} is not an integer`);
  }
  return BigInt(v);
}

function hexList(obj: Json, key: string): Hex[] {
  const v = field(obj, key);
  if (!Array.isArray(v)) throw new Error(`fixture: ${key} is not an array`);
  return v.map((item: Json): Hex => {
    if (typeof item !== 'string' || !/^0x[0-9a-fA-F]*$/.test(item)) {
      throw new Error(`fixture: ${key} holds a non-hex item`);
    }
    return `0x${item.slice(2)}`;
  });
}

function has(obj: Json, key: string): boolean {
  return isRecord(obj) && key in obj;
}

interface FixtureEntry {
  method3x: string;
  contract: string;
  functionName: string;
  to: Hex;
  data: Hex;
  value: bigint;
  /** The token the call was made on, when it has one. */
  token: Hex | undefined;
  burnTxHash: string | undefined;
  /** The token list of a batch `processExits`. */
  tokens: Hex[] | undefined;
}

const calldata: Json = JSON.parse(readFileSync(join(FIXTURE_DIR, 'calldata-3x.json'), 'utf8'));
const rawInputs = field(calldata, 'inputs');
const rawAddresses = field(calldata, 'addresses');
const rawEntries = field(calldata, 'entries');
if (!Array.isArray(rawEntries)) throw new Error('fixture: entries is not an array');

const ENTRIES: FixtureEntry[] = rawEntries.map((e: Json) => ({
  method3x: str(e, 'method'),
  contract: str(e, 'contract'),
  functionName: str(e, 'function'),
  to: hex(e, 'to'),
  data: hex(e, 'data'),
  value: int(e, 'value'),
  token: has(e, 'token') ? hex(e, 'token') : undefined,
  burnTxHash: has(e, 'burnTxHash') ? str(e, 'burnTxHash') : undefined,
  tokens: has(e, 'tokens') ? hexList(e, 'tokens') : undefined
}));

const INPUTS = { user: hex(rawInputs, 'user'), amount: int(rawInputs, 'amount') };
const MATIC = hex(rawAddresses, 'MaticToken');
const POL = hex(rawAddresses, 'PolToken');
const NATIVE_CHILD = hex(rawAddresses, 'nativeChildToken');
const NON_NATIVE_CHILD = hex(rawAddresses, 'nonNativeChildToken');

const keyOf = (e: Pick<FixtureEntry, 'method3x' | 'contract'>): string =>
  `${e.method3x}:${e.contract}`;

const entryFor = (key: string): FixtureEntry => {
  const found = ENTRIES.find((e) => keyOf(e) === key);
  if (found === undefined) throw new Error(`fixture has no entry ${key}`);
  return found;
};

const CONFIRM = entryFor('withdrawConfirm:ERC20Predicate');
const BURN = CONFIRM.burnTxHash ?? '';
if (BURN === '') throw new Error('fixture: the withdrawConfirm entry names no burnTxHash');
const BATCH_TOKENS = entryFor('PlasmaClient.withdrawExit:WithdrawManager').tokens ?? [];

const cassette: Cassette = loadCassette('plasma-erc20-burn-1.json');
if (cassette.burnTxHash.toLowerCase() !== BURN.toLowerCase()) {
  throw new Error('the cassette is not for the burn the withdrawConfirm entry was captured for');
}
const BURN_FIXTURE: Json = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'exits', 'plasma-erc20-burn-1.json'), 'utf8')
);
const RECORDED_PAYLOAD = hex(BURN_FIXTURE, 'expectedPayloadHex');

// The recording never saw the exit token contract, and 3.x resolved the
// predicate from its registry, so the predicate is configuration taken from
// the confirm entry's `to`: that entry proves the call is routed to the
// configured predicate with the 3.x bytes, not that the address was
// discovered.
const ADDRESSES: PlasmaAddresses = {
  RootChain: hex(rawAddresses, 'RootChain'),
  DepositManager: hex(rawAddresses, 'DepositManager'),
  WithdrawManager: hex(rawAddresses, 'WithdrawManager'),
  PlasmaERC20Predicate: CONFIRM.to,
  ExitNFT: EXIT_NFT,
  MaticToken: MATIC,
  PolToken: POL
};

const CONTRACT_ADDRESS: Record<string, Hex> = {
  MaticToken: MATIC,
  PolToken: POL,
  DepositManager: ADDRESSES.DepositManager,
  WithdrawManager: ADDRESSES.WithdrawManager,
  ERC20Predicate: ADDRESSES.PlasmaERC20Predicate,
  MRC20: NATIVE_CHILD,
  ChildERC20: NON_NATIVE_CHILD
};

// --- what each fixture entry is prepared through ------------------------

interface Variant {
  label: string;
  prepare: (plasma: PlasmaClient) => Promise<PreparedTx>;
  /** Needs a client built with a proof API URL. */
  fast?: boolean;
}

const parentToken = ({ plasma, token }: { plasma: PlasmaClient; token: Hex }): PlasmaParentERC20 =>
  plasma.parent.erc20(token);
const childToken = ({ plasma, token }: { plasma: PlasmaClient; token: Hex }): PlasmaChildERC20 =>
  plasma.child.erc20(token);

/** Keyed by `${3.x method}:${contract}`; every variant must equal the entry. */
const VARIANTS: Record<string, Variant[]> = {
  'approve:MaticToken': [
    {
      label: 'PlasmaERC20.prepareApprove (MATIC)',
      prepare: (p) => parentToken({ plasma: p, token: MATIC }).prepareApprove(INPUTS.amount)
    }
  ],
  'approve:PolToken': [
    {
      label: 'PlasmaERC20.prepareApprove (POL)',
      prepare: (p) => parentToken({ plasma: p, token: POL }).prepareApprove(INPUTS.amount)
    }
  ],
  'approveMax:PolToken': [
    {
      label: 'PlasmaERC20.prepareApproveMax',
      prepare: (p) => parentToken({ plasma: p, token: POL }).prepareApproveMax()
    }
  ],
  'deposit:DepositManager': [
    {
      label: 'PlasmaERC20.prepareDeposit',
      prepare: (p) =>
        parentToken({ plasma: p, token: POL }).prepareDeposit(INPUTS.amount, INPUTS.user)
    }
  ],
  'withdrawStart:MRC20': [
    {
      label: 'PlasmaERC20.prepareStartWithdraw (native token)',
      prepare: (p) =>
        childToken({ plasma: p, token: NATIVE_CHILD }).prepareStartWithdraw(INPUTS.amount)
    }
  ],
  'withdrawStart:ChildERC20': [
    {
      label: 'PlasmaERC20.prepareStartWithdraw (child ERC-20)',
      prepare: (p) =>
        childToken({ plasma: p, token: NON_NATIVE_CHILD }).prepareStartWithdraw(INPUTS.amount)
    }
  ],
  'withdrawConfirm:ERC20Predicate': [
    {
      label: 'PlasmaERC20.prepareConfirmWithdraw',
      prepare: (p) => parentToken({ plasma: p, token: MATIC }).prepareConfirmWithdraw(BURN)
    },
    {
      // 3.x has no fast confirm. Handed the payload the proof API recorded
      // for this burn, the fast path must encode the same call as the slow
      // one; the live test checks the API itself against local construction.
      label: 'PlasmaERC20.prepareConfirmWithdrawFast (proof API returns the recorded payload)',
      fast: true,
      prepare: (p) => parentToken({ plasma: p, token: MATIC }).prepareConfirmWithdrawFast(BURN)
    }
  ],
  'withdrawExit:WithdrawManager': [
    {
      label: 'PlasmaERC20.prepareCompleteWithdraw (MATIC handle)',
      prepare: (p) => parentToken({ plasma: p, token: MATIC }).prepareCompleteWithdraw()
    },
    {
      label: 'PlasmaERC20.prepareCompleteWithdraw (POL handle maps to the MATIC queue)',
      prepare: (p) => parentToken({ plasma: p, token: POL }).prepareCompleteWithdraw()
    },
    {
      label: 'PlasmaClient.prepareProcessExits (one token)',
      prepare: (p) => p.prepareProcessExits({ tokens: [MATIC] })
    }
  ],
  'PlasmaClient.withdrawExit:WithdrawManager': [
    {
      label: 'PlasmaClient.prepareProcessExits (two tokens)',
      prepare: (p) => p.prepareProcessExits({ tokens: BATCH_TOKENS })
    }
  ]
};

/**
 * Every public write, by `Class.method`, against the fixture entries that
 * check it. `none` declares a write with no 3.x entry, with the reason.
 */
const COVERAGE: Record<string, { entries: string[] } | { none: string }> = {
  'PlasmaERC20.approve': { entries: ['approve:MaticToken', 'approve:PolToken'] },
  'PlasmaERC20.approveMax': { entries: ['approveMax:PolToken'] },
  'PlasmaERC20.deposit': { entries: ['deposit:DepositManager'] },
  'PlasmaERC20.startWithdraw': { entries: ['withdrawStart:MRC20', 'withdrawStart:ChildERC20'] },
  'PlasmaERC20.confirmWithdraw': { entries: ['withdrawConfirm:ERC20Predicate'] },
  'PlasmaERC20.confirmWithdrawFast': { entries: ['withdrawConfirm:ERC20Predicate'] },
  'PlasmaERC20.completeWithdraw': { entries: ['withdrawExit:WithdrawManager'] },
  'PlasmaClient.processExits': {
    entries: ['withdrawExit:WithdrawManager', 'PlasmaClient.withdrawExit:WithdrawManager']
  }
};

/** Public methods that have a `prepareXxx` sibling: the writes. */
const writesOf = ({ name, proto }: { name: string; proto: object }): string[] => {
  const methods = new Set(Object.getOwnPropertyNames(proto));
  return [...methods]
    .filter((m) => {
      const sibling = `prepare${m.charAt(0).toUpperCase()}${m.slice(1)}`;
      return m !== 'constructor' && methods.has(sibling);
    })
    .map((m) => `${name}.${m}`);
};

const DISCOVERED_WRITES = [
  ...writesOf({ name: 'PlasmaERC20', proto: PlasmaERC20.prototype }),
  ...writesOf({ name: 'PlasmaClient', proto: PlasmaClient.prototype })
].sort();

// --- adapters -----------------------------------------------------------

/**
 * The real adapter encodes; recorded data answers every read. The fixture's
 * burn needs the cassette for both chains, and `processExits` needs the
 * queue reads the cassette does not hold.
 */
const withReplay = ({ real, replay }: { real: Adapter; replay: Adapter }): Adapter => ({
  getChainId: () => replay.getChainId(),
  read: (req) => replay.read(req),
  request: <T>(method: string, params: readonly unknown[]) => replay.request<T>(method, params),
  getTransactionReceipt: (hash) => replay.getTransactionReceipt(hash),
  keccak256: (data) => replay.keccak256(data),
  write: (req) => real.write(req),
  prepareWrite: (req) => real.prepareWrite(req),
  estimateGas: (req) => real.estimateGas(req)
});

const parentReplay = (): Adapter => {
  const recorded = cassetteAdapter(cassette.parent);
  return {
    ...recorded,
    read: (req) => {
      if (req.functionName === 'exitsQueues') return Promise.resolve(QUEUE);
      if (req.functionName === 'currentSize') return Promise.resolve(1n);
      return recorded.read(req);
    }
  };
};

const ADAPTERS: ReadonlyArray<{ name: string; build: () => Adapter }> = [
  {
    name: 'viem',
    build: () => viemAdapter({ public: createPublicClient({ transport: http(UNROUTABLE) }) })
  },
  {
    name: 'ethers v5',
    build: () => ethersV5Adapter({ provider: new providers.JsonRpcProvider(UNROUTABLE) })
  },
  {
    name: 'ethers v6',
    build: () =>
      ethersV6Adapter({
        provider: new JsonRpcProvider(UNROUTABLE, Network.from(1), { staticNetwork: true })
      })
  }
];

const clientOver = ({
  build,
  fast
}: {
  build: () => Adapter;
  fast: boolean;
}): Promise<PlasmaClient> =>
  PlasmaClient.init({
    network: 'mainnet',
    parent: withReplay({ real: build(), replay: parentReplay() }),
    child: withReplay({ real: build(), replay: cassetteAdapter(cassette.child) }),
    addresses: ADDRESSES,
    ...(fast ? { proofGenerationApiUrl: PROOF_API } : {})
  });

// --- selectors, written by hand so they do not depend on the SDK's ABI ---

const SIGNATURES: Record<string, string> = {
  'MaticToken.approve': 'approve(address,uint256)',
  'PolToken.approve': 'approve(address,uint256)',
  'DepositManager.depositERC20ForUser': 'depositERC20ForUser(address,address,uint256)',
  'MRC20.withdraw': 'withdraw(uint256)',
  'ChildERC20.withdraw': 'withdraw(uint256)',
  'ERC20Predicate.startExitWithBurntTokens': 'startExitWithBurntTokens(bytes)',
  'WithdrawManager.processExits': 'processExits(address)',
  'WithdrawManager.processExitsBatch': 'processExitsBatch(address[])'
};

function functionSignature(e: FixtureEntry): string {
  const sig = SIGNATURES[`${e.contract}.${e.functionName}`];
  if (sig === undefined) throw new Error(`no signature for ${e.contract}.${e.functionName}`);
  return sig;
}

// A byte-for-byte match proves argument order only if the arguments that
// could be swapped differ. A re-capture with repeated values would let a
// swap pass silently, so fail at load. The values are decoded from the
// captured `data`, the bytes the tests compare against.
for (const e of ENTRIES) {
  const sig = functionSignature(e);
  const types = sig.slice(sig.indexOf('(') + 1, -1);
  if (types === '') continue;
  const values = decodeAbiParameters(parseAbiParameters(types), `0x${e.data.slice(10)}`);
  const seen = new Map<string, string>();
  types.split(',').forEach((type, i) => {
    const key = `${type}:${String(values[i]).toLowerCase()}`;
    const clash = seen.get(key);
    if (clash !== undefined) {
      throw new Error(
        `fixture entry ${keyOf(e)}: ${type} arguments ${clash} and ${i} are equal; a swap would go undetected`
      );
    }
    seen.set(key, String(i));
  });
}

// A fixture that gained, lost or renamed an entry must fail loudly rather
// than silently shrink the comparison.
{
  const fixtureKeys = ENTRIES.map(keyOf).sort().join(',');
  const mappedKeys = Object.keys(VARIANTS).sort().join(',');
  if (ENTRIES.length !== 9 || fixtureKeys !== mappedKeys) {
    throw new Error(`fixture entries [${fixtureKeys}] do not match mapped entries [${mappedKeys}]`);
  }
}

// --- tests --------------------------------------------------------------

describe('plasma calldata: 3.x ground truth', { timeout: 30_000 }, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const adapter of ADAPTERS) {
    describe(`under ${adapter.name}`, () => {
      for (const entry of ENTRIES) {
        const variants = VARIANTS[keyOf(entry)] ?? [];
        for (const variant of variants) {
          it(`${entry.method3x} ${entry.contract}.${entry.functionName} -> ${variant.label}`, async () => {
            const fetchStub = vi.fn((_url: string) =>
              Promise.resolve(
                new Response(JSON.stringify({ message: 'success', result: RECORDED_PAYLOAD }))
              )
            );
            if (variant.fast === true) vi.stubGlobal('fetch', fetchStub);
            const plasma = await clientOver({
              build: adapter.build,
              fast: variant.fast === true
            });

            const prepared = await variant.prepare(plasma);

            expect(prepared.data).equals(entry.data);
            expect(prepared.to.toLowerCase()).equals(entry.to.toLowerCase());
            expect(prepared.to.toLowerCase()).equals(
              (CONTRACT_ADDRESS[entry.contract] ?? EXIT_NFT).toLowerCase()
            );
            expect(prepared.value ?? 0n).equals(entry.value);
            // The selector must be the fixture function's, not merely a
            // function with the same argument shape.
            expect(prepared.data.slice(0, 10)).equals(
              toFunctionSelector(`function ${functionSignature(entry)}`)
            );
            if (variant.fast === true) {
              // The API arm ran: a failed or skipped fetch would fall back to
              // local construction and still match, proving nothing.
              expect(fetchStub.mock.calls).lengthOf(1);
              expect(String(fetchStub.mock.calls[0]?.[0])).contains(`/exit-payload/${BURN}`);
            }
          });
        }
      }
    });
  }

  describe('coverage of the public writes', () => {
    it('lists every write the classes expose, and no write that is gone', () => {
      expect(Object.keys(COVERAGE).sort()).deep.equals(DISCOVERED_WRITES);
    });

    for (const write of DISCOVERED_WRITES) {
      it(`${write} has a fixture entry that checks it`, () => {
        const coverage = COVERAGE[write];
        if (coverage === undefined) throw new Error(`${write} is not in COVERAGE`);
        if ('none' in coverage) throw new Error(`${write} has no 3.x entry: ${coverage.none}`);
        expect(coverage.entries.length).greaterThan(0);
        for (const key of coverage.entries) {
          expect(ENTRIES.map(keyOf), `${write} names a fixture entry that is gone`).include(key);
          expect(VARIANTS[key]?.length ?? 0, `${key} is prepared through nothing`).greaterThan(0);
        }
      });
    }

    it('checks each write through the public prepare sibling it is named for', () => {
      const labels = Object.values(VARIANTS).flatMap((vs) => vs.map((v) => v.label));
      for (const write of DISCOVERED_WRITES) {
        const method = write.split('.')[1] ?? '';
        const sibling = `prepare${method.charAt(0).toUpperCase()}${method.slice(1)}`;
        expect(
          labels.some((l) => l.includes(`.${sibling}`)),
          `no variant calls ${sibling}`
        ).equals(true);
      }
    });
  });
});
