/**
 * ERC-20 live reads on Sepolia, parameterised over all three adapters.
 *
 * Reads only, through signer-less adapters, against a fixed subject
 * address: the values drift, so the assertions check types and ranges.
 * Approve, deposit and exit run on the devnet in `packages/e2e`.
 */
import { describe, expect, it } from 'vitest';

import { POSClient } from '../../src/index.js';
import { TEST_NETWORKS } from '../fixtures/networks.js';
import { HAS_LIVE_RPC, noteSkippedIfNoLiveRpc, READ_SUBJECT, readAdapterRows } from './helpers.js';

noteSkippedIfNoLiveRpc('ERC20');

describe.skipIf(!HAS_LIVE_RPC)('ERC20', { timeout: 90_000 }, () => {
  describe.each(readAdapterRows())('via %s', (_name, row) => {
    it('parent.erc20(addr).getBalance returns the balance as bigint', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const balance = await pos.parent
        .erc20(TEST_NETWORKS.parent.contracts.erc20)
        .getBalance(READ_SUBJECT);
      expect(typeof balance).equals('bigint');
      expect(balance >= 0n).equals(true);
    });

    it('parent.erc20(addr).getAllowance(user) reads the predicate allowance', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const allowance = await pos.parent
        .erc20(TEST_NETWORKS.parent.contracts.erc20)
        // Read against the bridge's predicate (the legacy default).
        .getAllowance(READ_SUBJECT);
      expect(typeof allowance).equals('bigint');
      expect(allowance >= 0n).equals(true);
    });
  });
});
