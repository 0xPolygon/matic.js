# @polygonlabs/maticjs

[![npm version](https://img.shields.io/npm/v/@polygonlabs/maticjs.svg)](https://www.npmjs.com/package/@polygonlabs/maticjs)
[![License: MIT](https://img.shields.io/npm/l/@polygonlabs/maticjs.svg)](LICENSE)

TypeScript SDK for the Polygon PoS bridge, the Plasma bridge and PoS
staking. Deposits, withdrawals, and exit proofs against `RootChainManager` —
across ERC-20, ERC-721, ERC-1155 and native ETH — plus Plasma ERC-20
deposits and withdrawals from `@polygonlabs/maticjs/plasma` and validator and delegator
staking from `@polygonlabs/maticjs/staking`, driven by whichever EVM client
library you already have: `viem`, `ethers v5`, or `ethers v6`.

`@polygonlabs/maticjs` 4.0 is the next major release of maticjs,
moved from the `@maticnetwork` npm scope — versions up to 3.x remain
published as `@maticnetwork/maticjs`. If you are migrating, read
[MIGRATION.md](./MIGRATION.md).

## Install

```bash
pnpm add @polygonlabs/maticjs viem      # or
pnpm add @polygonlabs/maticjs ethers    # v5 or v6
```

`viem` and `ethers` are optional peer dependencies. Install only the
one you use; the SDK keeps every cross-library import type-only at the
module-load boundary so the absent peer never crashes.

### Entry points

One package, several entry points. Import only the ones you use, so your bundle
carries no code for the bridges and features you do not call:

| Import                                                  | What it is for                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `@polygonlabs/maticjs`                                  | PoS bridge: `POSClient`, errors, status types                                 |
| `@polygonlabs/maticjs/plasma`                           | Plasma bridge: `PlasmaClient` (ERC-20 deposits and withdrawals)                |
| `@polygonlabs/maticjs/staking`                          | Validator and delegator staking: `StakingClient`                              |
| `@polygonlabs/maticjs/viem`, `/ethers-v5`, `/ethers-v6` | The adapter factory for the library you use                                   |
| `@polygonlabs/maticjs/abi`                              | The PoS and staking ABIs plus `RootChainABI`, for calls the SDK does not wrap |
| `@polygonlabs/maticjs/plasma/abi`                       | The Plasma bridge's vendored ABIs (`Plasma<Name>ABI`)                         |

### ESM-only

The package ships ES modules only — there is no CommonJS build,
because the SDK's own dependencies are ESM-only, so a `.cjs` artifact
could never actually load. It runs on Node 22, 24 and 26 (22.12 or
later; Node 20 is end-of-life and not supported). Use `import`; from a
CommonJS project use `await import('@polygonlabs/maticjs')` or native
`require()` of ES modules, which every supported Node runs unflagged.
TypeScript CommonJS
consumers need `"module": "nodenext"` (or `"node20"`, TypeScript ≥ 5.8);
under `node16`, TypeScript reports TS1479 for any ESM-only package.

### Inspectable by design

SDK objects deliberately avoid hard-private (`#`) fields: adapters
expose the exact `provider`/`signer` (ethers) or
`publicClient`/`walletClient` (viem) you passed in, and token wrappers
expose `tokenAddress`/`isParent` — so you can verify wiring, compare
identity against your own references, and debug in a REPL. Internals
are TypeScript-`private` (hidden from the typed API but plain
properties at runtime), which also means SDK instances survive
Proxy-based reactivity systems (Vue `reactive()`, Pinia) without the
`Cannot read private member` errors that `#`-field libraries like
ethers v6 hit there. Anything not in the typed API remains
unsupported surface — it may change in any release.

## Quickstart (viem)

```ts
import { createPublicClient, createWalletClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { POSClient } from '@polygonlabs/maticjs';
import { viemAdapter } from '@polygonlabs/maticjs/viem';

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

const parentPublic = createPublicClient({
  chain: sepolia,
  transport: http(process.env.PARENT_RPC)
});
const parentWallet = createWalletClient({
  account,
  chain: sepolia,
  transport: http(process.env.PARENT_RPC)
});

const childPublic = createPublicClient({ transport: http(process.env.CHILD_RPC) });
const childWallet = createWalletClient({ account, transport: http(process.env.CHILD_RPC) });

const pos = await POSClient.init({
  network: 'amoy',
  parent: viemAdapter({ public: parentPublic, wallet: parentWallet }),
  child: viemAdapter({ public: childPublic, wallet: childWallet })
});

// Read: balance of the bridged ERC-20 on the parent chain.
const erc20 = pos.parent.erc20(process.env.PARENT_TOKEN as `0x${string}`);
const balance = await erc20.getBalance(account.address);

// Write: approve the bridge predicate, then wait for inclusion.
const approve = await erc20.approve(1_000_000n);
console.log('approve hash:', approve.hash);
const receipt = await approve.confirmed();
console.log('approve mined in block:', receipt.blockNumber);
```

### TxResult: separating "submitted" from "mined"

Every write returns

```ts
interface TxResult {
  hash: `0x${string}`;
  confirmed(): Promise<Receipt>;
}
```

`hash` is populated the moment the parent-chain RPC accepts the
broadcast. `confirmed()` waits for the receipt and is **memoised** —
subsequent calls reuse the same waiter rather than starting a second
poll. The 3.x lazy `result.getTransactionHash()` / `result.getReceipt()`
pattern is gone; consumers no longer have to remember which awaitable
they are holding.

If the transaction mines but reverts, or is cancelled or replaced by a
different transaction at the same nonce, `confirmed()` rejects. With ethers
the rejection is ethers' own `CALL_EXCEPTION` or `TRANSACTION_REPLACED`
error, exactly as `wait()` raised it, carrying the receipt. viem reports
neither, so with viem the SDK detects them from the receipt and rejects
with a `ConfirmationError` caused by a `TransactionRevertedError` (read the
receipt from `TransactionRevertedError.find(err)?.info.receipt`) or a
`TransactionReplacedError`. Either way the rejection is memoised. A
fee-bumped re-send of the same transaction counts as the original. So a
resolved `confirmed()` means the transaction, or a fee-bumped re-send of
it, succeeded. See
[MIGRATION.md](./MIGRATION.md#txresult-resultconfirmed-not-resultgetreceipt).

### Smart wallets and unsigned transactions

Every public write has a sibling `prepareXxx` that returns the encoded
transaction without broadcasting:

```ts
const tx = await pos.parent.erc20(token).prepareApprove(1_000n);
//   tx.to    — the contract to call
//   tx.data  — encoded calldata
//   tx.value — wei to attach (omitted when zero)

await safeClient.proposeTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n });
```

Use this for Safe / Sequence / account abstraction bundlers, batched
multicall flows, pre-flight inspection, or any path where the SDK should
encode the bridge call but a different signer should send it. The prepared
path is pure — no chain-id lookup, no gas estimation, no fee-cap guard. The one
exception is `prepareReplayDeposit`, which reads the deposit's receipt and the
state receiver's failed record to build its calldata; it still estimates no gas
and checks no chain id. The Plasma exit prepares also read the chain, because
their calldata depends on chain state: see
[Plasma bridge](#plasma-bridge).

### Direct bridge helpers

Several methods are exposed flat on `POSClient` for consumers building
exit payloads outside the standard token flows (sync block events,
custom bridge events):

```ts
await pos.getCheckpointStatus(burnTxHash); // checkpointed, or why not
await pos.buildExitPayload(burnTxHash, eventSig, false); // exit calldata
await pos.getBlockProof(blockNumber, { start, end }); // Merkle proof
await pos.getPredicateAddress(token); // bridge predicate
await pos.getWithdrawStatus(burnTxHash, eventSig); // exited, or why not
await pos.replayDeposit(depositTxHash); // resend a failed delivery, paying its gas
await pos.prepareReplayDeposit(depositTxHash); // the same, unsigned
```

The token classes (`pos.parent.erc20(...).completeWithdraw(...)`) wrap these
for the 95% case; reach for the flat methods only when you need them.

### Calling contract methods the SDK doesn't wrap

When you need a bridge contract method that has no wrapper at all, drive
the contract with the client you already passed in. The SDK hands you the
two things it owns that you'd otherwise have to reproduce: the **resolved
address** via `pos.getAddresses()` (served from the same
stale-while-revalidate cache the bridge flows use) and the **vendored
`as const` ABI** from the `@polygonlabs/maticjs/abi` subpath:

```ts
import { RootChainManagerABI } from '@polygonlabs/maticjs/abi';

const { RootChainManager } = await pos.getAddresses();
const value = await parentPublic.readContract({
  address: RootChainManager,
  abi: RootChainManagerABI,
  functionName: 'someMethodTheSdkDoesNotWrap',
  args: [
    /* ... */
  ]
});
```

Your client infers argument and return types straight from the `as const`
ABI — there's no SDK-specific call surface to learn, and the addresses
still track index redeployments within the TTL window. This is the 4.0
replacement for the 3.x `contract.method(name, ...args)` accessor; see
[MIGRATION.md](./MIGRATION.md#calling-unwrapped-contract-methods-replaces-method).

### Dynamic address resolution

`POSClient.init` validates configuration by fetching the active
address index for `network` from the Polygon CDN, caches it for one
hour, and serves cached values stale-while-revalidate. **Long-running
services pick up Polygon contract redeployments without a restart**:
the next read after the TTL window kicks off a background refresh and
keeps serving the cached value until it lands.

For air-gapped or staging deployments, override either the source URL
(`addressIndexUrl`) or supply pre-resolved addresses directly
(`addresses: NetworkAddresses`); both are documented on
`POSClientConfig` in
[`src/pos-client.ts`](./src/pos-client.ts).

Two entries in the index have names that are easy to confuse, and they are
different contracts. `RootChain` is the checkpoint contract: it stores the
checkpoint headers that every exit proof is checked against, for the PoS bridge
and the Plasma bridge alike. `RootChainManager` is the PoS bridge's own entry
point for deposits and exits, and the Plasma bridge does not use it.

Forks and devnets whose chain ids differ from the `network` preset must
declare them: `chainIds: { parent, child }` (positive integers). The SDK
takes them from your code, like `addresses`, and never from the RPC, so an
RPC that reports any other chain is still refused with
`UnsupportedNetworkError` before anything is signed.

### Security checks

Your RPC is not trusted to say where a write goes. Every bridge write is
checked against the chain ids pinned for your `network` (not the chain id
the RPC reports) and rejects with `UnsupportedNetworkError` before anything
is signed. Default-spender approvals go only to a predicate the address
index publishes; any other address rejects with `UntrustedPredicateError`.
An explicit `spenderAddress` or `chainId` in the options is yours to choose.

## Other clients

The same flow with ethers v5 or v6 — import the matching adapter
factory from its subpath; everything else is identical. You only pull
in the web3 library you actually use:

```ts
// ethers v5
import { ethersV5Adapter } from '@polygonlabs/maticjs/ethers-v5';
import { providers, Wallet } from 'ethers';
const provider = new providers.StaticJsonRpcProvider(process.env.PARENT_RPC);
const signer = new Wallet(process.env.PRIVATE_KEY!, provider);
const pos = await POSClient.init({
  network: 'amoy',
  parent: ethersV5Adapter({ provider, signer }),
  child: ethersV5Adapter({ provider: childProvider, signer: childSigner })
});

// ethers v6
import { ethersV6Adapter } from '@polygonlabs/maticjs/ethers-v6';
import { JsonRpcProvider, Wallet, Network } from 'ethers';
const provider = new JsonRpcProvider(process.env.PARENT_RPC, Network.from(11155111), {
  staticNetwork: true
});
const signer = new Wallet(process.env.PRIVATE_KEY!, provider);
const pos = await POSClient.init({
  network: 'amoy',
  parent: ethersV6Adapter({ provider, signer }),
  child: ethersV6Adapter({ provider: childProvider, signer: childSigner })
});
```

Full runnable scripts (with env-var guards and an approve + read
flow) live in the workspace
[`examples/`](https://github.com/0xPolygon/matic.js/tree/master/examples)
directory.

## Staking

Validator and delegator staking ships in the same package behind its own
subpath, so bridge-only consumers carry no staking code. Staking lives on the
parent chain, so `StakingClient.init` takes a single `parent` adapter built the
same way as above:

```ts
import { StakingClient } from '@polygonlabs/maticjs/staking';
import { viemAdapter } from '@polygonlabs/maticjs/viem';

const staking = await StakingClient.init({
  network: 'mainnet',
  parent: viemAdapter({ public: publicClient, wallet: walletClient })
});

// Delegate POL to a validator: approve the StakeManager, then buy shares.
const validatorId = await staking.stakeManager.getValidatorId({ user: validatorOwner });
const share = staking.validatorShare(
  await staking.stakeManager.getValidatorContract({ validatorId })
);
const amount = 10n * 10n ** 18n;

await (await staking.pol.approveStakeManager({ amount })).confirmed();
const result = await share.delegate({ amount, minSharesToMint: 0n });
console.log(result.hash);
await result.confirmed();
```

Every staking write has an unsigned sibling for smart wallets and batchers —
`await share.prepareDelegate({ amount, minSharesToMint: 0n })` returns
`{ to, data }` — and reads return `bigint` or typed structs:

```ts
const info = await staking.stakeManager.getValidator({ validatorId });
const { stake } = await share.getTotalStake({ user: delegator });
const rewards = await share.getLiquidRewards({ user: delegator });
```

To pin addresses instead of fetching the address index, pass
`addresses: { StakeManager, MaticToken, PolToken }` to `StakingClient.init`.
Staking needs only those three, not the bridge addresses `POSClient` requires.
Passing a full bridge address index as `addresses` still works but is deprecated and
will be removed in the next major version, because the client only ever reads the
three staking addresses; pass those three instead.

The gas limit of `stakeManager.unstake` carries extra headroom for the epoch race (a checkpoint landing between estimation and inclusion makes the call write storage the estimate did not see); unused gas is refunded, but the wallet must hold native balance for the full limit × fee when sending. Pass `gasLimit` to set it yourself; it is then used exactly as given.

Coming from `@maticnetwork/maticjs-staking`? See the
[migration guide](./MIGRATION.md#staking-migrating-from-maticnetworkmaticjs-staking)
for the method mapping and the permit flow.

## Plasma bridge

`@polygonlabs/maticjs/plasma` moves ERC-20 tokens between Ethereum and Polygon
PoS through the Plasma bridge, the older exit path that still serves native POL
between the two chains. It has its own `PlasmaClient`, which takes a `parent` and
a `child` adapter built the way the PoS client's are, so a PoS-only app carries no
Plasma code, and a Plasma-only app carries none of the PoS bridge's ABIs except
`RootChain`, which it loads for checkpoint reads. The Plasma contracts' ABIs are
at `@polygonlabs/maticjs/plasma/abi`, named `PlasmaDepositManagerABI`,
`PlasmaWithdrawManagerABI` and so on, and `@polygonlabs/maticjs/abi` carries none
of them; `RootChainABI` stays in `./abi`. The errors only Plasma raises
(`ExitNotStartedError`, `ExitQueueEmptyError`, `ExitGasLimitTooLowError`,
`NativeBurnValueMismatchError`, `ChildBurnValueNotAllowedError`) and the event
topics `PlasmaEventSignature` are imported from `@polygonlabs/maticjs/plasma`, so a
PoS-only app never loads them; `isMaticjsError` from any entry still recognises
them. `sanitiseError` is exported there too: it returns a copy of an error with
every RPC `token=` query parameter redacted, for logging an error that carries
an RPC URL. Token handles come
from `plasma.parent.erc20(address)` and `plasma.child.erc20(address)`, and the call
shapes (`deposit(amount, userAddress)`, `startWithdraw(amount)`) match the PoS
bridge's. The two handles are different types, `PlasmaParentERC20` and
`PlasmaChildERC20`, each listing only the methods that can work on that chain, so
calling a parent-only method on the child handle is a compile error rather than a
failed transaction.

A deposit runs on the parent chain: approve the `DepositManager`, then call
`deposit(amount, userAddress)` on `plasma.parent.erc20(token)`. The spender is
fixed, because a Plasma deposit pulls through the manager and not through a
predicate, so `approve(amount)` and `approveMax()` take no spender. `getBalance`
and `getAllowance` read what the holder has and what the manager may pull; each
write has a `prepareXxx` sibling.

```ts
const token = plasma.parent.erc20(tokenAddress); // `plasma` as built below
await (await token.approve(amount)).confirmed(); // or `token.approveMax()`
await (await token.deposit(amount, userAddress)).confirmed();
```

A withdrawal has three steps, and the third waits out the exit period:

1. **`startWithdraw`** burns the tokens on the child chain. For the native token
   the SDK attaches the amount as the transaction value; if you pass
   `options.value` yourself it must equal the amount, and any other value is
   refused with `NativeBurnValueMismatchError` before anything is sent, because
   the token contract reverts on it. For any other child token the SDK refuses a
   non-zero `options.value` with `ChildBurnValueNotAllowedError` before anything
   is sent, because that token's burn accepts the value, ignores it and keeps
   it, so the value would be lost.
2. **`confirmWithdraw`** (or `confirmWithdrawFast`) runs on the parent chain once a
   checkpoint covers the burn. It builds the exit payload and queues the exit.
3. **`completeWithdraw`** runs on the parent chain after the exit's waiting period
   and pays out every queued exit that is due.

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
const nativeToken = '0x0000000000000000000000000000000000001010'; // POL on the child chain
const amount = 10n ** 18n;

// 1. Burn on the child chain.
const burn = await plasma.child.erc20(nativeToken).startWithdraw(amount);
await burn.confirmed();

// 2. Once a checkpoint covers the burn, queue the exit on the parent chain.
//    `getWithdrawStatus` reads 'not-checkpointed' until then.
const pol = plasma.parent.erc20(PolToken);
const confirm = await pol.confirmWithdraw(burn.hash);
await confirm.confirmed();

// 3. After the exit's waiting period, pay out the queue. Pass `confirmTxHash`
//    so the status read can find your exit.
const status = await pol.getWithdrawStatus({
  burnTxHash: burn.hash,
  confirmTxHash: confirm.hash
});
if (!status.exited && status.reason === 'ready-to-process') {
  const exit = await pol.completeWithdraw();
  await exit.confirmed();
}
```

The burn and the exit are separate transactions on separate chains, so keep
`burn.hash` and `confirm.hash` (a database row or a file is enough): the status
read needs both. Every write has a `prepareXxx` sibling (`prepareStartWithdraw`,
`prepareConfirmWithdraw`, `prepareCompleteWithdraw`, and so on) that returns the
unsigned `{ to, data, value? }` for a smart wallet or a batcher.

Unlike most PoS prepares, the Plasma exit prepares read the chain:

- `prepareConfirmWithdraw` reads the burn, its receipt and the checkpoint to build
  the exit payload.
- `prepareCompleteWithdraw` and `prepareProcessExits` read the exit queue, and
  refuse an empty one with `ExitQueueEmptyError`.
- `prepareConfirmWithdrawFast` needs `proofGenerationApiUrl` set in
  `PlasmaClient.init`.

A prepared transaction carries no gas, so for the payout calls
(`prepareCompleteWithdraw`, `prepareProcessExits`) the sender must set `gasLimit`
to at least `await token.getCompleteWithdrawGasLimit()` or
`await plasma.getProcessExitsGasLimit({ tokens })`. A wallet, batcher or bundler
that sizes the transaction from its own estimate under-provides it, and the
transaction succeeds without paying anything out. See
[Before you rely on `completeWithdraw`](#before-you-rely-on-completewithdraw).

### Fast confirm

`confirmWithdrawFast(burnTxHash)` takes the exit payload from a proof-generation
API instead of building it from RPC. It needs `proofGenerationApiUrl` in
`PlasmaClient.init`; without it the call rejects with an error caused by
`ProofApiNotSetError`. If the API is configured and then fails, the SDK logs a
warning and builds the payload locally, so a proof-API outage makes the fast path
slow, never stuck.

### Configuration

`PlasmaClient.init` takes the same network, address-index and logging settings as
`POSClient.init`. The options are documented on the `PlasmaClientConfig` type,
which you can import from `@polygonlabs/maticjs/plasma`. Two optional fields are
worth knowing:

- **`chainIds: { parent, child }`**: forks and devnets whose chain ids differ from
  the `network` preset must declare them, as positive integers. The SDK takes them
  from your code, like `addresses`, and never from the RPC, so an RPC that reports
  any other chain is still refused with `UnsupportedNetworkError` before anything
  is signed.
- **`rootChainDefaultBlock`**: `'safe'` (default), `'finalized'` or `'latest'`.
  The parent-chain block tag that checkpoint reads pin to. The default avoids
  reading a checkpoint that is reorged out before your exit payload reaches the
  parent chain.

To pin addresses instead of fetching the address index, pass `addresses` as the
seven Plasma addresses (`PlasmaAddresses`: `RootChain`, `DepositManager`,
`WithdrawManager`, `PlasmaERC20Predicate`, `ExitNFT`, `MaticToken`, `PolToken`).
`plasma.getAddresses()` returns that same type. The client reads and validates only
those entries of the address index, so a PoS bridge index passed as `addresses`, or
an index that lacks a Plasma contract, rejects `init` with an `InitError` whose
`cause` is a `ContractNotAvailableOnNetworkError` naming the keys it lacks. If a
later refresh of the index lacks one, the client keeps the last good addresses and
calls `onAddressRefreshError`. The Plasma client keeps its own address cache, so a
process that also runs a `POSClient` or `StakingClient` on the same index makes one
extra fetch per `addressTTLMs`.

### Where is my withdrawal?

`getWithdrawStatus({ burnTxHash, confirmTxHash? })` answers `{ exited: true }` or
`{ exited: false, reason }`. It is available on the client and on a parent-chain
token handle, and it answers with a reason instead of throwing. What each reason
means, and what to do:

| `reason`             | Meaning                                                   | What to do                                                                                                                   |
| -------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `'pending'`          | The burn is in no block yet.                              | Wait for it to mine.                                                                                                         |
| `'not-checkpointed'` | The burn is mined and no checkpoint covers its block yet. | Keep polling.                                                                                                                |
| `'not-confirmed'`    | Checkpointed, but no confirmed exit is known for it.      | If you have not confirmed, call `confirmWithdraw` (or `confirmWithdrawFast`); if you have, pass its hash as `confirmTxHash`. |
| `'in-exit-window'`   | The exit is queued and its waiting period has not ended.  | Keep polling.                                                                                                                |
| `'ready-to-process'` | The waiting period has ended.                             | Call `completeWithdraw`.                                                                                                     |

`{ exited: true }` means the exit was processed: its exit token is gone. It does
not say the payout succeeded in full, because the contract does not check the
result of the token's payout step when it processes an exit.

The contracts keep no lookup from a burn to its exit, so when you omit
`confirmTxHash` a checkpointed burn reads `'not-confirmed'` even if you already
confirmed it, and even if the exit was already processed. The answer cannot tell
"never confirmed" from "confirmed, but the confirm hash was not supplied". If you
lost the confirm hash, do not call `confirmWithdraw` again: a new confirm for an
exit that already exists reverts. Find the confirm transaction and pass its hash
as `confirmTxHash`.

The read follows the parent chain's latest state. A chain reorganisation on the
parent chain in the short window between the exit's processing and the read can
make the answer briefly stale. A node that is behind the block of the confirm
transaction answers `'in-exit-window'` from its own view, even when the exit is
already processed or its waiting period has ended; a later read from a node that
has caught up answers correctly. A `confirmTxHash` that did not start an exit for this burn rejects
with `ExitNotStartedError`, and so does a burn whose receipt has no Plasma
`Withdraw` log (for example a PoS burn passed by mistake) with
`LogNotFoundInReceiptError`. Both arrive as the `cause` of the `BridgeStatusError`
the read rejects with, so find them with `ExitNotStartedError.find(err)` and
`LogNotFoundInReceiptError.find(err)`. Without `confirmTxHash` the burn's log is
never read.

### Before you rely on `completeWithdraw`

> **Warning: a successful `completeWithdraw` receipt does not prove your exit was
> processed.**
>
> - **The contract can stop without reverting.** `WithdrawManager` pays exits in a
>   loop that runs only while the transaction has more gas left than its
>   `ON_FINALIZE_GAS_LIMIT` reserve, and that stops at the first exit that is not
>   yet due. Either way the transaction succeeds and your exit stays queued. After
>   the receipt, call `getWithdrawStatus` and look for `{ exited: true }`.
> - **Default gas.** Without `options.gasLimit`, the SDK sets the limit to the
>   node's estimate plus `PROCESS_EXITS_GAS_PER_EXIT` (350,000 gas) for every exit
>   in the queue, capped at `MAX_PROCESS_EXITS_GAS_LIMIT` (16,000,000 gas), which
>   keeps the transaction under Ethereum's per-transaction gas cap. Both constants
>   are exported from `@polygonlabs/maticjs/plasma`, as is
>   `PRE_LOOP_GAS_ALLOWANCE` (see "Your own `gasLimit`" below). A long queue is paid out over
>   several calls, because each call handles as many exits as its gas allows. A
>   long queue also drives the default limit up toward that 16,000,000 cap, and
>   the sending wallet must hold native balance for the full limit × `maxFeePerGas`
>   up front, even though unused gas is refunded.
> - **A transaction you send yourself needs the same gas.** `prepareCompleteWithdraw`
>   and `prepareProcessExits` return no gas, and a wallet's own estimate is the gas
>   the run used, not the gas the loop needs left at its start, so a transaction
>   sized by it succeeds and pays out nothing. The sender must set `gasLimit` to at
>   least `await token.getCompleteWithdrawGasLimit()` (or
>   `await plasma.getProcessExitsGasLimit({ tokens })`), which return exactly the
>   limit the SDK's own write sends. Like the write, they estimate as
>   `options.from` or the adapter's signer, so pass `{ from }` when the adapter has
>   neither, and they reject with `ExitQueueEmptyError` when nothing is queued.
> - **Your own `gasLimit`.** A limit you pass is used exactly as given, with one
>   exception: a limit too low for the contract's loop to start (below the floor, the
>   contract's `ON_FINALIZE_GAS_LIMIT` reserve plus `PRE_LOOP_GAS_ALLOWANCE`, 30,000
>   gas for the call's own overhead) would succeed and process nothing, so the SDK
>   refuses it with `ExitGasLimitTooLowError` before anything is sent.
>   `info.minimum` on that error is the floor. Read it rather
>   than hardcoding a number, because it follows the contract. The floor only
>   rules out limits that can never work: a limit a little above it can still
>   complete without processing anything, more so when you name several tokens.
>   Passing the raw `eth_estimateGas` value always does, because the estimate is
>   the gas the run used, not the gas the loop needs left at its start. Leave
>   `gasLimit` unset unless you must set it; the SDK's default is the safe value.
> - **Send `confirmWithdraw` and `confirmWithdrawFast` from the account that
>   burned.** The predicate starts the exit only for the account the burn's
>   `Withdraw` log names as `from`, so confirm from that account.
>   `completeWithdraw` and `processExits` are permissionless: any account may
>   send them, and each exit pays its owner, whoever sends the transaction.
> - **One burn per transaction.** The bridge identifies an exit by the burn's
>   block and its transaction's position in that block, not by the log inside
>   it, so it accepts one exit per burn transaction. If you batch
>   `prepareStartWithdraw` calls through a smart wallet or a multicall, give each
>   burn its own transaction: a second burn in the same transaction leaves the
>   child chain and can never be confirmed on the parent chain. The SDK's exit
>   payload always points at the transaction's first `Withdraw` log.
> - **Burn only from an account that can send on the parent chain.** The confirm
>   must come from the same address that burned. A contract wallet that exists on
>   Polygon but not at that address on Ethereum can burn and can never confirm.
> - **POL exits are queued under the MATIC token.** A native-token burn pays POL
>   but is queued under the legacy MATIC token, and the SDK handles that:
>   `completeWithdraw` on a POL handle processes that queue. If you call
>   `plasma.processExits({ tokens })` yourself, name the MATIC token
>   (`(await plasma.getAddresses()).MaticToken`) for a POL exit.

`processExits` and `completeWithdraw` reject with `ExitQueueEmptyError`, sending
nothing, when no exit is queued for the token. Someone else may already have
processed yours, so read `getWithdrawStatus` before retrying.

Not included: ERC-721 tokens, `depositEther`, `transfer`, and MoreVP and
challenge exits. Coming from `@maticnetwork/maticjs-plasma`? See the
[migration guide](./MIGRATION.md#plasma-from-maticnetworkmaticjs-plasma).

## Errors

SDK errors are errors from this SDK. Errors from ethers, viem, your wallet
or your RPC transport are rethrown exactly as they came, as in 3.x: the
same object, with its own class, `code` and message. The SDK never wraps
them and never uses them as causes. A wallet rejection reaches you as your
library's own rejection error, an `eth_estimateGas` revert as its own
revert error, and a mined revert reported by ethers (`CALL_EXCEPTION`) as
that ethers error. Handle them as your library documents.

Every error the SDK raises itself, for a condition it detected, is a named
class that extends
[`VError`](https://www.npmjs.com/package/@polygonlabs/verror). There are
two kinds:

- **Condition errors** say what went wrong: `BurnTxNotCheckpointedError`,
  `TransactionRevertedError`, `UnsupportedNetworkError`, and so on. Each
  carries typed details on `info`.
- **Operation errors** say which public call failed. A public method wraps
  each condition it detects in one: `completeWithdraw` in `ExitError`,
  `deposit` in `DepositError`, `confirmed()` in `ConfirmationError`, and so
  on. The operation error's `cause` is the condition error.

A condition's own `cause`, when it has one, is the SDK's own fetch or
parser error (the network failure behind an `HttpRequestFailedError`, for
example), stored as a copy with RPC `?token=` values redacted.

Recognise an SDK error by its name anywhere in the cause chain, and branch
on it with the typed finders. Every class has two static finders:

- `find(err)` returns the first error in the chain with that class's name,
  with `info` typed for that class, or `null`.
- `has(err)` returns whether there is one.

`isMaticjsError(err)` returns `true` when any error in the chain came from
the SDK. All three match by name, not with `instanceof`, so they also work
when your bundle holds two copies of the package, or on an error that has
been through `JSON.stringify` and back.

Check for your wallet's or library's own error first, then for the SDK's:

```ts
import {
  BurnTxNotCheckpointedError,
  ExitError,
  isMaticjsError,
  TransactionRevertedError
} from '@polygonlabs/maticjs';

try {
  const result = await erc20.completeWithdraw(burnTxHash);
  await result.confirmed();
} catch (err) {
  const reverted = TransactionRevertedError.find(err);
  if (typeof err === 'object' && err !== null && 'code' in err && err.code === 4001) {
    // The user rejected the request in their wallet (the wallet's own
    // error, rethrown unchanged).
  } else if (BurnTxNotCheckpointedError.has(err)) {
    // The burn is not in a checkpoint yet. Retry after the next one.
  } else if (reverted !== null) {
    // The SDK saw the exit mine and revert, so `confirmed()` rejected with
    // a ConfirmationError. The receipt is on the condition's `info`.
    console.error('reverted in block', reverted.info.receipt.blockNumber);
  } else if (ExitError.has(err)) {
    // completeWithdraw itself failed on a condition the SDK detected. The
    // message reads "completeWithdraw failed: <reason>".
    console.error(ExitError.find(err)?.message);
  } else if (isMaticjsError(err)) {
    // Any other SDK failure.
    console.error('bridge call failed', err);
  }
  // Anything else is your wallet's, node's or library's own error.
  throw err;
}
```

How the 4001 arrives depends on the library: viem wraps it in its own
error (find it with viem's `err.walk()`), ethers v6 raises
`ACTION_REJECTED` with the wallet's error at `info.error`, and ethers v5
passes the wallet's error through (or raises `ACTION_REJECTED` for "user
denied" text). Whether a mined revert is the library's error or the SDK's
`TransactionRevertedError` also depends on the library: ethers reports the
revert itself, viem does not, so under viem the SDK detects it from the
receipt.

The classes that cover a condition 3.x already reported also carry the 3.x
string on `type` (for example `BurnTxNotCheckpointedError.find(err)?.type`
is `'burn_tx_not_checkpointed'`). The full class list, with what raises each
one and its 3.x `type`, is in
[MIGRATION.md](./MIGRATION.md#error-handling).

Status reads answer with a reason instead of throwing. One method answers
one question and returns the answer together with why, so you never combine
two calls that can disagree:

| Question                                    | Read                                                                                                                                                                 | Result                                                                                                                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Has this burn been exited?                  | `pos.getWithdrawStatus`, `pos.getWithdrawStatusOnIndex`, and on the tokens `getWithdrawExitStatus` (plus `…OnIndex`, `…OnIndices`, `…Many` where the token has them) | `{ exited: true }` or `{ exited: false, reason: 'pending' \| 'not-checkpointed' \| 'not-exited' }`                                                                                                              |
| Is this burn checkpointed?                  | `pos.getCheckpointStatus(burnTx)`                                                                                                                                    | `{ checkpointed: true }` or `{ checkpointed: false, reason: 'pending' \| 'not-checkpointed' }`                                                                                                                  |
| Has this deposit landed on the child chain? | `pos.getDepositStatus(depositTx)`                                                                                                                                    | `{ deposited: true }` or `{ deposited: false, reason: 'pending' \| 'not-synced' }` or `{ deposited: false, reason: 'delivery-failed', stateId, receiver, record, replayable }` → `pos.replayDeposit(depositTx)` |

The result types are exported as `WithdrawStatus`, `CheckpointStatus` and
`DepositStatus`, with their reason unions `WithdrawNotExitedReason`,
`CheckpointNotReachedReason` and `DepositNotDeliveredReason`. These reads reject
only for an unresolved dependency: invalid input (an empty hash, a negative
index), a transaction that does not exist, or a failure of your library,
wallet or RPC. Methods that require the condition, such as `completeWithdraw`
and `buildExitPayload`, still reject with it. Methods named `is*`
(`isApproved`, `isApprovedAll`, `isExitProcessed`, `isLocked`) are plain
chain facts with no reason and resolve a boolean.

**Deliveries can fail on the child chain.** Since the Uburu fork (November 2026)
each state-sync delivery on Polygon PoS runs under a per-record gas limit read
from an on-chain gas oracle: 160,000 gas on mainnet at the time of writing
(November 2026), changeable by the oracle's owner. A deposit whose child-side
processing needs more than that is committed as failed: the tokens stay locked
on the parent chain and nothing is minted on the child chain. Enumerable
ERC-721 child tokens exceed the cap today. Deliveries also failed before the fork, when the child-side call reverted; those are reported too. `getDepositStatus` reports this as
`{ deposited: false, reason: 'delivery-failed', stateId, receiver, record, replayable }`.
The SDK reports the condition; it cannot prevent it. The check needs a child chain whose `StateReceiver` has the Uburu fork's failed-record store, as Polygon mainnet and Amoy do; on an older child chain the read rejects with your client library's call error. Failed deliveries are read from both records the `StateReceiver` keeps: `record` is `'payload'` for a delivery that failed before the Uburu fork (the receiver stores the full receiver and data, in its published `failedStateSyncs` mapping) and `'hash'` for one that failed since (it stores only a hash). `replayable` is `true`
when the failed record the `StateReceiver` holds is this deposit's own
`(receiver, data)`, so a replay can be attempted with this deposit's data. It
does not mean the replay will succeed: the receiving contract may still revert.
To recover, call `pos.replayDeposit(depositTx)` from the child-chain signer, or
`pos.prepareReplayDeposit(depositTx)` to get the unsigned `{ to, data }` for another signer.
The SDK re-reads the deposit, refuses with `DepositNotReplayableError` (under `DepositError`)
unless the status is `delivery-failed` with `replayable: true`, and picks the call from
`record`: `replayFailedStateSync(stateId)` for `'payload'`, `replayFailedStateSyncWithData(stateId, receiver, data)`
for `'hash'`, both on the child chain's `StateReceiver` (`0x0000000000000000000000000000000000001001`).
Anyone may replay; the replay runs with your transaction's gas, not the per-record limit that
failed the delivery. A replay the receiving contract rejects reverts as a whole and leaves the
record in place: without `gasLimit` that surfaces as your client library's `eth_estimateGas`
error before anything is sent. Once a replay succeeds, the deposit reads `{ deposited: true }`.
If someone else's replay clears the record between the SDK's read and your send, the
`StateReceiver` itself reverts `!found`; that is your client library's error too, and
`getDepositStatus` then reads `{ deposited: true }`.
The same calls can be made by hand with any client, using the `receiver` and `data` of the
deposit's `StateSynced` event for `'hash'`. `replayFailedStateSync` is published source
(PIP-36); `replayFailedStateSyncWithData` and its calling convention
were confirmed by the protocol team, while the post-Uburu contract source itself
remains unpublished.
If one deposit transaction emitted several `StateSynced` logs, the status
reports the first. Deliveries that failed before PIP-36 (the Ahmedabad upgrade
of the child chain's node software) are kept in no mapping, so the SDK cannot
detect them and such a deposit reads as delivered.

### Operation errors

An operation error's message is `<method> failed:` followed by the
condition's one-line summary, for example
`completeWithdraw failed: Burn transaction has not been checkpointed as yet`.
The full text stays on the `cause` chain. When the condition itself has a
cause whose text its message leaves out, the SDK appends it as
`; root cause: <text>`, so the reason a call failed is always in the
top-level message.

A public method that calls another public method still throws a single
operation error, named for the method you called. `completeWithdrawFast`
rejects with one `ExitError` whose `info.operation` is
`completeWithdrawFast`, not with an `ExitError` wrapped in another.
`info` also carries `mode` (`'write'`, `'prepare'`, `'read'`, `'confirm'`
or `'init'`) and whatever the call knew: the token address, chain id, or
transaction hash.

The `keccak256` method on an adapter is synchronous and throws
`InvalidHexStringError` directly, with no operation error around it.

### Reading the wallet's own error

A wallet's error is never wrapped, so read its fields on the error you
caught: `err.code === 4001` for a raw EIP-1193 rejection, `err.code ===
'ACTION_REJECTED'` for ethers' own classification, viem's
`UserRejectedRequestError` through `err.walk()`.

`rootCause(err)` is a utility for reaching the cause inside an SDK
condition: it returns the error at the bottom of the chain, such as the
network error under an `HttpRequestFailedError`. It follows `cause` to the
deepest error, then steps into that error's `info.error` or `error` while
there is one, which is where ethers keeps the provider's raw error. That
means it also works on an ethers error you caught directly: over an HTTP
provider, ethers v5 nests the node's error inside its own `SERVER_ERROR`,
and `rootCause` reaches the node's `{ code, message }`. The result is typed
`unknown`, because those steps can land on a plain JSON-RPC error object
rather than an `Error`, so check its shape before reading `code`.
`rootCause` returns `null` when `err` is not an `Error`.

One known gap: when the wallet's message contains "user denied", ethers v5
throws its own `ACTION_REJECTED` error and discards the wallet's error, so
no `4001` is left to read. Check for `code === 'ACTION_REJECTED'` as well
if you support ethers v5 wallets.

### Redacting RPC tokens before logging

Many RPC endpoints carry auth tokens in their URL query string, and
upstream fetch errors interpolate that URL into the error message.
Before handing any SDK (or web3-library) error to your logger, run it
through `sanitiseError` — it deep-walks the message, stack, structured
`info`, and the whole `cause` chain, replacing `token=<value>` with
`token=***` without mutating the original:

```ts
import { sanitiseError } from '@polygonlabs/maticjs';

catch (err) {
  logger.error({ err: sanitiseError(err) }, 'bridge call failed');
}
```

The SDK's own errors never embed an unredacted token in the first
place, and `@polygonlabs/verror`/`@polygonlabs/logger` users get
additional automatic redaction of recognised ethers/viem fetch-error
shapes at serialisation time — `sanitiseError` is the logging-stack-
agnostic layer that covers everything else.

## Documentation

- [MIGRATION.md](./MIGRATION.md) — upgrading from `@maticnetwork/maticjs`
- [Source — `0xPolygon/matic.js`](https://github.com/0xPolygon/matic.js) — issues, contributions, monorepo

## License

[MIT](./LICENSE).

Third-party code bundled into the package, and its licence, is listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
