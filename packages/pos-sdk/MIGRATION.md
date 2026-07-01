# Migration: 0.x → 1.0

`@polygonlabs/pos-sdk` 1.0 is a clean break from the
`@maticnetwork/maticjs` 0.x / 3.x line. The bridge protocol it speaks
hasn't changed; the SDK around it has been rewritten to remove the
plugin layer, drop legacy big-number types, and surface configuration
errors at construction time. This guide walks every breaking change in
the order most consumers will hit them.

If you are starting a new integration, skip this file and read the
package [README](./README.md).

## Package rename: `@maticnetwork/maticjs` → `@polygonlabs/pos-sdk`

The package now lives under the official `@polygonlabs` npm scope and
is re-themed for its actual scope: the Polygon **PoS bridge**. The
zkEVM bridge surface that the legacy `@maticnetwork/maticjs` package
also shipped is **not** part of this rewrite — the zkEVM chain is on
a wind-down schedule, and consumers using the zkEVM bridge should
stay on `@maticnetwork/maticjs` until the chain is shut down. See
"zkEVM bridge users — stay on `@maticnetwork/maticjs`" at the bottom
of this guide for the rationale.

Update the install:

```diff
-pnpm remove @maticnetwork/maticjs @maticnetwork/maticjs-ethers @maticnetwork/maticjs-web3
+pnpm add @polygonlabs/pos-sdk
+# plus your existing peer:
+pnpm add viem      # or ethers (v5 or v6)
```

And every import:

```diff
-import { POSClient, use } from '@maticnetwork/maticjs';
-import { Web3ClientPlugin } from '@maticnetwork/maticjs-web3';
+import { POSClient } from '@polygonlabs/pos-sdk';
```

`@polygonlabs/pos-sdk` no longer ships any `*-web3` / `*-ethers`
companion packages; the parent-chain client is configured directly on
`POSClient.init` (see "Plugin removal" below).

## Plugin removal: pass clients directly to `POSClient.init`

The 0.x SDK required calling `use(Plugin)` at module load time to
register a global EVM-library implementation, then passing raw provider
objects into a generic `init(...)`. That design forced every consumer
to mutate global state during application boot, made multi-version
co-existence impossible (you can only `use` one plugin), and hid the
parent/child wiring in implementation detail.

1.0 replaces the plugin with **per-library adapter factories** imported
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

