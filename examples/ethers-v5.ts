/**
 * Quickstart for `@polygonlabs/pos-sdk` using ethers v5.
 *
 * Reads the parent-chain ERC-20 balance and submits a bridge-predicate
 * `approve(...)` write. Same flow as `viem.ts`; only the parent/child
 * config blocks differ.
 *
 * v5 returns `BigNumber` for every numeric value but the SDK speaks
 * native `bigint` end-to-end. Convert at the boundary:
 * `someBigNumber.toBigInt()`.
 *
 *     pnpm --filter @polygonlabs/pos-sdk run build
 *     PARENT_RPC=... CHILD_RPC=... PARENT_TOKEN=0x... \
 *       PRIVATE_KEY=0x... node --conditions=@polygonlabs/source examples/ethers-v5.ts
 */

// `ethers-v5` is a devDep alias for ethers@5 — the same alias the SDK
// uses internally. In a real consumer you would `npm install ethers@5`
// and import from `'ethers'`.
import { providers, Wallet } from 'ethers-v5';

import { POSClient, POSBridgeError } from '@polygonlabs/pos-sdk';
import { ethersV5Adapter } from '@polygonlabs/pos-sdk/ethers-v5';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    console.error(`set ${name}=...`);
    process.exit(1);
  }
  return v;
}

const PARENT_RPC = requireEnv('PARENT_RPC');
const CHILD_RPC = requireEnv('CHILD_RPC');
const PARENT_TOKEN = requireEnv('PARENT_TOKEN') as `0x${string}`;
const PRIVATE_KEY = requireEnv('PRIVATE_KEY');

async function main(): Promise<void> {
  // `StaticJsonRpcProvider` skips the chain-id sniffing round-trip on
  // every call — required for any service that polls (the SDK doesn't
  // subscribe, so this is the right provider to pick).
  const parentProvider = new providers.StaticJsonRpcProvider(PARENT_RPC);
  const parentSigner = new Wallet(PRIVATE_KEY, parentProvider);

  const childProvider = new providers.StaticJsonRpcProvider(CHILD_RPC);
  const childSigner = new Wallet(PRIVATE_KEY, childProvider);

  const pos = await POSClient.init({
    network: 'amoy',
    parent: ethersV5Adapter({ provider: parentProvider, signer: parentSigner }),
    child: ethersV5Adapter({ provider: childProvider, signer: childSigner })
  });

  const erc20 = pos.parent.erc20(PARENT_TOKEN);

  const balance = await erc20.getBalance(parentSigner.address);
  console.log(`balance(${parentSigner.address}): ${balance}`);

  try {
    const result = await erc20.approve(1_000_000n);
    console.log('approve hash:    ', result.hash);
    const receipt = await result.confirmed();
    console.log('approve mined in:', receipt.blockNumber, 'status:', receipt.status);
  } catch (err) {
    if (err instanceof POSBridgeError) {
      console.error(`POSBridgeError ${err.code}: ${err.message}`);
      console.error('context:', err.context);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
