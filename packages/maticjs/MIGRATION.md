# Migration: 3.x → 4.0

`@polygonlabs/maticjs` 4.0 is a clean break from the
`@maticnetwork/maticjs` 3.x line. The bridge protocol it speaks
hasn't changed; the SDK around it has been rewritten to remove the
plugin layer, drop legacy big-number types, and surface configuration
errors at construction time. This guide walks every breaking change in
the order most consumers will hit them.

If you are starting a new integration, skip this file and read the
package [README](./README.md).

## Package scope: `@maticnetwork/maticjs` → `@polygonlabs/maticjs`

The package keeps its name and moves to the official `@polygonlabs`
npm scope: versions up to 3.x remain published as
`@maticnetwork/maticjs`, and 4.0 onwards ships as
`@polygonlabs/maticjs`. The package is also narrowed to what it
actually covers today — the Polygon **PoS bridge**. The zkEVM bridge
surface the 3.x line also shipped is gone, because the zkEVM
network has reached end of life (see "zkEVM" at the bottom of this
guide).

Update the install:

```diff
-pnpm remove @maticnetwork/maticjs @maticnetwork/maticjs-ethers @maticnetwork/maticjs-web3
+pnpm add @polygonlabs/maticjs
+# plus your existing peer:
+pnpm add viem      # or ethers (v5 or v6)
```

And every import:

```diff
-import { POSClient, use } from '@maticnetwork/maticjs';
-import { Web3ClientPlugin } from '@maticnetwork/maticjs-web3';
+import { POSClient } from '@polygonlabs/maticjs';
```

`@polygonlabs/maticjs` no longer ships any `*-web3` / `*-ethers`
companion packages; the parent-chain client is configured directly on
`POSClient.init` (see "Plugin removal" below).

### ESM-only (no CommonJS build)

The legacy package shipped CommonJS (plus a UMD browser bundle); 4.0
ships **ES modules only**, because its own dependencies are ESM-only —
a `.cjs` artifact could never actually load them. `import` works
everywhere on Node ≥ 20. From a CommonJS project:

```js
// CJS file, any Node >= 20 (CommonJS has no top-level await):
async function main() {
  const { POSClient } = await import('@polygonlabs/maticjs');
  // ...
}
main();

// or, Node >= 20.19 supports require() of ES modules natively
// (Node 22.0-22.11 needs --experimental-require-module):
const { POSClient } = require('@polygonlabs/maticjs');
```

There is no UMD/script-tag bundle; browser consumers use a bundler
(Vite, webpack, esbuild), which handles ESM natively.

## Plugin removal: pass clients directly to `POSClient.init`

The 3.x SDK required calling `use(Plugin)` at module load time to
register a global EVM-library implementation, then passing raw provider
objects into a generic `init(...)`. That design forced every consumer
to mutate global state during application boot, made multi-version
co-existence impossible (you can only `use` one plugin), and hid the
parent/child wiring in implementation detail.

4.0 replaces the plugin with **per-library adapter factories** imported
from a subpath. The consumer constructs their own viem / ethers client,
wraps it with the matching factory, and passes the result as `parent` /
`child`. There is no global state, no plugin to register, and the main
entry pulls in no web3 library — you import only the adapter for the
library you actually use, so the bundle stays minimal and statically
analysable.

```diff
-import { POSClient, use } from '@maticnetwork/maticjs';
-import { Web3ClientPlugin } from '@maticnetwork/maticjs-web3';
-
-use(Web3ClientPlugin);
-const client = new POSClient();
-await client.init({
-  network: 'testnet',
-  version: 'amoy',
-  parent: { provider: parentWeb3Provider, defaultConfig: { from } },
-  child:  { provider: childWeb3Provider,  defaultConfig: { from } }
-});

+import { POSClient } from '@polygonlabs/maticjs';
+import { viemAdapter } from '@polygonlabs/maticjs/viem';
+
+const pos = await POSClient.init({
+  network: 'amoy',
+  parent: viemAdapter({ public: parentPublic, wallet: parentWallet }),
+  child:  viemAdapter({ public: childPublic,  wallet: childWallet  })
+});
```

The factory lives at a library-specific subpath:

| Your client library | Import                           | Factory call                            |
| ------------------- | -------------------------------- | --------------------------------------- |
| viem                | `@polygonlabs/maticjs/viem`      | `viemAdapter({ public, wallet })`       |
| ethers v5           | `@polygonlabs/maticjs/ethers-v5` | `ethersV5Adapter({ provider, signer })` |
| ethers v6           | `@polygonlabs/maticjs/ethers-v6` | `ethersV6Adapter({ provider, signer })` |

