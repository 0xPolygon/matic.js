/**
 * ERC-1155 bridge writes through each adapter, against the devnet's
 * pos-portal DummyERC1155 (id 1, seeded with 10 per key).
 *
 * Balance deltas are read with plain viem, not through the SDK, so a write
 * the SDK misreports cannot hide behind the SDK's own reads. The SDK's
 * `getBalance` is checked against those reads too.
 *
 * Also covers `approveAllForMintable`, which needs a deployed
 * MintableERC1155Predicate. The devnet has one; the public testnet does
 * not, so this is the only place that row can run.
 */
import { describe, expect, it } from 'vitest';

import type { Suite } from '../src/keys.ts';

import { buildAdapters } from '../src/adapters.ts';
import { getTestEnv } from '../src/test-env.ts';
import {
  confirmSuccess,
  CYCLE_TIMEOUT_MS,
  erc1155BalanceOf,
  exitWhenCheckpointed,
  HASH_PATTERN,
  initPos,
  isApprovedForAll,
  readers,
  revokeApprovalForAll,
  waitForCheckpoint,
  waitForStateSync
} from './cycle.ts';

const SUITE: Suite = 'bridge-erc1155';
const TOKEN_ID = 1n;
const AMOUNT = 5n;

const rows = buildAdapters({ suite: SUITE });

describe.concurrent('ERC-1155 deposit and exit cycle', { timeout: CYCLE_TIMEOUT_MS }, () => {
  it.each(rows)('via $name', async (row) => {
    const { tokens, addresses } = getTestEnv().E2E_ADDRESSES_JSON;
    const { l1, l2 } = readers();
    const pos = await initPos(row);
    const parentToken = pos.parent.erc1155(tokens.root.erc1155);
    const childToken = pos.child.erc1155(tokens.child.erc1155);
    const parentBalance = () =>
      erc1155BalanceOf({
        client: l1,
        token: tokens.root.erc1155,
        owner: row.address,
        id: TOKEN_ID
      });
    const childBalance = () =>
      erc1155BalanceOf({
        client: l2,
        token: tokens.child.erc1155,
        owner: row.address,
        id: TOKEN_ID
      });

    const parentBefore = await parentBalance();
    const childBefore = await childBalance();
    expect(parentBefore >= AMOUNT, 'seeded root DummyERC1155 balance').equals(true);
    expect(await parentToken.getBalance(row.address, TOKEN_ID)).equals(parentBefore);
    expect(await childToken.getBalance(row.address, TOKEN_ID)).equals(childBefore);

    // Revoke first so the approval check below cannot pass on an earlier run's approval.
    const approval = {
      token: tokens.root.erc1155,
      owner: row.address,
      operator: addresses.ERC1155Predicate
    };
    await revokeApprovalForAll({
      suite: SUITE,
      adapter: row.name,
      token: approval.token,
      operator: approval.operator
    });
    await confirmSuccess(await parentToken.approveAll());
    expect(await parentToken.isApprovedAll(row.address)).equals(true);
    expect(await isApprovedForAll(approval)).equals(true);

    const deposit = await confirmSuccess(
      await parentToken.deposit({ tokenId: TOKEN_ID, amount: AMOUNT, userAddress: row.address })
    );
    expect(await parentBalance()).equals(parentBefore - AMOUNT);

    await waitForStateSync({
      read: childBalance,
      done: (balance) => balance === childBefore + AMOUNT,
      label: `${row.name} child DummyERC1155 #1 balance`
    });
    expect(await childToken.getBalance(row.address, TOKEN_ID)).equals(childBefore + AMOUNT);
    expect(await pos.isDeposited(deposit.transactionHash)).equals(true);

    const burn = await confirmSuccess(await childToken.startWithdraw(TOKEN_ID, AMOUNT));
    expect(await childBalance()).equals(childBefore);
    await waitForCheckpoint({
      pos,
      burnHash: burn.transactionHash,
      label: `${row.name} burn ${burn.transactionHash}`
    });
    expect(await parentToken.isWithdrawExited(burn.transactionHash)).equals(false);

    await exitWhenCheckpointed({
      exit: () => parentToken.completeWithdraw(burn.transactionHash),
      label: `${row.name} ERC-1155 burn ${burn.transactionHash}`
    });

    expect(await parentToken.isWithdrawExited(burn.transactionHash)).equals(true);
    expect(await parentBalance()).equals(parentBefore);
    expect(await parentToken.getBalance(row.address, TOKEN_ID)).equals(parentBefore);
  });
});

describe.each(rows)('ERC-1155 approvals via $name', (row) => {
  it('approveAll() returns a hash and confirms success', async () => {
    const { tokens, addresses } = getTestEnv().E2E_ADDRESSES_JSON;
    const pos = await initPos(row);
    const parentToken = pos.parent.erc1155(tokens.root.erc1155);
    const approval = {
      token: tokens.root.erc1155,
      owner: row.address,
      operator: addresses.ERC1155Predicate
    };

    // Revoke first, and check the SDK sees it, so the approval below is this write's.
    await revokeApprovalForAll({
      suite: SUITE,
      adapter: row.name,
      token: approval.token,
      operator: approval.operator
    });
    expect(await parentToken.isApprovedAll(row.address)).equals(false);

    const tx = await parentToken.approveAll();
    expect(tx.hash).match(HASH_PATTERN);
    await confirmSuccess(tx);
    expect(await parentToken.isApprovedAll(row.address)).equals(true);
    expect(await isApprovedForAll(approval)).equals(true);
  });

  it('approveAllForMintable() approves the MintableERC1155Predicate', async () => {
    const { tokens, addresses } = getTestEnv().E2E_ADDRESSES_JSON;
    const pos = await initPos(row);
    const mintable = pos.parent.erc1155(tokens.root.mintableErc1155);

    // Revoke first, so the approval below is this write's.
    await revokeApprovalForAll({
      suite: SUITE,
      adapter: row.name,
      token: tokens.root.mintableErc1155,
      operator: addresses.MintableERC1155Predicate
    });

    const tx = await mintable.approveAllForMintable();
    expect(tx.hash).match(HASH_PATTERN);
    await confirmSuccess(tx);
    const approved = await isApprovedForAll({
      token: tokens.root.mintableErc1155,
      owner: row.address,
      operator: addresses.MintableERC1155Predicate
    });
    expect(approved).equals(true);
  });
});
