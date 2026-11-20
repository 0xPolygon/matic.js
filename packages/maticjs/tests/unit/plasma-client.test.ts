/**
 * `PlasmaClient.init`, address resolution, the client-level calls, and the
 * chain-id pin.
 *
 * Only the network boundary is faked: a recording adapter per chain and a
 * stubbed `fetch` for the address index. Address parsing, the Plasma-only
 * versus full-index discrimination, operation errors and the signer-chain
 * guard in the real viem adapter are the real code.
 */
import { createPublicClient, createWalletClient, custom } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import type { PlasmaAddresses } from '../../src/plasma/addresses.ts';

import { viemAdapter } from '../../src/adapters/viem.ts';
import {
  ContractNotAvailableOnNetworkError,
  ExitQueueEmptyError,
  InvalidNumericValueError,
  TransactionHashRequiredError,
  TransactionNotFoundError,
  UnsupportedNetworkError
} from '../../src/errors.ts';
import { ExitProofBuilder } from '../../src/internal/exit-proof.ts';
import { L1_CHAIN_ID, L2_CHAIN_ID } from '../../src/networks.ts';
import { PlasmaERC20 } from '../../src/plasma/erc20.ts';
import { PlasmaClient } from '../../src/plasma/plasma-client.ts';
import { __resetAddressCacheForTesting } from '../../src/services/address-service.ts';

const MANAGER: Hex = '0x1111111111111111111111111111111111111111';
const DEPOSIT_MANAGER: Hex = '0x2222222222222222222222222222222222222222';
const PREDICATE: Hex = '0x3333333333333333333333333333333333333333';
const EXIT_NFT: Hex = '0x4444444444444444444444444444444444444444';
const MATIC: Hex = '0x5555555555555555555555555555555555555555';
const POL: Hex = '0x6666666666666666666666666666666666666666';
const ROOT_CHAIN: Hex = '0x7777777777777777777777777777777777777777';
const POS_ADDRESS: Hex = '0x8888888888888888888888888888888888888888';
const QUEUE: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ZERO: Hex = '0x0000000000000000000000000000000000000000';
const TOKEN: Hex = '0x9999999999999999999999999999999999999999';
const USER: Hex = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BURN = `0x${'ab'.repeat(32)}`;
const INDEX_URL = 'https://index.example.test/network';

const PLASMA_ONLY: PlasmaAddresses = {
  RootChain: ROOT_CHAIN,
  DepositManager: DEPOSIT_MANAGER,
  WithdrawManager: MANAGER,
  PlasmaERC20Predicate: PREDICATE,
  ExitNFT: EXIT_NFT,
  MaticToken: MATIC,
  PolToken: POL
};

/** A flat index mirror: the bridge keys beside the seven Plasma ones. */
const FULL_INDEX = {
  RootChainManager: POS_ADDRESS,
  ERC20Predicate: POS_ADDRESS,
  ERC721Predicate: POS_ADDRESS,
  ERC1155Predicate: POS_ADDRESS,
  EtherPredicate: POS_ADDRESS,
  ...PLASMA_ONLY
};

/** A full bridge index: every PoS key, and none of the Plasma ones it does not share. */
const BRIDGE_INDEX: NetworkAddresses = {
  RootChainManager: POS_ADDRESS,
  ERC20Predicate: POS_ADDRESS,
  ERC721Predicate: POS_ADDRESS,
  ERC1155Predicate: POS_ADDRESS,
  EtherPredicate: POS_ADDRESS,
  RootChain: ROOT_CHAIN,
  MaticToken: MATIC,
  PolToken: POL
};
const PLASMA_KEYS = Object.keys(PLASMA_ONLY) as Array<keyof PlasmaAddresses>;

/** One chain behind one adapter. */
class Chain implements Adapter {
  readonly reads: ReadRequest[] = [];
  readonly writes: WriteRequest[] = [];
  readonly prepares: WriteRequest[] = [];
  queueSize = 0n;
  /** Answers for `request`; a method not listed rejects. */
  readonly rpc = new Map<string, unknown>();

