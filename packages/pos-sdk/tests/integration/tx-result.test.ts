/**
 * `TxResult` shape integration test.
 *
 * The 1.0 contract: `await write(...)` resolves the moment the chain
 * accepts the broadcast (returning a `TxResult` carrying a `hash` and
 * a `confirmed()` factory); `confirmed()` returns a `Receipt` and is
 * idempotent — calling it twice resolves to equivalent receipts via
 * one underlying poll.
 *
 * The legacy SDK's awaitable result blurred "submitted" and
 * "confirmed". This file pins that the new shape never re-introduces
 * that ambiguity.
 */
import { JsonRpcProvider, Network as V6Network, Wallet as V6Wallet } from 'ethers';
import { providers as v5Providers, Wallet as V5Wallet } from 'ethers-v5';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygonAmoy, sepolia } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import type { Adapter } from '../../src/index.js';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.js';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.js';
import { viemAdapter } from '../../src/adapters/viem.js';
import { POSClient } from '../../src/index.js';
import { TEST_NETWORKS } from '../fixtures/networks.js';
import { HAS_CREDS, readChainEnvOrPlaceholder } from './helpers.js';

const env = readChainEnvOrPlaceholder();

interface AdapterRow {
  name: string;
  parent: Adapter;
  child: Adapter;
}

function rows(): readonly AdapterRow[] {
  if (!HAS_CREDS) return [];
  const viemAccount = privateKeyToAccount(env.privateKey);
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
      })
    },
    {
      name: 'ethers-v5',
      parent: ethersV5Adapter({ provider: new v5Providers.StaticJsonRpcProvider(env.parentRpc),
        signer: new V5Wallet(env.privateKey, new v5Providers.StaticJsonRpcProvider(env.parentRpc))
      }),
      child: ethersV5Adapter({ provider: new v5Providers.StaticJsonRpcProvider(env.childRpc),
        signer: new V5Wallet(env.privateKey, new v5Providers.StaticJsonRpcProvider(env.childRpc))
      })
    },
    {
      name: 'ethers-v6',
      parent: ethersV6Adapter({ provider: new JsonRpcProvider(env.parentRpc, V6Network.from(TEST_NETWORKS.parent.chainId), { staticNetwork: true }),
        signer: new V6Wallet(env.privateKey, new JsonRpcProvider(env.parentRpc, V6Network.from(TEST_NETWORKS.parent.chainId), { staticNetwork: true }))
      }),
      child: ethersV6Adapter({ provider: new JsonRpcProvider(env.childRpc, V6Network.from(TEST_NETWORKS.child.chainId), { staticNetwork: true }),
        signer: new V6Wallet(env.privateKey, new JsonRpcProvider(env.childRpc, V6Network.from(TEST_NETWORKS.child.chainId), { staticNetwork: true }))
      })
    }
  ];
}

const TABLE = rows().map((r) => [r.name, r] as const);

describe.skipIf(!HAS_CREDS)('TxResult shape', { timeout: 120_000 }, () => {
  describe.each(TABLE)('via %s', (_name, row) => {
    it('hash is a non-empty 0x-prefixed string immediately on resolve', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const tx = await pos.parent
        .erc20(TEST_NETWORKS.parent.contracts.erc20)
        .approve(1n);
      // The hash must be ready immediately — `write()` resolves on
      // broadcast, NOT on confirmation. The team-standard
      // `instance` shape on TxResult guarantees this.
      expect(tx.hash).match(/^0x[0-9a-f]{64}$/i);
    });

    it('confirmed() resolves to a Receipt within 60s on Sepolia', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const tx = await pos.parent
        .erc20(TEST_NETWORKS.parent.contracts.erc20)
        .approve(1n);
      const r = await tx.confirmed();
      expect(r).property('transactionHash').match(/^0x[0-9a-f]{64}$/i);
      expect(r).property('status').oneOf(['success', 'reverted']);
    });

    it('confirmed() can be called multiple times safely (idempotent)', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const tx = await pos.parent
        .erc20(TEST_NETWORKS.parent.contracts.erc20)
        .approve(1n);
      const a = await tx.confirmed();
      const b = await tx.confirmed();
      expect(a.transactionHash).equals(b.transactionHash);
      expect(a.status).equals(b.status);
    });

    it('await on the method does not pre-confirm (confirmed() must be called explicitly)', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const start = Date.now();
      const tx = await pos.parent
        .erc20(TEST_NETWORKS.parent.contracts.erc20)
        .approve(1n);
      const broadcastMs = Date.now() - start;
      // Sepolia block time ~12s; if `write()` waited for confirmation
      // the broadcast measurement would routinely exceed 12s. A
      // conservative threshold is 8s — well below block time, well
      // above any plausible RPC overhead.
      expect(broadcastMs).lessThan(8_000);
      expect(tx.hash).match(/^0x[0-9a-f]{64}$/i);
    });
  });
});
