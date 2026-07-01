/**
 * Quickstart for `@polygonlabs/pos-sdk` using viem.
 *
 * Reads the parent-chain ERC-20 balance and submits a bridge-predicate
 * `approve(...)` write. The script intentionally stops after the
 * approve so it can be re-run safely without spending gas on a real
 * deposit each time — the deposit call is left in a comment block to
 * copy-paste once you are happy with the wiring.
 *
 * Run from the workspace root:
 *
 *     pnpm --filter @polygonlabs/pos-sdk run build
 *     PARENT_RPC=... CHILD_RPC=... PARENT_TOKEN=0x... \
 *       PRIVATE_KEY=0x... node --conditions=@polygonlabs/source examples/viem.ts
 */

import { createPublicClient, createWalletClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import { POSClient, POSBridgeError } from '@polygonlabs/pos-sdk';
import { viemAdapter } from '@polygonlabs/pos-sdk/viem';

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
const PRIVATE_KEY = requireEnv('PRIVATE_KEY') as `0x${string}`;

async function main(): Promise<void> {
  const account = privateKeyToAccount(PRIVATE_KEY);

  // Sepolia is the parent chain for Amoy. For mainnet, swap in
  // `mainnet` from `viem/chains` and pass `network: 'mainnet'` to
  // `POSClient.init`.
  const parentPublic = createPublicClient({ chain: sepolia, transport: http(PARENT_RPC) });
  const parentWallet = createWalletClient({ account, chain: sepolia, transport: http(PARENT_RPC) });

  // viem doesn't ship a built-in `polygon-amoy` chain object; the SDK
  // doesn't need one — only the RPC and an account.
  const childPublic = createPublicClient({ transport: http(CHILD_RPC) });
  const childWallet = createWalletClient({ account, transport: http(CHILD_RPC) });

  const pos = await POSClient.init({
    network: 'amoy',
    parent: viemAdapter({ public: parentPublic, wallet: parentWallet }),
    child: viemAdapter({ public: childPublic, wallet: childWallet })
  });

  const erc20 = pos.parent.erc20(PARENT_TOKEN);

  // Read.
  const balance = await erc20.getBalance(account.address);
  console.log(`balance(${account.address}): ${balance}`);

  // Write — approve the bridge predicate to spend a small amount.
  // `approve` resolves the predicate via the dynamic address index, so
  // there is no hard-coded predicate address.
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

  // To actually bridge tokens, uncomment:
  //
  //   const deposit = await erc20.deposit(1_000_000n, account.address);
  //   await deposit.confirmed();
  //   console.log('deposit hash:', deposit.hash);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