  getChainId(): Promise<number> {
    return Promise.resolve(1);
  }
  read(req: ReadRequest): Promise<unknown> {
    this.reads.push(req);
    switch (req.functionName) {
      case 'exitsQueues':
        return Promise.resolve(this.queueSize === 0n ? ZERO : QUEUE);
      case 'currentSize':
        return Promise.resolve(this.queueSize);
      case 'ON_FINALIZE_GAS_LIMIT':
        return Promise.resolve(300_000n);
      case 'getLastChildBlock':
        return Promise.resolve(100n);
      default:
        return Promise.reject(new Error(`unscripted read ${req.functionName}`));
    }
  }
  write(req: WriteRequest): Promise<TxResult> {
    this.writes.push(req);
    return Promise.resolve({
      hash: `0x${'aa'.repeat(32)}`,
      confirmed: () => Promise.reject(new Error('not used'))
    });
  }
  prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    this.prepares.push(req);
    return Promise.resolve({ to: req.address, data: '0x' });
  }
  estimateGas(): Promise<bigint> {
    return Promise.resolve(100_000n);
  }
  getTransactionReceipt(): Promise<Receipt | null> {
    return Promise.resolve(null);
  }
  keccak256(): string {
    throw new Error('not used');
  }
  request<T>(method: string): Promise<T> {
    if (!this.rpc.has(method)) return Promise.reject(new Error(`unscripted ${method}`));
    return Promise.resolve(this.rpc.get(method) as T);
  }
}

const rejection = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
};

const initOn = ({
  parent = new Chain(),
  child = new Chain(),
  ...config
}: { parent?: Adapter; child?: Adapter } & Partial<Parameters<typeof PlasmaClient.init>[0]> = {}) =>
  PlasmaClient.init({ network: 'amoy', parent, child, ...config });

const without = <T extends object, K extends keyof T>(source: T, key: K): Omit<T, K> => {
  const { [key]: _omitted, ...rest } = source;
  return rest;
};

/** The CDN's nested index shape, with the Plasma contracts the client reads. */
const nestedIndex = (omit?: 'ExitNFT'): unknown => ({
  Main: {
    POSContracts: {
      RootChainManagerProxy: POS_ADDRESS,
      ERC20PredicateProxy: POS_ADDRESS,
      ERC721PredicateProxy: POS_ADDRESS,
      ERC1155PredicateProxy: POS_ADDRESS,
      EtherPredicateProxy: POS_ADDRESS
    },
    Contracts: {
      RootChainProxy: ROOT_CHAIN,
      DepositManagerProxy: DEPOSIT_MANAGER,
      WithdrawManagerProxy: MANAGER,
      ERC20Predicate: PREDICATE,
      ...(omit === 'ExitNFT' ? {} : { ExitNFT: EXIT_NFT }),
      Tokens: { MaticToken: MATIC },
      PolygonEcosystemToken: POL
    }
  }
});

const stubIndexFetch = (body: () => unknown) => {
  const fetchStub = vi.fn((_url: string) => Promise.resolve(new Response(JSON.stringify(body()))));
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
};