+import { POSClient } from '@polygonlabs/pos-sdk';
+import { viemAdapter } from '@polygonlabs/pos-sdk/viem';
+
+const pos = await POSClient.init({
+  network: 'amoy',
+  parent: viemAdapter({ public: parentPublic, wallet: parentWallet }),
+  child:  viemAdapter({ public: childPublic,  wallet: childWallet  })
+});
```

The factory lives at a library-specific subpath:

| Your client library | Import | Factory call |
|---|---|---|
| viem | `@polygonlabs/pos-sdk/viem` | `viemAdapter({ public, wallet })` |
| ethers v5 | `@polygonlabs/pos-sdk/ethers-v5` | `ethersV5Adapter({ provider, signer })` |
| ethers v6 | `@polygonlabs/pos-sdk/ethers-v6` | `ethersV6Adapter({ provider, signer })` |

`POSClientConfig.parent` / `.child` are typed as the SDK's `Adapter`
interface (exported from the main entry for consumers who want to type
their own wiring). There is no `kind` discriminator and no
`ParentClientConfig` union — those existed in an interim design and
were removed before 1.0 in favour of the factory pattern, which keeps
viem and ethers as fully optional peers (importing the SDK never
references a library you didn't install).

`POSClient.init` is the only public constructor — the class
constructor itself is private so misuse (skipping the address-index
validation, forgetting to inject the bridge helpers) cannot happen.

## bigint everywhere

Every numeric parameter and return value is now native `bigint`. The
0.x SDK accepted any of `string | number | BN | BaseBigNumber`,
threaded values through a runtime `Converter`, and returned big-number
wrappers (`BN` from web3, `BigNumber` from ethers v5). 1.0 demands the
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

The 0.x bridge surface mixed verb-noun and noun-verb conventions
(`withdrawStart` next to `getCheckpoint`). 1.0 normalises everything
to verb-noun:

| 0.x                                     | 1.0                                                |
|-----------------------------------------|----------------------------------------------------|
| `erc20.withdrawStart(amount)`           | `erc20.startWithdraw(amount)`                      |
| `erc721.withdrawStart(tokenId)`         | `erc721.startWithdraw(tokenId)`                    |
| `erc1155.withdrawStart(id, amount)`     | `erc1155.startWithdraw(id, amount)`                |
| `erc20.withdrawExit(burnTxHash)`        | `erc20.completeWithdraw(burnTxHash)`               |
| `erc20.withdrawExitFaster(burnTxHash)`  | `erc20.completeWithdrawFast(burnTxHash)`           |
| `client.etheriumSha3(...)`              | _removed_ — call `Adapter.keccak256(bytes)` or use viem/ethers' own helper |
| `client.encode(value, type)`            | _removed_ — vendor your own ABI helper or use viem/ethers' own coder |

`completeWithdraw` accepts `{ isFast: true }` as an option, so the
`completeWithdrawFast` method is just a shorthand. The legacy SDK
returned a different shape from the two paths; 1.0 returns the same
`TxResult` for both.

## Error handling

The 0.x SDK threw plain `Error` instances assembled by an
`ErrorHelper.throw(code, ...)` helper. Consumers had to regex the
message to extract the failure code, which made downstream aggregation
brittle and forced ad-hoc branching on substrings.

1.0 raises a single `POSBridgeError` class with a stable discriminator
`code`. Existing dashboards keyed off the legacy code names continue
to match — the strings haven't changed; they are now a typed field on
a dedicated class.

```ts
import { POSBridgeError } from '@polygonlabs/pos-sdk';

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

| Code                              | Raised when |
|-----------------------------------|-------------|
| `BURN_TX_NOT_CHECKPOINTED`        | `completeWithdraw` ran before the burn tx's block was checkpointed on the parent chain |
| `EIP1559_NOT_SUPPORTED`           | EIP-1559 fee fields supplied to a legacy-only chain |
| `PROOF_API_NOT_SET`               | `completeWithdrawFast` or fast-exit code path used without `proofGenerationApiUrl` configured |
| `INVALID_TOKEN_TYPE`              | A token-type discriminator (ERC-20 / 721 / 1155) didn't match the underlying contract |
| `CONTRACT_NOT_AVAILABLE_ON_NETWORK` | An operation needs a contract that isn't deployed/configured on the active network — `depositEtherWithGas` / `depositWithGas` where no `GasSwapper` exists, or `approveAllForMintable` where the index carries no mintable-ERC-1155 predicate |
| `TX_OPTION_NOT_OBJECT`            | `options` arg passed but not an object |
| `UNSUPPORTED_NETWORK`             | Method invoked on the wrong chain (`startWithdraw` on parent, `deposit` on child, etc.) |
| `WEB3_CLIENT_NOT_INITIALIZED`     | Internal client was used before `POSClient.init` resolved |
| `ROOT_HASH_RPC_FAILED`            | bor's `bor_getRootHash` RPC call returned an error |
| `INVALID_HEX_STRING`              | Hex helper received a value that isn't `0x`-prefixed lowercase hex |
| `NEGATIVE_BIG_NUMBER`             | A negative bigint reached a code path that requires unsigned values |
| `INVALID_NUMERIC_VALUE`           | A `bigint` parser received a non-numeric input |
| `BUFFER_TYPE_REQUIRED`            | Internal helper expected `Uint8Array` and got something else |
| `UNSUPPORTED_KECCAK_BIT_WIDTH`    | keccak helper called with a width other than 256 |
| `MERKLE_TREE_REQUIRES_LEAVES`     | Merkle-proof builder invoked with zero leaves |
| `MERKLE_TREE_DEPTH_EXCEEDED`      | Merkle-proof depth exceeded the protocol's maximum |
| `STATE_SYNCED_EVENT_NOT_FOUND`    | `isDeposited` couldn't find the `StateSynced` event in the deposit receipt |
| `PROOF_NODE_KEY_MISMATCH`         | Internal proof-tree consistency check failed |
| `TRANSACTION_HASH_REQUIRED`       | Bridge call made without the burn transaction hash |
| `BATCH_SIZE_LIMIT_EXCEEDED`       | A batched ERC-1155 call exceeded the protocol's per-call limit |
| `LOG_NOT_FOUND_IN_RECEIPT`        | Receipt didn't contain the log expected by the bridge decoder |
| `NEGATIVE_INDEX`                  | Negative index passed to a positional helper |
| `INDEX_OUT_OF_BOUNDS`             | Index past the end of the underlying array |
| `BRIDGE_EVENT_DECODE_FAILED`      | Couldn't decode a bridge event log against its ABI |
| `NULL_SPENDER_ADDRESS`            | `approve` on a child-chain token without an explicit `spenderAddress` |
| `ALLOWED_ON_NON_NATIVE_TOKENS`    | Operation only valid for non-native tokens was invoked on a native one |
| `ONLY_ALLOWED_ON_MAINNET`         | Mainnet-only call (e.g. `depositEtherWithGas`) made on a testnet |

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
disambiguating which chain you meant. 1.0 splits the factory in two:

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
the receiver-token concept doesn't apply to native ETH. 1.0 hoists
them to the top-level client where they belong:

