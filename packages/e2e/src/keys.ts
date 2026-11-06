/**
 * Deterministic test keys: one per (suite × adapter).
 *
 * Every key is derived from a fixed public string, so it is public by
 * construction — never store, fund on a real network, or reuse one. The
 * seed step funds each key on the devnet from the devnet admin key.
 *
 * Why one key per (suite × adapter) rather than one per adapter: each key
 * then has a single writer, so its nonce stream never races. The adapter
 * rows inside a file can run concurrently, and a failure points at exactly
 * one (suite, adapter) pair.
 */
import type { PrivateKeyAccount } from 'viem/accounts';

import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const SUITES = [
  'tx-result',
  'bigint',
  'adapter-parity',
  'bridge-erc20',
  'bridge-erc721',
  'bridge-erc1155',
  'bridge-ether',
  'staking',
  'staking-delegation'
] as const;

export const ADAPTERS = ['viem', 'ethers-v5', 'ethers-v6'] as const;

export type Suite = (typeof SUITES)[number];
export type AdapterName = (typeof ADAPTERS)[number];

export function privateKeyFor({ suite, adapter }: { suite: Suite; adapter: AdapterName }) {
  return keccak256(toHex(`maticjs-e2e:${suite}:${adapter}`));
}

export function keyFor({
  suite,
  adapter
}: {
  suite: Suite;
  adapter: AdapterName;
}): PrivateKeyAccount {
  return privateKeyToAccount(privateKeyFor({ suite, adapter }));
}

/** Every (suite × adapter) pair, in a fixed order the seed uses for per-key token ids. */
export function allKeySlots(): { suite: Suite; adapter: AdapterName; index: number }[] {
  return SUITES.flatMap((suite, s) =>
    ADAPTERS.map((adapter, a) => ({ suite, adapter, index: s * ADAPTERS.length + a }))
  );
}
