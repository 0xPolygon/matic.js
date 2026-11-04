# @polygonlabs/maticjs

[![npm version](https://img.shields.io/npm/v/@polygonlabs/maticjs.svg)](https://www.npmjs.com/package/@polygonlabs/maticjs)
[![License: MIT](https://img.shields.io/npm/l/@polygonlabs/maticjs.svg)](LICENSE)

TypeScript SDK for the Polygon PoS bridge. Deposits, withdrawals, and
exit proofs against `RootChainManager` — across ERC-20, ERC-721,
ERC-1155 and native ETH — driven by whichever EVM client library you
already have: `viem`, `ethers v5`, or `ethers v6`.

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
could never actually load. On Node ≥ 20 use `import`; from a CommonJS
project use `await import('@polygonlabs/maticjs')` (or native
`require()` of ES modules, supported unflagged on Node ≥ 20.19).

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
poll. The 0.x lazy `result.getTransactionHash()` / `result.getReceipt()`
pattern is gone; consumers no longer have to remember which awaitable
they are holding.

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
custom bridge events, plasma exits):

```ts
await pos.isCheckpointed(burnTxHash);                    // boolean
await pos.buildExitPayload(burnTxHash, eventSig, false); // exit calldata
await pos.getBlockProof(blockNumber, { start, end });    // Merkle proof
await pos.getPredicateAddress(token);                    // bridge predicate
await pos.isWithdrawn(burnTxHash, eventSig);             // already exited?
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
replacement for the 0.x `contract.method(name, ...args)` accessor; see
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

Coming from `@maticnetwork/maticjs-staking`? See the
[migration guide](./MIGRATION.md#staking-migrating-from-maticnetworkmaticjs-staking)
for the method mapping and the permit flow.

## Errors

Every failure raised by the SDK is a `POSBridgeError` with a stable
discriminator `code`. Switch on `code` rather than parsing message
strings:

```ts
import { POSBridgeError } from '@polygonlabs/maticjs';

try {
  await erc20.completeWithdraw(burnTxHash);
} catch (err) {
  if (err instanceof POSBridgeError) {
    switch (err.code) {
      case 'BURN_TX_NOT_CHECKPOINTED':
        // user-actionable: tell them to wait for the next checkpoint
        break;
      case 'PROOF_API_NOT_SET':
        // configuration: surface the missing `proofGenerationApiUrl` setting
        break;
      // ... TypeScript exhaustiveness-checks every code
    }
  }
  throw err;
}
```

The full code list is the `POSBridgeErrorCode` union exported from
the SDK; see [MIGRATION.md](./MIGRATION.md#error-handling) for a
one-liner per code. Errors whose condition existed in the legacy SDK
also carry the old 0.x string on `err.type`, so switches written
against `@maticnetwork/maticjs` keep matching.

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