beforeEach(() => {
  __resetAddressCacheForTesting();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PlasmaClient.init address resolution', () => {
  it('uses a Plasma-only override without ever fetching the index', async () => {
    const fetchStub = stubIndexFetch(() => nestedIndex());
    const plasma = await initOn({ addresses: PLASMA_ONLY });
    expect(await plasma.getAddresses()).deep.equals(PLASMA_ONLY);
    expect(fetchStub.mock.calls).lengthOf(0);
  });

  it('hands out a fresh copy of a Plasma-only override on every call', async () => {
    const plasma = await initOn({ addresses: PLASMA_ONLY });
    const first = await plasma.getAddresses();
    first.DepositManager = ZERO;
    expect(await plasma.getAddresses())
      .property('DepositManager')
      .equals(DEPOSIT_MANAGER);
  });

  it('returns only the seven Plasma addresses of an override that also carries PoS keys', async () => {
    const fetchStub = stubIndexFetch(() => nestedIndex());
    const plasma = await initOn({ addresses: FULL_INDEX });
    expect(await plasma.getAddresses()).deep.equals(PLASMA_ONLY);
    expect(fetchStub.mock.calls).lengthOf(0);
  });

  it('refuses a full bridge index, naming the Plasma keys it lacks', async () => {
    const err = await rejection(() => initOn({ addresses: BRIDGE_INDEX as never }));
    expect(err).property('name').equals('InitError');
    expect(ContractNotAvailableOnNetworkError.find(err)?.info).deep.equals({
      network: 'amoy',
      missing: ['DepositManager', 'WithdrawManager', 'PlasmaERC20Predicate', 'ExitNFT']
    });
  });

  it('resolves the seven Plasma addresses from the address index URL, one fetch', async () => {
    const fetchStub = stubIndexFetch(() => nestedIndex());
    const plasma = await initOn({ addressIndexUrl: INDEX_URL });
    expect(await plasma.getAddresses()).deep.equals(PLASMA_ONLY);
    expect(fetchStub.mock.calls).lengthOf(1);
  });

  it.each(PLASMA_KEYS)('refuses a Plasma-only override without %s', async (key) => {
    const err = await rejection(() => initOn({ addresses: without(PLASMA_ONLY, key) as never }));
    expect(err).property('name').equals('InitError');
    expect(ContractNotAvailableOnNetworkError.find(err)?.info).deep.equals({
      network: 'amoy',
      missing: [key]
    });
  });

  it('refuses a Plasma-only override whose value is not an address', async () => {
    const err = await rejection(() =>
      initOn({ addresses: { ...PLASMA_ONLY, ExitNFT: '0x1234' as Hex } })
    );
    expect(ContractNotAvailableOnNetworkError.find(err)?.info.missing).deep.equals(['ExitNFT']);
  });

  it.each(PLASMA_KEYS)('refuses an override with PoS keys but without %s', async (key) => {
    const err = await rejection(() => initOn({ addresses: without(FULL_INDEX, key) as never }));
    expect(err).property('name').equals('InitError');
    expect(ContractNotAvailableOnNetworkError.find(err)?.info).deep.equals({
      network: 'amoy',
      missing: [key]
    });
  });

  it('refuses a fetched index that lacks a Plasma contract', async () => {
    stubIndexFetch(() => nestedIndex('ExitNFT'));
    const err = await rejection(() => initOn({ addressIndexUrl: INDEX_URL }));
    expect(ContractNotAvailableOnNetworkError.find(err)?.info.missing).deep.equals(['ExitNFT']);
  });

  it('keeps serving the last good addresses and reports the error when a refresh drops a Plasma key', async () => {
    let served: unknown = FULL_INDEX;
    const fetchStub = stubIndexFetch(() => served);
    const errors: Error[] = [];
    const plasma = await initOn({
      addressIndexUrl: INDEX_URL,
      addressTTLMs: 10,
      onAddressRefreshError: (err) => {
        errors.push(err);
      }
    });
    expect(await plasma.getAddresses()).deep.equals(PLASMA_ONLY);
    served = without(FULL_INDEX, 'ExitNFT');
    // Past the TTL the cached value is served while one refresh runs.
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(await plasma.getAddresses()).deep.equals(PLASMA_ONLY);
    await vi.waitFor(() => {
      expect(errors).lengthOf(1);
    });
    expect(fetchStub.mock.calls).lengthOf(2);
    expect(ContractNotAvailableOnNetworkError.find(errors[0])?.info.missing).deep.equals([
      'ExitNFT'
    ]);
    // The rejected index was never stored: later reads still get the last good one.
    expect(await plasma.getAddresses()).deep.equals(PLASMA_ONLY);
    expect(await plasma.getAddresses())
      .property('ExitNFT')
      .equals(EXIT_NFT);
  });
});

