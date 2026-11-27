/**
 * `PlasmaClient.init`: address resolution and the init-time configuration
 * checks.
 *
 * Only the network boundary is faked: an inert adapter per chain and a
 * stubbed `fetch` for the address index. Address parsing and the Plasma-only
 * versus full-index discrimination are the real code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Hex, PreparedTx, Receipt, TxResult } from '../../src/adapter.ts';
import type { NetworkAddresses } from '../../src/networks.ts';
import type { PlasmaAddresses } from '../../src/plasma/addresses.ts';

import { ContractNotAvailableOnNetworkError, InvalidNumericValueError } from '../../src/errors.ts';
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
const ZERO: Hex = '0x0000000000000000000000000000000000000000';
const TOKEN: Hex = '0x9999999999999999999999999999999999999999';
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

/** An adapter that is never driven: init only needs the two chains to exist. */
class Chain implements Adapter {
  getChainId(): Promise<number> {
    return Promise.resolve(1);
  }
  read(): Promise<unknown> {
    return Promise.reject(new Error('not used'));
  }
  write(): Promise<TxResult> {
    return Promise.reject(new Error('not used'));
  }
  prepareWrite(): Promise<PreparedTx> {
    return Promise.reject(new Error('not used'));
  }
  estimateGas(): Promise<bigint> {
    return Promise.reject(new Error('not used'));
  }
  getTransactionReceipt(): Promise<Receipt | null> {
    return Promise.resolve(null);
  }
  keccak256(): string {
    throw new Error('not used');
  }
  request<T>(): Promise<T> {
    return Promise.reject(new Error('not used'));
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
});
