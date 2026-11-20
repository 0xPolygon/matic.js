import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  Adapter,
  PreparedTx,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';
import type { NetworkAddresses } from '../../src/networks.ts';
import type { PlasmaAddresses } from '../../src/plasma/addresses.ts';

import { PlasmaClient } from '../../src/plasma/plasma-client.ts';
import { POSClient } from '../../src/pos-client.ts';
import { __resetAddressCacheForTesting } from '../../src/services/address-service.ts';
import { StakingClient } from '../../src/staking/staking-client.ts';

/**
 * A `POSClient` and a `StakingClient` read the same address index through
 * one process-wide cache. Pins that they share a single fetch, and that a
 * refresh the bridge parser rejects is never stored for either of them.
 */

const FULL: NetworkAddresses = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666',
  StakeManager: '0x7777777777777777777777777777777777777777',
  MaticToken: '0x8888888888888888888888888888888888888888',
  PolToken: '0x9999999999999999999999999999999999999999'
};

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

describe('address cache shared by POSClient and StakingClient', () => {
  // A base URL of its own keeps this suite's cache entry apart from any
  // other test's.
  const BASE_URL = 'https://address-index.test/cache-sharing';
  let served: unknown = FULL;
  let fetches = 0;

  beforeEach(() => {
    __resetAddressCacheForTesting();
    served = FULL;
    fetches = 0;
    vi.stubGlobal('fetch', () => {
      fetches += 1;
      return Promise.resolve(new Response(JSON.stringify(served), { status: 200 }));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __resetAddressCacheForTesting();
  });

  it('makes exactly one fetch between the two clients, each returning its own shape', async () => {
    const pos = await POSClient.init({
      network: 'mainnet',
      parent: new RecordingAdapter(),
      child: new RecordingAdapter(),
      addressIndexUrl: BASE_URL
    });
    const staking = await StakingClient.init({
      network: 'mainnet',
      parent: new RecordingAdapter(),
      addressIndexUrl: BASE_URL
    });
    expect(fetches).equals(1);

    // Each client returns its own shape from the one cached index.
    expect(await pos.getAddresses()).deep.equals(FULL);
    expect(await staking.getAddresses()).deep.equals(FULL);
    expect(await staking.stakeManager.getAddress()).equals(FULL.StakeManager);
    expect(await pos.rootChainManager.caller.getContractAddress()).equals(FULL.RootChainManager);
    expect(fetches).equals(1);
  });

  it('keeps serving the previous value, fires onRefreshError once and does not throw on a later get, when a refresh fails the bridge parser', async () => {
    // Only Date is faked: the cache ages by `Date.now()`, and the real
    // timers keep `vi.waitFor` working.
    vi.useFakeTimers({ toFake: ['Date'] });
    const errors: Error[] = [];
    const onAddressRefreshError = (err: Error): void => {
      errors.push(err);
    };
    const pos = await POSClient.init({
      network: 'mainnet',
      parent: new RecordingAdapter(),
      child: new RecordingAdapter(),
      addressIndexUrl: BASE_URL,
      addressTTLMs: 1000,
      onAddressRefreshError
    });
    const staking = await StakingClient.init({
      network: 'mainnet',
      parent: new RecordingAdapter(),
      addressIndexUrl: BASE_URL,
      addressTTLMs: 1000,
      onAddressRefreshError
    });
    expect(fetches).equals(1);

    // The next refresh drops a required bridge key, so the bridge parser rejects it.
    const { RootChain: _omit, ...rejected } = FULL;
    served = rejected;
    vi.setSystemTime(Date.now() + 5000);

    // Stale: this call serves the cached index and starts the refresh.
    expect(await staking.getAddresses()).deep.equals(FULL);
    await vi.waitFor(() => {
      expect(errors).lengthOf(1);
    });
    expect(fetches).equals(2);
    expect(errors[0]).property('message').contains("missing or invalid 'RootChain'");

    // The rejected index was never stored: both clients still serve the old one.
    expect(await pos.getAddresses()).deep.equals(FULL);
    expect(await staking.getAddresses()).deep.equals(FULL);
    expect(await staking.stakeManager.getAddress()).equals(FULL.StakeManager);
  });
});

/**
 * The Plasma client reads the same index URL through a cache of its own, so a
 * refresh one parser rejects never changes what the other serves. Each store
 * costs one fetch per TTL.
 */
describe('address caches of POSClient, StakingClient and PlasmaClient', () => {
  const BASE_URL = 'https://address-index.test/cache-sharing-plasma';

  /** What a flat mirror serves: the bridge index and the four Plasma-only contracts. */
  const PLASMA_ONLY_KEYS = {
    DepositManager: '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa',
    WithdrawManager: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB',
    PlasmaERC20Predicate: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
    ExitNFT: '0xdDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd'
  } as const;
  const SERVED: Record<string, unknown> = { ...FULL, ...PLASMA_ONLY_KEYS };
  const EXPECTED_PLASMA: PlasmaAddresses = {
    RootChain: FULL.RootChain,
    MaticToken: '0x8888888888888888888888888888888888888888',
    PolToken: '0x9999999999999999999999999999999999999999',
    ...PLASMA_ONLY_KEYS
  };

  let served: unknown = SERVED;
  let fetches = 0;

  const bridgeConfig = (onAddressRefreshError?: (err: Error) => void) => ({
    network: 'mainnet' as const,
    parent: new RecordingAdapter(),
    addressIndexUrl: BASE_URL,
    addressTTLMs: 1000,
    ...(onAddressRefreshError !== undefined ? { onAddressRefreshError } : {})
  });
  const initPos = (onAddressRefreshError?: (err: Error) => void) =>
    POSClient.init({ ...bridgeConfig(onAddressRefreshError), child: new RecordingAdapter() });
  const initStaking = (onAddressRefreshError?: (err: Error) => void) =>
    StakingClient.init(bridgeConfig(onAddressRefreshError));
  const initPlasma = (onAddressRefreshError?: (err: Error) => void) =>
    PlasmaClient.init({ ...bridgeConfig(onAddressRefreshError), child: new RecordingAdapter() });

  /** Let a started refresh run to its end; only `Date` is faked, so real timers work. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  beforeEach(() => {
    __resetAddressCacheForTesting();
    served = SERVED;
    fetches = 0;
    vi.stubGlobal('fetch', () => {
      fetches += 1;
      return Promise.resolve(new Response(JSON.stringify(served), { status: 200 }));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __resetAddressCacheForTesting();
  });

  it('makes exactly two fetches between the three clients, one per store, each returning its own shape', async () => {
    const pos = await initPos();
    const staking = await initStaking();
    const plasma = await initPlasma();
    expect(fetches).equals(2);

    expect(await pos.getAddresses()).deep.equals(FULL);
    expect(await staking.getAddresses()).deep.equals(FULL);
    const resolvedPlasma = await plasma.getAddresses();
    expect(resolvedPlasma).deep.equals(EXPECTED_PLASMA);
    expect(Object.keys(resolvedPlasma)).lengthOf(7);
    for (const key of Object.keys(PLASMA_ONLY_KEYS)) {
      expect(await pos.getAddresses()).not.property(key);
    }
    expect(fetches).equals(2);
  });

  it("does not fire the bridge clients' onRefreshError, or change what they serve, when a refresh drops a Plasma key", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const posErrors: Error[] = [];
    const plasmaErrors: Error[] = [];
    const pos = await initPos((err) => {
      posErrors.push(err);
    });
    const plasma = await initPlasma((err) => {
      plasmaErrors.push(err);
    });
    expect(fetches).equals(2);

    const { ExitNFT: _omit, ...withoutExitNft } = SERVED;
    served = withoutExitNft;
    vi.setSystemTime(Date.now() + 5000);

    // Stale: each call serves its cache and starts that store's own refresh.
    expect(await plasma.getAddresses()).deep.equals(EXPECTED_PLASMA);
    expect(await pos.getAddresses()).deep.equals(FULL);
    await vi.waitFor(() => {
      expect(plasmaErrors).lengthOf(1);
    });
    await settle();
    expect(fetches).equals(4);
    expect(plasmaErrors[0]).property('message').contains('ExitNFT');
    expect(posErrors).lengthOf(0);
    expect(await pos.getAddresses()).deep.equals(FULL);
    // The rejected index was never stored for Plasma either.
    expect(await plasma.getAddresses()).deep.equals(EXPECTED_PLASMA);
  });

  it('does not disturb the Plasma client when a refresh drops a required PoS key', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const posErrors: Error[] = [];
    const plasmaErrors: Error[] = [];
    const pos = await initPos((err) => {
      posErrors.push(err);
    });
    const plasma = await initPlasma((err) => {
      plasmaErrors.push(err);
    });
    expect(fetches).equals(2);

    // The bridge parser rejects this index; the Plasma parser reads none of
    // the bridge-only keys and accepts it, with a new DepositManager.
    const { RootChainManager: _omit, ...withoutManager } = SERVED;
    const moved = '0xeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeE';
    served = { ...withoutManager, DepositManager: moved };
    vi.setSystemTime(Date.now() + 5000);

    expect(await pos.getAddresses()).deep.equals(FULL);
    await vi.waitFor(() => {
      expect(posErrors).lengthOf(1);
    });
    expect(await plasma.getAddresses()).deep.equals(EXPECTED_PLASMA);
    await settle();
    expect(fetches).equals(4);
    expect(posErrors[0]).property('message').contains("missing or invalid 'RootChainManager'");
    expect(plasmaErrors).lengthOf(0);

    // Plasma took the refresh; PoS kept its last good index.
    expect(await plasma.getAddresses()).deep.equals({ ...EXPECTED_PLASMA, DepositManager: moved });
    expect(await pos.getAddresses()).deep.equals(FULL);
  });

  it('clears both stores in __resetAddressCacheForTesting', async () => {
    await initPos();
    await initPlasma();
    expect(fetches).equals(2);

    __resetAddressCacheForTesting();
    await initPos();
    expect(fetches).equals(3);
    await initPlasma();
    expect(fetches).equals(4);
  });
});
