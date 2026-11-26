import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { info as mainnetInfo } from '@polygonlabs/meta/info/mainnet/v1';

import type {
  Adapter,
  PreparedTx,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';
import type { NetworkAddresses } from '../../src/networks.ts';
import type { StakingAddresses } from '../../src/staking/staking-client.ts';

import {
  BridgeEventDecodeFailedError,
  ContractNotAvailableOnNetworkError,
  isMaticjsError
} from '../../src/errors.ts';
import {
  __resetAddressCacheForTesting,
  createAddressFetcher
} from '../../src/services/address-service.ts';
import { StakingClient } from '../../src/staking/staking-client.ts';

/**
 * Pins how `StakingClient` classifies and resolves its `addresses`
 * input, as 4.0.0 behaves. Where the shipped behaviour is odd the test
 * records it rather than judging it. Complements `staking-client.test.ts`,
 * which covers the happy paths and the refresh behaviour.
 */

const BRIDGE: NetworkAddresses = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666'
};
const STAKING_ONLY: StakingAddresses = {
  StakeManager: '0x7777777777777777777777777777777777777777',
  MaticToken: '0x8888888888888888888888888888888888888888',
  PolToken: '0x9999999999999999999999999999999999999999'
};
const FULL: NetworkAddresses = { ...BRIDGE, ...STAKING_ONLY };
const GAS_SWAPPER = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';

class RecordingAdapter implements Adapter {
  getChainId(): Promise<number> {
    return Promise.resolve(1);
  }
  read(_req: ReadRequest): Promise<unknown> {
    return Promise.resolve(0n);
  }
  write(_req: WriteRequest): Promise<TxResult> {
    return Promise.resolve({ hash: '0xdead', confirmed: () => Promise.resolve({} as Receipt) });
  }
  prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    return Promise.resolve({ to: req.address, data: '0xfeed' });
  }
  estimateGas(_req: WriteRequest): Promise<bigint> {
    return Promise.resolve(21_000n);
  }
  getTransactionReceipt(_hash: string): Promise<Receipt | null> {
    return Promise.resolve(null);
  }
  keccak256(_data: Uint8Array | string): string {
    return '0x0';
  }
  request<T>(_method: string, _params: readonly unknown[]): Promise<T> {
    return Promise.resolve(undefined as T);
  }
}