```diff
-await client.erc20(parentToken, true).depositEther(amount, userAddress);
-await client.erc20(parentToken, true).depositEtherWithGas(amount, userAddress, swapEthAmount, swapCallData);

+await pos.depositEther(amount, userAddress);
+await pos.depositEtherWithGas(amount, userAddress, swapEthAmount, swapCallData);
```

`depositEtherWithGas` is mainnet-only — it throws
`POSBridgeError('ONLY_ALLOWED_ON_MAINNET')` on Amoy, because the
`GasSwapper` contract is only deployed on Ethereum mainnet.

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

The 0.x SDK exposed `pos.client.exitUtil` directly, which several services
relied on for non-token use cases — exit payloads for sync block events,
custom bridge events, plasma exits, etc. The new SDK exposes those helpers
as flat methods on `POSClient`:

| 0.x                                                           | 1.0                                                                |
|---------------------------------------------------------------|--------------------------------------------------------------------|
| `pos.client.exitUtil.buildPayloadForExit(burnTx, sig, fast)`  | `pos.buildExitPayload(burnTx, sig, fast?)`                         |
| `pos.client.exitUtil.buildPayloadForExit(burnTx, sig, fast, i)` | `pos.buildExitPayloadOnIndex(burnTx, sig, i, fast?)`             |
| `pos.client.exitUtil.buildMultiplePayloadsForExit(burnTx, sig, fast)` | `pos.buildExitPayloads(burnTx, sig, fast?)` → `string[]`     |
| `pos.client.exitUtil.isCheckPointed(burnTx)`                  | `pos.isCheckpointed(burnTx)`                                       |
| `pos.client.isDeposited(depositTx)`                           | `pos.isDeposited(depositTx)`                                       |
| `pos.client.exitUtil.getBlockProof(blockNum, { start, end })` | `pos.getBlockProof(blockNum, { start, end })`                      |
| `pos.client.exitUtil.rootChain.getLastChildBlock()`           | `pos.rootChain.getLastChildBlock()`                                |
| `pos.client.exitUtil.rootChain.findRootBlockFromChild(n)`     | `pos.rootChain.findRootBlockFromChild(n)`                          |
| `pos.isExited(burnTx, sig)`                                   | `pos.isWithdrawn(burnTx, sig)`                                     |
| `pos.isExitedOnIndex(burnTx, sig, i)`                         | `pos.isWithdrawnOnIndex(burnTx, sig, i)`                           |
| `pos.client.exitUtil.getPredicateAddress(token)`              | `pos.getPredicateAddress(token)`                                   |

