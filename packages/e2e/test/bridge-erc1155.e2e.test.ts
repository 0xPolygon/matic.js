/**
 * ERC-1155 bridge writes through each adapter, against the devnet's
 * pos-portal DummyERC1155 (id 1, seeded with 10 per key).
 *
 * Also covers `approveAllForMintable`, which needs a deployed
 * MintableERC1155Predicate. The devnet has one; the public testnet does
 * not, so this is the only place that row can run.
 */
import { parseAbi } from 'viem';
import { describe, expect, it } from 'vitest';

import { buildAdapters } from '../src/adapters.ts';
import { getTestEnv } from '../src/test-env.ts';
import {
  confirmSuccess,
  CYCLE_TIMEOUT_MS,
  exitWhenCheckpointed,
  HASH_PATTERN,
  initPos,
  readers,
  waitForCheckpoint,
  waitForStateSync
} from './cycle.ts';

const isApprovedForAllAbi = parseAbi([
  'function isApprovedForAll(address account, address operator) view returns (bool)'
]);

const TOKEN_ID = 1n;
const AMOUNT = 5n;

const rows = buildAdapters({ suite: 'bridge-erc1155' });

describe.concurrent('ERC-1155 deposit and exit cycle', { timeout: CYCLE_TIMEOUT_MS }, () => {
  it.each(rows)('via $name', async (row) => {
    const { tokens } = getTestEnv().E2E_ADDRESSES_JSON;
    const pos = await initPos(row);
    const parentToken = pos.parent.erc1155(tokens.root.erc1155);
    const childToken = pos.child.erc1155(tokens.child.erc1155);

    const parentBefore = await parentToken.getBalance(row.address, TOKEN_ID);
    const childBefore = await childToken.getBalance(row.address, TOKEN_ID);
    expect(parentBefore >= AMOUNT, 'seeded root DummyERC1155 balance').equals(true);

    await confirmSuccess(await parentToken.approveAll());
    expect(await parentToken.isApprovedAll(row.address)).equals(true);

    const deposit = await confirmSuccess(
      await parentToken.deposit({ tokenId: TOKEN_ID, amount: AMOUNT, userAddress: row.address })
    );
    expect(await parentToken.getBalance(row.address, TOKEN_ID)).equals(parentBefore - AMOUNT);

    await waitForStateSync({
      read: () => childToken.getBalance(row.address, TOKEN_ID),
      done: (balance) => balance === childBefore + AMOUNT,
      label: `${row.name} child DummyERC1155 #1 balance`
    });
    expect(await pos.isDeposited(deposit.transactionHash)).equals(true);

    const burn = await confirmSuccess(await childToken.startWithdraw(TOKEN_ID, AMOUNT));
    expect(await childToken.getBalance(row.address, TOKEN_ID)).equals(childBefore);
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
    expect(await parentToken.getBalance(row.address, TOKEN_ID)).equals(parentBefore);
  });
});

describe.each(rows)('ERC-1155 approvals via $name', (row) => {
  it('approveAll() returns a hash and confirms success', async () => {
    const { tokens } = getTestEnv().E2E_ADDRESSES_JSON;
    const pos = await initPos(row);
    const parentToken = pos.parent.erc1155(tokens.root.erc1155);

    const tx = await parentToken.approveAll();
    expect(tx.hash).match(HASH_PATTERN);
    await confirmSuccess(tx);
    expect(await parentToken.isApprovedAll(row.address)).equals(true);
  });

  it('approveAllForMintable() approves the MintableERC1155Predicate', async () => {
    const { tokens, addresses } = getTestEnv().E2E_ADDRESSES_JSON;
    const pos = await initPos(row);
    const mintable = pos.parent.erc1155(tokens.root.mintableErc1155);

    const tx = await mintable.approveAllForMintable();
    expect(tx.hash).match(HASH_PATTERN);
    await confirmSuccess(tx);
    const approved = await readers().l1.readContract({
      address: tokens.root.mintableErc1155,
      abi: isApprovedForAllAbi,
      functionName: 'isApprovedForAll',
      args: [row.address, addresses.MintableERC1155Predicate]
    });
    expect(approved).equals(true);
  });
});
