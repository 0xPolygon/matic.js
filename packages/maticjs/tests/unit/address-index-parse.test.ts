import { describe, expect, it } from 'vitest';

import { info as mainnetInfo } from '@polygonlabs/meta/info/mainnet/v1';
import { info as amoyInfo } from '@polygonlabs/meta/info/testnet/amoy';

import { createAddressFetcher } from '../../src/services/address-service.ts';

/**
 * Pins the address-index parsing contract against `@polygonlabs/meta`'s
 * generated `info` snapshots — which are codegenned from the SAME
 * `network/` JSON files the live CDN serves (both live in the
 * `0xPolygon/static` repo). This is the fixture layer of the go-live
 * fix for the Cluster-1 blocker: the 1.0 rewrite shipped a parser for
 * a FLAT index shape that never existed on the wire, so `POSClient.init`
 * failed on both networks. The parser must read the legacy NESTED
 * maticjs layout, selecting the exact Proxy entries the 0.x SDK read.
 *
 * The companion live test (`tests/integration/live-cdn.test.ts`)
 * asserts the real CDN still serves this shape.
 */

/** Drive the module-private parser through the public override path. */
async function parseVia(raw: unknown): Promise<Record<string, unknown>> {
  const fetcher = createAddressFetcher({
    network: 'mainnet',
    initial: raw as never
  });
  return (await fetcher.get()) as unknown as Record<string, unknown>;
}

describe('parseAddressIndex — nested CDN shape (meta snapshot fixtures)', () => {
  it('extracts the mainnet Proxy entries the legacy SDK read', async () => {
    const out = await parseVia(mainnetInfo);
    const pos = mainnetInfo.Main.POSContracts;
    expect(out).property('RootChainManager').equals(pos.RootChainManagerProxy);
    expect(out).property('ERC20Predicate').equals(pos.ERC20PredicateProxy);
    expect(out).property('ERC721Predicate').equals(pos.ERC721PredicateProxy);
    expect(out).property('ERC1155Predicate').equals(pos.ERC1155PredicateProxy);
    expect(out).property('EtherPredicate').equals(pos.EtherPredicateProxy);
    expect(out).property('RootChain').equals(mainnetInfo.Main.Contracts.RootChainProxy);
    expect(out).property('GasSwapper').equals(pos.GasSwapper);
    expect(out).property('MintableERC1155Predicate').equals(pos.MintableERC1155PredicateProxy);
  });

  it('extracts the amoy entries — GasSwapper absent, mintable predicate present', async () => {
    const out = await parseVia(amoyInfo);
    const pos = amoyInfo.Main.POSContracts;
    expect(out).property('RootChainManager').equals(pos.RootChainManagerProxy);
    expect(out).property('RootChain').equals(amoyInfo.Main.Contracts.RootChainProxy);
    expect(out).not.property('GasSwapper');
    expect(out).property('MintableERC1155Predicate').equals(pos.MintableERC1155PredicateProxy);
  });

  it('never selects an implementation entry over its Proxy twin', async () => {
    const out = await parseVia(mainnetInfo);
    const pos = mainnetInfo.Main.POSContracts as unknown as Record<string, string>;
    // The nested index carries implementation twins next to every proxy;
    // wiring one would send approvals to an inert delegation target.
    expect(out.RootChainManager).not.equals(pos.RootChainManager);
    expect(out.ERC20Predicate).not.equals(pos.ERC20Predicate);
    expect(out.RootChain).not.equals(
      (mainnetInfo.Main.Contracts as unknown as Record<string, string>).RootChain
    );
  });

  it('throws a path-precise typed error when a Proxy entry is missing', async () => {
    const broken = structuredClone(mainnetInfo) as unknown as {
      Main: { POSContracts: Record<string, unknown> };
    };
    delete broken.Main.POSContracts.RootChainManagerProxy;
    const err = await parseVia(broken).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).not.equals(null);
    expect(err).property('code').equals('BRIDGE_EVENT_DECODE_FAILED');
    expect((err as Error).message).contains('Main.POSContracts.RootChainManagerProxy');
  });

  it('still accepts the flat NetworkAddresses shape (override / pre-flattened mirror)', async () => {
    const flat = {
      RootChainManager: '0x1111111111111111111111111111111111111111',
      ERC20Predicate: '0x2222222222222222222222222222222222222222',
      ERC721Predicate: '0x3333333333333333333333333333333333333333',
      ERC1155Predicate: '0x4444444444444444444444444444444444444444',
      EtherPredicate: '0x5555555555555555555555555555555555555555',
      RootChain: '0x6666666666666666666666666666666666666666'
    };
    const out = await parseVia(flat);
    expect(out).deep.equals(flat);
  });
});