describe('PlasmaClient.init configuration', () => {
  it.each([0, -1, 1.5, Number.NaN])('rejects proofConcurrency %s', async (value) => {
    const err = await rejection(() => initOn({ addresses: PLASMA_ONLY, proofConcurrency: value }));
    expect(err).property('name').equals('InitError');
    expect(InvalidNumericValueError.has(err)).equals(true);
  });

  it('accepts a positive integer proofConcurrency', async () => {
    expect(await initOn({ addresses: PLASMA_ONLY, proofConcurrency: 2 })).instanceOf(PlasmaClient);
  });

  it.each([
    ['parent', { parent: 0, child: 1 }],
    ['child', { parent: 1, child: 1.5 }]
  ])('rejects an invalid chainIds.%s', async (_side, chainIds) => {
    const err = await rejection(() => initOn({ addresses: PLASMA_ONLY, chainIds }));
    expect(InvalidNumericValueError.has(err)).equals(true);
  });

  it('builds token handles for each side', async () => {
    const plasma = await initOn({ addresses: PLASMA_ONLY });
    expect(plasma.parent.erc20(TOKEN)).instanceOf(PlasmaERC20);
    expect(plasma.parent.erc20(TOKEN)).property('isParent').equals(true);
    expect(plasma.child.erc20(TOKEN)).instanceOf(PlasmaERC20);
    expect(plasma.child.erc20(TOKEN)).property('isParent').equals(false);
  });

  it('pins writes to the network ids, and to chainIds when declared', async () => {
    const pinned = { parent: new Chain(), child: new Chain() };
    const preset = await initOn({ ...pinned, addresses: PLASMA_ONLY });
    await preset.parent.erc20(TOKEN).approve(1n);
    await preset.child.erc20(TOKEN).startWithdraw(1n);
    expect(pinned.parent.writes[0]).property('chainId').equals(L1_CHAIN_ID.amoy);
    expect(pinned.child.writes[0]).property('chainId').equals(L2_CHAIN_ID.amoy);

    const declared = { parent: new Chain(), child: new Chain() };
    const devnet = await initOn({
      ...declared,
      addresses: PLASMA_ONLY,
      chainIds: { parent: 3151908, child: 4927 }
    });
    await devnet.parent.erc20(TOKEN).approve(1n);
    await devnet.child.erc20(TOKEN).startWithdraw(1n);
    expect(declared.parent.writes[0]).property('chainId').equals(3151908);
    expect(declared.child.writes[0]).property('chainId').equals(4927);
  });
});

describe('PlasmaClient.processExits', () => {
  it('routes one token to processExits and several to processExitsBatch, on the manager', async () => {
    const parent = new Chain();
    parent.queueSize = 1n;
    const plasma = await initOn({ parent, addresses: PLASMA_ONLY });
    await plasma.processExits({ tokens: [MATIC] });
    await plasma.processExits({ tokens: [MATIC, TOKEN] });
    expect(parent.writes.map((w) => w.functionName)).deep.equals([
      'processExits',
      'processExitsBatch'
    ]);
    expect(parent.writes[0]).property('address').equals(MANAGER);
    expect(parent.writes[0]).property('chainId').equals(L1_CHAIN_ID.amoy);
  });

  it('prepares the same call without sending', async () => {
    const parent = new Chain();
    parent.queueSize = 1n;
    const plasma = await initOn({ parent, addresses: PLASMA_ONLY });
    const prepared = await plasma.prepareProcessExits({ tokens: [MATIC] });
    expect(prepared).property('to').equals(MANAGER);
    expect(parent.writes).lengthOf(0);
    expect(parent.prepares[0]).property('functionName').equals('processExits');
  });

  it('rejects an empty queue as ExitError caused by ExitQueueEmptyError, sending nothing', async () => {
    const parent = new Chain();
    const plasma = await initOn({ parent, addresses: PLASMA_ONLY });
    const err = await rejection(() => plasma.processExits({ tokens: [MATIC] }));
    expect(err).property('name').equals('ExitError');
    expect(err).property('info').property('operation').equals('processExits');
    expect(ExitQueueEmptyError.find(err)?.info.tokens).deep.equals([MATIC]);
    expect(parent.writes).lengthOf(0);
  });
});

