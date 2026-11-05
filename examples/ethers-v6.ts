/**
 * Quickstart for `@polygonlabs/maticjs` using ethers v6.
 *
 * Reads the parent-chain ERC-20 balance and submits a bridge-predicate
 * `approve(...)` write. Same flow as `viem.ts`; only the parent/child
 * config blocks differ.
 *
 * Unlike v5, ethers v6 already speaks native `bigint` for every
 * numeric value, so no boundary conversion is needed.
 *
 *     pnpm --filter @polygonlabs/maticjs run build
 *     PARENT_RPC=... CHILD_RPC=... PARENT_TOKEN=0x... \
 *       PRIVATE_KEY=0x... node --conditions=@polygonlabs/source examples/ethers-v6.ts
 */

import { isError, JsonRpcProvider, Network, Wallet } from 'ethers';

import { isMaticjsError, POSClient, TransactionRevertedError } from '@polygonlabs/maticjs';
import { ethersV6Adapter } from '@polygonlabs/maticjs/ethers-v6';

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
  const parentProvider = new JsonRpcProvider(PARENT_RPC, Network.from(SEPOLIA_CHAIN_ID), {
    staticNetwork: true
  });
  const parentSigner = new Wallet(PRIVATE_KEY, parentProvider);

  const childProvider = new JsonRpcProvider(CHILD_RPC, Network.from(AMOY_CHAIN_ID), {
    staticNetwork: true
  });
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
    // Errors from your wallet, node or ethers are rethrown unchanged, so
    // check for them first, on the thrown error itself, with ethers' own
    // `isError`. A mined revert is ethers' `CALL_EXCEPTION`, with the
    // receipt on it.
    if (isError(err, 'ACTION_REJECTED')) {
      console.error('rejected in the wallet');
      process.exit(1);
    }
    if (isError(err, 'CALL_EXCEPTION')) {
      console.error('the transaction reverted:', err.shortMessage);
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
