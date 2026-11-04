---
'@polygonlabs/maticjs': major
---

Rewrites the Polygon PoS bridge SDK from the ground up. The package moves from the `@maticnetwork` npm scope to `@polygonlabs` — versions up to 3.x remain published as `@maticnetwork/maticjs`; 4.0 onwards ships as `@polygonlabs/maticjs`. The plugin layer is removed; consumers wrap their existing viem / ethers v5 / ethers v6 client with a per-library adapter factory imported from a subpath (`viemAdapter` from `@polygonlabs/maticjs/viem`, etc.) and pass it to `POSClient.init({ parent, child })` — the main entry pulls in no web3 library, so you ship only the one you use. The SDK is fully cross-environment: no `Buffer`, no `node:*` imports, no dynamic imports — it runs unchanged in Node ≥20 and modern browsers. Every numeric value on the public API is native `bigint`. Errors are thrown as `POSBridgeError` (extends `VError`) carrying a discriminator `code` — switch on `error.code` instead of parsing message strings. Contract addresses are fetched dynamically from the published address index with a 1-hour stale-while-revalidate cache, so long-running services pick up Polygon contract redeployments without restart. The `BaseToken → POSToken → ERC20` inheritance chain is gone, replaced by composition over two internal services. The lazy `ITransactionWriteResult` shape is replaced by `TxResult = { hash, confirmed() }` — `await write(...)` resolves on broadcast, `await result.confirmed()` waits for the receipt.

## Breaking changes

- Package scope: `@maticnetwork/maticjs` → `@polygonlabs/maticjs` (same name, new org scope). The `*-web3` and `*-ethers` companion packages no longer exist; choose one of `viem`, `ethers ^5.6.0`, or `ethers ^6` as a peer.
- Plugin removal + per-library adapter factories: `use(Plugin)` is gone. Import the factory for your library from its subpath and pass the result as `parent` / `child`: `import { viemAdapter } from '@polygonlabs/maticjs/viem'` then `POSClient.init({ parent: viemAdapter({ public, wallet }), child: viemAdapter({ ... }) })`. Likewise `ethersV5Adapter` from `/ethers-v5` and `ethersV6Adapter` from `/ethers-v6`. viem and ethers are fully optional peers — importing the SDK never references a library you didn't install.
- bigint everywhere: drop `BN.from` / `BigNumber.from` at consumer call sites. Use `123n` literals or `BigInt(...)` from a string.
- Method renames on the token classes:
  - `withdrawStart` → `startWithdraw`
  - `withdrawExit` → `completeWithdraw`
  - `withdrawExitFaster` → `completeWithdrawFast`
  - `etheriumSha3` → _removed_ — use `Adapter.keccak256` for plain bytes, or your own client's packed-keccak helper
