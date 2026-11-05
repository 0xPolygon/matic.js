/**
 * Shared helpers for the live-read tier.
 *
 * The bridge-token and adapter files read the Sepolia (parent) and Amoy
 * (child) RPC URLs from `POS_SDK_TEST_PARENT_RPC` / `POS_SDK_TEST_CHILD_RPC`
 * and build signer-less adapters on them. Every call is a read, so no key
 * is needed; writes run against a local devnet in `packages/e2e`.
 *
 * # Why gate on the URLs instead of falling back to public endpoints
 *
 * These files make many calls per run across three adapters, which free
 * public Sepolia / Amoy endpoints throttle. CI composes rate-limit-free
 * URLs (`.github/scripts/compose-rpc-env.sh`); without them the files
 * skip rather than fail on a 429.
 */
import { JsonRpcProvider, Network as V6Network } from 'ethers';
import { providers as v5Providers } from 'ethers-v5';
import { createPublicClient, http } from 'viem';
import { polygonAmoy, sepolia } from 'viem/chains';

import type { Adapter, Hex } from '../../src/index.js';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.js';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.js';
import { viemAdapter } from '../../src/adapters/viem.js';
import { TEST_NETWORKS } from '../fixtures/networks.js';

/** True when both testnet RPC URLs are set; the `skipIf` guard. */
export const HAS_LIVE_RPC =
  (process.env['POS_SDK_TEST_PARENT_RPC'] ?? '') !== '' &&
  (process.env['POS_SDK_TEST_CHILD_RPC'] ?? '') !== '';

export interface LiveEnv {
  parentRpc: string;
  childRpc: string;
}

/**
 * Read the RPC URLs. Without them it returns placeholders: the gated
 * `describe` bodies still have to type-check and build their tables at
 * collection time, but no `it()` body runs, so the placeholders are never
 * dialled.
 */
export function readLiveEnv(): LiveEnv {
  if (!HAS_LIVE_RPC) {
    return { parentRpc: 'http://placeholder', childRpc: 'http://placeholder' };
  }
  return {
    parentRpc: process.env['POS_SDK_TEST_PARENT_RPC'] ?? '',
    childRpc: process.env['POS_SDK_TEST_CHILD_RPC'] ?? ''
  };
}

/**
 * A fixed, well-known address used as the subject of balance and approval
 * reads. Its values change over time, so tests assert shapes, not amounts.
 */
export const READ_SUBJECT: Hex = '0x000000000000000000000000000000000000dEaD';

/** Emits one stderr line when the live tier is skipped for lack of URLs. */
export function noteSkippedIfNoLiveRpc(label: string): void {
  if (!HAS_LIVE_RPC) {
    process.stderr.write(
      `[maticjs live] ${label} skipped: POS_SDK_TEST_PARENT_RPC / POS_SDK_TEST_CHILD_RPC unset\n`
    );
  }
}

export interface ReadAdapterRow {
  name: string;
  parent: Adapter;
  child: Adapter;
}

/**
 * One signer-less parent/child adapter pair per library, for
 * `describe.each`. Empty without the URLs so a skipped file builds no
 * providers.
 */
export function readAdapterRows(): readonly (readonly [string, ReadAdapterRow])[] {
  if (!HAS_LIVE_RPC) return [];
  const env = readLiveEnv();
  const rows: ReadAdapterRow[] = [
    {
      name: 'viem',
      parent: viemAdapter({
        public: createPublicClient({ chain: sepolia, transport: http(env.parentRpc) })
      }),
      child: viemAdapter({
        public: createPublicClient({ chain: polygonAmoy, transport: http(env.childRpc) })
      })
    },
    {
      name: 'ethers-v5',
      parent: ethersV5Adapter({
        provider: new v5Providers.StaticJsonRpcProvider(env.parentRpc)
      }),
      child: ethersV5Adapter({
        provider: new v5Providers.StaticJsonRpcProvider(env.childRpc)
      })
    },
    {
      name: 'ethers-v6',
      parent: ethersV6Adapter({
        provider: new JsonRpcProvider(env.parentRpc, V6Network.from(TEST_NETWORKS.parent.chainId), {
          staticNetwork: true
        })
      }),
      child: ethersV6Adapter({
        provider: new JsonRpcProvider(env.childRpc, V6Network.from(TEST_NETWORKS.child.chainId), {
          staticNetwork: true
        })
      })
    }
  ];
  return rows.map((r) => [r.name, r] as const);
}
