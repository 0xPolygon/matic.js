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
import type { StakingAddresses } from '../../src/staking/staking-client.ts';

import { POSBridgeError } from '../../src/errors.ts';
import { POSClient } from '../../src/pos-client.ts';
import { __resetAddressCacheForTesting } from '../../src/services/address-service.ts';
import { StakingClient } from '../../src/staking/staking-client.ts';

/**
 * `StakingClient.init` is where a misconfigured address index must
 * fail: a missing staking key would otherwise surface only on the first
 * transaction, from deep inside an adapter.
 */

const BRIDGE: NetworkAddresses = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666'
};
const FULL: NetworkAddresses = {
  ...BRIDGE,
  StakeManager: '0x7777777777777777777777777777777777777777',
  MaticToken: '0x8888888888888888888888888888888888888888',
  PolToken: '0x9999999999999999999999999999999999999999'
};
const SHARE: Hex = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';

class RecordingAdapter implements Adapter {
  readonly prepares: WriteRequest[] = [];
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
    this.prepares.push(req);
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

async function initError(addresses: NetworkAddresses): Promise<POSBridgeError> {
  try {
    await StakingClient.init({ network: 'mainnet', parent: new RecordingAdapter(), addresses });
  } catch (err) {
    if (err instanceof POSBridgeError) return err;
    throw err;
  }
  throw new Error('expected StakingClient.init to throw');
}

describe('StakingClient.init', () => {
  it('succeeds with an addresses override carrying the staking keys (no network)', async () => {
    const client = await StakingClient.init({
      network: 'mainnet',
      parent: new RecordingAdapter(),
      addresses: FULL
    });
    expect(client).instanceOf(StakingClient);
    expect(client).property('stakeManager');
    expect(client).property('matic');
    expect(client).property('pol');
  });

  it('throws CONTRACT_NOT_AVAILABLE_ON_NETWORK listing every missing staking key', async () => {
    const err = await initError(BRIDGE);
    expect(err).property('code').equals('CONTRACT_NOT_AVAILABLE_ON_NETWORK');
    expect(err).property('name').equals('POSBridgeError');
    expect(err)
      .nested.property('info.missing')
      .deep.equals(['StakeManager', 'MaticToken', 'PolToken']);
    expect(err).nested.property('info.network').equals('mainnet');
  });

  it('lists only the key that is actually missing', async () => {
    const { PolToken: _omit, ...withoutPol } = FULL;
    const err = await initError(withoutPol);
    expect(err).nested.property('info.missing').deep.equals(['PolToken']);
  });

  it('exposes the token supportsPermit flags (POL yes, MATIC no)', async () => {
    const client = await StakingClient.init({
      network: 'amoy',
      parent: new RecordingAdapter(),
      addresses: FULL
    });
    expect(client.pol).property('supportsPermit').equals(true);
    expect(client.matic).property('supportsPermit').equals(false);
  });
});

describe('StakingClient accessors', () => {
  it('getAddresses() round-trips the resolved index', async () => {
    const client = await StakingClient.init({
      network: 'mainnet',
      parent: new RecordingAdapter(),
      addresses: FULL
    });
    expect(await client.getAddresses()).deep.equals(FULL);
  });

  it('contract wrappers resolve their addresses from the index', async () => {
    const client = await StakingClient.init({
      network: 'mainnet',
      parent: new RecordingAdapter(),
      addresses: FULL
    });
    expect(await client.stakeManager.getAddress()).equals(FULL.StakeManager);
    expect(await client.matic.getAddress()).equals(FULL.MaticToken);
    expect(await client.pol.getAddress()).equals(FULL.PolToken);
  });

  it('validatorShare(addr) binds the prepared tx `to` to that address', async () => {
    const adapter = new RecordingAdapter();
    const client = await StakingClient.init({
      network: 'mainnet',
      parent: adapter,
      addresses: FULL
    });
    const share = client.validatorShare(SHARE);
    expect(share).property('address').equals(SHARE);
    const tx = await share.prepareDelegate({ amount: 1n, minSharesToMint: 0n });
    expect(tx).property('to').equals(SHARE);
    expect(adapter.prepares[0]).property('address').equals(SHARE);
  });

  it('validatorShare() returns an independent wrapper per address', async () => {
    const client = await StakingClient.init({
      network: 'mainnet',
      parent: new RecordingAdapter(),
      addresses: FULL
    });
    const other: Hex = '0xcCCccccCCCCCCCcccccCcCCcCcCcCcCCccCccCcC';
    expect(client.validatorShare(SHARE)).property('address').equals(SHARE);
    expect(client.validatorShare(other)).property('address').equals(other);
  });
});

const STAKING_ONLY: StakingAddresses = {
  StakeManager: '0x7777777777777777777777777777777777777777',
  MaticToken: '0x8888888888888888888888888888888888888888',
  PolToken: '0x9999999999999999999999999999999999999999'
};

async function rejection(promise: Promise<unknown>): Promise<POSBridgeError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof POSBridgeError) return err;
    throw err;
  }
  throw new Error('expected a POSBridgeError');
}

