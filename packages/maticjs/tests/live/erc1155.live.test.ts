/**
 * ERC-1155 live reads on Sepolia, parameterised over all three adapters.
 *
 * Parallels `erc20.live.test.ts`: reads only, signer-less adapters, a
 * fixed subject address. Approve, deposit and exit run on the devnet in
 * `packages/e2e`.
 */
import { describe, expect, it } from 'vitest';

import { POSClient } from '../../src/index.js';
import { TEST_NETWORKS } from '../fixtures/networks.js';
import { HAS_LIVE_RPC, noteSkippedIfNoLiveRpc, READ_SUBJECT, readAdapterRows } from './helpers.js';

const TEST_TOKEN_ID = 1n;

noteSkippedIfNoLiveRpc('ERC1155');

describe.skipIf(!HAS_LIVE_RPC)('ERC1155', { timeout: 90_000 }, () => {
  describe.each(readAdapterRows())('via %s', (_name, row) => {
    it('parent.erc1155(addr).getBalance returns the balance as bigint', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const balance = await pos.parent
        .erc1155(TEST_NETWORKS.parent.contracts.erc1155)
        .getBalance(READ_SUBJECT, TEST_TOKEN_ID);
      expect(typeof balance).equals('bigint');
      expect(balance >= 0n).equals(true);
    });

    it('parent.erc1155(addr).isApprovedAll reads operator approval', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const isApproved = await pos.parent
        .erc1155(TEST_NETWORKS.parent.contracts.erc1155)
        .isApprovedAll(READ_SUBJECT);
      expect(typeof isApproved).equals('boolean');
    });
  });
});
