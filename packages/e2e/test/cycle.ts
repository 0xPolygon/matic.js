/**
 * Shared plumbing for the bridge cycle tests: building a `POSClient` for an
 * adapter row, waiting for state sync, and retrying an exit until its burn
 * is checkpointed.
 *
 * The waits are polls with hard caps rather than fixed sleeps, so a fast
 * devnet finishes fast and a stuck one fails with a message naming what it
 * was waiting for.
 */
import type { Address, Hash, PublicClient } from 'viem';

import { createPublicClient, createWalletClient, http } from 'viem';
import { expect } from 'vitest';

import type { Receipt, TxResult } from '@polygonlabs/maticjs';

import { BurnTxNotCheckpointedError, POSClient } from '@polygonlabs/maticjs';

import type { AdapterRow } from '../src/adapters.ts';
import type { AdapterName, Suite } from '../src/keys.ts';

import { devnetChains, VIEM_POLLING_INTERVAL_MS } from '../src/adapters.ts';
import { approvalForAllAbi, dummyErc1155Abi, erc20Abi } from '../src/devnet-abis.ts';
import { keyFor } from '../src/keys.ts';
import { getTestEnv } from '../src/test-env.ts';
import { pollUntil } from '../src/wait.ts';

/** Poll interval for every cycle wait. Devnet blocks are 1 s. */
export const POLL_MS = 2_000;
/** Deposit confirmed → child balance visible. Measured at about 55 s. */
export const STATE_SYNC_TIMEOUT_MS = 180_000;
/** Burn confirmed → first exit that builds. Measured at 18-36 s. */
export const CHECKPOINT_TIMEOUT_MS = 300_000;
/** Whole-cycle cap per test. */
export const CYCLE_TIMEOUT_MS = 900_000;

export const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;

/** A `POSClient` for one adapter row, pointed at the devnet's contracts. */
export function initPos(row: AdapterRow): Promise<POSClient> {
  return POSClient.init({
    network: 'amoy',
    addresses: getTestEnv().E2E_ADDRESSES_JSON.addresses,
    parent: row.parent,
    child: row.child
  });
}

/**
 * Plain viem readers for each chain. The tests use them for facts the SDK
 * does not expose (native balances, gas paid, raw `ownerOf`), so an
 * assertion on the SDK's own reads is never checked with the SDK.
 */
export function readers(): { l1: PublicClient; l2: PublicClient } {
  const { l1, l2 } = devnetChains();
  return {
    l1: createPublicClient({
      chain: l1,
      transport: http(),
      pollingInterval: VIEM_POLLING_INTERVAL_MS
    }),
    l2: createPublicClient({
      chain: l2,
      transport: http(),
      pollingInterval: VIEM_POLLING_INTERVAL_MS
    })
  };
}

/** Await a write's receipt and assert it landed. */
export async function confirmSuccess(tx: TxResult): Promise<Receipt> {
  expect(tx.hash).match(HASH_PATTERN);
  const receipt = await tx.confirmed();
  expect(receipt).property('status').equals('success');
  expect(receipt).property('transactionHash').equals(tx.hash);
  return receipt;
}

/** Wait until `read()` satisfies `done`, polling every {@link POLL_MS}. */
export function waitForStateSync<T>({
  read,
  done,
  label
}: {
  read: () => Promise<T>;
  done: (value: T) => boolean;
  label: string;
}): Promise<T> {
  return pollUntil({
    fn: async () => {
      const value = await read();
      return done(value) ? value : undefined;
    },
    pollMs: POLL_MS,
    timeoutMs: STATE_SYNC_TIMEOUT_MS,
    label: `state sync: ${label}`
  });
}

/**
 * Wait until a burn's L2 block is covered by a checkpoint on L1.
 *
 * The `getWithdrawExitStatus*` reads derive the exit hash from the checkpoint,
 * so before it lands they throw `BURN_TX_NOT_CHECKPOINTED` rather than
 * returning `false`. A "not exited yet" check therefore has to wait here
 * first.
 */
