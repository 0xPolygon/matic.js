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