describe('PlasmaClient.getProcessExitsGasLimit', () => {
  const clientWithQueue = async (queueSize: bigint) => {
    const parent = new Chain();
    parent.queueSize = queueSize;
    return { parent, plasma: await initOn({ parent, addresses: PLASMA_ONLY }) };
  };

  it.each([
    [1n, 450_000n],
    [3n, 1_150_000n],
    [500n, 16_000_000n]
  ])(
    'equals the limit processExits sends with no gasLimit, for %s queued exits (%s)',
    async (queueSize, expected) => {
      const { parent, plasma } = await clientWithQueue(queueSize);
      const limit = await plasma.getProcessExitsGasLimit({ tokens: [MATIC] });
      expect(limit).equals(expected);
      expect(parent.writes).lengthOf(0);
      expect(parent.prepares).lengthOf(0);
      await plasma.processExits({ tokens: [MATIC] });
      expect(parent.writes[0]).property('gasLimit').equals(limit);
    }
  );

  it('counts the exits of every token named, as the batch write does', async () => {
    const { parent, plasma } = await clientWithQueue(2n);
    const limit = await plasma.getProcessExitsGasLimit({ tokens: [MATIC, TOKEN] });
    expect(limit).equals(100_000n + 4n * 350_000n);
    await plasma.processExits({ tokens: [MATIC, TOKEN] });
    expect(parent.writes[0]).property('functionName').equals('processExitsBatch');
    expect(parent.writes[0]).property('gasLimit').equals(limit);
  });

  it('rejects an empty queue as ExitError caused by ExitQueueEmptyError, estimating nothing', async () => {
    const { parent, plasma } = await clientWithQueue(0n);
    let estimated = 0;
    parent.estimateGas = (): Promise<bigint> => {
      estimated += 1;
      return Promise.resolve(1n);
    };
    const err = await rejection(() => plasma.getProcessExitsGasLimit({ tokens: [MATIC] }));
    expect(err).property('name').equals('ExitError');
    expect(err).property('info').property('operation').equals('getProcessExitsGasLimit');
    expect(err).property('info').property('mode').equals('read');
    expect(ExitQueueEmptyError.find(err)?.info.tokens).deep.equals([MATIC]);
    expect(estimated).equals(0);
    expect(parent.writes).lengthOf(0);
  });

  it('rethrows an estimation failure as the same object', async () => {
    const { parent, plasma } = await clientWithQueue(1n);
    const libraryError = new Error('execution reverted');
    parent.estimateGas = (): Promise<bigint> => Promise.reject(libraryError);
    const err = await rejection(() => plasma.getProcessExitsGasLimit({ tokens: [MATIC] }));
    expect(err).equals(libraryError);
  });

  it('rethrows a queue read failure as the same object', async () => {
    const { parent, plasma } = await clientWithQueue(1n);
    const libraryError = new Error('rpc down');
    parent.read = (): Promise<unknown> => Promise.reject(libraryError);
    const err = await rejection(() => plasma.getProcessExitsGasLimit({ tokens: [MATIC] }));
    expect(err).equals(libraryError);
  });
});

describe('PlasmaClient.getWithdrawStatus', () => {
  const pendingBurn = (): Chain => {
    const child = new Chain();
    child.rpc.set('eth_getTransactionByHash', { hash: BURN, blockNumber: null });
    return child;
  };

  it("answers 'pending' for a burn in no block", async () => {
    const plasma = await initOn({ child: pendingBurn(), addresses: PLASMA_ONLY });
    expect(await plasma.getWithdrawStatus({ burnTxHash: BURN })).deep.equals({
      exited: false,
      reason: 'pending'
    });
  });

  it('answers through a burn hash the node does not know as a rejected dependency', async () => {
    const child = new Chain();
    child.rpc.set('eth_getTransactionByHash', null);
    const plasma = await initOn({ child, addresses: PLASMA_ONLY });
    const err = await rejection(() => plasma.getWithdrawStatus({ burnTxHash: BURN }));
    expect(err).property('name').equals('BridgeStatusError');
    expect(err).property('info').property('burnTxHash').equals(BURN);
    expect(TransactionNotFoundError.has(err)).equals(true);
  });

  it('rejects an empty burn hash as missing input', async () => {
    const plasma = await initOn({ addresses: PLASMA_ONLY });
    const err = await rejection(() => plasma.getWithdrawStatus({ burnTxHash: '' }));
    expect(err).property('name').equals('BridgeStatusError');
    expect(TransactionHashRequiredError.has(err)).equals(true);
  });

  it('reads the burn through the same builder the exit payloads come from', async () => {
    const checkpoint = vi
      .spyOn(ExitProofBuilder.prototype, 'getCheckpointStatus')
      .mockResolvedValue({ checkpointed: false, reason: 'not-checkpointed' });
    const plasma = await initOn({ addresses: PLASMA_ONLY });
    expect(await plasma.getWithdrawStatus({ burnTxHash: BURN })).deep.equals({
      exited: false,
      reason: 'not-checkpointed'
    });
    expect(checkpoint.mock.calls).deep.equals([[BURN]]);
  });

  it("answers 'not-confirmed' for a checkpointed burn when no confirm transaction is given", async () => {
    vi.spyOn(ExitProofBuilder.prototype, 'getCheckpointStatus').mockResolvedValue({
      checkpointed: true
    });
    const plasma = await initOn({ addresses: PLASMA_ONLY });
    expect(await plasma.getWithdrawStatus({ burnTxHash: BURN })).deep.equals({
      exited: false,
      reason: 'not-confirmed'
    });
  });

  it('rejects when a burn reported checkpointed has no receipt to read its block from', async () => {
    vi.spyOn(ExitProofBuilder.prototype, 'getCheckpointStatus').mockResolvedValue({
      checkpointed: true
    });
    vi.spyOn(ExitProofBuilder.prototype, 'readBurn').mockResolvedValue({
      receipt: undefined,
      checkpointed: false
    });
    const confirm: Hex = `0x${'cd'.repeat(32)}`;
    const parent = new Chain();
    parent.getTransactionReceipt = (): Promise<Receipt | null> =>
      Promise.resolve({
        transactionHash: confirm,
        status: 'success',
        blockNumber: 1n,
        logs: [
          {
            address: MANAGER,
            topics: [
              '0xaa5303fdad123ab5ecaefaf69137bf8632257839546d43a3b3dd148cc2879d6f',
              `0x${'00'.repeat(32)}`,
              `0x${(1n << 33n).toString(16).padStart(64, '0')}`
            ],
            data: '0x',
            logIndex: 0
          }
        ]
      });
    const plasma = await initOn({ parent, addresses: PLASMA_ONLY });
    const err = await rejection(() =>
      plasma.getWithdrawStatus({ burnTxHash: BURN, confirmTxHash: confirm })
    );
    expect(err).property('name').equals('BridgeStatusError');
    expect(TransactionNotFoundError.has(err)).equals(true);
  });
});

