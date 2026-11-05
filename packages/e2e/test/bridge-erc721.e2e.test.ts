/**
 * ERC-721 bridge writes through each adapter, against the devnet's
 * pos-portal DummyERC721.
 *
 * Each row moves three tokens: one through the single-token path
 * (`deposit` → `startWithdraw` → `completeWithdraw`) and two through the
 * batch path (`depositMany` → `startWithdrawMany` → one
 * `completeWithdrawOnIndex` per token). The batch burn is exited one token
 * at a time so the partly-exited state can be observed: after exiting
 * index 0, `isWithdrawExitedOnIndices` must report `[true, false]`.
 * Ownership is checked on both chains with plain reads at every step.
 */
import type { Address, PublicClient } from 'viem';

import { createWalletClient, http } from 'viem';
import { describe, expect, it } from 'vitest';

import type { Suite } from '../src/keys.ts';

import { devnetChains, VIEM_POLLING_INTERVAL_MS, buildAdapters } from '../src/adapters.ts';
import { dummyErc721Abi } from '../src/devnet-abis.ts';
import { ADAPTERS, keyFor } from '../src/keys.ts';
import { getTestEnv } from '../src/test-env.ts';
import {
  confirmSuccess,
  CYCLE_TIMEOUT_MS,
  exitWhenCheckpointed,
  HASH_PATTERN,
  initPos,
  isApprovedForAll,
  readers,
  revokeApprovalForAll,
  waitForCheckpoint,
  waitForStateSync
} from './cycle.ts';

const SUITE: Suite = 'bridge-erc721';
const TOKENS_PER_CYCLE = 3;

const rows = buildAdapters({ suite: SUITE });

async function ownerOf({
  client,
  token,
  tokenId
}: {
  client: PublicClient;
  token: Address;
  tokenId: bigint;
}): Promise<Address | undefined> {
  try {
    return await client.readContract({
      address: token,
      abi: dummyErc721Abi,
      functionName: 'ownerOf',
      args: [tokenId]
    });
  } catch {
    // pos-portal tokens revert `ownerOf` for an id nobody holds.
    return undefined;
  }
}

/**
 * Make sure the row's key owns at least {@link TOKENS_PER_CYCLE} root
 * tokens. The seed gives each key one; the batch path needs two more. Each
 * adapter mints from its own id range, well clear of the seed's ranges, so
 * concurrent rows never race for an id.
 */
async function ensureRootTokens({
  adapterIndex,
  address,
  have
}: {
  adapterIndex: number;
  address: Address;
  have: number;
}): Promise<void> {
  const { tokens } = getTestEnv().E2E_ADDRESSES_JSON;
  const { l1 } = readers();
  const adapter = ADAPTERS[adapterIndex];
  if (adapter === undefined) throw new Error(`no adapter at index ${String(adapterIndex)}`);
  const wallet = createWalletClient({
    account: keyFor({ suite: SUITE, adapter }),
    chain: devnetChains().l1,
    transport: http(),
    pollingInterval: VIEM_POLLING_INTERVAL_MS
  });
  let tokenId = 500_000n + 10_000n * BigInt(adapterIndex);
  for (let missing = TOKENS_PER_CYCLE - have; missing > 0; missing--) {
    while ((await ownerOf({ client: l1, token: tokens.root.erc721, tokenId })) !== undefined) {
      tokenId++;
    }
    const hash = await wallet.writeContract({
      address: tokens.root.erc721,
      abi: dummyErc721Abi,
      functionName: 'mint',
      args: [tokenId]
    });
    const receipt = await l1.waitForTransactionReceipt({ hash });
    expect(receipt).property('status').equals('success');
    expect(await ownerOf({ client: l1, token: tokens.root.erc721, tokenId })).equals(address);
  }
}

