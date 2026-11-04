import { describe, expect, it } from 'vitest';

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

import { POSBridgeError } from '../../src/errors.ts';
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