The token classes (`pos.parent.erc20(...).completeWithdraw(...)`, etc.)
still wrap these helpers for the 95% case; reach for the flat methods only
when you need to build exit data outside the standard flows.

`isDeposited(depositTxHash)` confirms a deposit has been processed on the
child chain (it reads the child `StateReceiver.lastStateId()` and compares
it to the `StateSynced` event in the parent-chain deposit receipt) — the
standard "has my deposit landed on Polygon yet?" poll. `buildExitPayloads`
(plural) returns every exit payload for a burn tx that emitted multiple
matching logs, the equivalent of the old `buildMultiplePayloadsForExit`.

## Calling unwrapped contract methods (replaces `.method(...)`)

The 0.x SDK let you reach arbitrary contract methods via
`rootChain.method(name, ...args)` / `rootChainManager.method(...)`. 1.0
drops that string-dispatch accessor. Since you already bring your own
viem / ethers client, the idiomatic replacement is to call the contract
with that client directly — the SDK just hands you the two things it
owns that you'd otherwise have to reproduce: the **resolved address**
(`pos.getAddresses()`, served from the same stale-while-revalidate cache
the bridge flows use) and the **vendored ABI** (exported from the
`@polygonlabs/pos-sdk/abi` subpath).

```ts
import { RootChainManagerABI } from '@polygonlabs/pos-sdk/abi';

const { RootChainManager } = await pos.getAddresses();
const value = await parentPublicClient.readContract({
  address: RootChainManager,
  abi: RootChainManagerABI,
  functionName: 'someMethodTheSdkDoesNotWrap',
  args: [/* ... */]
});
```

This is fully typed by your own client (viem infers argument and return
types straight from the `as const` ABI), needs no SDK-specific call
surface, and the addresses still track index redeployments within the
TTL window. `getAddresses()` returns your `config.addresses` override
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
sometimes a receipt depending on a `returnTransaction` option. 1.0
makes the shape unconditional: `hash` is a property (synchronously
available the moment the RPC accepts the broadcast), `confirmed()`
is the only way to wait for the receipt, and it is idempotent — call
it twice and the underlying `wait` is reused.

## Address resolution

Previously, contract addresses were either bundled at SDK release time
(implicit; a redeployment required a SDK upgrade) or supplied entirely
by the consumer (explicit but error-prone). 1.0 takes a middle path:
addresses are fetched on demand from a CDN-hosted index, cached for
1 hour, and served stale-while-revalidate so the next read after the
TTL kicks off a background refresh and keeps serving the cached value.

```ts
const pos = await POSClient.init({
  network: 'amoy',
  parent: /* ... */,
  child:  /* ... */,
  // Optional overrides:
  addressIndexUrl: 'https://staging.polygon.tools/network',
  addressTTLMs: 30 * 60_000,
  onAddressRefreshError: (err) => myLogger.warn({ err }, 'address refresh failed')
});
```

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

The 0.x SDK enabled the fast-exit path through a global
`setProofApi(url)` mutation; fast exits were opt-in and threw if you
never called it. 1.0 keeps fast exits opt-in but moves the URL into
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
from RPC, exactly as in 0.x. (1.0 also fixes a latent 0.x bug where the
proof-API network segment was hardcoded to `matic`, so fast exits only
worked on mainnet; the segment is now derived from `network`.)

There is no injectable proof-API client object — the old SDK never
exposed one either. The SDK builds its own client from the URL.

