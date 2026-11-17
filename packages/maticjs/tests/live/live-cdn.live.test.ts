import { describe, expect, it } from 'vitest';

import { info as mainnetInfo } from '@polygonlabs/meta/info/mainnet/v1';
import { info as amoyInfo } from '@polygonlabs/meta/info/testnet/amoy';

import { createAddressFetcher, DEFAULT_TTL_MS } from '../../src/services/address-service.ts';
import {
  classifyIndexMismatch,
  fetchLatestMetaVersion,
  installedMetaVersion
} from './meta-freshness.ts';

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
 * one of exactly two things:
 *  - (a) the ops team updated the CDN index and `@polygonlabs/meta`
 *    hasn't been bumped here yet. Static deploys the index and publishes
 *    meta from the same tag, so this has a fingerprint: npm's latest meta
 *    is a newer stable version than the installed one. The automated meta
 *    bump handles it, so failing every unrelated PR meanwhile helps
 *    nobody: the test prints a `::warning` and passes.
 *  - (b) the CDN is serving something unexpected (fallback HTML, stale
 *    mirror, restructure) → the SDK's default path is at risk. With no
 *    newer meta on npm this still fails, listing every mismatched key.
 *
 * Fetching and parsing the real index, and the shape assertions, stay
 * hard failures in every case: `POSClient.init` must work against the
 * live index, whatever meta version is installed.
 */

const NETWORKS = [
  { network: 'mainnet' as const, snapshot: mainnetInfo, hasGasSwapper: true },
  { network: 'amoy' as const, snapshot: amoyInfo, hasGasSwapper: false }
];

interface Mismatch {
  key: string;
  expected: unknown;
  actual: unknown;
}

/** The meta typings do not declare every proxy key, so read by name. */
function readKey(record: object, key: string): unknown {
  return key in record ? Object.getOwnPropertyDescriptor(record, key)?.value : undefined;
}

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

      if (hasGasSwapper) {
        expect(addresses)
          .property('GasSwapper')
          .match(/^0x[0-9a-fA-F]{40}$/);
      } else {
        expect(addresses).not.property('GasSwapper');
      }
      expect(addresses)
        .property('MintableERC1155Predicate')
        .match(/^0x[0-9a-fA-F]{40}$/);

      const pos = snapshot.Main.POSContracts;
      const contracts = snapshot.Main.Contracts;
      const comparisons: Array<{ key: string; expected: unknown }> = [
        { key: 'RootChainManager', expected: pos.RootChainManagerProxy },
        { key: 'ERC20Predicate', expected: pos.ERC20PredicateProxy },
        { key: 'ERC721Predicate', expected: pos.ERC721PredicateProxy },
        { key: 'ERC1155Predicate', expected: pos.ERC1155PredicateProxy },
        { key: 'EtherPredicate', expected: pos.EtherPredicateProxy },
        { key: 'RootChain', expected: contracts.RootChainProxy },
        { key: 'StakeManager', expected: readKey(contracts, 'StakeManagerProxy') },
        { key: 'MaticToken', expected: contracts.Tokens.MaticToken },
        { key: 'PolToken', expected: readKey(contracts, 'PolygonEcosystemToken') }
      ];
      const mismatches: Mismatch[] = [];
      for (const { key, expected } of comparisons) {
        const actual = readKey(addresses, key);
        if (actual !== expected) mismatches.push({ key, expected, actual });
      }
      if (mismatches.length === 0) return;

      const installed = installedMetaVersion();
      // A registry failure throws and fails the test: never pass on a guess.
      const latest = await fetchLatestMetaVersion();
      const keys = mismatches.map((m) => m.key).join(', ');

      if (classifyIndexMismatch({ installed, latest }) === 'bump-pending') {
        console.log(
          `::warning title=meta bump pending::${network} live index differs from installed @polygonlabs/meta ${installed} for [${keys}]; npm has ${latest}, which the meta bump will pick up`
        );
        return;
      }

      expect.fail(
        `${network} live index differs from the @polygonlabs/meta ${installed} snapshot ` +
          `and npm has no newer meta (latest ${latest}), so the CDN is serving something unexpected:\n` +
          mismatches
            .map((m) => `  ${m.key}: expected ${String(m.expected)}, live ${String(m.actual)}`)
            .join('\n')
      );
    });
  }
});