describe('staking-only addresses override', () => {
  it('initialises from the three staking addresses alone, with no bridge keys', async () => {
    const adapter = new RecordingAdapter();
    const client = await StakingClient.init({
      network: 'mainnet',
      parent: adapter,
      addresses: STAKING_ONLY
    });
    expect(await client.getAddresses()).deep.equals(STAKING_ONLY);
    expect(await client.stakeManager.getAddress()).equals(STAKING_ONLY.StakeManager);
    expect(await client.matic.getAddress()).equals(STAKING_ONLY.MaticToken);
    const tx = await client.pol.prepareApproveStakeManager({ amount: 1n });
    expect(tx).property('to').equals(STAKING_ONLY.PolToken);
    expect(adapter.prepares[0]).nested.property('args[0]').equals(STAKING_ONLY.StakeManager);
  });

  it('fails init with CONTRACT_NOT_AVAILABLE_ON_NETWORK for an absent or malformed staking key', async () => {
    const { MaticToken: _omit, ...withoutMatic } = STAKING_ONLY;
    const missing = await rejection(
      StakingClient.init({
        network: 'mainnet',
        parent: new RecordingAdapter(),
        // @ts-expect-error — a plain-JS consumer can omit a key the type requires
        addresses: withoutMatic
      })
    );
    expect(missing).property('code').equals('CONTRACT_NOT_AVAILABLE_ON_NETWORK');
    expect(missing).nested.property('info.missing').deep.equals(['MaticToken']);

    const malformed = await rejection(
      StakingClient.init({
        network: 'mainnet',
        parent: new RecordingAdapter(),
        addresses: { ...STAKING_ONLY, PolToken: '0x1234' }
      })
    );
    expect(malformed).property('code').equals('CONTRACT_NOT_AVAILABLE_ON_NETWORK');
    expect(malformed).nested.property('info.missing').deep.equals(['PolToken']);
  });

  it('still validates an override carrying any bridge key as a full index', async () => {
    const { RootChain: _omit, ...partialBridge } = FULL;
    const err = await rejection(
      StakingClient.init({
        network: 'mainnet',
        parent: new RecordingAdapter(),
        // @ts-expect-error — a plain-JS consumer can pass a full index missing a bridge key
        addresses: partialBridge
      })
    );
    expect(err).property('code').equals('BRIDGE_EVENT_DECODE_FAILED');
    expect(err).property('message').contains('RootChain');
  });

  it('leaves POSClient requiring every bridge key', async () => {
    const err = await rejection(
      POSClient.init({
        network: 'mainnet',
        parent: new RecordingAdapter(),
        child: new RecordingAdapter(),
        // @ts-expect-error — POSClient takes a full NetworkAddresses, never the staking subset
        addresses: STAKING_ONLY
      })
    );
    expect(err).property('code').equals('BRIDGE_EVENT_DECODE_FAILED');
    expect(err).property('message').contains('RootChainManager');
  });
});

describe('StakingClient after a background address refresh', () => {
  // A base URL of its own keeps this suite's cache entry apart from any
  // other test's; TTL 0 makes every call after init stale, so each call
  // serves the cached index and starts a refresh for the next one.
  const BASE_URL = 'https://address-index.test/staking-refresh';
  let served: NetworkAddresses = FULL;

  beforeEach(() => {
    __resetAddressCacheForTesting();
    served = FULL;
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify(served), { status: 200 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAddressCacheForTesting();
  });

  async function refreshedClient(next: NetworkAddresses): Promise<{
    client: StakingClient;
    adapter: RecordingAdapter;
  }> {
    const adapter = new RecordingAdapter();
    const client = await StakingClient.init({
      network: 'mainnet',
      parent: adapter,
      addressIndexUrl: BASE_URL,
      addressTTLMs: 0
    });
    served = next;
    // Served from the stale cache; kicks off the refresh that fetches `next`.
    await client.getAddresses();
    await vi.waitFor(async () => {
      const seen = await client.getAddresses().then(
        (addresses) => addresses,
        (err: unknown) => err
      );
      // A refresh that drops a staking key makes getAddresses() reject,
      // so either outcome proves the new index was picked up.
      if (seen instanceof POSBridgeError) {
        expect(seen).property('code').equals('CONTRACT_NOT_AVAILABLE_ON_NETWORK');
      } else {
        expect(seen).deep.equals(next);
      }
    });
    return { client, adapter };
  }

  it('fails a call with CONTRACT_NOT_AVAILABLE_ON_NETWORK once a refresh drops its key', async () => {
    const { PolToken: _omit, ...withoutPol } = FULL;
    const { client } = await refreshedClient(withoutPol);

    const err = await rejection(client.pol.prepareApproveStakeManager({ amount: 1n }));
    expect(err).property('code').equals('CONTRACT_NOT_AVAILABLE_ON_NETWORK');
    expect(err).nested.property('info.missing').deep.equals(['PolToken']);
    const viaGetAddresses = await rejection(client.getAddresses());
    expect(viaGetAddresses).property('code').equals('CONTRACT_NOT_AVAILABLE_ON_NETWORK');
    expect(viaGetAddresses).nested.property('info.missing').deep.equals(['PolToken']);
    // Keys the refresh kept still resolve.
    expect(await client.stakeManager.getAddress()).equals(FULL.StakeManager);
  });

  it('targets the new address once a refresh changes a key', async () => {
    const moved: Hex = '0x7777777777777777777777777777777777770001';
    const { client, adapter } = await refreshedClient({ ...FULL, StakeManager: moved });

    const unstake = await client.stakeManager.prepareUnstake({ validatorId: 1n });
    expect(unstake).property('to').equals(moved);
    // The POL approval's spender follows the moved StakeManager too.
    await client.pol.prepareApproveStakeManager({ amount: 1n });
    expect(adapter.prepares.at(-1)).nested.property('args[0]').equals(moved);
  });
});
