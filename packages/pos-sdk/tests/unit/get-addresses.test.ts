import { describe, expect, it } from 'vitest';

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

/**
 * `getAddresses()` is the supported escape-hatch accessor: it surfaces
 * the resolved bridge addresses so consumers can drive contract methods
 * the SDK doesn't wrap (paired with the `@polygonlabs/pos-sdk/abi`
 * exports + their own client). This pins that it returns the resolved
 * set — here via the `addresses` override path, which needs no network.
 */

const ADDRESSES: NetworkAddresses = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666'
};

/**
 * Minimal stub adapter. `POSClient.init` builds contract callers but
 * does not invoke any adapter method during construction (the only
 * eager call is the one address-index fetch, short-circuited by the
 * `addresses` override), so these throwing stubs are never reached.
 */
function stubAdapter(): Adapter {
  const unreached = (): never => {
    throw new Error('stub adapter method should not be called during getAddresses test');
  };
  return {
    getChainId: () => Promise.resolve(80002),
    read: (_req: ReadRequest) => Promise.resolve(unreached()),
    write: (_req: WriteRequest) => Promise.resolve(unreached() as TxResult),
    prepareWrite: (_req: WriteRequest) => Promise.resolve(unreached() as PreparedTx),
    estimateGas: (_req: WriteRequest) => Promise.resolve(unreached() as bigint),
    getTransactionReceipt: (_hash: string) => Promise.resolve(unreached() as Receipt | null),
    keccak256: () => unreached(),
    request: <T>() => Promise.resolve(unreached() as T)
  };
}

describe('POSClient.getAddresses', () => {
  it('returns the resolved bridge addresses (override path, no network)', async () => {
    const pos = await POSClient.init({
      network: 'amoy',
      parent: stubAdapter(),
      child: stubAdapter(),
      addresses: ADDRESSES
    });

    const resolved = await pos.getAddresses();
    expect(resolved).deep.equals(ADDRESSES);
    expect(resolved).property('RootChainManager').equals(ADDRESSES.RootChainManager);
  });
});
