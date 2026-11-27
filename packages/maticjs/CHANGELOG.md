# @polygonlabs/maticjs

## 4.1.0

### Minor Changes

- [#503](https://github.com/0xPolygon/matic.js/pull/503) [`d82bf61`](https://github.com/0xPolygon/matic.js/commit/d82bf6171fab9a9d59358731864df4e8da41cfa4) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Add the Plasma bridge at `@polygonlabs/maticjs/plasma`, so ERC-20 tokens, including native POL, can be withdrawn through Plasma with the same viem, ethers v5 or ethers v6 adapters as the PoS bridge.

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
      wallet: createWalletClient({
        account,
        chain: mainnet,
        transport: http(process.env.PARENT_RPC)
      })
    }),
    child: viemAdapter({
      public: createPublicClient({ chain: polygon, transport: http(process.env.CHILD_RPC) }),
      wallet: createWalletClient({
        account,
        chain: polygon,
        transport: http(process.env.CHILD_RPC)
      })
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
  const status = await pol.getWithdrawStatus({
    burnTxHash: burn.hash,
    confirmTxHash: confirm.hash
  });
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

### Patch Changes

- [#504](https://github.com/0xPolygon/matic.js/pull/504) [`b51c7cc`](https://github.com/0xPolygon/matic.js/commit/b51c7cc489a886b5004ab2b556218b3488d899db) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - The slow exit path now uses the proof-generation API's checkpoint lookup when `proofGenerationApiUrl` is set

  The API's `block-included` endpoint returns `start` and `end` as ethers BigNumber JSON (`{"type":"BigNumber","hex":"0x…"}`), which the client rejected as "not a number". Every slow-path exit (`completeWithdraw`, or `buildExitPayload` with `isFast` false) then logged a warning and looked the checkpoint up on-chain instead. The results were correct, but the API never helped. The client now accepts that shape alongside plain numbers and numeric strings. Responses that are genuinely malformed are still rejected, with the same warning and on-chain fallback.

- [#503](https://github.com/0xPolygon/matic.js/pull/503) [`39ea665`](https://github.com/0xPolygon/matic.js/commit/39ea66594a280586d7a0436dd409606b653e0b27) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Passing a full bridge address index as `addresses` to `StakingClient.init` is deprecated and will be removed in the next major version. Pass the three staking addresses (`StakeManager`, `MaticToken`, `PolToken`) instead. Nothing changes in this release: both forms are accepted and behave as before.

## 4.0.0

### Major Changes

- [#476](https://github.com/0xPolygon/matic.js/pull/476) [`b5f6a3c`](https://github.com/0xPolygon/matic.js/commit/b5f6a3ccd634d06dc153353d67870741dee596f5) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Rewrites the Polygon PoS bridge SDK from the ground up. The package moves from the `@maticnetwork` npm scope to `@polygonlabs` — versions up to 3.x remain published as `@maticnetwork/maticjs`; 4.0 onwards ships as `@polygonlabs/maticjs`. The plugin layer is removed; consumers wrap their existing viem / ethers v5 / ethers v6 client with a per-library adapter factory imported from a subpath (`viemAdapter` from `@polygonlabs/maticjs/viem`, etc.) and pass it to `POSClient.init({ parent, child })` — the main entry pulls in no web3 library, so you ship only the one you use. The SDK is fully cross-environment: no `Buffer`, no `node:*` imports, no dynamic imports — it runs unchanged in Node ≥20 and modern browsers. Every numeric value on the public API is native `bigint`. Errors from your wallet, RPC node or client library are rethrown unchanged; conditions the SDK detects itself are named classes extending `VError`, and a public method that hits one rejects with an operation error (such as `ExitError`) whose cause is that condition (such as `BurnTxNotCheckpointedError`) — recognise them with each class's `find` / `has` finders and `isMaticjsError` instead of parsing message strings. Contract addresses are fetched dynamically from the published address index with a 1-hour stale-while-revalidate cache, so long-running services pick up Polygon contract redeployments without restart. The `BaseToken → POSToken → ERC20` inheritance chain is gone, replaced by composition over two internal services. The lazy `ITransactionWriteResult` shape is replaced by `TxResult = { hash, confirmed() }` — `await write(...)` resolves on broadcast, `await result.confirmed()` waits for the receipt.

  ## Breaking changes
  - Requires Node 22.12 or later (tested on Node 22, 24 and 26); Node 20 is end-of-life and no longer tested.
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
  - Fast exits: `setProofApi(url)` global mutation → optional `proofGenerationApiUrl` on `POSClient.init` (no default — fast exits stay opt-in; unset rejects with a `ProofApiNotSetError` cause and payloads build locally).
  - Dropped Adapter methods: `signTypedData` (was unused).
  - Errors: the 3.x `{ message, type }` error objects and their `ERROR_TYPE` strings are replaced by named `Error` classes. Replace `if (err.message.includes('checkpointed'))` or `if (err.type === 'burn_tx_not_checkpointed')` with `if (BurnTxNotCheckpointedError.has(err))`.
    - Exit, checkpoint and deposit status reads return a reason instead of throwing. 3.x `isWithdrawExited` threw "Burn transaction has not been checkpointed as yet"; 4.0 replaces the yes/no predicates with one status read per question: `getWithdrawExitStatus` (and `getWithdrawExitStatusOnIndex`, `getWithdrawExitStatusOnIndices`, `getWithdrawExitStatusMany`) on the tokens, and `getWithdrawStatus`, `getWithdrawStatusOnIndex`, `getCheckpointStatus` and `getDepositStatus` on `POSClient`. Each resolves the answer with a string-literal reason, for example `{ exited: false, reason: 'pending' | 'not-checkpointed' | 'not-exited' }`, and rejects only for invalid input, a transaction that does not exist, or a library failure. 3.x `isWithdrawExited*`, `isWithdrawn*`, `isCheckPointed` and `isDeposited` are removed, with no boolean twin; `isApproved`, `isApprovedAll`, `isExitProcessed` and `isLocked` stay plain booleans.
    - `getDepositStatus` has a third reason, `{ deposited: false, reason: 'delivery-failed', stateId, receiver, record, replayable }`: since the Uburu fork each state-sync delivery runs under a per-record gas limit, and a deposit the child chain cannot process within it is committed as failed, so the tokens stay locked on the parent chain. The SDK reports the condition and cannot prevent it; `record` is `'payload'` for a delivery that failed before Uburu and `'hash'` for one since, which decides the replay call; `replayable` says whether the stored failed record is this deposit's own, not that a replay will succeed. `DepositNotSyncedReason` (exported by 4.0.0-pre.2) is now `DepositNotDeliveredReason` and gains `'delivery-failed'`, so replace the import and give an exhaustive `switch` over it a new case. `pos.replayDeposit(depositTx)` (and `prepareReplayDeposit`) resends the failed delivery from the child-chain signer, choosing the state receiver's replay call by `record`; it rejects with a `DepositNotReplayableError` cause when the deposit is not in a replayable state.
    - For a condition the SDK detects, the thrown error is now an operation error naming the method that failed, so the 3.x `type` string is no longer on the thrown value. It is still on the condition error, verbatim: `BurnTxNotCheckpointedError.find(err)?.type === 'burn_tx_not_checkpointed'`.
    - Wallet, RPC and client-library errors are still rethrown exactly as they came, as in 3.x: the same object, never wrapped and never used as a cause. Check for the wallet's own error first (`err.code === 4001` on the thrown error), then for SDK errors with `isMaticjsError` and the finders.
    - The 3.x type `allowed_on_non_native_token` is never raised: only the zkEVM bridge raised it, and the zkEVM bridge is not part of 4.0.

  ## What stays the same

  The bridge protocol itself — predicates, the RootChainManager, exit proofs, the proof API — is unchanged. Existing checkpoints, bridge state, and contract addresses are fully compatible. The migration is entirely on the SDK side.

  ## New surface
  - **Unsigned transactions via `prepareXxx`.** Every public write has a sibling `prepareXxx` method (`prepareApprove`, `prepareDeposit`, `prepareCompleteWithdraw`, `prepareDepositEther`, etc.) that returns `{ to, data, value? }` instead of broadcasting. Use this for Safe / Sequence / account-abstraction bundlers, batched multicall flows, pre-flight inspection, or any path where the SDK should encode the bridge call but a different signer should send it.
  - **Bridge helpers exposed on `POSClient`.** Direct access to `pos.buildExitPayload(burnTx, sig, fast?)`, `pos.buildExitPayloads(...)` (all matching logs), `pos.buildExitPayloadOnIndex(...)`, `pos.getCheckpointStatus(burnTx)`, `pos.getDepositStatus(depositTx)` (state-sync deposit confirmation, including the `delivery-failed` reason when the child chain cannot process the deposit within the post-Uburu per-record gas limit), `pos.getWithdrawStatus(burnTx, sig)`, `pos.getWithdrawStatusOnIndex(...)`, `pos.getBlockProof(blockNum, range)`, `pos.getPredicateAddress(token)`. Restores the non-token capabilities (`buildMultiplePayloadsForExit`, deposit confirmation via `getDepositStatus`) and the `pos.exitUtil.X` access that downstream services relied on for sync block events and custom bridge events. Plasma is not part of 4.0.
  - **Replay a failed deposit delivery.** `pos.replayDeposit(depositTx, options?)` resends a deposit whose child-chain delivery failed, paying the gas from the child-chain signer, and `pos.prepareReplayDeposit(depositTx, options?)` returns the unsigned `{ to, data }` for a Safe, a bundler or a batch (it reads the chain to build the calldata, unlike the other `prepareXxx` methods). Both take the same `depositTx` as `getDepositStatus` and choose the state receiver's replay call from the status's `record`. A deposit that is not `delivery-failed` with `replayable: true` rejects with `DepositNotReplayableError` (new, under `DepositError`), whose `info.status` is the status the SDK read; a replay the receiving contract rejects reaches you as your client library's own error. `replayFailedStateSyncWithData` and its calling convention were confirmed by the protocol team; the post-Uburu contract source remains unpublished.
  - **Reorg-safe checkpoint reads.** Root-block / checkpoint reads default to the `'safe'` block tag (tunable via `rootChainDefaultBlock`), avoiding the reorg race where a proof is built against an un-finalised header.
  - **SDK errors are errors from the SDK.** Errors from ethers, viem or your RPC transport are rethrown exactly as they came; the SDK never wraps them and never uses them as causes.
  - **Named error classes that extend `VError`.** Every error the SDK raises for a condition it detects is a named class extending a TypeScript-first, browser-friendly port of Joyent's canonical Node `verror` library — same `findCauseByName` / `findCauseByType` / `info` / `fullStack` helpers, zero runtime dependencies. Structured `info` is an own enumerable property, typed per class, so any logger that serializes own properties on Error instances (pino, winston, Sentry, custom) picks it up.
  - **Condition errors** say what went wrong: `BurnTxNotCheckpointedError`, `TransactionRevertedError`, `UnsupportedNetworkError` and the rest. Each one whose condition existed in 3.x carries the 3.x string, verbatim, on `type`.
  - **Operation errors** say which public call failed. A public method wraps each condition it detects in one (`ExitError`, `DepositError`, `ApproveError`, `ConfirmationError`, …), with the condition error as its `cause`. The message names the method and gives the condition's one-line summary, plus the text of the condition's own cause when its message leaves that out, appended as `; root cause: …`.
  - **Typed finders.** Every class has static `find(err)`, which returns the first error in the cause chain with that class's name and typed `info` (or `null`), and `has(err)`. They match by name, so they work across two copies of the package in one bundle and on errors read back from JSON.
  - **`isMaticjsError(err)`** returns whether any error in the cause chain came from the SDK.
  - **`rootCause(err)`** reaches the cause inside an SDK condition: it returns the error at the bottom of the chain, then steps into the raw provider error that ethers keeps on `info.error` or `error`, as many times as it is nested, so on an ethers error you caught it also reaches the node's own `{ code, message }` (ethers v5 over HTTP nests it inside its own `SERVER_ERROR`).

  ## Write, confirmation and packaging fixes
  - **Writes through the ethers v5 adapter work.** They no longer fail with `cannot override "chainId"`. The expected chain is checked against the signing wallet before broadcast, instead of being passed to ethers as a transaction override.
  - **viem private-key writes sign locally.** Writes through the viem adapter with a private-key wallet now sign locally when `from` is the wallet's own address, instead of asking the RPC node to sign.
  - **ethers adapters price writes that carry no fee options.**
    - For signers that sign locally (e.g. `Wallet`), the ethers v5 adapter takes the priority fee from the node's `eth_maxPriorityFeePerGas` instead of ethers v5's fixed tip, which is below the minimum Polygon PoS accepts.
    - The ethers v6 adapter uses the higher of the gas-station and node tips, and falls back to the node when the station is unreachable.
    - JSON-RPC and injected wallet signers (`provider.getSigner()`, `BrowserProvider`/`Web3Provider` signers) are left untouched, so the wallet prices the transaction as before.
    - A caller-supplied `maxPriorityFeePerGas` always wins.
    - With ethers v5, writes from a local signer no longer fail when the read provider has no JSON-RPC `send` (for example a `FallbackProvider` from `getDefaultProvider`). The priority-fee lookup falls back to the signer's own provider.
  - **Unparseable fee lookups are typed.** When the node's `eth_maxPriorityFeePerGas` answer is not a quantity the SDK can parse, or (ethers v5) no JSON-RPC provider is available to ask, the write rejects with a `FeeEstimationFailedError` carrying `info.method` / `info.chainId`. A node error during the lookup is the node's own error, rethrown unchanged. Pass `maxPriorityFeePerGas` explicitly to skip the lookup.
  - **Writes check the signing wallet's chain.** Before broadcasting, writes check which chain the signing wallet is on, and reject with an `UnsupportedNetworkError` cause if the wallet has been switched to a different network than the one the transaction is for.
  - **Bridge writes are pinned to the network's chain ids.** The chain a bridge write is checked against now comes from your `network` (Ethereum `1` and Polygon `137` on mainnet, Sepolia `11155111` and Amoy `80002` on amoy), not from the chain id your RPC reports. A wallet or RPC on any other chain is rejected with an `UnsupportedNetworkError` cause before anything is signed, and the viem adapter signs for the pinned chain. Pass `chainId` in the write options to override it for a fork.
  - **Forks and devnets declare their chain ids.** Pass `chainIds: { parent, child }` to `POSClient.init` to replace the network's pinned ids; they come from your code, never from the RPC, and an RPC on any other chain is still refused.
  - **Approvals only go to predicates in the address index.** `approve`, `approveMax` and the other default-spender approvals now check the predicate the RootChainManager reports against the predicates the address index publishes, including the mintable ERC-20, ERC-721 and ERC-1155 ones, and reject with an `UntrustedPredicateError` cause instead of approving an unknown address. An explicit `spenderAddress` is still yours to choose.
  - **Checkpoint ranges are validated.** The range a checkpoint lookup returns, from the chain or from the proof API, must contain the burn's block and span at most 65,536 blocks. A bad range from the proof API falls back to the on-chain lookup, and a bad on-chain range rejects with a `CheckpointRangeInvalidError` cause. Proof building also refuses a Merkle path deeper than that, with `MerkleTreeDepthExceededError`, instead of allocating for it.
  - **`confirmed()` only resolves on success.**
    - `TxResult.confirmed()` rejects when the transaction is mined but reverts, with every adapter. Under ethers that is ethers' own `CALL_EXCEPTION`, rethrown unchanged with the receipt on it. viem reports no error for a mined revert, so there the SDK detects it and rejects with a `ConfirmationError` caused by `TransactionRevertedError`; the full receipt is on `TransactionRevertedError.find(err)?.info.receipt`.
    - A cancelled or replaced transaction rejects too: with ethers' own `TRANSACTION_REPLACED` under ethers, and with a `TransactionReplacedError` cause under viem, whose `info` carries `reason`, `transactionHash`, `replacementHash` and the replacement's `receipt`.
    - A fee-bumped re-send of the same call still counts as the original.
    - With ethers v6, `confirmed()` now settles when the transaction is replaced, instead of waiting forever.
  - With ethers v6, back-to-back writes from the same local signer no longer reuse a nonce: the adapter reads the pending nonce directly from the node instead of from ethers' short-lived provider cache.
  - Malformed responses from the fast-exit proof API are rejected (falling back to local proof construction) instead of being encoded into the exit payload.
  - `proofGenerationApiUrl` and `addressIndexUrl` may carry their own query string (for example an API key) and a trailing slash; request paths are now resolved against them instead of appended as text; query parameters from the configured base URL are always redacted in error messages and `info`, whatever their name.
  - **Errors serialise to JSON.** Every SDK error serialises to JSON when its `info` contains bigints; they are written as decimal strings.
  - **`require()` works.** `require('@polygonlabs/maticjs')` and its subpath entry points now work from CommonJS through native `require()` of ES modules, which every supported Node runs unflagged, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
  - Argument checks on token and client methods (such as a missing spender address, calling on the wrong chain, or an oversized batch) now reject the returned promise instead of throwing before it is created, so `.catch()` and `try`/`await` handlers both see them, with the same error class and message.
  - Passing an odd-length or non-hex string to an adapter's `keccak256` now throws `InvalidHexStringError` instead of a bare `RangeError` from the hashing library.
  - ERC-721 `isWithdrawExitedMany` is removed: it could not report per-token exits. Use the new `getWithdrawExitStatusOnIndices(burnTxHash, indices)`, which checks many tokens from one burn in a single pass, or `getWithdrawExitStatusOnIndex` per token.
  - Exit-status reads (`getWithdrawStatus`, `getWithdrawExitStatus`, `getWithdrawExitStatusOnIndex` and the new `getWithdrawExitStatusOnIndices`) no longer rebuild the block's receipt trie, cutting each to a handful of RPC calls; building an exit payload still verifies the full proof.
  - Exit payloads are now checked against the block's receipts root before they are returned. If the receipt proof the SDK builds does not reproduce the block's `receiptsRoot`, the call rejects with a `ReceiptsRootMismatchError` cause (block number, block hash and both roots in `info`) instead of returning a payload that would be rejected on-chain after gas is spent. Payloads for valid blocks are unchanged.

  ## Staking

  Validator and delegator staking now ships in this package behind `@polygonlabs/maticjs/staking`, with its own `StakingClient`. The 3.x `@maticnetwork/maticjs-staking` plugin is frozen and has no 4.0 peer. Staking uses a single parent-chain adapter (no `child`), every write returns a `TxResult` and has an unsigned `prepareXxx` sibling, amounts are `bigint`, and both the MATIC and POL token namespaces are available as `staking.matic` and `staking.pol`. Permit delegation is sign-free: `preparePermit` returns the EIP-712 payload, your own wallet signs it, and `splitSignature` feeds `delegateWithPermit`.

  Renames from the 3.x plugin:
  - `delegateAmountPOL` → `delegate({ amount, minSharesToMint })`
  - `stakeForPOL` → `stakeFor({ user, amount, heimdallFee, acceptDelegation, signerPubkey })` — a params object with all five fields required, so a missing field is a compile error
  - `approveMaxForStakingManager` → `approveMaxForStakeManager`
  - `getPermitData` → `preparePermit` + `splitSignature`
  - `client.getConfig(...)` → `getAddresses()`

  Behaviour change since the pre-releases:
  - `stakeManager.unstake` now adds a fixed 250,000 gas on top of its usual estimate-plus-15% gas limit. If a checkpoint advances the epoch between estimation and inclusion, the call writes storage the estimate never saw, and the 15% margin did not cover that: an unstake could run out of gas. The extra gas is refunded when unused, but the sending wallet must hold native balance for the full limit × fee. A `gasLimit` you pass is used exactly as given, and no other write changes.

  Two 3.x names now mean something different, so check every call site:
  - `stakeFor(...)` (MATIC) → `stakeForMatic({ ... })`. In 4.0, `stakeFor` stakes POL. A 3.x positional call no longer compiles, so this one is caught at build time.
  - `validatorShare.withdrawRewards()` now calls the POL variant (`withdrawRewardsPOL`) and pays out POL. The call shape is unchanged, so a 3.x call compiles and runs without error. The MATIC `withdrawRewards` is not ported.

  See [MIGRATION.md](https://github.com/0xPolygon/matic.js/blob/master/packages/maticjs/MIGRATION.md) for the full upgrade walkthrough with before/after code blocks, including a comprehensive replacement table for every removed API (`signTypedData`, `etheriumSha3`, `encode`, `sendRPCRequest`, etc.).

### Patch Changes

- [#476](https://github.com/0xPolygon/matic.js/pull/476) [`b5f6a3c`](https://github.com/0xPolygon/matic.js/commit/b5f6a3ccd634d06dc153353d67870741dee596f5) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Fewer third-party runtime dependencies and a smaller install: a fresh `npm install` of the SDK, without the optional `viem` or `ethers` peers, now brings in 12 packages and about 9.2 MB instead of 22 packages and about 16.2 MB. Produced exit payloads are byte-for-byte unchanged.
  - The legacy `rlp` package is replaced by `@ethereumjs/rlp`, which the Merkle Patricia trie dependency already installs.
  - `ethereum-cryptography` is replaced by `@noble/hashes`, which the Merkle Patricia trie dependency already installs.
  - The concurrency limiter (`p-limit` and its queue, `yocto-queue`) is now bundled verbatim instead of installed, with its MIT attribution in `THIRD_PARTY_NOTICES.md`.
  - Third-party runtime dependencies are pinned to exact versions.
  - Malformed block-proof strings from the optional proof API now throw instead of being partially encoded.

The changelog for versions up to 3.x — published as
`@maticnetwork/maticjs` — lives in that package's history on npm and
in this repository's git history prior to the 4.0 rewrite.