export async function waitForCheckpoint({
  pos,
  burnHash,
  label
}: {
  pos: POSClient;
  burnHash: string;
  label: string;
}): Promise<void> {
  await pollUntil({
    fn: async () => ((await pos.getCheckpointStatus(burnHash)).checkpointed ? true : undefined),
    pollMs: POLL_MS,
    timeoutMs: CHECKPOINT_TIMEOUT_MS,
    label: `checkpoint: ${label}`
  });
}

/**
 * Submit an exit, retrying while the burn is not yet checkpointed.
 *
 * `exit()` builds the payload before broadcasting, and the build throws
 * `BURN_TX_NOT_CHECKPOINTED` until heimdall's checkpoint covering the burn
 * block lands on L1. Nothing is broadcast on those attempts, so retrying
 * costs no gas. Any other error is a real failure and is rethrown.
 */
export async function exitWhenCheckpointed({
  exit,
  label
}: {
  exit: () => Promise<TxResult>;
  label: string;
}): Promise<Receipt> {
  const tx = await pollUntil({
    fn: async () => {
      try {
        return await exit();
      } catch (err) {
        if (BurnTxNotCheckpointedError.has(err)) {
          return undefined;
        }
        throw err;
      }
    },
    pollMs: POLL_MS,
    timeoutMs: CHECKPOINT_TIMEOUT_MS,
    label: `checkpoint: ${label}`
  });
  return confirmSuccess(tx);
}

/** Gas paid by a transaction, in wei, read from its L1 receipt. */
export async function gasPaid({
  client,
  hash
}: {
  client: PublicClient;
  hash: Hash;
}): Promise<bigint> {
  const receipt = await client.getTransactionReceipt({ hash });
  return receipt.gasUsed * receipt.effectiveGasPrice;
}

/** `isApprovedForAll(owner, operator)` on an L1 token, read with plain viem. */
export function isApprovedForAll({
  token,
  owner,
  operator
}: {
  token: Address;
  owner: Address;
  operator: Address;
}): Promise<boolean> {
  return readers().l1.readContract({
    address: token,
    abi: approvalForAllAbi,
    functionName: 'isApprovedForAll',
    args: [owner, operator]
  });
}

/**
 * Revoke `operator`'s approval-for-all on an L1 token with a plain viem
 * write from the (suite × adapter) key, and check it now reads false.
 *
 * Nothing in the tier ever revokes the approval `approveAll()` sets, and a
 * devnet can outlive a run, so on a reused devnet an "approved after
 * `approveAll()`" check would pass on an earlier run's approval even if this
 * run's write changed nothing. Revoking first gives the write something to
 * change.
 */
export async function revokeApprovalForAll({
  suite,
  adapter,
  token,
  operator
}: {
  suite: Suite;
  adapter: AdapterName;
  token: Address;
  operator: Address;
}): Promise<void> {
  const account = keyFor({ suite, adapter });
  const wallet = createWalletClient({
    account,
    chain: devnetChains().l1,
    transport: http(),
    pollingInterval: VIEM_POLLING_INTERVAL_MS
  });
  const hash = await wallet.writeContract({
    address: token,
    abi: approvalForAllAbi,
    functionName: 'setApprovalForAll',
    args: [operator, false]
  });
  const receipt = await readers().l1.waitForTransactionReceipt({ hash });
  expect(receipt).property('status').equals('success');
  expect(await isApprovedForAll({ token, owner: account.address, operator })).equals(false);
}

/** ERC-20 `balanceOf`, read with plain viem on the given chain's client. */
export function erc20BalanceOf({
  client,
  token,
  owner
}: {
  client: PublicClient;
  token: Address;
  owner: Address;
}): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner]
  });
}

/** ERC-1155 `balanceOf`, read with plain viem on the given chain's client. */
export function erc1155BalanceOf({
  client,
  token,
  owner,
  id
}: {
  client: PublicClient;
  token: Address;
  owner: Address;
  id: bigint;
}): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: dummyErc1155Abi,
    functionName: 'balanceOf',
    args: [owner, id]
  });
}