- `parent` / `child` namespaces replace the `isParent: boolean` parameter — `pos.parent.erc20(addr).deposit(...)` instead of `pos.erc20(addr, true).deposit(...)`.
- ETH deposits hoisted to top-level: `pos.depositEther(amount)` and `pos.depositEtherWithGas(amount)` (ETH has no token contract, so they don't fit on `parent.erc20(addr)`).
- TxResult shape: `const result = await pos.parent.erc20(addr).approve(amount); const receipt = await result.confirmed();`. The legacy `result.getTransactionHash()` / `result.getReceipt()` lazy methods are gone.
- Dropped configuration fields: `version`, `log: boolean`, `option.returnTransaction`, `resolution` (UnstoppableDomains), and `defaultConfig.from` (reads carry no sender; a write's `from` is the adapter's signer/account).
- Fast exits: `setProofApi(url)` global mutation → optional `proofGenerationApiUrl` on `POSClient.init` (no default — fast exits stay opt-in; unset throws `PROOF_API_NOT_SET` and payloads build locally).
- Dropped Adapter methods: `signTypedData` (was unused).
- Errors: replace `try/catch (err) { if (err.message.includes('checkpointed')) ... }` with `try/catch (err) { if (err instanceof POSBridgeError) switch (err.code) { case 'BURN_TX_NOT_CHECKPOINTED': ... } }`.

## What stays the same

The bridge protocol itself — predicates, the RootChainManager, exit proofs, the proof API — is unchanged. Existing checkpoints, bridge state, and contract addresses are fully compatible. The migration is entirely on the SDK side.

## New surface

- **Unsigned transactions via `prepareXxx`.** Every public write has a sibling `prepareXxx` method (`prepareApprove`, `prepareDeposit`, `prepareCompleteWithdraw`, `prepareDepositEther`, etc.) that returns `{ to, data, value? }` instead of broadcasting. Use this for Safe / Sequence / account-abstraction bundlers, batched multicall flows, pre-flight inspection, or any path where the SDK should encode the bridge call but a different signer should send it.
- **Bridge helpers exposed on `POSClient`.** Direct access to `pos.buildExitPayload(burnTx, sig, fast?)`, `pos.buildExitPayloads(...)` (all matching logs), `pos.buildExitPayloadOnIndex(...)`, `pos.isCheckpointed(burnTx)`, `pos.isDeposited(depositTx)` (state-sync deposit confirmation), `pos.isWithdrawn(burnTx, sig)`, `pos.isWithdrawnOnIndex(...)`, `pos.getBlockProof(blockNum, range)`, `pos.getPredicateAddress(token)`. Restores the non-token capabilities (`buildMultiplePayloadsForExit`, `isDeposited`) and the `pos.exitUtil.X` access that downstream services relied on for sync block events and custom bridge events. Plasma is not part of 4.0.
- **Reorg-safe checkpoint reads.** Root-block / checkpoint reads default to the `'safe'` block tag (tunable via `rootChainDefaultBlock`), avoiding the reorg race where a proof is built against an un-finalised header.
- **`POSBridgeError` extends `VError`.** A TypeScript-first, browser-friendly port of Joyent's canonical Node `verror` library — same `findCauseByName` / `findCauseByType` / `info` / `fullStack` helpers, zero runtime dependencies. Structured `info` is an own enumerable property so any logger that serializes own properties on Error instances (pino, winston, Sentry, custom) picks it up. The constructor's third arg is renamed `context` → `info` to match the VError convention; positional call sites keep working unchanged.

## Write, confirmation and packaging fixes

- **Writes through the ethers v5 adapter work.** They no longer fail with `cannot override "chainId"`. The expected chain is checked against the signing wallet before broadcast, instead of being passed to ethers as a transaction override.
- **viem private-key writes sign locally.** Writes through the viem adapter with a private-key wallet now sign locally when `from` is the wallet's own address, instead of asking the RPC node to sign.
- **ethers adapters price writes that carry no fee options.**
  - For signers that sign locally (e.g. `Wallet`), the ethers v5 adapter takes the priority fee from the node's `eth_maxPriorityFeePerGas` instead of ethers v5's fixed tip, which is below the minimum Polygon PoS accepts.
  - The ethers v6 adapter uses the higher of the gas-station and node tips, and falls back to the node when the station is unreachable.
  - JSON-RPC and injected wallet signers (`provider.getSigner()`, `BrowserProvider`/`Web3Provider` signers) are left untouched, so the wallet prices the transaction as before.
  - A caller-supplied `maxPriorityFeePerGas` always wins.
  - With ethers v5, writes from a local signer no longer fail when the read provider has no JSON-RPC `send` (for example a `FallbackProvider` from `getDefaultProvider`). The priority-fee lookup falls back to the signer's own provider.
- **Fee-estimation failures are typed.** They are now a `POSBridgeError` coded `FEE_ESTIMATION_FAILED`, with the underlying error as `cause` and `info.method` / `info.chainId`. Pass `maxPriorityFeePerGas` explicitly to skip the lookup.
- **Writes check the signing wallet's chain.** Before broadcasting, writes check which chain the signing wallet is on, and reject with `UNSUPPORTED_NETWORK` if the wallet has been switched to a different network than the one the transaction is for.
- **`confirmed()` only resolves on success.**
  - `TxResult.confirmed()` rejects with a `POSBridgeError` coded `TRANSACTION_REVERTED` when the transaction is mined but reverts, with every adapter. The full receipt is on `err.info.receipt`.
  - A cancelled or replaced transaction rejects with `TRANSACTION_REPLACED`. `info` carries `reason`, `transactionHash`, `replacementHash` and the replacement's `receipt`.
  - A fee-bumped re-send of the same call still counts as the original.
  - With ethers v6, `confirmed()` now settles when the transaction is replaced, instead of waiting forever.
- With ethers v6, back-to-back writes from the same local signer no longer reuse a nonce: the adapter reads the pending nonce directly from the node instead of from ethers' short-lived provider cache.
- Malformed responses from the fast-exit proof API are rejected (falling back to local proof construction) instead of being encoded into the exit payload.
- **`POSBridgeError` JSON.** `POSBridgeError` now serialises to JSON when its `info` contains bigints; they are written as decimal strings.
- **`require()` works.** `require('@polygonlabs/maticjs')` and its subpath entry points now work from CommonJS on Node versions with native `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- Argument checks on token and client methods (such as a missing spender address, calling on the wrong chain, or an oversized batch) now reject the returned promise instead of throwing before it is created, so `.catch()` and `try`/`await` handlers both see them, with the same error code and message.
- Passing an odd-length or non-hex string to an adapter's `keccak256` now throws `POSBridgeError` with code `INVALID_HEX_STRING` instead of a bare `RangeError` from the hashing library.
- ERC-721 `isWithdrawExitedMany` is deprecated: it cannot report per-token exits; call `isWithdrawExitedOnIndex` for each token instead.

See [MIGRATION.md](https://github.com/0xPolygon/matic.js/blob/master/packages/maticjs/MIGRATION.md) for the full upgrade walkthrough with before/after code blocks, including a comprehensive replacement table for every removed API (`signTypedData`, `etheriumSha3`, `encode`, `sendRPCRequest`, etc.).
