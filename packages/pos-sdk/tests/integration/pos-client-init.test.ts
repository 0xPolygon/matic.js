/**
 * `POSClient.init` smoke test, parameterised over all three adapters.
 *
 * The same five `it()` bodies run for viem, ethers v5, and ethers v6 —
 * any divergence in init behaviour between the three lights up exactly
 * one row of the matrix.
 */
import { JsonRpcProvider, Network as V6Network, Wallet as V6Wallet } from 'ethers';
import { providers as v5Providers, Wallet as V5Wallet } from 'ethers-v5';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygonAmoy, sepolia } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, POSClientConfig } from '../../src/index.js';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.js';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.js';
import { viemAdapter } from '../../src/adapters/viem.js';
import {
  POSClient
} from '../../src/index.js';
import { ERC20 } from '../../src/pos/erc20.js';
import { __resetAddressCacheForTesting } from '../../src/services/address-service.js';
import { TEST_NETWORKS } from '../fixtures/networks.js';
import { HAS_CREDS, readChainEnvOrPlaceholder } from './helpers.js';

const env = readChainEnvOrPlaceholder();

interface AdapterFactory {
  /** Human-readable name for `describe.each` row. */
  name: string;
  /** Build the parent adapter (Sepolia). */
  parent(): Adapter;
  /** Build the child adapter (Amoy). */
  child(): Adapter;
}

function viemFactory(): AdapterFactory {
  return {
    name: 'viem',
    parent: () => {
      const account = privateKeyToAccount(env.privateKey);
      const publicClient = createPublicClient({
        chain: sepolia,
        transport: http(env.parentRpc)
      });
      const walletClient = createWalletClient({
        account,
        chain: sepolia,
        transport: http(env.parentRpc)
      });
      return viemAdapter({ public: publicClient, wallet: walletClient, account: account.address });
    },
    child: () => {
      const account = privateKeyToAccount(env.privateKey);
      const publicClient = createPublicClient({
        chain: polygonAmoy,
        transport: http(env.childRpc)
      });
      const walletClient = createWalletClient({
        account,
        chain: polygonAmoy,
        transport: http(env.childRpc)
      });
      return viemAdapter({ public: publicClient, wallet: walletClient, account: account.address });
    }
  };
}

function ethersV5Factory(): AdapterFactory {
  return {
    name: 'ethers-v5',
    parent: () => {
      const provider = new v5Providers.StaticJsonRpcProvider(env.parentRpc);
      const signer = new V5Wallet(env.privateKey, provider);
      return ethersV5Adapter({ provider, signer });
    },
    child: () => {
      const provider = new v5Providers.StaticJsonRpcProvider(env.childRpc);
      const signer = new V5Wallet(env.privateKey, provider);
      return ethersV5Adapter({ provider, signer });
    }
  };
}

function ethersV6Factory(): AdapterFactory {
  return {
    name: 'ethers-v6',
    parent: () => {
      const provider = new JsonRpcProvider(env.parentRpc, V6Network.from(TEST_NETWORKS.parent.chainId), { staticNetwork: true });
      const signer = new V6Wallet(env.privateKey, provider);
      return ethersV6Adapter({ provider, signer });
    },
    child: () => {
      const provider = new JsonRpcProvider(env.childRpc, V6Network.from(TEST_NETWORKS.child.chainId), { staticNetwork: true });
      const signer = new V6Wallet(env.privateKey, provider);
      return ethersV6Adapter({ provider, signer });
    }
  };
}

const FACTORIES: readonly AdapterFactory[] = [
  viemFactory(),
  ethersV5Factory(),
  ethersV6Factory()
];

const FAKE_ADDRESSES = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666'
} as const;

describe.skipIf(!HAS_CREDS)('POSClient.init', { timeout: 60_000 }, () => {
  beforeEach(() => {
    __resetAddressCacheForTesting();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe.each(FACTORIES.map((f) => [f.name, f] as const))(
    'POSClient.init via %s',
    (_name, factory) => {
      it('constructs and exposes parent/child namespaces', async () => {
        const config: POSClientConfig = {
          network: 'amoy',
          parent: factory.parent(),
          child: factory.child(),
          // Provide pre-resolved addresses so init does not hit the CDN
          // — keeps the test deterministic and self-contained.
          addresses: FAKE_ADDRESSES
        };
        const client = await POSClient.init(config);
        expect(client).property('parent').an('object');
        expect(client).property('child').an('object');
        expect(client).property('rootChainManager').an('object');
      });

      it('parent.erc20(addr) returns ERC20 bound to parent chain', async () => {
        const client = await POSClient.init({
          network: 'amoy',
          parent: factory.parent(),
          child: factory.child(),
          addresses: FAKE_ADDRESSES
        });
        const erc20 = client.parent.erc20(TEST_NETWORKS.parent.contracts.erc20);
        expect(erc20).instanceOf(ERC20);
      });

      it('child.erc20(addr) returns ERC20 bound to child chain', async () => {
        const client = await POSClient.init({
          network: 'amoy',
          parent: factory.parent(),
          child: factory.child(),
          addresses: FAKE_ADDRESSES
        });
        const erc20 = client.child.erc20(TEST_NETWORKS.child.contracts.erc20);
        expect(erc20).instanceOf(ERC20);
      });

      it('skips CDN fetch entirely when config.addresses is provided', async () => {
        // Spy on global fetch to assert no HTTPS request to the address
        // index — the SDK is expected to short-circuit when the consumer
        // supplies addresses directly (the staging / air-gapped path).
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        await POSClient.init({
          network: 'amoy',
          parent: factory.parent(),
          child: factory.child(),
          addresses: FAKE_ADDRESSES
        });
        // Find any call to the address index URL — there must be none.
        const indexCalls = fetchSpy.mock.calls.filter(([url]) =>
          typeof url === 'string' && url.includes('static.polygon.technology')
        );
        expect(indexCalls).lengthOf(0);
      });

      it('refreshes infrastructure addresses after addressTTLMs elapses', async () => {
        // The address fetcher is the SDK's owner of the CDN. We mount a
        // counter via a custom baseUrl pointing at a mock fetch; this
        // is the same pattern as `tests/unit/address-service.test.ts`.
        let calls = 0;
        const recordingFetch = vi.fn(async (_url: string) => {
          calls++;
          const body: typeof FAKE_ADDRESSES = FAKE_ADDRESSES;
          const json = async (): Promise<unknown> => body;
          return { ok: true, json } as unknown as Response;
        });
        vi.stubGlobal('fetch', recordingFetch);
        const client = await POSClient.init({
          network: 'amoy',
          parent: factory.parent(),
          child: factory.child(),
          addressIndexUrl: 'https://test.polygon.technology/network',
          addressTTLMs: 50
        });
        expect(calls).equals(1);
        // Wait for the TTL to lapse; on the next access the fetcher
        // serves stale and triggers a background refresh.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        // Force one client touch that goes through the fetcher.
        await client.rootChainManager.caller.getContractAddress();
        // Drain microtasks so the background refresh has propagated.
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(calls).greaterThan(1);
      });
    }
  );
});
