/**
 * Quickstart for `@polygonlabs/maticjs` using ethers v5.
 *
 * Reads the parent-chain ERC-20 balance and submits a bridge-predicate
 * `approve(...)` write. Same flow as `viem.ts`; only the parent/child
 * config blocks differ.
 *
 * v5 returns `BigNumber` for every numeric value but the SDK speaks
 * native `bigint` end-to-end. Convert at the boundary:
 * `someBigNumber.toBigInt()`.
 *
 *     pnpm --filter @polygonlabs/maticjs run build
 *     PARENT_RPC=... CHILD_RPC=... PARENT_TOKEN=0x... \
 *       PRIVATE_KEY=0x... node --conditions=@polygonlabs/source examples/ethers-v5.ts
 */

// `ethers-v5` is a devDep alias for ethers@5 — the same alias the SDK
// uses internally. In a real consumer you would `npm install ethers@5`
// and import from `'ethers'`.
import { providers, Wallet } from 'ethers-v5';

import { isMaticjsError, POSClient, TransactionRevertedError } from '@polygonlabs/maticjs';
import { ethersV5Adapter } from '@polygonlabs/maticjs/ethers-v5';

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
    // Errors from your wallet, node or ethers are rethrown unchanged, so
    // check for them first, on the thrown error itself. A standard EIP-1193
    // rejection keeps the wallet's `code: 4001`; for "user denied" text
    // ethers v5 raises its own `ACTION_REJECTED` instead. A mined revert is
    // ethers' own `CALL_EXCEPTION`, with the receipt on it.
    const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
    if (code === 4001 || code === 'ACTION_REJECTED') {
      console.error('rejected in the wallet');
      process.exit(1);
    }
    if (code === 'CALL_EXCEPTION') {
      console.error('the transaction reverted:', err);
      process.exit(1);
    }
    if (isMaticjsError(err)) {
      // A condition the SDK detected: an ApproveError from `approve`, or a
      // ConfirmationError from `confirmed()`. The message names the method
      // and the reason.
      console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
      // Find a named condition anywhere in the cause chain; its `info` is typed.
      const reverted = TransactionRevertedError.find(err);
      if (reverted !== null) console.error('reverted in tx:', reverted.info.transactionHash);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
