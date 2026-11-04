/**
 * ERC-20 integration tests, parameterised over all three adapters.
 *
 * The test wallet is identified by the public key derived from
 * `POS_SDK_TEST_PRIVATE_KEY`. Tests assume the wallet holds a balance
 * of the parent-chain test ERC-20 (mintable; see `tests/README.md`).
 *
 * Read paths (`getBalance`, `getAllowance`) hit the real chain; write
 * paths (`approve`) submit real transactions. The deposit flow's
 * round-trip is gated on `POS_SDK_TEST_E2E_ENABLED` because checkpoint
 * inclusion takes ~30–90 minutes on Amoy↔Sepolia.
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
} from './helpers.js';

const env = readChainEnvOrPlaceholder();

interface AdapterRow {
  name: string;
  parent: Adapter;
  child: Adapter;
  /** Address derived from the private key on the parent chain. */
  testWallet: Hex;
}

function rows(): readonly AdapterRow[] {
  if (!HAS_CREDS) return [];
  const viemAccount = privateKeyToAccount(env.privateKey);
  const v5ChildProvider = new v5Providers.StaticJsonRpcProvider(env.childRpc);
  const v5ChildSigner = new V5Wallet(env.privateKey, v5ChildProvider);
  const v5ParentProvider = new v5Providers.StaticJsonRpcProvider(env.parentRpc);
  const v5ParentSigner = new V5Wallet(env.privateKey, v5ParentProvider);
  const v6ChildProvider = new JsonRpcProvider(
    env.childRpc,
    V6Network.from(TEST_NETWORKS.child.chainId),
    { staticNetwork: true }
  );
  const v6ChildSigner = new V6Wallet(env.privateKey, v6ChildProvider);
  const v6ParentProvider = new JsonRpcProvider(
    env.parentRpc,
    V6Network.from(TEST_NETWORKS.parent.chainId),
    { staticNetwork: true }
  );
  const v6ParentSigner = new V6Wallet(env.privateKey, v6ParentProvider);
  return [
    {
      name: 'viem',
      parent: viemAdapter({ public: createPublicClient({ chain: sepolia, transport: http(env.parentRpc) }),
        wallet: createWalletClient({
          account: viemAccount,
          chain: sepolia,
          transport: http(env.parentRpc)
        }),
        account: viemAccount.address
      }),
      child: viemAdapter({ public: createPublicClient({ chain: polygonAmoy, transport: http(env.childRpc) }),
        wallet: createWalletClient({
          account: viemAccount,
          chain: polygonAmoy,
          transport: http(env.childRpc)
        }),
        account: viemAccount.address
      }),
      testWallet: viemAccount.address
    },
    {
      name: 'ethers-v5',
      parent: ethersV5Adapter({ provider: v5ParentProvider, signer: v5ParentSigner }),
      child: ethersV5Adapter({ provider: v5ChildProvider, signer: v5ChildSigner }),
      testWallet: v5ParentSigner.address as Hex
    },
    {
      name: 'ethers-v6',
      parent: ethersV6Adapter({ provider: v6ParentProvider, signer: v6ParentSigner }),
      child: ethersV6Adapter({ provider: v6ChildProvider, signer: v6ChildSigner }),
      testWallet: v6ParentSigner.address as Hex
    }
  ];
}

const TABLE = rows().map((r) => [r.name, r] as const);

describe.skipIf(!HAS_CREDS)('ERC20', { timeout: 90_000 }, () => {
  describe.each(TABLE)('via %s', (_name, row) => {
    it('parent.erc20(addr).getBalance returns the test wallet balance as bigint', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const balance = await pos.parent
        .erc20(TEST_NETWORKS.parent.contracts.erc20)
        .getBalance(row.testWallet);
      expect(typeof balance).equals('bigint');
      expect(balance >= 0n).equals(true);
    });

    it('parent.erc20(addr).getAllowance(user, spender) reads allowance', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const allowance = await pos.parent
        .erc20(TEST_NETWORKS.parent.contracts.erc20)
        // Read against the bridge's predicate (the legacy default).
        .getAllowance(row.testWallet);
      expect(typeof allowance).equals('bigint');
      expect(allowance >= 0n).equals(true);
    });

    it('parent.erc20(addr).approve(amount) submits and returns TxResult with hash', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const tx = await pos.parent
        .erc20(TEST_NETWORKS.parent.contracts.erc20)
        // 1 wei — the smallest meaningful approval value. Doesn't
        // require the wallet to actually hold tokens.
        .approve(1n);
      expect(tx).property('hash').match(/^0x[0-9a-f]{64}$/i);
    });

    it('TxResult.confirmed() resolves to a receipt', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const tx = await pos.parent
        .erc20(TEST_NETWORKS.parent.contracts.erc20)
        .approve(1n);
      const receipt = await tx.confirmed();
      expect(receipt).property('status').oneOf(['success', 'reverted']);
      expect(receipt).property('transactionHash').match(/^0x[0-9a-f]{64}$/i);
    });

    it.skipIf(!E2E_ENABLED)(
      'child.erc20(addr).getBalance round-trips a freshly deposited amount',
      { timeout: 14_400_000 },
      async () => {
        // Gated on POS_SDK_TEST_E2E_ENABLED because deposit confirmation
        // on Amoy can take ~10 minutes (state-sync delay). The full e2e
        // cycle test in tests/e2e/ exercises the longer checkpoint path.
        const pos = await POSClient.init({
          network: 'amoy',
          parent: row.parent,
          child: row.child
        });
        const initial = await pos.child
          .erc20(TEST_NETWORKS.child.contracts.erc20)
          .getBalance(row.testWallet);

        // Approve 1 wei + deposit. The state-sync to Amoy takes time;
        // poll the child balance until it bumps.
        const approveTx = await pos.parent
          .erc20(TEST_NETWORKS.parent.contracts.erc20)
          .approve(1n);
        await approveTx.confirmed();
        const depositTx = await pos.parent
          .erc20(TEST_NETWORKS.parent.contracts.erc20)
          .deposit(1n, row.testWallet);
        await depositTx.confirmed();

        // Poll until balance increases — bounded by the test timeout.
        let updated = initial;
        const deadline = Date.now() + 12 * 60 * 1000;
        while (Date.now() < deadline) {
          updated = await pos.child
            .erc20(TEST_NETWORKS.child.contracts.erc20)
            .getBalance(row.testWallet);
          if (updated > initial) break;
          await new Promise<void>((r) => setTimeout(r, 30_000));
        }
        expect(updated > initial).equals(true);
      }
    );
  });
});
