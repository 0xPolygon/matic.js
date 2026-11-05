/**
 * SDK adapters for each (suite × adapter) key, built the way a consumer of
 * each library would build them.
 *
 * The SDK is imported only through its public entry points. Which build of
 * the SDK those resolve to, and how the ethers v5 adapter gets ethers 5, is
 * decided in `vitest.e2e.config.ts`.
 */
import type { Address, Chain } from 'viem';

import { JsonRpcProvider, Network, Wallet as WalletV6 } from 'ethers';
import { providers, Wallet as WalletV5 } from 'ethers-v5';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';

import type { Adapter } from '@polygonlabs/maticjs';

import { ethersV5Adapter } from '@polygonlabs/maticjs/ethers-v5';
import { ethersV6Adapter } from '@polygonlabs/maticjs/ethers-v6';
import { viemAdapter } from '@polygonlabs/maticjs/viem';

import type { AdapterName, Suite } from './keys.ts';

import { keyFor, privateKeyFor } from './keys.ts';
import { getTestEnv } from './test-env.ts';

/**
 * viem's default polling interval is 4 s; devnet blocks are 1 s. Polling
 * faster cuts each `confirmed()` from about 4 s to about 1 s.
 */
export const VIEM_POLLING_INTERVAL_MS = 250;

export interface AdapterRow {
  name: AdapterName;
  parent: Adapter;
  child: Adapter;
  address: Address;
}

function devnetChain({ id, name, rpcUrl }: { id: number; name: string; rpcUrl: string }): Chain {
  return defineChain({
    id,
    name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  });
}

export function devnetChains(): { l1: Chain; l2: Chain } {
  const env = getTestEnv();
  return {
    l1: devnetChain({ id: env.E2E_L1_CHAIN_ID, name: 'devnet-l1', rpcUrl: env.E2E_L1_RPC_URL }),
    l2: devnetChain({ id: env.E2E_L2_CHAIN_ID, name: 'devnet-l2', rpcUrl: env.E2E_L2_RPC_URL })
  };
}

function viemRow(suite: Suite): AdapterRow {
  const account = keyFor({ suite, adapter: 'viem' });
  const { l1, l2 } = devnetChains();
  const side = (chain: Chain): Adapter =>
    viemAdapter({
      public: createPublicClient({
        chain,
        transport: http(),
        pollingInterval: VIEM_POLLING_INTERVAL_MS
      }),
      wallet: createWalletClient({
        account,
        chain,
        transport: http(),
        pollingInterval: VIEM_POLLING_INTERVAL_MS
      })
    });
  return { name: 'viem', parent: side(l1), child: side(l2), address: account.address };
}

function ethersV6Row(suite: Suite): AdapterRow {
  const env = getTestEnv();
  const privateKey = privateKeyFor({ suite, adapter: 'ethers-v6' });
  const side = (url: string, chainId: number): Adapter => {
    const provider = new JsonRpcProvider(url, Network.from(chainId), { staticNetwork: true });
    return ethersV6Adapter({ provider, signer: new WalletV6(privateKey, provider) });
  };
  return {
    name: 'ethers-v6',
    parent: side(env.E2E_L1_RPC_URL, env.E2E_L1_CHAIN_ID),
    child: side(env.E2E_L2_RPC_URL, env.E2E_L2_CHAIN_ID),
    address: keyFor({ suite, adapter: 'ethers-v6' }).address
  };
}

function ethersV5Row(suite: Suite): AdapterRow {
  const env = getTestEnv();
  const privateKey = privateKeyFor({ suite, adapter: 'ethers-v5' });
  const side = (url: string, chainId: number, name: string): Adapter => {
    const provider = new providers.StaticJsonRpcProvider(url, { chainId, name });
    return ethersV5Adapter({ provider, signer: new WalletV5(privateKey, provider) });
  };
  return {
    name: 'ethers-v5',
    parent: side(env.E2E_L1_RPC_URL, env.E2E_L1_CHAIN_ID, 'devnet-l1'),
    child: side(env.E2E_L2_RPC_URL, env.E2E_L2_CHAIN_ID, 'devnet-l2'),
    address: keyFor({ suite, adapter: 'ethers-v5' }).address
  };
}

/** One row per adapter, each signing with that (suite × adapter) key. */
export function buildAdapters({ suite }: { suite: Suite }): AdapterRow[] {
  return [viemRow(suite), ethersV5Row(suite), ethersV6Row(suite)];
}

/**
 * Staking writes pin the network's L1 chain id unless the caller overrides
 * it. The devnet is neither mainnet nor Amoy, so every staking write passes
 * the devnet's L1 chain id. Bridge writes need no override: they use the
 * adapter's own chain. No fee options are passed anywhere: every adapter's
 * default fee estimate lands on this devnet.
 */
export function stakingTxOptions(): { chainId: number } {
  return { chainId: getTestEnv().E2E_L1_CHAIN_ID };
}