describe('a wrong-chain signer is refused before anything is signed', () => {
  const HOSTILE_CHAIN = 5;
  const FROM = '0x2222222222222222222222222222222222222223';
  const GAS = { gasLimit: 100_000n };

  const viemOn = (chainId: number): { adapter: Adapter; broadcasts: () => number } => {
    let wireSends = 0;
    const transport = custom({
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
        if (method.startsWith('eth_send') || method.startsWith('eth_sign')) wireSends += 1;
        throw new Error(`stub transport: unexpected RPC ${method}`);
      }
    });
    const walletClient = createWalletClient({ account: FROM, transport });
    const writeSpy = vi
      .spyOn(walletClient, 'writeContract')
      .mockResolvedValue(`0x${'11'.repeat(32)}`);
    return {
      adapter: viemAdapter({ public: createPublicClient({ transport }), wallet: walletClient }),
      broadcasts: () => writeSpy.mock.calls.length + wireSends
    };
  };

  it.each([
    ['approve', 'parent', (p: PlasmaClient) => p.parent.erc20(TOKEN).approve(1n, GAS)],
    ['deposit', 'parent', (p: PlasmaClient) => p.parent.erc20(TOKEN).deposit(1n, USER, GAS)],
    ['startWithdraw', 'child', (p: PlasmaClient) => p.child.erc20(TOKEN).startWithdraw(1n, GAS)],
    [
      'native startWithdraw',
      'child',
      (p: PlasmaClient) =>
        p.child.erc20('0x0000000000000000000000000000000000001010').startWithdraw(1n, GAS)
    ],
    [
      'confirmWithdraw',
      'parent',
      (p: PlasmaClient) => {
        vi.spyOn(ExitProofBuilder.prototype, 'buildExitPayload').mockResolvedValue('0x01');
        return p.parent.erc20(TOKEN).confirmWithdraw(BURN, GAS);
      }
    ]
  ])('%s rejects with UnsupportedNetworkError naming the pinned chain', async (_n, side, write) => {
    const parent = viemOn(HOSTILE_CHAIN);
    const child = viemOn(HOSTILE_CHAIN);
    const plasma = await initOn({
      parent: parent.adapter,
      child: child.adapter,
      addresses: PLASMA_ONLY
    });
    const err = await rejection(() => write(plasma));
    const mismatch = UnsupportedNetworkError.find(err);
    expect(mismatch)
      .nested.property('info.expected')
      .equals(side === 'parent' ? L1_CHAIN_ID.amoy : L2_CHAIN_ID.amoy);
    expect(mismatch).nested.property('info.actual').equals(HOSTILE_CHAIN);
    expect(parent.broadcasts() + child.broadcasts()).equals(0);
  });
});
