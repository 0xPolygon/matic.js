/**
 * Full deposit → checkpoint → withdraw cycle test, gated by
 * `POS_SDK_TEST_E2E_ENABLED=true`.
 *
 * Each `it()` runs the full bridge cycle for one adapter:
 *   1. parent.erc20.approve(amount)
 *   2. parent.erc20.deposit(amount, userAddress) — submits to L1
 *   3. wait for state-sync to mirror the deposit on Amoy (~10 min)
 *   4. child.erc20.startWithdraw(amount) — burn on Amoy
 *   5. wait for the burn block to be checkpointed onto Sepolia
 *      (~30–90 min)
 *   6. parent.erc20.completeWithdraw(burnTxHash)
 *
 * Total wallclock per adapter is ~30–90 minutes; with the three
 * adapters in series the worst case approaches 4 hours, hence the
 * `{ timeout: 14_400_000 }` (4h) ceiling. The CI nightly workflow
 * (`ci-nightly.yml`) is the canonical scheduler.
 */
import { JsonRpcProvider, Network as V6Network, Wallet as V6Wallet } from 'ethers';
import { providers as v5Providers, Wallet as V5Wallet } from 'ethers-v5';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygonAmoy, sepolia } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import type { Adapter, Hex } from '../../src/index.js';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.js';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.js';
import { viemAdapter } from '../../src/adapters/viem.js';
import { POSClient } from '../../src/index.js';
import { TEST_NETWORKS } from '../fixtures/networks.js';
import {
  E2E_ENABLED,
  HAS_CREDS,
  readChainEnvOrPlaceholder
} from '../integration/helpers.js';

const env = readChainEnvOrPlaceholder();
const ENABLED = HAS_CREDS && E2E_ENABLED;

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const STATE_SYNC_TIMEOUT_MS = 12 * 60 * 1000;
const CHECKPOINT_TIMEOUT_MS = 90 * 60 * 1000;
const POLL_INTERVAL_MS = 30_000;

async function runCycle(parent: Adapter, child: Adapter, testWallet: Hex): Promise<void> {
  const pos = await POSClient.init({ network: 'amoy', parent, child });

  const parentToken = pos.parent.erc20(TEST_NETWORKS.parent.contracts.erc20);
  const childToken = pos.child.erc20(TEST_NETWORKS.child.contracts.erc20);

  const initialChild = await childToken.getBalance(testWallet);

  // 1. approve
  const approveTx = await parentToken.approve(1n);
  await approveTx.confirmed();

  // 2. deposit
  const depositTx = await parentToken.deposit(1n, testWallet);
  await depositTx.confirmed();

  // 3. wait for state-sync
  let bridged = initialChild;
  const syncDeadline = Date.now() + STATE_SYNC_TIMEOUT_MS;
  while (Date.now() < syncDeadline) {
    bridged = await childToken.getBalance(testWallet);
    if (bridged > initialChild) break;
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  expect(bridged > initialChild).equals(true);

  // 4. burn on the child chain
  const burnTx = await childToken.startWithdraw(1n);
  const burnReceipt = await burnTx.confirmed();

  // 5. wait for checkpoint
  // Repeatedly call completeWithdraw — it throws BURN_TX_NOT_CHECKPOINTED
  // until the burn block has been included. When the throw stops, the
  // checkpoint is in. We catch and retry until the deadline.
  const checkpointDeadline = Date.now() + CHECKPOINT_TIMEOUT_MS;
  let exitTxHash: string | undefined;
  while (Date.now() < checkpointDeadline) {
    try {
      const exitTx = await parentToken.completeWithdraw(burnReceipt.transactionHash);
      const exitReceipt = await exitTx.confirmed();
      exitTxHash = exitReceipt.transactionHash;
      break;
    } catch (err) {
      // The expected-during-wait error is BURN_TX_NOT_CHECKPOINTED;
      // any other error code is a real failure. The dynamic narrowing
      // is the team-standard pattern for branching on POSBridgeError.
      const { POSBridgeError } = await import('../../src/index.js');
      if (err instanceof POSBridgeError && err.code === 'BURN_TX_NOT_CHECKPOINTED') {
        await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }
      throw err;
    }
  }
  expect(exitTxHash).match(/^0x[0-9a-f]{64}$/i);
}

describe.skipIf(!ENABLED)(
  'deposit-withdraw cycle',
  { timeout: FOUR_HOURS_MS },
  () => {
    it('approves, deposits, waits for checkpoint, completes withdraw — viem', async () => {
      const account = privateKeyToAccount(env.privateKey);
      const parent = viemAdapter({
        public: createPublicClient({ chain: sepolia, transport: http(env.parentRpc) }),
        wallet: createWalletClient({ account, chain: sepolia, transport: http(env.parentRpc) }),
        account: account.address
      });
      const child = viemAdapter({
        public: createPublicClient({ chain: polygonAmoy, transport: http(env.childRpc) }),
        wallet: createWalletClient({ account, chain: polygonAmoy, transport: http(env.childRpc) }),
        account: account.address
      });
      await runCycle(parent, child, account.address);
    });

    it('— ethers v5', async () => {
      const v5ParentProvider = new v5Providers.StaticJsonRpcProvider(env.parentRpc);
      const v5ParentSigner = new V5Wallet(env.privateKey, v5ParentProvider);
      const v5ChildProvider = new v5Providers.StaticJsonRpcProvider(env.childRpc);
      const v5ChildSigner = new V5Wallet(env.privateKey, v5ChildProvider);
      const parent = ethersV5Adapter({ provider: v5ParentProvider, signer: v5ParentSigner });
      const child = ethersV5Adapter({ provider: v5ChildProvider, signer: v5ChildSigner });
      await runCycle(parent, child, v5ParentSigner.address as Hex);
    });

    it('— ethers v6', async () => {
      const v6ParentProvider = new JsonRpcProvider(env.parentRpc, V6Network.from(TEST_NETWORKS.parent.chainId), { staticNetwork: true });
      const v6ParentSigner = new V6Wallet(env.privateKey, v6ParentProvider);
      const v6ChildProvider = new JsonRpcProvider(env.childRpc, V6Network.from(TEST_NETWORKS.child.chainId), { staticNetwork: true });
      const v6ChildSigner = new V6Wallet(env.privateKey, v6ChildProvider);
      const parent = ethersV6Adapter({ provider: v6ParentProvider, signer: v6ParentSigner });
      const child = ethersV6Adapter({ provider: v6ChildProvider, signer: v6ChildSigner });
      await runCycle(parent, child, (await v6ParentSigner.getAddress()) as Hex);
    });
  }
);
