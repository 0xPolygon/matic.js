# @polygonlabs/maticjs

[![npm version](https://img.shields.io/npm/v/@polygonlabs/maticjs.svg)](https://www.npmjs.com/package/@polygonlabs/maticjs)
[![License: MIT](https://img.shields.io/npm/l/@polygonlabs/maticjs.svg)](LICENSE)

TypeScript SDK for the Polygon PoS bridge and PoS staking. Deposits,
withdrawals, and exit proofs against `RootChainManager` — across ERC-20,
ERC-721, ERC-1155 and native ETH — plus validator and delegator staking
from `@polygonlabs/maticjs/staking`, driven by whichever EVM client
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

const parentPublic = createPublicClient({ chain: sepolia, transport: http(process.env.PARENT_RPC) });
const parentWallet = createWalletClient({ account, chain: sepolia, transport: http(process.env.PARENT_RPC) });

const childPublic  = createPublicClient({ transport: http(process.env.CHILD_RPC)  });
const childWallet  = createWalletClient({ account, transport: http(process.env.CHILD_RPC)  });

const pos = await POSClient.init({
  network: 'amoy',
  parent: viemAdapter({ public: parentPublic, wallet: parentWallet }),
  child:  viemAdapter({ public: childPublic,  wallet: childWallet  })
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
path is pure — no chain-id lookup, no gas estimation, no fee-cap guard.

### Direct bridge helpers

Several methods are exposed flat on `POSClient` for consumers building
exit payloads outside the standard token flows (sync block events,
custom bridge events):

```ts
await pos.getCheckpointStatus(burnTxHash);               // checkpointed, or why not
await pos.buildExitPayload(burnTxHash, eventSig, false); // exit calldata
await pos.getBlockProof(blockNumber, { start, end });    // Merkle proof
await pos.getPredicateAddress(token);                    // bridge predicate
await pos.getWithdrawStatus(burnTxHash, eventSig);       // exited, or why not
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
  args: [/* ... */]
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
const signer   = new Wallet(process.env.PRIVATE_KEY!, provider);
const pos = await POSClient.init({
  network: 'amoy',
  parent: ethersV5Adapter({ provider, signer }),
  child:  ethersV5Adapter({ provider: childProvider, signer: childSigner })
});

// ethers v6
import { ethersV6Adapter } from '@polygonlabs/maticjs/ethers-v6';
import { JsonRpcProvider, Wallet, Network } from 'ethers';
const provider = new JsonRpcProvider(process.env.PARENT_RPC, Network.from(11155111), { staticNetwork: true });
const signer   = new Wallet(process.env.PRIVATE_KEY!, provider);
const pos = await POSClient.init({
  network: 'amoy',
  parent: ethersV6Adapter({ provider, signer }),
  child:  ethersV6Adapter({ provider: childProvider, signer: childSigner })
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

Coming from `@maticnetwork/maticjs-staking`? See the
[migration guide](./MIGRATION.md#staking-migrating-from-maticnetworkmaticjs-staking)
for the method mapping and the permit flow.

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

| Question                            | Read                                                                                                                                | Result                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Has this burn been exited?          | `pos.getWithdrawStatus`, `pos.getWithdrawStatusOnIndex`, and on the tokens `getWithdrawExitStatus` (plus `…OnIndex`, `…OnIndices`, `…Many` where the token has them) | `{ exited: true }` or `{ exited: false, reason: 'pending' \| 'not-checkpointed' \| 'not-exited' }` |
| Is this burn checkpointed?          | `pos.getCheckpointStatus(burnTx)`                                                                                                   | `{ checkpointed: true }` or `{ checkpointed: false, reason: 'pending' \| 'not-checkpointed' }` |
| Has this deposit landed on the child chain? | `pos.getDepositStatus(depositTx)`                                                                                           | `{ deposited: true }` or `{ deposited: false, reason: 'pending' \| 'not-synced' }` or `{ deposited: false, reason: 'delivery-failed', stateId, receiver, record, replayable }` |

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
The post-Uburu `StateReceiver` source is not published, so whether a failed
replay attempt could clear the stored hash, and so turn `replayable` stale, is
unverified. To recover, call the `StateReceiver`
(`0x0000000000000000000000000000000000001001`) on the child chain, from any
account, paying the gas yourself. The call depends on `record`: for `'payload'`
call `replayFailedStateSync(stateId)`; for `'hash'` call
`replayFailedStateSyncWithData(stateId, receiver, data)` with the `receiver`
and `data` of the deposit's `StateSynced` event. The SDK has no replay method
in 4.0.0, and the post-Uburu contract's source is not published, so the
`…WithData` call shape is the one mainnet replays use. Once replayed, the
deposit reads `{ deposited: true }`.
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
