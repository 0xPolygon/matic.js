/**
 * Quickstart for `@polygonlabs/pos-sdk` using ethers v6.
 *
 * Reads the parent-chain ERC-20 balance and submits a bridge-predicate
 * `approve(...)` write. Same flow as `viem.ts`; only the parent/child
 * config blocks differ.
 *
 * Unlike v5, ethers v6 already speaks native `bigint` for every
 * numeric value, so no boundary conversion is needed.
 *
 *     pnpm --filter @polygonlabs/pos-sdk run build
 *     PARENT_RPC=... CHILD_RPC=... PARENT_TOKEN=0x... \
 *       PRIVATE_KEY=0x... node --conditions=@polygonlabs/source examples/ethers-v6.ts
 */

import { JsonRpcProvider, Network, Wallet } from 'ethers';

import { POSClient, POSBridgeError } from '@polygonlabs/pos-sdk';
import { ethersV6Adapter } from '@polygonlabs/pos-sdk/ethers-v6';

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

// Sepolia chain id; v6 expects `Network.from(...)` plus
// `staticNetwork: true` to skip the chain-id auto-detection that
// v6's default provider performs on every call.
const SEPOLIA_CHAIN_ID = 11155111;
const AMOY_CHAIN_ID = 80002;

async function main(): Promise<void> {
  const parentProvider = new JsonRpcProvider(
    PARENT_RPC,
    Network.from(SEPOLIA_CHAIN_ID),
    { staticNetwork: true }
  );
  const parentSigner = new Wallet(PRIVATE_KEY, parentProvider);

  const childProvider = new JsonRpcProvider(
    CHILD_RPC,
    Network.from(AMOY_CHAIN_ID),
    { staticNetwork: true }
  );
  const childSigner = new Wallet(PRIVATE_KEY, childProvider);

  const pos = await POSClient.init({
    network: 'amoy',
    parent: ethersV6Adapter({ provider: parentProvider, signer: parentSigner }),
    child: ethersV6Adapter({ provider: childProvider, signer: childSigner })
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
