/**
 * Quickstart for `@polygonlabs/maticjs` using viem.
 *
 * Reads the parent-chain ERC-20 balance and submits a bridge-predicate
 * `approve(...)` write. The script intentionally stops after the
 * approve so it can be re-run safely without spending gas on a real
 * deposit each time — the deposit call is left in a comment block to
 * copy-paste once you are happy with the wiring.
 *
 * Run from the workspace root:
 *
 *     pnpm --filter @polygonlabs/maticjs run build
 *     PARENT_RPC=... CHILD_RPC=... PARENT_TOKEN=0x... \
 *       PRIVATE_KEY=0x... node --conditions=@polygonlabs/source examples/viem.ts
 */

import {
  BaseError,
  createPublicClient,
  createWalletClient,
  http,
  UserRejectedRequestError
} from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import { isMaticjsError, POSClient, TransactionRevertedError } from '@polygonlabs/maticjs';
import { viemAdapter } from '@polygonlabs/maticjs/viem';

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
    // Errors from your wallet, node or viem are rethrown unchanged, so
    // check for them first, on the thrown error itself, with viem's own
    // classes. viem reports no error for a mined revert; the SDK detects
    // that one and raises TransactionRevertedError, handled below.
    if (err instanceof BaseError && err.walk((e) => e instanceof UserRejectedRequestError)) {
      console.error('rejected in the wallet');
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

  // To actually bridge tokens, uncomment:
  //
  //   const deposit = await erc20.deposit(1_000_000n, account.address);
  //   await deposit.confirmed();
  //   const status = await pos.getDepositStatus(deposit.hash);
  //   if (!status.deposited && status.reason === 'delivery-failed' && status.replayable) {
  //     await (await pos.replayDeposit(deposit.hash)).confirmed(); // resend the failed delivery, paying its gas
  //   }
  //   console.log('deposit hash:', deposit.hash);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
