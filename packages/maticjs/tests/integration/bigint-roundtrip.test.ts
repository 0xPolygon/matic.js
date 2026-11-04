/**
 * bigint round-trip integration test.
 *
 * The 1.0 SDK speaks `bigint` end-to-end. This file confirms the
 * round-trip survives ethers v5's `BigNumber` conversion layer, ethers
 * v6's native `bigint`, and viem's native `bigint`. A regression that
 * silently truncated to `Number.MAX_SAFE_INTEGER` (2^53 - 1) would
 * pass simpler tests using small amounts; this file deliberately uses
 * a number well above 2^53 to surface that case.
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
import { HAS_CREDS, readChainEnvOrPlaceholder } from './helpers.js';

const env = readChainEnvOrPlaceholder();

interface AdapterRow {
  name: string;
  parent: Adapter;
  child: Adapter;
  testWallet: Hex;
}

function rows(): readonly AdapterRow[] {
  if (!HAS_CREDS) return [];
  const viemAccount = privateKeyToAccount(env.privateKey);
  const v5Provider = new v5Providers.StaticJsonRpcProvider(env.parentRpc);
  const v5Signer = new V5Wallet(env.privateKey, v5Provider);
  const v6Provider = new JsonRpcProvider(env.parentRpc, V6Network.from(TEST_NETWORKS.parent.chainId), { staticNetwork: true });
  const v6Signer = new V6Wallet(env.privateKey, v6Provider);
  return [
    {
      name: 'viem',
      parent: viemAdapter({ public: createPublicClient({ chain: sepolia, transport: http(env.parentRpc) }),
        wallet: createWalletClient({ account: viemAccount, chain: sepolia, transport: http(env.parentRpc) }),
        account: viemAccount.address
      }),
      child: viemAdapter({ public: createPublicClient({ chain: polygonAmoy, transport: http(env.childRpc) }),
        wallet: createWalletClient({ account: viemAccount, chain: polygonAmoy, transport: http(env.childRpc) }),
        account: viemAccount.address
      }),
      testWallet: viemAccount.address
    },
    {
      name: 'ethers-v5',
      parent: ethersV5Adapter({ provider: v5Provider, signer: v5Signer }),
      child: ethersV5Adapter({ provider: new v5Providers.StaticJsonRpcProvider(env.childRpc),
        signer: new V5Wallet(env.privateKey, new v5Providers.StaticJsonRpcProvider(env.childRpc))
      }),
      testWallet: v5Signer.address as Hex
    },
    {
      name: 'ethers-v6',
      parent: ethersV6Adapter({ provider: v6Provider, signer: v6Signer }),
      child: ethersV6Adapter({ provider: new JsonRpcProvider(env.childRpc, V6Network.from(TEST_NETWORKS.child.chainId), { staticNetwork: true }),
        signer: new V6Wallet(env.privateKey, new JsonRpcProvider(env.childRpc, V6Network.from(TEST_NETWORKS.child.chainId), { staticNetwork: true }))
      }),
      testWallet: v6Signer.address as Hex
    }
  ];
}

const TABLE = rows().map((r) => [r.name, r] as const);

describe.skipIf(!HAS_CREDS)('bigint round-trip', { timeout: 120_000 }, () => {
  describe.each(TABLE)('via %s', (_name, row) => {
    it('approve(123456789012345678901234567890n) round-trips through getAllowance', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      const huge = 123_456_789_012_345_678_901_234_567_890n;
      const erc20 = pos.parent.erc20(TEST_NETWORKS.parent.contracts.erc20);
      const approveTx = await erc20.approve(huge);
      await approveTx.confirmed();
      const allowance = await erc20.getAllowance(row.testWallet);
      expect(allowance).equals(huge);
    });

    it('amounts above 2^53 do not lose precision', async () => {
      const pos = await POSClient.init({
        network: 'amoy',
        parent: row.parent,
        child: row.child
      });
      // 2^53 is `Number.MAX_SAFE_INTEGER + 1`. A regression that
      // silently truncated to JS Number would produce 2^53 itself
      // (loss of the +123 component); a regression that kept bigint
      // semantics returns the full value.
      const above = (1n << 53n) + 123n;
      const erc20 = pos.parent.erc20(TEST_NETWORKS.parent.contracts.erc20);
      const approveTx = await erc20.approve(above);
      await approveTx.confirmed();
      const allowance = await erc20.getAllowance(row.testWallet);
      expect(allowance).equals(above);
    });
  });
});
