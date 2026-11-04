import { describe, expect, it } from 'vitest';

import { info as mainnetInfo } from '@polygonlabs/meta/info/mainnet/v1';
import { info as amoyInfo } from '@polygonlabs/meta/info/testnet/amoy';

import { createAddressFetcher, DEFAULT_TTL_MS } from '../../src/services/address-service.ts';

/**
 * LIVE-CDN verification — hits the real `static.polygon.technology`
 * index for BOTH networks on every test run, deliberately ungated: it
 * needs no secrets, only outbound HTTPS, and its absence is exactly how
 * the 1.0 rewrite shipped with `POSClient.init` broken on both networks
 * while CI stayed green (go-live review, Cluster 1). If this test can't
 * run, we don't know the SDK works.
 *
 * Expected values come from `@polygonlabs/meta`'s generated snapshots,
 * which are codegenned from the SAME `network/` JSON tree the CDN
 * serves (both live in `0xPolygon/static`). A mismatch therefore means
 * one of exactly two things, both of which SHOULD fail loudly here:
 *  - the ops team updated the CDN index and `@polygonlabs/meta` hasn't
 *    been released/bumped yet → bump the meta devDependency;
 *  - the CDN is serving something unexpected (fallback HTML, stale
 *    mirror, restructure) → the SDK's default path is at risk.
 */

const NETWORKS = [
  { network: 'mainnet' as const, snapshot: mainnetInfo, hasGasSwapper: true },
  { network: 'amoy' as const, snapshot: amoyInfo, hasGasSwapper: false }
];

describe('live CDN address index', { timeout: 30_000 }, () => {
  for (const { network, snapshot, hasGasSwapper } of NETWORKS) {
    it(`resolves ${network} addresses from the live index and matches the meta snapshot`, async () => {
      const fetcher = createAddressFetcher({
        network,
        // Below the TTL a previous test's module-level cache entry would
        // be served; a tiny TTL forces a real fetch while still passing
        // through the full parse path.
        ttlMs: Math.min(1, DEFAULT_TTL_MS)
      });
      const addresses = await fetcher.get();

      const pos = snapshot.Main.POSContracts;
      expect(addresses).property('RootChainManager').equals(pos.RootChainManagerProxy);
      expect(addresses).property('ERC20Predicate').equals(pos.ERC20PredicateProxy);
      expect(addresses).property('ERC721Predicate').equals(pos.ERC721PredicateProxy);
      expect(addresses).property('ERC1155Predicate').equals(pos.ERC1155PredicateProxy);
      expect(addresses).property('EtherPredicate').equals(pos.EtherPredicateProxy);
      expect(addresses).property('RootChain').equals(snapshot.Main.Contracts.RootChainProxy);
      if (hasGasSwapper) {
        expect(addresses).property('GasSwapper').match(/^0x[0-9a-fA-F]{40}$/);
      } else {
        expect(addresses).not.property('GasSwapper');
      }
      expect(addresses).property('MintableERC1155Predicate').match(/^0x[0-9a-fA-F]{40}$/);
    });
  }
});