describe.concurrent('ERC-721 deposit and exit cycle', { timeout: CYCLE_TIMEOUT_MS }, () => {
  it.each(rows)('via $name', async (row) => {
    const { tokens, addresses } = getTestEnv().E2E_ADDRESSES_JSON;
    const { l1, l2 } = readers();
    const pos = await initPos(row);
    const parentToken = pos.parent.erc721(tokens.root.erc721);
    const childToken = pos.child.erc721(tokens.child.erc721);

    await ensureRootTokens({
      adapterIndex: ADAPTERS.indexOf(row.name),
      address: row.address,
      have: await parentToken.getTokensCount(row.address)
    });
    const parentCountBefore = await parentToken.getTokensCount(row.address);
    const childCountBefore = await childToken.getTokensCount(row.address);
    const [single, batchA, batchB] = await parentToken.getAllTokens(row.address, TOKENS_PER_CYCLE);
    if (single === undefined || batchA === undefined || batchB === undefined) {
      throw new Error(`${row.name}: expected ${String(TOKENS_PER_CYCLE)} root tokens`);
    }
    const batch = [batchA, batchB];
    const moved = [single, ...batch];

    // Revoke first so the approval check below cannot pass on an earlier run's approval.
    const approval = {
      token: tokens.root.erc721,
      owner: row.address,
      operator: addresses.ERC721Predicate
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

    const singleDeposit = await confirmSuccess(await parentToken.deposit(single, row.address));
    const batchDeposit = await confirmSuccess(await parentToken.depositMany(batch, row.address));
    expect(await parentToken.getTokensCount(row.address)).equals(
      parentCountBefore - TOKENS_PER_CYCLE
    );

    await waitForStateSync({
      read: () => childToken.getTokensCount(row.address),
      done: (count) => count === childCountBefore + TOKENS_PER_CYCLE,
      label: `${row.name} child DummyERC721 count`
    });
    expect(await pos.isDeposited(singleDeposit.transactionHash)).equals(true);
    expect(await pos.isDeposited(batchDeposit.transactionHash)).equals(true);
    for (const tokenId of moved) {
      expect(await ownerOf({ client: l2, token: tokens.child.erc721, tokenId })).equals(
        row.address
      );
    }

    const singleBurn = await confirmSuccess(await childToken.startWithdraw(single));
    const batchBurn = await confirmSuccess(await childToken.startWithdrawMany(batch));
    expect(await childToken.getTokensCount(row.address)).equals(childCountBefore);
    // The batch burn is the later block, so its checkpoint covers the single burn too.
    await waitForCheckpoint({
      pos,
      burnHash: batchBurn.transactionHash,
      label: `${row.name} batch burn ${batchBurn.transactionHash}`
    });
    expect(await parentToken.isWithdrawExited(singleBurn.transactionHash)).equals(false);
    expect(
      await parentToken.isWithdrawExitedOnIndices(batchBurn.transactionHash, [0, 1])
    ).deep.equals([false, false]);

    await exitWhenCheckpointed({
      exit: () => parentToken.completeWithdraw(singleBurn.transactionHash),
      label: `${row.name} ERC-721 single burn ${singleBurn.transactionHash}`
    });
    expect(await parentToken.isWithdrawExited(singleBurn.transactionHash)).equals(true);
    expect(await parentToken.isWithdrawExitedOnIndex(singleBurn.transactionHash, 0)).equals(true);
    expect(
      await parentToken.isWithdrawExitedOnIndices(singleBurn.transactionHash, [0])
    ).deep.equals([true]);
    expect(await ownerOf({ client: l1, token: tokens.root.erc721, tokenId: single })).equals(
      row.address
    );

    // Exit the batch one token at a time; the first exit leaves the second pending.
    await exitWhenCheckpointed({
      exit: () => parentToken.completeWithdrawOnIndex(batchBurn.transactionHash, 0),
      label: `${row.name} ERC-721 batch burn ${batchBurn.transactionHash} index 0`
    });
    expect(
      await parentToken.isWithdrawExitedOnIndices(batchBurn.transactionHash, [0, 1])
    ).deep.equals([true, false]);
    expect(await parentToken.isWithdrawExitedOnIndex(batchBurn.transactionHash, 1)).equals(false);
    expect(await ownerOf({ client: l1, token: tokens.root.erc721, tokenId: batchA })).equals(
      row.address
    );

    await confirmSuccess(await parentToken.completeWithdrawOnIndex(batchBurn.transactionHash, 1));
    expect(
      await parentToken.isWithdrawExitedOnIndices(batchBurn.transactionHash, [0, 1])
    ).deep.equals([true, true]);
    expect(await ownerOf({ client: l1, token: tokens.root.erc721, tokenId: batchB })).equals(
      row.address
    );

    expect(await parentToken.getTokensCount(row.address)).equals(parentCountBefore);
  });
});

describe.each(rows)('ERC-721 approveAll via $name', (row) => {
  it('approveAll() returns a hash and confirms success', async () => {
    const { tokens, addresses } = getTestEnv().E2E_ADDRESSES_JSON;
    const pos = await initPos(row);
    const parentToken = pos.parent.erc721(tokens.root.erc721);
    const approval = {
      token: tokens.root.erc721,
      owner: row.address,
      operator: addresses.ERC721Predicate
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
});
