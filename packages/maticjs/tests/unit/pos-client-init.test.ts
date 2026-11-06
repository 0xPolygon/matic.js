/**
 * `POSClient.init` smoke test, parameterised over all three adapters.
 *
 * The same five `it()` bodies run for viem, ethers v5, and ethers v6 —
 * any divergence in init behaviour between the three lights up exactly
 * one row of the matrix.
 *
 * No case dials an RPC: each one either passes `addresses` or stubs
 * `fetch`, so the adapters sit on an unroutable placeholder URL with no
 * signer, and every provider is static (no network detection on build).
 */
import { JsonRpcProvider, Network as V6Network } from 'ethers';
import { providers as v5Providers } from 'ethers-v5';
import { createPublicClient, http } from 'viem';
import { polygonAmoy, sepolia } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, POSClientConfig } from '../../src/index.js';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.js';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.js';
import { viemAdapter } from '../../src/adapters/viem.js';
import { POSClient } from '../../src/index.js';
import { ERC20 } from '../../src/pos/erc20.js';
import { __resetAddressCacheForTesting } from '../../src/services/address-service.js';
import { TEST_NETWORKS } from '../fixtures/networks.js';

/** Unroutable on purpose: a case that dialled it would fail loudly. */
const UNUSED_RPC = 'http://127.0.0.1:1';

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
    parent: () =>
      viemAdapter({ public: createPublicClient({ chain: sepolia, transport: http(UNUSED_RPC) }) }),
    child: () =>
      viemAdapter({
        public: createPublicClient({ chain: polygonAmoy, transport: http(UNUSED_RPC) })
      })
  };
}

function ethersV5Factory(): AdapterFactory {
  return {
    name: 'ethers-v5',
    parent: () =>
      ethersV5Adapter({
        provider: new v5Providers.StaticJsonRpcProvider(UNUSED_RPC, TEST_NETWORKS.parent.chainId)
      }),
    child: () =>
      ethersV5Adapter({
        provider: new v5Providers.StaticJsonRpcProvider(UNUSED_RPC, TEST_NETWORKS.child.chainId)
      })
  };
}

function ethersV6Factory(): AdapterFactory {
  return {
    name: 'ethers-v6',
    parent: () =>
      ethersV6Adapter({
        provider: new JsonRpcProvider(UNUSED_RPC, V6Network.from(TEST_NETWORKS.parent.chainId), {
          staticNetwork: true
        })
      }),
    child: () =>
      ethersV6Adapter({
        provider: new JsonRpcProvider(UNUSED_RPC, V6Network.from(TEST_NETWORKS.child.chainId), {
          staticNetwork: true
        })
      })
  };
}

const FACTORIES: readonly AdapterFactory[] = [viemFactory(), ethersV5Factory(), ethersV6Factory()];

const FAKE_ADDRESSES = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666'
} as const;

describe('POSClient.init', { timeout: 60_000 }, () => {
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
        const indexCalls = fetchSpy.mock.calls.filter(
          ([url]) => typeof url === 'string' && url.includes('static.polygon.technology')
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
          const text = async (): Promise<string> => JSON.stringify(body);
          return { ok: true, text } as unknown as Response;
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
