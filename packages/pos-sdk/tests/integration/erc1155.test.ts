/**
 * ERC-1155 integration tests, parameterised over all three adapters.
 *
 * Same shape as `erc20.test.ts` and `erc721.test.ts`. Tests assume the
 * test wallet holds a balance of tokenId `1` of the parent-chain
 * test ERC-1155 (mintable; see `tests/README.md`).
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
const TEST_TOKEN_ID = 1n;

interface AdapterRow {
  name: string;
  parent: Adapter;
  child: Adapter;
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

describe.skipIf(!HAS_CREDS)('ERC1155', { timeout: 90_000 }, () => {
  describe.each(TABLE)('via %s', (_name, row) => {
    it('parent.erc1155(addr).getBalance returns the test wallet balance as bigint', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const balance = await pos.parent
        .erc1155(TEST_NETWORKS.parent.contracts.erc1155)
        .getBalance(row.testWallet, TEST_TOKEN_ID);
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
        .isApprovedAll(row.testWallet);
      expect(typeof isApproved).equals('boolean');
    });

    it('parent.erc1155(addr).approveAll() submits and returns TxResult with hash', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const tx = await pos.parent
        .erc1155(TEST_NETWORKS.parent.contracts.erc1155)
        .approveAll();
      expect(tx).property('hash').match(/^0x[0-9a-f]{64}$/i);
    });

    it.skipIf(!E2E_ENABLED)(
      'child.erc1155(addr).getBalance round-trips a freshly deposited amount',
      { timeout: 14_400_000 },
      async () => {
        const pos = await POSClient.init({
          network: 'amoy',
          parent: row.parent,
          child: row.child
        });
        const initial = await pos.child
          .erc1155(TEST_NETWORKS.child.contracts.erc1155)
          .getBalance(row.testWallet, TEST_TOKEN_ID);

        const approveTx = await pos.parent
          .erc1155(TEST_NETWORKS.parent.contracts.erc1155)
          .approveAll();
        await approveTx.confirmed();
        const depositTx = await pos.parent
          .erc1155(TEST_NETWORKS.parent.contracts.erc1155)
          .deposit({
            tokenId: TEST_TOKEN_ID,
            amount: 1n,
            userAddress: row.testWallet
          });
        await depositTx.confirmed();

        let updated = initial;
        const deadline = Date.now() + 12 * 60 * 1000;
        while (Date.now() < deadline) {
          updated = await pos.child
            .erc1155(TEST_NETWORKS.child.contracts.erc1155)
            .getBalance(row.testWallet, TEST_TOKEN_ID);
          if (updated > initial) break;
          await new Promise<void>((r) => setTimeout(r, 30_000));
        }
        expect(updated > initial).equals(true);
      }
    );
  });
});