## Reorg safety: `rootChainDefaultBlock`

Checkpoint and root-block reads default to the `'safe'` block tag to
avoid a reorg race (reading an un-finalised header that is reorged out
before the exit payload reaches L1). This restores the 0.x
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
  Consumers wanting unsigned transaction data construct it directly
  from the SDK's vendored ABIs (`ChildERC20ABI`, etc.) and their own
  client; the SDK never returns half-built tx objects.
- **`resolution`** — the legacy SDK accepted an UnstoppableDomains
  resolver here. Address resolution (ENS, UD, anything human-readable)
  is a consumer concern; the SDK takes raw `0x`-addresses.

## Dropped methods — and what to call instead

The 0.x SDK exposed a generic `Web3SideChainClient` via `pos.client.parent` /
`pos.client.child` that surfaced library-agnostic wrappers around RPC
primitives. The 1.0 SDK is intentionally narrower: consumers bring their
own client, so generic RPC and crypto helpers stay on the consumer's
client. Each removed method has a direct replacement:

### `pos.client.parent.signTypedData(signer, typedData)`

Call your own wallet client. The signature differs slightly per library
but the shape (signer + typed data → 0x signature) is identical:

```ts
// viem
const sig = await parentWallet.signTypedData({
  account, domain, types, primaryType: 'Bridge', message
});

// ethers v5
const sig = await signer._signTypedData(domain, types, message);

// ethers v6
const sig = await signer.signTypedData(domain, types, message);
```

### `pos.client.parent.etheriumSha3(...args)` / Solidity-packed keccak

The 0.x method was a variadic packed-keccak that inferred Solidity types
from the values. The 1.0 SDK doesn't expose it — call your client's
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

For a plain (non-packed) keccak256 over a `Uint8Array` or hex string, every
adapter's underlying client has `keccak256` directly. Or use
`ethereum-cryptography/keccak`, which the SDK already depends on:

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

The constructor's third argument was renamed `context` → `info` to match
VError's conventional name (which itself follows Joyent's). Existing call
sites that pass positionally keep working unchanged. Reading sites should
switch from `err.context` to `err.info`:

```diff
 try {
   await pos.parent.erc20(token).completeWithdraw(burnTxHash);
 } catch (err) {
   if (err instanceof POSBridgeError) {
-    logger.error({ err, context: err.context }, 'withdraw failed');
+    // `info` and `code` are own enumerable properties; any logger that
+    // walks those (pino, winston, Sentry, custom) picks them up directly.
+    logger.error({ err }, 'withdraw failed');
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

## zkEVM bridge users — stay on `@maticnetwork/maticjs`

The legacy `@maticnetwork/maticjs` package shipped both the PoS bridge
and the zkEVM bridge surfaces. **`@polygonlabs/pos-sdk` covers only the
PoS side.** The zkEVM bridge is intentionally not ported.

The zkEVM chain is on a wind-down schedule. Rewriting and shipping a
`@polygonlabs/zkevm-sdk` would create a migration burden on consumers
for capability that goes away when the chain is shut down — they would
update once now and again when the package is sunset. Skipping the
intermediate step is cleaner for everyone.

**If your codebase uses the zkEVM `ZkEvmClient`:** keep
`@maticnetwork/maticjs` installed for those calls until the zkEVM
chain is shut down, then remove the import along with the chain. If
you also use the PoS bridge, both packages can be installed side by
side — they have non-overlapping public surfaces.

```ts
// Before — single legacy package for both bridges:
import { POSClient, ZkEvmClient } from '@maticnetwork/maticjs';

// After — PoS migrated, zkEVM stays on the legacy package:
import { POSClient } from '@polygonlabs/pos-sdk';
import { ZkEvmClient } from '@maticnetwork/maticjs';
```

When the zkEVM chain shuts down: drop `@maticnetwork/maticjs` and the
`ZkEvmClient` calls together.
