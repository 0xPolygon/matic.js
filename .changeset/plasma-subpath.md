---
'@polygonlabs/maticjs': minor
---

Add the Plasma bridge at `@polygonlabs/maticjs/plasma`, so ERC-20 tokens, including native POL, can be withdrawn through Plasma with the same viem, ethers v5 or ethers v6 adapters as the PoS bridge.

## What you can do

`PlasmaClient.init` takes a `parent` and a `child` adapter. Token handles come from `plasma.parent.erc20(address)` and `plasma.child.erc20(address)`, with the same call shapes as the PoS bridge's.

- `approve`, `approveMax` and `deposit` move tokens from Ethereum to Polygon.
- A withdrawal is `startWithdraw` (burn on the child chain), `confirmWithdraw` or `confirmWithdrawFast` (queue the exit on the parent chain once a checkpoint covers the burn), and `completeWithdraw` (pay out after the exit's waiting period).
- `plasma.processExits({ tokens })` pays out the exit queues of several tokens in one transaction.
- `getWithdrawStatus({ burnTxHash, confirmTxHash? })` answers `{ exited: true }` or `{ exited: false, reason }`, where `reason` is `'pending'`, `'not-checkpointed'`, `'not-confirmed'`, `'in-exit-window'` or `'ready-to-process'`, so you know what the withdrawal is waiting for. `{ exited: true }` means the exit was processed, not that the payout succeeded in full. Without `confirmTxHash` a checkpointed burn reads `'not-confirmed'` even if its exit was already processed, so keep the confirm hash.
- Every write has a `prepareXxx` sibling that returns the unsigned `{ to, data, value? }` for smart wallets and batchers.
- `plasma.getProcessExitsGasLimit({ tokens })` and `plasma.parent.erc20(address).getCompleteWithdrawGasLimit()` return the gas limit the SDK's own `processExits` and `completeWithdraw` would send. A prepared payout transaction carries no gas, and a wallet's own estimate is too low for the contract's exit loop, which then stops without paying out and without reverting. Set the transaction's gas limit to at least the value these return.
- `confirmWithdrawFast` takes the exit payload from a proof-generation API when you set `proofGenerationApiUrl`.
- `PlasmaClient.init` accepts `chainIds` and `rootChainDefaultBlock`, as `POSClient.init` does.
- The Plasma contracts' ABIs are exported from `@polygonlabs/maticjs/plasma/abi` as `PlasmaDepositManagerABI`, `PlasmaWithdrawManagerABI`, `PlasmaExitNFTABI`, `PlasmaPriorityQueueABI`, `PlasmaMRC20ABI`, `PlasmaChildERC20ABI` and `PlasmaERC20PredicateABI`. `@polygonlabs/maticjs/abi` does not export them; `RootChainABI`, which both bridges use, stays there.
- `PlasmaClient.init` takes `addresses` as the seven Plasma addresses (`PlasmaAddresses`), and `plasma.getAddresses()` returns that same type. The Plasma client reads and validates only the Plasma entries of the address index, so `NetworkAddresses` and `pos.getAddresses()` are unchanged. If a refresh of the index lacks a Plasma entry, the client keeps serving the last good addresses and calls `onAddressRefreshError`.
- The compiler rejects calls that cannot work. `plasma.parent.erc20()` returns `PlasmaParentERC20` and `plasma.child.erc20()` returns `PlasmaChildERC20`, each listing only the methods valid on that chain (the burn on the child; deposits, approvals, confirms, payouts and `getWithdrawStatus` on the parent). `PlasmaClientConfig` rejects `addressIndexUrl`, `addressTTLMs` and `onAddressRefreshError` beside `addresses`, which skips the index.
- The errors only Plasma raises (`ExitNotStartedError`, `ExitQueueEmptyError`, `ExitGasLimitTooLowError`, `NativeBurnValueMismatchError`, `ChildBurnValueNotAllowedError`) and the Plasma event topics (`PlasmaEventSignature`) are exported from `@polygonlabs/maticjs/plasma`. `isMaticjsError` and `MATICJS_ERROR_NAMES` from any entry recognise them.
- Reason and status types have importable names: `CheckpointRangeInvalidReason`, `ExitNotStartedReason`, `ReplacementReason` and `FailedStateSyncRecord` are new exports, and `WithdrawNotExitedReason` and `PlasmaWithdrawNotExitedReason` are built from `CheckpointNotReachedReason`. Their values are unchanged.

```ts
import { createPublicClient, createWalletClient, http } from 'viem';
import { mainnet, polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { PlasmaClient } from '@polygonlabs/maticjs/plasma';
import { viemAdapter } from '@polygonlabs/maticjs/viem';

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

const plasma = await PlasmaClient.init({
  network: 'mainnet',
  parent: viemAdapter({
    public: createPublicClient({ chain: mainnet, transport: http(process.env.PARENT_RPC) }),
    wallet: createWalletClient({ account, chain: mainnet, transport: http(process.env.PARENT_RPC) })
  }),
  child: viemAdapter({
    public: createPublicClient({ chain: polygon, transport: http(process.env.CHILD_RPC) }),
    wallet: createWalletClient({ account, chain: polygon, transport: http(process.env.CHILD_RPC) })
  })
});

const { PolToken } = await plasma.getAddresses();
const nativeToken = '0x0000000000000000000000000000000000001010';

// Burn POL on the child chain.
const burn = await plasma.child.erc20(nativeToken).startWithdraw(10n ** 18n);
await burn.confirmed();

// Once a checkpoint covers the burn, queue the exit on the parent chain.
const pol = plasma.parent.erc20(PolToken);
const confirm = await pol.confirmWithdraw(burn.hash);
await confirm.confirmed();

// After the exit's waiting period, pay out the queue.
const status = await pol.getWithdrawStatus({ burnTxHash: burn.hash, confirmTxHash: confirm.hash });
if (!status.exited && status.reason === 'ready-to-process') {
  await (await pol.completeWithdraw()).confirmed();
}
```

## Things to know

- The gas limit's floor is read from the contract. If the contract answers without that value the SDK uses 300,000; a network or RPC failure on that read reaches you unchanged.
- A successful `completeWithdraw` receipt does not prove your exit was processed: the contract stops without reverting when it runs low on gas or reaches an exit that is not yet due. Check `getWithdrawStatus`.
- Without a `gasLimit`, the SDK sizes the limit as the node's estimate plus `PROCESS_EXITS_GAS_PER_EXIT` for every queued exit, capped at `MAX_PROCESS_EXITS_GAS_LIMIT`; both are exported from `@polygonlabs/maticjs/plasma`. A `gasLimit` too low for the contract's loop to start is refused with `ExitGasLimitTooLowError`, whose `info.minimum` is the floor.
- Send `confirmWithdraw` and `confirmWithdrawFast` from the account that made the burn; the contract starts the exit only for that account. `completeWithdraw` and `processExits` can be sent from any account, and each exit pays its owner.
- The bridge accepts one exit per burn transaction, so never batch two burns into one transaction: the second can never be confirmed. A contract wallet must exist at the same address on Ethereum to confirm its own burn.
- ERC-721 tokens, `depositEther`, `transfer`, and MoreVP and challenge exits are not included. See `MIGRATION.md` if you are coming from `@maticnetwork/maticjs-plasma`.
