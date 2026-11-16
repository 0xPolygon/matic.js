/**
 * ERC-721 live reads on Sepolia, parameterised over all three adapters.
 *
 * Parallels `erc20.live.test.ts`: reads only, signer-less adapters, a
 * fixed subject address. Approve, deposit and exit run on the devnet in
 * `packages/e2e`.
 */
import { describe, expect, it } from 'vitest';

import { POSClient } from '../../src/index.js';
import { TEST_NETWORKS } from '../fixtures/networks.js';
import { HAS_LIVE_RPC, noteSkippedIfNoLiveRpc, READ_SUBJECT, readAdapterRows } from './helpers.js';

noteSkippedIfNoLiveRpc('ERC721');

describe.skipIf(!HAS_LIVE_RPC)('ERC721', { timeout: 90_000 }, () => {
  describe.each(readAdapterRows())('via %s', (_name, row) => {
    it('parent.erc721(addr).getTokensCount returns the balance as number', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const count = await pos.parent
        .erc721(TEST_NETWORKS.parent.contracts.erc721)
        .getTokensCount(READ_SUBJECT);
      expect(typeof count).equals('number');
      expect(count).least(0);
    });

    it('parent.erc721(addr).isApprovedAll reads operator approval', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      // The bridge predicate is the default operator a deposit approves.
      const isApproved = await pos.parent
        .erc721(TEST_NETWORKS.parent.contracts.erc721)
        .isApprovedAll(READ_SUBJECT);
      expect(typeof isApproved).equals('boolean');
    });
  });
});
