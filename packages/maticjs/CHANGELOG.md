# @maticnetwork/maticjs

## 3.9.12

### Patch Changes

- 2dc5cc7: Surface the real cause when network/ABI metadata fails to load. `HttpRequest` now checks `res.ok` and reports the HTTP status plus a body snippet (and flags non-JSON responses) instead of letting `res.json()` throw a context-free parse error, and `Web3SideChainClient.init` preserves that underlying error — as the message and as `cause` — rather than discarding it and rethrowing a bare `network <x> - <v> is not supported`. A transport or CDN failure (non-2xx, HTML error/challenge page, timeout) is now diagnosable instead of masquerading as an unsupported network.

## 3.9.11

### Patch Changes

- 234f070: Ship `README.md` and `LICENSE` in the published npm package.

  Previous releases were missing both: the package directory
  (`packages/maticjs/`) had neither file, and npm's auto-include only
  looks at the package directory, not the workspace root. Consumers
  running `npm view @maticnetwork/maticjs readme` saw nothing.

  Adds `packages/maticjs/README.md` (consumer-facing, with install,
  docs, source, and support links) and `packages/maticjs/LICENSE`
  (copy of the workspace MIT licence). Both auto-include on publish —
  no `files` field change needed.

## 3.9.10

### Patch Changes

- e332a8f: Republish 3.9.9 as 3.9.10 with the missing `dist/` directory.

  3.9.9's tarball was 3 files / 2.4 KB instead of the usual ~106 files /
  4.2 MB — `dist/` is gitignored and the canonical release flow doesn't
  run a build before `changeset publish`, so the published package
  contained only `package.json`, `MIGRATION.md`, and `license.js`.
  Consumers installing 3.9.9 got a package with no compiled code.

  Fixed by adding `"prepublishOnly": "pnpm run build"` to
  `packages/maticjs/package.json`. `prepublishOnly` is an npm lifecycle
  hook that runs immediately before `npm publish`, so the build always
  runs regardless of which release path (canonical CI, manual local
  publish, etc.) invokes the publish.

  3.9.9 has been deprecated on npm; install 3.9.10 to actually receive
  the canonical RLP encoding fix and `RootChain.findRootBlockFromChild`
  hardening from
  [matic.js#465](https://github.com/0xPolygon/matic.js/pull/465).

## 3.9.9

### Patch Changes

- b424dd0: Harden `RootChain.findRootBlockFromChild` so it cannot return a checkpoint slot that doesn't actually contain the burn block.

  Two related issues, both fixed:
  - The binary search's single-candidate early exit (`start.eq(end)`) accepted the converged slot without verifying its range contained the child block. When a burn block sat past every existing checkpoint, the search would converge on `currentHeaderBlock / 10000` and silently return that slot — producing a proof that embedded an unrelated or non-existent header. On-chain MPT verification then reverted at submission time. The fix verifies `headerStart ≤ child ≤ headerEnd` for the converged candidate and throws `Burn transaction has not been checkpointed as yet` otherwise (matching the existing `isCheckPointed_` guard message). The throw also covers the case where no checkpoint has ever been submitted (`currentHeaderBlock = 0`).
  - `currentHeaderBlock()` and `headerBlocks(slot)` reads inside `findRootBlockFromChild` ignored `client.config.rootChainDefaultBlock`, defaulting to whatever the underlying provider used (effectively `latest`). `getLastChildBlock` already honoured the config. The two reads could therefore observe different chain views, opening a race where `isCheckPointed_` could pass against an un-finalised checkpoint that was reorged out before the proof was submitted on L1. Both reads now use the same block tag.

  The binary-search algorithm has been extracted into `findCheckpointSlot` for direct unit testing. It is plugin-agnostic — it consumes any `BaseBigNumber` and a constructor factory — so it works correctly with whatever BigNumber implementation the active plugin injects (`MaticBigNumber` for `@maticnetwork/maticjs-ethers`, bn.js for the web3 plugin, etc.).

- b424dd0: Fix `ProofUtil.getReceiptBytes` so `cumulativeGasUsed = 0` encodes as the canonical RLP empty byte string (`0x80`) instead of the literal byte `0x00`.

  The previous encoding wrapped the integer field in `BufferUtil.toBuffer` before handing it to `rlp.encode`. For zero, that produced `<Buffer 00>`, which RLP-encodes to the single byte `0x00` — non-canonical. Bor commits `receiptsRoot` using the canonical form, so the leaf hash produced from a buggy proof never matched the root for any block whose `cumulativeGasUsed` was zero. In practice that meant **every exit proof rooted in a Bor system-tx-only block was rejected on-chain** (Plasma `ERC20PredicateBurnOnly`, Portal `MerklePatriciaProof.verify`) with `INVALID_RECEIPT_MERKLE_PROOF`, even though the API returned `200 OK`.

  The fix passes `cumulativeGasUsed` directly to `rlp.encode`, which canonically encodes `0` as `0x80`. Non-zero values are unaffected.

> **Note:** Version `3.9.8` is skipped. An earlier non-canonical
> `changeset publish` from the `chore/monorepo` branch on 2026-03-29
> burned `3.9.8` on npm with a build that does not correspond to any
> release on `master` (since deprecated). The next release after `3.9.7`
> is `3.9.9`.