`POSClientConfig.parent` / `.child` are typed as the SDK's `Adapter`
interface (exported from the main entry for consumers who want to type
their own wiring). There is no `kind` discriminator and no
`ParentClientConfig` union — those existed in an interim design and
were removed before 4.0 in favour of the factory pattern, which keeps
viem and ethers as fully optional peers (importing the SDK never
references a library you didn't install).

`POSClient.init` is the only public constructor — the class
constructor itself is private so misuse (skipping the address-index
validation, forgetting to inject the bridge helpers) cannot happen.

## bigint everywhere

Every numeric parameter and return value is now native `bigint`. The
3.x SDK accepted any of `string | number | BN | BaseBigNumber`,
threaded values through a runtime `Converter`, and returned big-number
wrappers (`BN` from web3, `BigNumber` from ethers v5). 4.0 demands the
boundary be drawn at the consumer:

```diff
-import BN from 'bn.js';
-await erc20.deposit(BN.from('1000000'), userAddress);
-
-import { BigNumber } from 'ethers';
-await erc20.approve(BigNumber.from('1000000'));

+await pos.parent.erc20(token).deposit(1_000_000n, userAddress);
+await pos.parent.erc20(token).approve(1_000_000n);
```

If you are still on ethers v5 in the rest of your application, convert
`BigNumber` at the SDK boundary:

```ts
const balance: BigNumber = await someEthersV5Call();
await pos.parent.erc20(token).deposit(balance.toBigInt(), userAddress);
```

ethers v5 has exposed `BigNumber.toBigInt()` since 5.6.0; the SDK's
peer-dep range requires `^5.6.0 || ^6.0.0`.

## Method renames

The 3.x bridge surface mixed verb-noun and noun-verb conventions
(`withdrawStart` next to `getCheckpoint`). 4.0 normalises everything
to verb-noun:

| 3.x                                          | 4.0                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `erc20.withdrawStart(amount)`                | `erc20.startWithdraw(amount)`                                              |
| `erc721.withdrawStart(tokenId)`              | `erc721.startWithdraw(tokenId)`                                            |
| `erc1155.withdrawStart(id, amount)`          | `erc1155.startWithdraw(id, amount)`                                        |
| `erc20.withdrawExit(burnTxHash)`             | `erc20.completeWithdraw(burnTxHash)`                                       |
| `erc20.withdrawExitFaster(burnTxHash)`       | `erc20.completeWithdrawFast(burnTxHash)`                                   |
| `erc721.withdrawStartWithMetaData(tokenId)`  | `erc721.startWithdrawWithMetaData(tokenId)`                                |
| `erc721.withdrawStartMany(tokenIds)`         | `erc721.startWithdrawMany(tokenIds)`                                       |
| `erc1155.withdrawStartMany(ids, amounts)`    | `erc1155.startWithdrawMany(ids, amounts)`                                  |
| `erc721.withdrawExit(burnTxHash)`            | `erc721.completeWithdraw(burnTxHash)`                                      |
| `erc721.withdrawExitOnIndex(burnTxHash, i)`  | `erc721.completeWithdrawOnIndex(burnTxHash, i)`                            |
| `erc721.withdrawExitFaster(burnTxHash)`      | `erc721.completeWithdrawFast(burnTxHash)`                                  |
| `erc1155.withdrawExit(burnTxHash)`           | `erc1155.completeWithdraw(burnTxHash)`                                     |
| `erc1155.withdrawExitFaster(burnTxHash)`     | `erc1155.completeWithdrawFast(burnTxHash)`                                 |
| `erc1155.withdrawExitMany(burnTxHash)`       | `erc1155.completeWithdrawMany(burnTxHash)`                                 |
| `erc1155.withdrawExitFasterMany(burnTxHash)` | `erc1155.completeWithdrawFastMany(burnTxHash)`                             |
| `client.etheriumSha3(...)`                   | _removed_ — call `Adapter.keccak256(bytes)` or use viem/ethers' own helper |
| `client.encode(value, type)`                 | _removed_ — vendor your own ABI helper or use viem/ethers' own coder       |

`completeWithdraw` accepts `{ isFast: true }` as an option, so the
`completeWithdrawFast` method is just a shorthand. The legacy SDK
returned a different shape from the two paths; 4.0 returns the same
`TxResult` for both.

## Error handling

The 3.x SDK threw plain `{ message, type }` objects assembled by an
`ErrorHelper`, where `type` carried a lowercase-snake `ERROR_TYPE`
string (e.g. `'burn_tx_not_checkpointed'`). The thrown value was not
even an `Error` instance, so stack traces and `instanceof` checks were
unavailable.

4.0 raises a single `POSBridgeError` class with a stable discriminator
`code` — new UPPER_SNAKE identifiers, exhaustiveness-checked by
TypeScript. **Existing switches and dashboards keyed on the old
lowercase strings keep working without rework**: every error whose
condition existed in 3.x also carries the exact legacy string
(typos included, verbatim) on the same `type` field the old SDK used.
So `err.type === 'burn_tx_not_checkpointed'` still matches, while new
code should switch on `err.code`. Conditions that are new in 4.0 have
no `type`; the exported `LegacyErrorType` union lists every legacy
string. Argument guard failures (a missing `spenderAddress`, a call on
the wrong chain, an oversized batch) surface as rejected promises,
never as synchronous throws, so `.catch()` handles them; odd-length or
non-hex input to an adapter's synchronous `keccak256` throws
`INVALID_HEX_STRING`.

```ts
import { POSBridgeError } from '@polygonlabs/maticjs';

try {
  await pos.parent.erc20(token).completeWithdraw(burnTxHash);
} catch (err) {
  if (err instanceof POSBridgeError) {
    switch (err.code) {
      case 'BURN_TX_NOT_CHECKPOINTED':
        // wait, then retry — checkpoint hasn't landed yet
        break;
      case 'PROOF_API_NOT_SET':
        // misconfiguration — set `proofGenerationApiUrl` on POSClient.init
        break;
      // TypeScript exhaustiveness-checks every code
    }
  }
  throw err;
}
```

The full set of codes follows. The SDK's TypeScript types make every
case mandatory in an exhaustive `switch`.

| Code                                | Raised when                                                                                                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_ON_ROOT`                   | Parent-chain-only method invoked on a child-chain token (`deposit` on child, etc.). Legacy `type`: `allowed_on_root`                                                                                                                          |
| `ALLOWED_ON_CHILD`                  | Child-chain-only method invoked on a parent-chain token (`startWithdraw` on parent, etc.). Legacy `type`: `allowed_on_child`                                                                                                                  |
| `BURN_TX_NOT_CHECKPOINTED`          | `completeWithdraw` ran before the burn tx's block was checkpointed on the parent chain                                                                                                                                                        |
| `EIP1559_NOT_SUPPORTED`             | EIP-1559 fee fields supplied to a legacy-only chain                                                                                                                                                                                           |
| `PROOF_API_NOT_SET`                 | `completeWithdrawFast` or fast-exit code path used without `proofGenerationApiUrl` configured                                                                                                                                                 |
| `INVALID_TOKEN_TYPE`                | A token-type discriminator (ERC-20 / 721 / 1155) didn't match the underlying contract                                                                                                                                                         |
| `CONTRACT_NOT_AVAILABLE_ON_NETWORK` | An operation needs a contract that isn't deployed/configured on the active network — `depositEtherWithGas` / `depositWithGas` where no `GasSwapper` exists, or `approveAllForMintable` where the index carries no mintable-ERC-1155 predicate |
| `TX_OPTION_NOT_OBJECT`              | Not raised by 4.0 (writes are typed) — retained so the legacy `type` mapping `transation_object_not_object` stays representable                                                                                                               |
| `UNSUPPORTED_NETWORK`               | A `network` value outside the supported set reached network-dependent code                                                                                                                                                                    |
| `WEB3_CLIENT_NOT_INITIALIZED`       | Internal client was used before `POSClient.init` resolved                                                                                                                                                                                     |
| `ROOT_HASH_RPC_FAILED`              | bor's `bor_getRootHash` RPC call returned an error                                                                                                                                                                                            |
| `INVALID_HEX_STRING`                | Hex helper received a value that isn't `0x`-prefixed lowercase hex, or `keccak256` / `hexToBytes` got odd-length or non-hex input                                                                                                             |
| `NEGATIVE_BIG_NUMBER`               | A negative bigint reached a code path that requires unsigned values                                                                                                                                                                           |
| `INVALID_NUMERIC_VALUE`             | A `bigint` parser received a non-numeric input                                                                                                                                                                                                |
| `BUFFER_TYPE_REQUIRED`              | Internal helper expected `Uint8Array` and got something else                                                                                                                                                                                  |
| `UNSUPPORTED_KECCAK_BIT_WIDTH`      | keccak helper called with a width other than 256                                                                                                                                                                                              |
| `MERKLE_TREE_REQUIRES_LEAVES`       | Merkle-proof builder invoked with zero leaves                                                                                                                                                                                                 |
| `MERKLE_TREE_DEPTH_EXCEEDED`        | Merkle-proof depth exceeded the protocol's maximum                                                                                                                                                                                            |
| `STATE_SYNCED_EVENT_NOT_FOUND`      | `isDeposited` couldn't find the `StateSynced` event in the deposit receipt                                                                                                                                                                    |
| `PROOF_NODE_KEY_MISMATCH`           | Internal proof-tree consistency check failed                                                                                                                                                                                                  |
| `TRANSACTION_HASH_REQUIRED`         | Bridge call made without the burn transaction hash                                                                                                                                                                                            |
| `TRANSACTION_NOT_FOUND`             | A referenced transaction has no receipt yet (not mined / unknown hash) — usually transient; retry after the tx lands                                                                                                                          |
| `TRANSACTION_REVERTED`              | `confirmed()` saw the transaction mine but revert. `info.receipt` carries the full receipt and `info.transactionHash` the hash of the transaction that mined (for a fee-bumped re-send that reverted, the re-send's hash)                     |
| `TRANSACTION_REPLACED`              | `confirmed()` saw another transaction take the nonce (a wallet cancel or a different call). `info.reason` is `'cancelled'` or `'replaced'`; `info.replacementHash` and `info.receipt` describe the other transaction                          |
| `FEE_ESTIMATION_FAILED`             | A write without `maxPriorityFeePerGas` could not price its fee (node error, no `eth_maxPriorityFeePerGas`, or no JSON-RPC provider). The cause is on `err.cause`; pass `maxPriorityFeePerGas` to skip the lookup                              |
| `HTTP_REQUEST_FAILED`               | An HTTP fetch (address index, proof API) failed — network error, non-2xx, or a non-JSON body; `info` carries the URL, status, and a body snippet                                                                                              |
| `BATCH_SIZE_LIMIT_EXCEEDED`         | An ERC-721 `depositMany` / `startWithdrawMany` (or its `prepare*` variant) was given more than 20 token ids, the bridge contracts' per-transaction batch limit. ERC-1155 batch calls are not size-checked client-side                         |
| `LOG_NOT_FOUND_IN_RECEIPT`          | Receipt didn't contain the log expected by the bridge decoder                                                                                                                                                                                 |
| `NEGATIVE_INDEX`                    | Negative index passed to a positional helper                                                                                                                                                                                                  |
| `INDEX_OUT_OF_BOUNDS`               | Index past the end of the underlying array                                                                                                                                                                                                    |
| `BRIDGE_EVENT_DECODE_FAILED`        | Couldn't decode a bridge event log against its ABI                                                                                                                                                                                            |
| `NULL_SPENDER_ADDRESS`              | `approve` on a child-chain token without an explicit `spenderAddress`                                                                                                                                                                         |
| `ALLOWED_ON_NON_NATIVE_TOKENS`      | Not raised by 4.0 (the native-token guard became unreachable in the rewrite) — retained so the legacy `type` mapping `allowed_on_non_native_token` stays representable                                                                        |
| `ONLY_ALLOWED_ON_MAINNET`           | Mainnet-only call (e.g. `depositEtherWithGas`) made on a testnet                                                                                                                                                                              |

Not every failed exit is an SDK error. Exits are enabled per token by
the bridge, and `RootChainManager.exit` reverts with `EXIT_DISABLED`
for USDT burns. If `completeWithdraw` (or a `prepareCompleteWithdraw`
payload you send yourself) fails with this revert, check whether exits
are enabled for that token; do not retry.

Every error also carries optional structured debug data on the
`info` property (token addresses, tx hashes, chain IDs). This is
the inherited `info` field from [`VError`][verror] — `POSBridgeError`
uses it directly rather than re-implementing it. Any logger that
walks own enumerable properties on Error instances (pino, winston,
Sentry's default scrubber, …) sees `info` and `code` in the JSON
serialization. Use `VError.info(err)` (or the standalone `info(err)`
helper) to get the merged set across the full cause chain.

## `parent` / `child` namespaces

Token operations were previously routed through a single overloaded
factory — `client.erc20(addr, isParent?)` — with a boolean argument
disambiguating which chain you meant. 4.0 splits the factory in two:

```diff
-const goerliErc20 = client.erc20(parentToken, true);   // parent
-const polygonErc20 = client.erc20(childToken);          // child (default)

+const parentErc20 = pos.parent.erc20(parentToken);
+const childErc20  = pos.child.erc20(childToken);
```

The `isParent` boolean is gone everywhere, including ERC-721 and
ERC-1155. The two namespaces share no state — calling
`pos.parent.erc20(addr)` returns a fresh wrapper bound to the parent
adapter, `pos.child.erc20(addr)` to the child adapter; both are cheap
to construct.

## ETH deposits hoisted to `POSClient`

Native-ETH deposits used to live as `_depositEther` on every ERC-20
instance, which was vestigial — they didn't read any ERC-20 state and
the receiver-token concept doesn't apply to native ETH. 4.0 hoists
them to the top-level client where they belong:

```diff
-await client.erc20(parentToken, true).depositEther(amount, userAddress);
-await client.erc20(parentToken, true).depositEtherWithGas(amount, userAddress, swapEthAmount, swapCallData);

+await pos.depositEther(amount, userAddress);
+await pos.depositEtherWithGas(amount, userAddress, swapEthAmount, swapCallData);
```

`depositEtherWithGas` is mainnet-only, because the `GasSwapper`
contract is only deployed on Ethereum mainnet. On a network whose
address index carries no GasSwapper (Amoy), it throws
`POSBridgeError('CONTRACT_NOT_AVAILABLE_ON_NETWORK')`; the
`ONLY_ALLOWED_ON_MAINNET` guard fires when a GasSwapper address exists
but the connected parent chain isn't mainnet (e.g. a custom `addresses`
override on a fork).

## Unsigned transactions: `prepareXxx()` for smart wallets, batchers, off-chain signers

Every public write on the SDK has a sibling `prepareXxx` method that returns
`{ to, data, value? }` instead of broadcasting. This replaces the legacy
`option.returnTransaction` flag (which was clumsy: same return type meaning
two different things depending on a boolean) with two distinct, statically-
typed methods.

```ts
// Default — broadcast.
const result = await pos.parent.erc20(addr).approve(1_000n);
await result.confirmed();

// Same call, prepared (not broadcast). Forward to a smart-contract wallet,
// batch with other operations, sign offline, etc.
const tx = await pos.parent.erc20(addr).prepareApprove(1_000n);
//   tx.to    — the contract to call
//   tx.data  — encoded calldata
//   tx.value — wei to attach (omitted when zero)

await safeClient.proposeTransaction({
  to: tx.to,
  data: tx.data,
  value: tx.value ?? 0n
});
```

Every write method gets a `prepareXxx` sibling: `prepareApprove`,
`prepareApproveMax`, `prepareDeposit`, `prepareDepositWithGas`,
`prepareStartWithdraw`, `prepareCompleteWithdraw`, `prepareCompleteWithdrawFast`,
`prepareCompleteWithdrawOnIndex` (ERC721), `prepareTransfer`, etc., plus
`prepareDepositEther` and `prepareDepositEtherWithGas` on `POSClient` for
ETH deposits.

The prepared path is pure — no chain-id lookup, no gas estimation, no fee-cap
guard. The wallet that eventually signs the transaction fills those in. If
you need a pre-computed gas estimate, call your own client's `estimateGas`
against the prepared `to`/`data`/`value`.

## Direct access to bridge helpers (`buildExitPayload`, `isCheckpointed`, …)

The 3.x SDK exposed `pos.client.exitUtil` directly, which several services
relied on for non-token use cases — exit payloads for sync block events,
custom bridge events, etc. (Plasma is not part of 4.0.) The new SDK exposes those helpers
as flat methods on `POSClient`:

| 3.x                                                            | 4.0                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pos.exitUtil.buildPayloadForExit(burnTx, sig, fast)`          | `pos.buildExitPayload(burnTx, sig, fast?)`                                                                                                                                                                                       |
| `pos.exitUtil.buildPayloadForExit(burnTx, sig, fast, i)`       | `pos.buildExitPayloadOnIndex(burnTx, sig, i, fast?)`                                                                                                                                                                             |
| `pos.exitUtil.buildMultiplePayloadsForExit(burnTx, sig, fast)` | `pos.buildExitPayloads(burnTx, sig, fast?)` → `string[]`                                                                                                                                                                         |
| `pos.isCheckPointed(burnTx)`                                   | `pos.isCheckpointed(burnTx)`                                                                                                                                                                                                     |
| `pos.isDeposited(depositTx)`                                   | `pos.isDeposited(depositTx)`                                                                                                                                                                                                     |
| `pos.exitUtil.getBlockProof(blockNum, { start, end })`         | `pos.getBlockProof(blockNum, { start, end })`                                                                                                                                                                                    |
| `pos.exitUtil.rootChain.getLastChildBlock()`                   | `pos.rootChain.getLastChildBlock()`                                                                                                                                                                                              |
| `pos.exitUtil.rootChain.findRootBlockFromChild(n)`             | `pos.rootChain.findRootBlockFromChild(n)`                                                                                                                                                                                        |
| `erc20.isWithdrawExited(burnTx)` (per token class)             | `erc20.isWithdrawExited(burnTx)` — or flat `pos.isWithdrawn(burnTx, sig)` with an explicit event signature                                                                                                                       |
| `erc721.isWithdrawExitedOnIndex(burnTx, i)`                    | `erc721.isWithdrawExitedOnIndex(burnTx, i)` — or flat `pos.isWithdrawnOnIndex(burnTx, sig, i)`                                                                                                                                   |
| _(internal)_ predicate lookup inside the token classes         | `pos.getPredicateAddress(token)` — now public                                                                                                                                                                                    |
| `pos.exitUtil.getExitHash(burnTx, i, sig)`                     | _dropped_ — `pos.isWithdrawn` / `isWithdrawnOnIndex` cover the exit-status check the hash fed; consumers needing the raw hash compute `keccak256(solidityPack(blockNumber, receiptPathNibbles, logIndex))` with their own client |

The token classes (`pos.parent.erc20(...).completeWithdraw(...)`, etc.)
still wrap these helpers for the 95% case; reach for the flat methods only
when you need to build exit data outside the standard flows.

To check whether the tokens of an ERC-721 `startWithdrawMany` burn have
exited, call `erc721.isWithdrawExitedOnIndex(burnTx, i)` for each token, not
`erc721.isWithdrawExitedMany(burnTx)`. Each token in a batch burn is exited
through its own `Transfer` log (`completeWithdrawOnIndex`), and the exit is
recorded under that log's index. `isWithdrawExitedMany` checks only the exit
of the batch's `WithdrawnBatch` log, which the standard `ERC721Predicate`
does not accept (only `MintableERC721Predicate` does) and which no 4.0
ERC-721 method submits. After a per-token exit it keeps returning `false`.

`isDeposited(depositTxHash)` confirms a deposit has been processed on the
child chain (it reads the child `StateReceiver.lastStateId()` and compares
it to the `StateSynced` event in the parent-chain deposit receipt) — the
standard "has my deposit landed on Polygon yet?" poll. `buildExitPayloads`
(plural) returns every exit payload for a burn tx that emitted multiple
matching logs, the equivalent of the old `buildMultiplePayloadsForExit`.

## Calling unwrapped contract methods (replaces `.method(...)`)

The 3.x SDK let you reach arbitrary contract methods via
`rootChain.method(name, ...args)` / `rootChainManager.method(...)`. 4.0
drops that string-dispatch accessor. Since you already bring your own
viem / ethers client, the idiomatic replacement is to call the contract
with that client directly — the SDK just hands you the two things it
owns that you'd otherwise have to reproduce: the **resolved address**
(`pos.getAddresses()`, served from the same stale-while-revalidate cache
the bridge flows use) and the **vendored ABI** (exported from the
`@polygonlabs/maticjs/abi` subpath).

```ts
import { RootChainManagerABI } from '@polygonlabs/maticjs/abi';

const { RootChainManager } = await pos.getAddresses();
const value = await parentPublicClient.readContract({
  address: RootChainManager,
  abi: RootChainManagerABI,
  functionName: 'someMethodTheSdkDoesNotWrap',
  args: [
    /* ... */
  ]
});
```

The same recipe with ethers — the `as const` ABI modules are accepted
by `new Contract(...)` directly (v5 and v6):

```ts
import { Contract } from 'ethers';

import { RootChainABI } from '@polygonlabs/maticjs/abi';

const { RootChain } = await pos.getAddresses();
const rootChain = new Contract(RootChain, RootChainABI, provider);
const headerBlock = await rootChain['headerBlocks'](headerSlot);
```

This is fully typed by your own client (viem infers argument and return
types straight from the `as const` ABI), needs no SDK-specific call
surface, and the addresses still track index redeployments within the
TTL window. Reuse a provider/client you already hold for these reads —
don't construct one per call. `getAddresses()` returns your `config.addresses` override
verbatim when one was supplied.

## TxResult: `result.confirmed()` not `result.getReceipt()`

```diff
-const tx = await erc20.approve(amount);
-const hash    = await tx.getTransactionHash();   // sometimes lazy, sometimes not
-const receipt = await tx.getReceipt();           // separately memoised

+const result = await pos.parent.erc20(token).approve(amount);
+const hash    = result.hash;                      // always available immediately
+const receipt = await result.confirmed();         // memoised; safe to call repeatedly
```

The legacy `ITransactionWriteResult` exposed `getTransactionHash()` /
`getReceipt()` lazily and the same call sometimes returned a hash and
sometimes a receipt depending on a `returnTransaction` option. 4.0
makes the shape unconditional: `hash` is a property (synchronously
available the moment the RPC accepts the broadcast), `confirmed()`
is the only way to wait for the receipt, and it is idempotent — call
it twice and the underlying `wait` is reused.

> **A reverted transaction rejects.** If the transaction is mined but
> reverts, `confirmed()` rejects with a `POSBridgeError` whose `code` is
> `'TRANSACTION_REVERTED'`. It does not resolve with a
> `status: 'reverted'` receipt, with any adapter. 3.x `getReceipt()` also
> rejected on revert, so code that treats "`confirmed()` resolved" as
> success stays correct. The receipt is still available. It is on
> `err.info.receipt`, and `err.info.transactionHash` holds the hash of
> the transaction that mined. For a fee-bumped re-send that reverted,
> that is the re-send's hash, not `result.hash`.
> Calling `confirmed()` again rejects with the same error, without
> polling the chain a second time.
>
> A transaction that never mines because another one took its nonce
> rejects too. If the wallet cancelled it, or sent a different
> transaction at the same nonce, `confirmed()` rejects with
> `'TRANSACTION_REPLACED'`. `err.info.reason` is `'cancelled'` or
> `'replaced'`, `err.info.replacementHash` names the other transaction,
> and `err.info.receipt` holds its receipt. A fee-bumped re-send of the
> same call (a wallet's speed-up) counts as the original: `confirmed()`
> resolves with the re-send's receipt, and rejects with
> `'TRANSACTION_REVERTED'` if the re-send reverted. So a resolved
> `confirmed()` means the transaction, or a fee-bumped re-send of it,
> succeeded.
>
> ```ts
> try {
>   await result.confirmed();
> } catch (err) {
>   if (err instanceof POSBridgeError && err.code === 'TRANSACTION_REVERTED') {
>     const receipt = err.info.receipt; // the full receipt, status 'reverted'
>   }
>   throw err;
> }
> ```
>
> To read a receipt without any throw, call the adapter you passed to
> `POSClient.init`: `await adapter.getTransactionReceipt(result.hash)`.
> It resolves with the receipt whatever its `status`, or `null` if the
> transaction is not mined yet. It does not wait, so call it after the
> transaction has landed.

## Address resolution

4.0 resolves bridge contract addresses from the **same CDN index files
the 3.x SDK reads** (`static.polygon.technology/network/mainnet/v1/…`
and `network/testnet/amoy/…`, in their existing nested layout, taking
the live `*Proxy` entries) — so there is no new infrastructure and no
divergence from what 3.9.x consumers resolve. What changes is the
lifecycle: 3.x fetched once at `init`; 4.0 caches for 1 hour and serves
stale-while-revalidate, so a long-running service picks up contract
redeployments without a restart. The 3.x `network`/`version` config
pair (`'testnet'`+`'amoy'`) collapses into the single `network` value
(`'amoy'`) — the SDK owns the path mapping.

```ts
const pos = await POSClient.init({
  network: 'amoy',
  parent: /* ... */,
  child:  /* ... */,
  // Optional overrides:
  addressIndexUrl: 'https://my-mirror.example/network',
  addressTTLMs: 30 * 60_000,
  onAddressRefreshError: (err) => myLogger.warn({ err }, 'address refresh failed')
});
```

An `addressIndexUrl` mirror must either replicate the CDN's layout and
nested JSON shape, or serve a pre-flattened `NetworkAddresses` object —
the SDK's parser accepts both.

One scoping note on the refresh: contract **addresses** track the index
live, but contract **availability** is fixed at `init` — whether the
network has a `GasSwapper` or a mintable-ERC-1155 predicate is decided
from the index fetched during `init`, so a network _gaining_ one of
those optional contracts later requires a re-`init` to pick up. (Their
addresses, once present at init, do refresh live.)

For air-gapped deployments, supply addresses directly:

```ts
const pos = await POSClient.init({
  network: 'amoy',
  parent: /* ... */,
  child:  /* ... */,
  addresses: {
    RootChainManager: '0x...',
    ERC20Predicate:   '0x...',
    // ...
  }
});
```

When `addresses` is provided the SDK never reaches the CDN; you are
responsible for keeping these addresses current across protocol
redeployments.

## Fast exits: `proofGenerationApiUrl` replaces `setProofApi()`

The 3.x SDK enabled the fast-exit path through a global
`setProofApi(url)` mutation; fast exits were opt-in and threw if you
never called it. 4.0 keeps fast exits opt-in but moves the URL into
the constructor config — no global state:

```diff
-import { setProofApi } from '@maticnetwork/maticjs';
-setProofApi('https://proof-generator.polygon.technology');

+const pos = await POSClient.init({
+  network: 'mainnet',
+  parent: /* ... */,
+  child:  /* ... */,
+  proofGenerationApiUrl: 'https://proof-generator.polygon.technology'
+});
```

`proofGenerationApiUrl` is optional and has **no default** — set it to
opt into fast exits (`completeWithdrawFast`, `buildExitPayload(..., true)`,
`buildExitPayloads(..., true)`). When it is unset, those methods throw
`POSBridgeError('PROOF_API_NOT_SET')` and every payload is built locally
from RPC, exactly as in 3.x. (4.0 also fixes a latent 3.x bug where the
proof-API network segment was hardcoded to `matic`, so fast exits only
worked on mainnet; the segment is now derived from `network`.)

There is no injectable proof-API client object — the old SDK never
exposed one either. The SDK builds its own client from the URL, and
`pos.getProofApi()` returns the configured URL (or `undefined`),
mirroring the 3.x accessor of the same name.

Behavioural notes, both fail-safe:

- **Fast exits degrade, never dead-end**: if the proof API is
  configured but errors, the SDK logs a warning and falls back to
  local payload construction — a proof-API outage turns fast exits
  into slow ones, matching 3.x's fallback.
- **The slow path gets faster when the URL is set**: local
  construction consults the API for two sub-steps (checkpoint lookup
  and block proof) with the same fall-back-to-local behaviour. In 3.x
  the `isFast=false` path never touched the API; if you need strictly
  RPC-only construction (e.g. an air-gapped verifier), simply don't
  configure `proofGenerationApiUrl`.

## Reorg safety: `rootChainDefaultBlock`

Checkpoint and root-block reads default to the `'safe'` block tag to
avoid a reorg race (reading an un-finalised header that is reorged out
before the exit payload reaches L1). This restores the 3.x
`rootChainDefaultBlock` behaviour. Override it per client:

```ts
const pos = await POSClient.init({
  network: 'amoy',
  parent: /* ... */,
  child:  /* ... */,
  rootChainDefaultBlock: 'finalized' // 'safe' (default) | 'finalized' | 'latest'
});
```

## Dropped configuration fields

These all silently no-op'd or made things worse and are not accepted
by `POSClient.init`:

- **`version`** — the `'pos' | 'mintable' | 'amoy'` selector is gone.
  Mintable variants are addressed via dedicated helpers (e.g.
  `ERC1155.approveAllForMintable`); the network selector is now just
  `network: 'mainnet' | 'amoy'`.
- **`log: true`** — pass a real `Logger` instance via the optional
  `logger` field. The structural `Logger` interface accepts any
  pino-shaped logger (`(obj, msg)` call convention) including raw
  `pino`, `bunyan`, [`@polygonlabs/logger`][polylogger], custom
  wrappers, and test stubs. Omit the field entirely for the no-op
  default.

[polylogger]: https://www.npmjs.com/package/@polygonlabs/logger

- **`option.returnTransaction`** — every write returns a `TxResult`.
  For unsigned transaction data, call the `prepareXxx()` sibling of the
  write (`prepareApprove`, `prepareDeposit`, …) — it returns the
  encoded `{ to, data, value? }` without broadcasting. See "Unsigned
  transactions" above.
- **`resolution`** — the legacy SDK accepted an UnstoppableDomains
  resolver here. Address resolution (ENS, UD, anything human-readable)
  is a consumer concern; the SDK takes raw `0x`-addresses.
- **`parent.defaultConfig.from` / `child.defaultConfig.from`** — gone,
  and nothing replaces it because nothing needs it: reads carry no
  sender, and a write's `from` is the signer/account inside the adapter
  you constructed. Read-only consumers (proof services, indexers) simply
  drop the field and pass an adapter with no signer.
- **Per-contract address overrides** (`rootChainManager`, `rootChain`,
  `gasSwapper`, `erc1155.mintablePredicate` under the old client
  config) — replaced by the single `addresses: NetworkAddresses`
  override, which supplies the full set at once and disables the CDN
  fetch entirely. There is no per-contract override: mixing one pinned
  address with live resolution for the rest silently breaks whenever a
  redeployment moves the pinned contract's counterparties.
- **`requestConcurrency`** — renamed `proofConcurrency`, and it now
  bounds only the receipt fetches of local proof construction. The
  default changed from unlimited to `4`: Polygon blocks can carry 280+
  transactions and firing every receipt fetch at once trips public-RPC
  rate limits, which surfaced as flaky exit builds.

### Per-transaction options: `ITransactionOption` → `TxOptions`

Every write still takes a trailing options object, now typed `TxOptions`
with `bigint` numeric fields: `from`, `value`, `gasLimit`,
`maxFeePerGas`, `maxPriorityFeePerGas`, `nonce`, `chainId` (a new
cross-chain mis-send guard), and `blockTag` (reads only). When you
pass no fee options, the SDK uses the node's suggested tip
(`eth_maxPriorityFeePerGas`) with no upper bound; pass `maxFeePerGas`
and `maxPriorityFeePerGas` if you need a ceiling.

With ethers v6, the SDK reads a local signer's pending nonce straight from
the node, so back-to-back SDK writes get consecutive nonces. If you also
send transactions from the same ethers v6 `Wallet` outside the SDK, the
provider's 250 ms `cacheTimeout` can hand those sends a stale pending
nonce: wrap the wallet in ethers' `NonceManager` and pass that same
`NonceManager` to the SDK as the signer, or create the provider with a
lower `cacheTimeout` (`-1` disables the cache).

Frontend note: before every write, the adapter asks the **signing
wallet** which chain it is on and compares it with `chainId` (or, when
you omit it, the chain your read client is connected to). If the user
has switched their browser wallet to another network, the write throws
`POSBridgeError` with code `UNSUPPORTED_NETWORK` and
`info: { expected, actual }` instead of broadcasting. Nothing is sent, so
catch that code and prompt the user to switch back, e.g. with viem's
`walletClient.switchChain`, then retry. The wallet's chain is re-read on
every write, so a retry after switching succeeds without rebuilding the
`POSClient`. With ethers, a browser provider created without the
`'any'` network rejects the switch itself with an ethers
`NETWORK_ERROR` before this check runs; nothing is broadcast in that
case either.

Two legacy fields are gone:

- **`gasPrice`** — the SDK models EIP-1559 fees only (both supported
  chains are EIP-1559). To pin an exact price the way `gasPrice` did,
  set `maxFeePerGas` and `maxPriorityFeePerGas` to the same value — an
  included transaction then pays exactly that. Note for JavaScript
  consumers: an object with a stray `gasPrice` key is **silently
  ignored** (TypeScript consumers get a compile error), so migrate the
  field, don't carry it.
- **`type`** (explicit type-0/type-2 selection) — writes are always
  EIP-1559. A consumer that genuinely must send a legacy type-0
  transaction can use the `prepareXxx()` escape hatch and submit the
  `{ to, data, value? }` with their own client and fee fields.

## Dropped methods — and what to call instead

The 3.x SDK exposed a generic `Web3SideChainClient` via `pos.client.parent` /
`pos.client.child` that surfaced library-agnostic wrappers around RPC
primitives. The 4.0 SDK is intentionally narrower: consumers bring their
own client, so generic RPC and crypto helpers stay on the consumer's
client. Each removed method has a direct replacement:

### `pos.client.parent.signTypedData(signer, typedData)`

Call your own wallet client. The signature differs slightly per library
but the shape (signer + typed data → 0x signature) is identical:

```ts
// viem
const sig = await parentWallet.signTypedData({
  account,
  domain,
  types,
  primaryType: 'Bridge',
  message
});

// ethers v5
const sig = await signer._signTypedData(domain, types, message);

// ethers v6
const sig = await signer.signTypedData(domain, types, message);
```

### `pos.client.parent.etheriumSha3(...args)` / Solidity-packed keccak

The 3.x method was a variadic packed-keccak that inferred Solidity types
from the values. The 4.0 SDK doesn't expose it — call your client's
explicit-typed equivalent:

```ts
// viem (encode + keccak in two steps; explicit types)
import { encodePacked, keccak256 } from 'viem';
const h = keccak256(encodePacked(['address', 'uint256'], [addr, amount]));

// ethers v5
const h = ethers.utils.solidityKeccak256(['address', 'uint256'], [addr, amount]);

// ethers v6
const h = ethers.solidityPackedKeccak256(['address', 'uint256'], [addr, amount]);
```

### `Converter.toHex(value)` / the `Converter` util

The runtime `Converter` existed to bridge the legacy big-number
wrappers. With native `bigint` everywhere the conversions are
one-liners, so 4.0 doesn't ship it:

```ts
const hex = `0x${value.toString(16)}`; // Converter.toHex
const wei = amount * 10n ** 18n; // Converter.toWei (18 decimals)
```

For a plain (non-packed) keccak256 over a `Uint8Array` or hex string, every
adapter's underlying client has `keccak256` directly. Or add
`ethereum-cryptography` (or `@noble/hashes`) as your own dependency —
the SDK does not ship it, so don't rely on it being installed:

```ts
import { keccak256 } from 'ethereum-cryptography/keccak';
import { hexToBytes, bytesToHex } from 'ethereum-cryptography/utils';
const out = '0x' + bytesToHex(keccak256(hexToBytes(input.replace(/^0x/, ''))));
```

### `pos.client.parent.encode(value, type)` / `encodeParameters` / `decodeParameters`

Every modern EVM client has first-class ABI encoding; the SDK no longer
re-exposes a uniform interface:

```ts
// viem
import { encodeAbiParameters, decodeAbiParameters } from 'viem';
const encoded = encodeAbiParameters([{ type: 'uint256' }], [amount]);
const [decoded] = decodeAbiParameters([{ type: 'uint256' }], encoded);

// ethers v5
const encoded = ethers.utils.defaultAbiCoder.encode(['uint256'], [amount]);
const [decoded] = ethers.utils.defaultAbiCoder.decode(['uint256'], encoded);

// ethers v6
const coder = ethers.AbiCoder.defaultAbiCoder();
const encoded = coder.encode(['uint256'], [amount]);
const [decoded] = coder.decode(['uint256'], encoded);
```

### `pos.client.parent.sendRPCRequest({method, params})`

Call your client's request method directly:

```ts
// viem
const result = await parentPublic.request({ method: 'bor_getRootHash', params });

// ethers v5
const result = await provider.send('bor_getRootHash', params);

// ethers v6 (JsonRpcProvider has the same signature)
const result = await provider.send('bor_getRootHash', params);
```

### `pos.client.parent.getBlock` / `getTransaction` / `getBalance` / `getAccounts` / `hexToNumber` / `hexToNumberString`

All available natively on every client library. Migrate to direct calls:
`parentPublic.getBlock(...)` (viem), `provider.getBlock(...)` (ethers).
The SDK never re-exposed these for any reason other than uniform-interface
ergonomics — that ergonomics belongs on the consumer's client now.

### `client.exitUtil` direct access

The legacy SDK exposed `pos.client.exitUtil` as a public surface; several
services depended on it for non-token use cases. The full migration table
is in the "Direct access to bridge helpers" section above.

## Errors extend `VError`

`POSBridgeError` now extends [`VError`][verror], a TypeScript-first,
browser-friendly port of Joyent's canonical Node `verror` library.
Consumers get the standard cause-chain helpers — `findCauseByName`,
`findCauseByType`, `info(err)`, `fullStack(err)` — out of the box,
matching the same API documented in Joyent's original library.

Structured context lives on `err.info` (VError's conventional name,
following Joyent's). The 3.x SDK had no equivalent — it threw plain
`{ message, type }` objects with any detail baked into the message
string — so there is nothing to rename at call sites; `info` is simply
where 4.0 puts the values you previously had to parse out of messages:

```ts
try {
  await pos.parent.erc20(token).completeWithdraw(burnTxHash);
} catch (err) {
  if (err instanceof POSBridgeError) {
    // `info` and `code` are own enumerable properties; any logger that
    // walks those (pino, winston, Sentry, custom) picks them up directly.
    logger.error({ err }, 'withdraw failed');
  }
}
```

VError has zero runtime dependencies and ships ESM, so the SDK works in
browser bundles without Node polyfills.

[verror]: https://www.npmjs.com/package/@polygonlabs/verror

## Verifying the migration

After updating the imports, lean on the type checker:

```bash
pnpm exec tsc --noEmit
```

Most of the breaking changes surface as type errors at the call site
(missing `kind` discriminator, `BigNumber` where `bigint` is expected,
`getTransactionHash()` on `TxResult` that no longer has it). Once the
type errors are gone, run your existing integration tests against
Amoy — the bridge protocol hasn't changed, so the on-chain behaviour
matches.

## zkEVM

The 3.x line shipped both the PoS bridge and the zkEVM bridge
surfaces. **`@polygonlabs/maticjs` covers only the PoS side.** The
Polygon zkEVM network has reached end of life, so the `ZkEvmClient`
surface is not ported — there is no longer a chain for it to talk to.
Remove `ZkEvmClient` usage along with the retired network.

`@maticnetwork/maticjs` (≤ 3.x) remains published on npm but is
frozen; new releases ship only as `@polygonlabs/maticjs`, from this
repository's `master` branch.