/** `addresses` typed loosely: plain-JS consumers can pass anything. */
function init(addresses?: unknown): Promise<StakingClient> {
  return StakingClient.init({
    network: 'mainnet',
    parent: new RecordingAdapter(),
    addresses: addresses as NetworkAddresses | undefined
  });
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('StakingClient addresses from the CDN', () => {
  const BASE_URL = 'https://address-index.test/staking-compat';

  beforeEach(() => {
    __resetAddressCacheForTesting();
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify(mainnetInfo), { status: 200 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAddressCacheForTesting();
  });

  it('getAddresses() returns the full parsed index, PoS keys included', async () => {
    const client = await StakingClient.init({
      network: 'mainnet',
      parent: new RecordingAdapter(),
      addressIndexUrl: BASE_URL
    });
    const addresses = await client.getAddresses();
    const pos = mainnetInfo.Main.POSContracts;
    const contracts = mainnetInfo.Main.Contracts;
    expect(addresses).property('RootChainManager').equals(pos.RootChainManagerProxy);
    expect(addresses).property('ERC20Predicate').equals(pos.ERC20PredicateProxy);
    expect(addresses).property('ERC721Predicate').equals(pos.ERC721PredicateProxy);
    expect(addresses).property('ERC1155Predicate').equals(pos.ERC1155PredicateProxy);
    expect(addresses).property('EtherPredicate').equals(pos.EtherPredicateProxy);
    expect(addresses).property('RootChain').equals(contracts.RootChainProxy);
    expect(addresses).property('StakeManager').equals(contracts.StakeManagerProxy);
    expect(addresses).property('MaticToken').equals(contracts.Tokens.MaticToken);
    expect(addresses).property('PolToken').equals(contracts.PolygonEcosystemToken);
    // The same parser feeds POSClient, so the two clients agree key for key.
    const bridgeView = await createAddressFetcher({
      network: 'mainnet',
      initial: mainnetInfo as unknown as NetworkAddresses
    }).get();
    expect(addresses).deep.equals(bridgeView);
  });
});

describe('StakingClient full override with a malformed staking key', () => {
  it('fails with ContractNotAvailableOnNetworkError naming that key, not a bridge decode error', async () => {
    const err = await rejection(init({ ...FULL, PolToken: '0x1234' }));
    expect(err).property('name').equals('InitError');
    expect(BridgeEventDecodeFailedError.find(err)).equals(null);
    const cause = ContractNotAvailableOnNetworkError.find(err);
    expect(cause).nested.property('info.missing').deep.equals(['PolToken']);
    expect(cause).nested.property('info.network').equals('mainnet');
  });
});

describe('StakingClient exact error messages', () => {
  it('lists every missing staking key in a fixed order', async () => {
    const err = await rejection(init(BRIDGE));
    expect(ContractNotAvailableOnNetworkError.find(err))
      .property('message')
      .equals(
        'Address index for mainnet lacks staking contracts: StakeManager, MaticToken, PolToken'
      );
  });

  it("names the bridge key and the received type for a full index missing 'RootChain'", async () => {
    const { RootChain: _omit, ...withoutRootChain } = FULL;
    const err = await rejection(init(withoutRootChain));
    const cause = BridgeEventDecodeFailedError.find(err);
    expect(cause).property('message').equals("address index: missing or invalid 'RootChain'");
    expect(cause).property('info').deep.equals({ key: 'RootChain', received: 'undefined' });
  });

  it('reports the received type for a malformed bridge key', async () => {
    const err = await rejection(init({ ...FULL, RootChain: 5 }));
    const cause = BridgeEventDecodeFailedError.find(err);
    expect(cause).property('message').equals("address index: missing or invalid 'RootChain'");
    expect(cause).property('info').deep.equals({ key: 'RootChain', received: 'number' });
  });
});

describe('StakingClient.getAddresses returns a fresh copy', () => {
  const BASE_URL = 'https://address-index.test/staking-compat-copy';

  beforeEach(() => {
    __resetAddressCacheForTesting();
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify(mainnetInfo), { status: 200 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAddressCacheForTesting();
  });

  const SOURCES: Array<[string, () => Promise<StakingClient>]> = [
    [
      'the CDN',
      () =>
        StakingClient.init({
          network: 'mainnet',
          parent: new RecordingAdapter(),
          addressIndexUrl: BASE_URL
        })
    ],
    ['a full override', () => init(FULL)],
    ['a staking-only override', () => init(STAKING_ONLY)]
  ];

  it.each(SOURCES)('mutating the result does not change the next call (%s)', async (_n, build) => {
    const client = await build();
    const first = await client.getAddresses();
    const snapshot = { ...first };
    first.StakeManager = '0x0000000000000000000000000000000000000001';
    Reflect.deleteProperty(first, 'PolToken');
    const second = await client.getAddresses();
    expect(second).not.equals(first);
    expect(second).deep.equals(snapshot);
    expect(await client.stakeManager.getAddress()).equals(snapshot.StakeManager);
  });
});

describe('StakingClient override parsing', () => {
  it('returns neither an unknown extra key nor a malformed optional key from a full override', async () => {
    const client = await init({ ...FULL, Unknown: GAS_SWAPPER, GasSwapper: 'nope' });
    const addresses = await client.getAddresses();
    expect(addresses).deep.equals(FULL);
    expect(addresses).not.property('Unknown');
    expect(addresses).not.property('GasSwapper');
  });

  it('keeps a well-formed optional key on a full override', async () => {
    const client = await init({ ...FULL, GasSwapper: GAS_SWAPPER });
    expect(await client.getAddresses()).deep.equals({ ...FULL, GasSwapper: GAS_SWAPPER });
  });
});

describe('StakingClient with a non-object addresses override (records 4.0.0)', () => {
  // `key in value` throws a TypeError inside the classifier, before any
  // SDK wrapping: the consumer sees a bare TypeError, not an InitError and
  // not an SDK error. This records that without judging it; the message
  // text is the engine's, so only its stable part is matched.
  it.each([
    ['null', null],
    ["'x'", 'x']
  ])('addresses: %s rejects with a bare TypeError', async (_label, value) => {
    const err = await rejection(init(value));
    expect(err).instanceOf(TypeError);
    expect(err).property('name').equals('TypeError');
    expect(err)
      .property('message')
      .match(/Cannot use 'in' operator to search for 'RootChainManager'/);
    expect(isMaticjsError(err)).equals(false);
    expect(err).not.property('cause');
  });
});
