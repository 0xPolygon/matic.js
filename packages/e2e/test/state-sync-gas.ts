/**
 * The Uburu hard fork's per-record state-sync gas limit, and the reads that
 * show what it does to a deposit.
 *
 * From Uburu (bor v2.11.0, kurtosis-pos #841) bor's StateReceiver gives each
 * state-sync record at most the `gasLimit()` of a gas oracle, 160,000 on the
 * devnet, and commits a record that runs out of gas as FAILED, so the L2
 * side of the deposit never happens. Minting a pos-portal ERC-721 on L2
 * needs about 213,000. kurtosis-pos's own e2e raises the limit around those
 * deposits as the devnet admin, who owns the oracle (pos-e2e #132); the
 * ERC-721 file does the same, after proving the failure under the real limit.
 */
import type { Hex } from 'viem';

import { createWalletClient, http, parseAbi, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { expect } from 'vitest';

import { devnetChains, VIEM_POLLING_INTERVAL_MS } from '../src/adapters.ts';
import { getTestEnv } from '../src/test-env.ts';
import { readers, waitForStateSync } from './cycle.ts';

/** Uburu's state-sync gas oracle, a genesis contract at the same address on the devnet and mainnet. */
const STATE_SYNC_GAS_ORACLE = '0x5e3a5eafd4501332c0bc2acfd38df3ebc5152147';
/** bor's StateReceiver system contract, which commits each state-sync record on L2. */
const STATE_RECEIVER = '0x0000000000000000000000000000000000001001';

/** The oracle's limit as the devnet boots: what the protocol ships. */
export const UBURU_STATE_SYNC_GAS_LIMIT = 160_000n;
/** What pos-e2e raises it to around an ERC-721 deposit. */
export const RAISED_STATE_SYNC_GAS_LIMIT = 500_000n;

const oracleAbi = parseAbi([
  'function gasLimit() view returns (uint256)',
  'function setGasLimit(uint256 limit)'
]);
const stateSyncedAbi = parseAbi([
  'event StateSynced(uint256 indexed id, address indexed contractAddress, bytes data)'
]);
const stateCommittedAbi = parseAbi(['event StateCommitted(uint256 indexed stateId, bool success)']);

export function readStateSyncGasLimit(): Promise<bigint> {
  return readers().l2.readContract({
    address: STATE_SYNC_GAS_ORACLE,
    abi: oracleAbi,
    functionName: 'gasLimit'
  });
}

/** Set the oracle's limit as the devnet admin, and fail unless it reads back. */
export async function setStateSyncGasLimit(limit: bigint): Promise<void> {
  const wallet = createWalletClient({
    account: privateKeyToAccount(getTestEnv().E2E_ADDRESSES_JSON.admin.privateKey),
    chain: devnetChains().l2,
    transport: http(),
    pollingInterval: VIEM_POLLING_INTERVAL_MS
  });
  const hash = await wallet.writeContract({
    address: STATE_SYNC_GAS_ORACLE,
    abi: oracleAbi,
    functionName: 'setGasLimit',
    args: [limit]
  });
  const receipt = await readers().l2.waitForTransactionReceipt({ hash });
  expect(receipt, `setGasLimit(${limit.toString()}) ${hash}`).property('status').equals('success');
  expect(await readStateSyncGasLimit()).equals(limit);
}

/** The state-sync ids an L1 transaction emitted. */
export async function stateSyncIdsOf(hash: Hex): Promise<bigint[]> {
  const receipt = await readers().l1.getTransactionReceipt({ hash });
  return parseEventLogs({ abi: stateSyncedAbi, eventName: 'StateSynced', logs: receipt.logs }).map(
    (event) => event.args.id
  );
}

/** Wait for L2 to commit a state-sync record, and return whether it succeeded. */
export async function stateCommittedSuccess({
  stateId,
  label
}: {
  stateId: bigint;
  label: string;
}): Promise<boolean> {
  return (
    (
      await waitForStateSync({
        read: async () =>
          readers().l2.getContractEvents({
            address: STATE_RECEIVER,
            abi: stateCommittedAbi,
            eventName: 'StateCommitted',
            args: { stateId },
            fromBlock: 0n
          }),
        done: (events) => events.length > 0,
        label: `${label}: StateCommitted(${stateId.toString()})`
      })
    )[0]?.args.success === true
  );
}
