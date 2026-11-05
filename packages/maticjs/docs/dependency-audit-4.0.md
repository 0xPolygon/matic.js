# Runtime dependency audit for `@polygonlabs/maticjs` 4.0

## 1. Purpose and scope

`@polygonlabs/maticjs` builds the exit proofs that users submit on-chain to
withdraw funds from the PoS bridge. Every byte of that payload is
consensus-relevant, and every third-party package on the SDK's runtime path is
code that executes in the user's process while those bytes are produced. This
document audits the SDK's declared runtime dependencies before the first 4.0
prerelease: what each one is used for, the facts behind keeping or removing it,
and the commands that reproduce the evidence.

In scope: the five entries in `dependencies` of `packages/maticjs/package.json`.
Out of scope: the optional peer dependencies (`viem`, `ethers`), which are the
consumer's to choose, and development dependencies, which never ship.

The acceptance criterion for any change that follows from this audit is **no
change in the bytes the SDK produces**.

## 2. Method

- **The "carry" rule.** A package counts as carried when it is already
  resolved in the installed production tree as a transitive dependency of a
  direct dependency that is being kept. A carried package may be promoted to a
  direct dependency only if the install afterwards resolves it to the same
  version already in the lockfile, and the set of unique `name@version`
  entries changes only by the removals intended.
- **Zero behaviour change.** Proven by (a) the byte-for-byte exit-payload
  ground-truth tests, which rebuild recorded burn payloads from live mainnet
  reads, (b) the live address-index tests, (c) the packed-tarball smoke on
  Node 20, 22 and 24, and (d) a real-Chromium browser smoke of the bundled
  SDK.
- **Specifier policy.** Every third-party runtime dependency is pinned to an
  exact version; ranges are not used. See [section 2.1](#21-version-pinning)
  for what that does and does not guarantee.
- **Evidence.** Registry facts come from `npm view`, tree and size facts from
  `pnpm list` and the installed package directories. All commands are listed
  in [section 7](#7-reproduce).

### 2.1 Version pinning

Policy: every third-party runtime dependency is pinned to an exact version;
ranges are not used. The three direct third-party dependencies are
`@ethereumjs/mpt` 10.1.2, `@ethereumjs/rlp` 10.1.2 and `@noble/hashes` 2.2.0.
A pinned dependency that the trie also carries must move together with
`@ethereumjs/mpt`.

The policy has limits:

- An exact pin freezes the direct dependency only. The trie's own dependencies
  are declared with ranges, so a fresh install can resolve newer transitive
  versions than the ones audited here. A fresh install of the packed tarball
  resolved `@ethereumjs/util` 10.1.3 and `@noble/curves` 2.4.0, where the
  lockfile holds 10.1.2 and 2.2.0.
- A pinned version can coexist with a newer copy required by a transitive
  dependency. The same fresh install holds two copies of `@ethereumjs/rlp`
  (10.1.2, the pin, and 10.1.3, required by `@ethereumjs/util`) and two of
  `@noble/hashes` (2.2.0, the pin, and 2.4.0, required by `@noble/curves`).
- The first-party `@polygonlabs/verror` keeps a caret range; the policy covers
  third-party packages.

This trade-off is under review.

## 3. Dependencies

### 3.1 `@ethereumjs/mpt`

- **Declared**: `^10.1.2`; resolved 10.1.2. Now pinned to exactly `10.1.2`
  under the specifier policy in [section 2](#2-method); the resolved version
  is unchanged.
- **Imported at**: `src/utils/proof_util.ts:5`;
  `tests/proof-util-receipt-bytes.test.ts:30`.
- **Symbols used**: `MerklePatriciaTrie` (constructor with default options,
  `put`, `findPath`, and node `.raw()` on the returned stack). `root()` is not
  called; see [section 6.1](#61-follow-up-review-trie-subtree-and-supply-chain-posture).
- **Why needed**: the SDK builds a real Merkle Patricia trie of block receipts
  to produce the receipt proof. Re-implementing a trie is outside a
  zero-behaviour-change effort.
- **Transitive footprint (BEFORE)**: `@ethereumjs/rlp@10.1.2`,
  `@ethereumjs/util@10.1.2` (which brings `@noble/curves@2.2.0` and
  `@noble/hashes@2.2.0`), `@noble/hashes@2.2.0`, `debug@4.4.3` (`ms@2.1.3`),
  `lru-cache@11.0.2`.
- **Registry facts (queried 2026-11-04)**: installed 10.1.2 published
  2026-05-29; latest 10.1.3 published 2026-08-21; licence MPL-2.0; no
  provenance attestation on the installed version.
- **Decision: kept.** The SDK needs a real Merkle Patricia trie, and
  re-implementing one is outside a zero-behaviour-change effort. The
  specifier is pinned to `10.1.2` (see [section 2.1](#21-version-pinning)).
  Its transitive footprint is now the largest remaining third-party surface
  (`@ethereumjs/util` about 966 KB and `@noble/curves@2.2.0` about 1,831 KB
  on disk), and it will be re-reviewed during 4.x.
- **Evidence**: `npm view @ethereumjs/mpt version time license dist.attestations --json`;
  `pnpm --filter @polygonlabs/maticjs why @ethereumjs/mpt --prod`.

### 3.2 `ethereum-cryptography`

- **Declared**: `^2.2.1`; resolved 2.2.1.
- **Imported at**: `src/utils/bytes.ts:21` (`bytesToHex`, `concatBytes`,
  `equalsBytes`, `hexToBytes`, `utf8ToBytes`); `src/utils/keccak.ts:1`
  (`keccak224`, `keccak256`, `keccak384`, `keccak512`); `src/adapters/viem.ts:3-4`,
  `src/adapters/ethers-v5.ts:3-4`, `src/adapters/ethers-v6.ts:10-11`
  (`keccak256`, `bytesToHex`, `hexToBytes`);
  `tests/proof-util-receipt-bytes.test.ts:31` (`bytesToHex`).
- **Why needed / not needed**: the package is a thin wrapper over
  `@noble/hashes`. The SDK uses only keccak and five byte helpers, all of which
  `@noble/hashes` already provides, and `@noble/hashes@2.2.0` is already
  carried by `@ethereumjs/mpt`. `equalsBytes` is re-exported at
  `src/utils/bytes.ts:21-23` but used nowhere else in `src/` or `tests/`.
- **Transitive footprint (BEFORE)**: `@noble/curves@1.4.2`
  (`@noble/hashes@1.4.0`), `@noble/hashes@1.4.0`, `@scure/bip32@1.4.0`,
  `@scure/bip39@1.3.0`, `@scure/base@1.1.9`: six packages in all.
- **Registry facts (queried 2026-11-04)**: installed 2.2.1 published
  2024-07-01; latest 3.2.0 published 2025-04-25; maintainers are the library's
  two authors; licence MIT; no provenance attestation on 2.2.1 (3.2.0 has one).
  `@noble/hashes` 2.2.0 (published 2026-04-11) and 1.4.0 (2024-03-14) both
  carry SLSA provenance; latest is 2.4.0 (2026-08-27).
- **Decision: removed; keccak and the byte helpers now come from
  `@noble/hashes` 2.x, already resolved via the trie.** `@noble/hashes` is now
  a direct dependency pinned to exactly `2.2.0` (see the specifier policy in
  [section 2](#2-method)); the install resolves it to the same 2.2.0 that
  `@ethereumjs/mpt` already installed, and adds no package. Its pin must move
  together with `@ethereumjs/mpt`, which declares `@noble/hashes ^2.0.1`.
  `src/utils/keccak.ts` and the three adapters import `keccak_224`,
  `keccak_256`, `keccak_384` and `keccak_512` from `@noble/hashes/sha3.js`;
  `src/utils/bytes.ts` imports `bytesToHex`, `concatBytes`, `hexToBytes` and
  `utf8ToBytes` from `@noble/hashes/utils.js` (the 2.x `exports` map requires
  the `.js` subpath). The adapters now take `bytesToHex` and `hexToBytes` from
  `src/utils/bytes.ts` instead of importing them from the library directly.
  The unused `equalsBytes` re-export was dropped; `src/utils/bytes.ts` is not
  part of the package's public exports.
- **Helper-by-helper equivalence** (the installed sources of
  `ethereum-cryptography@2.2.1`, `@noble/hashes@1.4.0` and
  `@noble/hashes@2.2.0`, compared function by function):
  1. **keccak.** The old `keccak224/256/384/512` were `wrapHash(keccak_*)`:
     assert the input is a `Uint8Array`, then call the noble function. The
     noble 2.x functions are the same sponge with the same parameters and
     check their input themselves. Both versions reject a string: the old
     wrapper's check ran first, and 2.x rejects any non-`Uint8Array`. No SDK
     path can hand a string to the hash: `Keccak.keccak` throws its own
     `POSBridgeError` for any non-`Uint8Array` before hashing, and each
     adapter's `keccak256` converts a string to bytes with `hexToBytes`
     first.
  2. **`bytesToHex`, `concatBytes`, `utf8ToBytes`.** The old package
     re-exported the noble 1.4.0 functions unchanged. The 2.2.0 functions
     produce the same output for every valid input: unprefixed lowercase hex,
     a freshly allocated concatenation, and UTF-8 bytes.
  3. **`hexToBytes`.** The old export was a wrapper that strips one leading
     lowercase `0x` and then calls noble. `src/utils/bytes.ts` now defines the
     same wrapper over the 2.2.0 function, so `0x` stripping is kept (an
     uppercase `0X` is still not stripped). Both noble versions accept upper-
     and lowercase digits and reject odd-length input and non-hex characters.
  4. **Where 2.2.0 differs, and why it does not reach the SDK's output.**
     (a) Invalid input throws `TypeError` or `RangeError` with different
     message text where 1.4.0 threw a plain `Error`. Both are `Error`
     subclasses, and no SDK code catches these errors or inspects their
     messages. The only public path to them is a malformed hex string passed
     to an adapter's `keccak256`, which threw before and still throws.
     (b) 2.2.0 uses the `Uint8Array.prototype.toHex` and `Uint8Array.fromHex`
     built-ins when the runtime has them (current Chromium does; Node 20.20,
     22.23 and 24.16 do not). The built-ins give the same bytes and the same
     lowercase hex, and also reject odd-length or non-hex input.
     (c) 2.2.0's byte check is stricter about objects that only look like a
     `Uint8Array` from another realm; every SDK caller passes a real
     `Uint8Array`.
  5. **`@ethereumjs/util` was considered and rejected** as the source of the
     byte helpers. Its `bytesToHex` returns a `0x`-prefixed string and its
     `hexToBytes` throws on unprefixed input, which is the opposite of what
     the SDK's call sites expect.
- **Engines**: `@noble/hashes@2.2.0` declares `engines.node >= 20.19.0`. That
  requirement was already in the SDK's install tree through the trie's own
  dependency on `@noble/hashes` 2.x, so this change adds no new constraint.
- **Contract test**: `tests/unit/bytes-helpers.test.ts`, 39 cases, written and
  passing against the old implementation before the swap. It pins, as literal
  values: `bytesToHex` (empty, `0x00`, `0xff`, 32 bytes, a subarray view);
  `hexToBytes` (empty, mixed case, `0x` stripping, `0X` and doubled-prefix
  rejection, odd-length and non-hex rejection, round trip); `concatBytes` with
  zero, one and three arrays; `utf8ToBytes('matic-bor-receipt-')`;
  `compareBytes`; `setLengthLeft`; `Keccak.keccak` at 224, 256, 384 and 512
  bits on the empty input and on `"foo"`; `Keccak.keccak256` on a 1,000-byte
  input and on a subarray view; `Keccak`'s `POSBridgeError` for a string and
  for an unsupported width; and each adapter's `keccak256` on bytes, `0x`,
  `0X`, unprefixed, uppercase-digit and doubled-prefix hex strings, the empty
  input and the 1,000-byte input.
- **Tree delta**: unique production packages (optional peers included) 39 →
  33. Removed: `ethereum-cryptography@2.2.1`, `@noble/hashes@1.4.0`,
  `@noble/curves@1.4.2`, `@scure/bip32@1.4.0`, `@scure/bip39@1.3.0`,
  `@scure/base@1.1.9`. Nothing was added.
- **On-disk delta**: the six removed packages total 2,920,457 bytes
  (2,852 KB) under `node_modules/.pnpm`, measured the same way as
  [section 4.2](#42-on-disk-size): `@noble/curves@1.4.2` 1,498,218,
  `@noble/hashes@1.4.0` 772,880, `@scure/bip39@1.3.0` 373,933,
  `@scure/base@1.1.9` 132,979, `ethereum-cryptography@2.2.1` 83,700,
  `@scure/bip32@1.4.0` 58,747.
- **Evidence**: `npm view ethereum-cryptography version time dist.attestations --json`;
  `npm view @noble/hashes time dist.attestations --json`;
  `pnpm --filter @polygonlabs/maticjs why @noble/hashes --prod`.

### 3.3 `p-limit`

- **Declared**: `^6.0.0`; resolved 6.2.0.
- **Imported at**: `src/internal/concurrency.ts:1`.
- **Symbols used**: the default export, called as `pLimit(limit)` and then
  `gate(() => fn(item))` (`src/internal/concurrency.ts:24-25`). None of
  `activeCount`, `pendingCount`, `clearQueue`, the `concurrency` setter,
  `limitFunction` or argument pass-through is used.
- **Why needed / not needed**: the SDK needs a small concurrency gate. The
  implementation is about 2.5 KB of MIT-licensed JavaScript plus a 1.6 KB
  dependency, small enough to own.
- **Transitive footprint (BEFORE)**: `yocto-queue@1.2.2`.
- **Registry facts (queried 2026-11-04)**: installed 6.2.0 published
  2024-12-19; latest 7.3.3 published 2026-09-18; `yocto-queue@1.2.2`
  published 2025-11-11 (also its latest); licence MIT for both; no provenance
  attestation on either installed version.
- **Decision: vendored verbatim with attribution (plus its only dependency
  `yocto-queue`).** `p-limit` is no longer a dependency. Its `index.js` and
  `index.d.ts` are copied to `src/vendor/p-limit/`, and `yocto-queue`'s to
  `src/vendor/yocto-queue/`. `src/internal/concurrency.ts` imports the copy
  (`../vendor/p-limit/index.js`); the call site is unchanged.
- **What "verbatim" means here**: below a `/*! ... */` attribution header,
  each `index.js` is byte-identical to the published file, except that
  p-limit's one import line `import Queue from 'yocto-queue';` now reads
  `import Queue from '../yocto-queue/index.js';`. The `index.d.ts` files are
  unchanged copies, and TypeScript types the `.js` import through them. The
  copies are excluded from ESLint and Prettier so tooling never rewrites them.
- **Upstream files** (as published; SHA-256 of the installed copy):

  | File | Bytes | SHA-256 |
  | --- | --- | --- |
  | `p-limit@6.2.0/index.js` | 2,510 | `4c87c6def171663d055c973f0afad6b85012483d5d3ddd8c17d3763c77e90279` |
  | `p-limit@6.2.0/index.d.ts` | | `98af2800b73d30adba3f338506b87e1329bcab2eb61b6cc19587bab8e2c3d9ae` |
  | `yocto-queue@1.2.2/index.js` | 1,587 | `2eabf3096793c43934ef127fb50238dcba93074fb54f943fc62aeab616769dfc` |
  | `yocto-queue@1.2.2/index.d.ts` | | `a760662b79da8ff47d9152d25b5641491b036a3762c3cd94645380c9f97288e7` |

- **Attribution**: both packages are MIT-licensed by the same author. The
  shipped attribution of record is `THIRD_PARTY_NOTICES.md` at the package
  root, which is listed in `files` and appears in the `npm pack` listing; the
  README's licence section points to it. Each vendored `index.js` also carries
  the package name, version, author, upstream URL, upstream SHA-256 and full
  MIT text in its `/*! ... */` header.
- **Legal comments in `dist/`**: the build keeps both `/*! ... */` headers in
  full. esbuild (through tsup) moves them to the end of `dist/index.js`, where
  `grep -c "sindresorhus" packages/maticjs/dist/index.js` counts 6. No other
  output file contains them.
- **Size**: the bundled limiter adds about 2.9 KB of code to `dist/index.js`,
  plus about 3.0 KB for the two licence headers: `dist/index.js` grows from
  120,182 to 126,020 bytes. The packed tarball grows from 183,846 to 190,839
  bytes (26 files instead of 25; the new file is `THIRD_PARTY_NOTICES.md`).
  Consumers no longer install the two packages.
- **Behaviour test**: `tests/unit/vendor-p-limit.test.ts`, 12 cases, written
  and passing against the published `p-limit@6.2.0` before the copy, then
  pointed at the vendored copy with every expectation unchanged. It pins: the
  `TypeError` and message for a concurrency of `0`, `-1`, `1.5` and `'2'`;
  acceptance of `Infinity`; at most 2 tasks in flight out of 10, with results
  in input order; FIFO start order; a synchronous throw becoming a rejection
  without stopping later tasks; a rejected task freeing its slot;
  `activeCount` and `pendingCount` before, during and after a run; argument
  pass-through; and `clearQueue()` leaving dropped tasks unsettled. It also
  re-runs the three `withConcurrency` expectations through the SDK wrapper.
- **Tree delta**: unique production packages (optional peers included) 33 →
  31. Removed: `p-limit@6.2.0`, `yocto-queue@1.2.2`. Nothing was added.
- **Evidence**: `npm view p-limit version time license --json`;
  `npm view yocto-queue version time license --json`;
  `pnpm --filter @polygonlabs/maticjs why p-limit --prod`.

### 3.4 `rlp`

- **Declared**: `^3.0.0`; resolved 3.0.0.
- **Imported at**: `src/internal/pos-bridge-helpers.ts:37` (`rlp.encode` at
  `:820`, `:828`); `src/utils/proof_util.ts:6` (`rlp.encode` at `:248`, `:254`,
  `:299`, `:328`; `rlp.decode` at `:285`);
  `tests/proof-util-receipt-bytes.test.ts:32`.
- **Symbols used**: the default export `{ encode, decode }`.
- **Why needed / not needed**: RLP encoding is required. The `rlp` package is
  the legacy distribution of an algorithm that `@ethereumjs/rlp@10.1.2`
  continues, and that package is already installed by `@ethereumjs/mpt`.
- **Transitive footprint (BEFORE)**: none.
- **Registry facts (queried 2026-11-04)**: installed 3.0.0 published
  2022-01-25, which is also the latest release (a 4.0.0 beta of 2022-07-17 was
  never released); licence MPL-2.0; no provenance attestation.
  `@ethereumjs/rlp` 10.1.2 published 2026-05-29, latest 10.1.3 published
  2026-08-21; licence MPL-2.0; no provenance attestation on 10.1.2.
- **Decision: replaced by `@ethereumjs/rlp` (already resolved via the trie).**
  `@ethereumjs/rlp` is now a direct dependency pinned to exactly `10.1.2`
  (see the specifier policy in [section 2](#2-method)); the install resolves
  it to the same 10.1.2 the trie already installed, and
  `rlp@3.0.0` is gone. Both import sites now use the named export
  `{ RLP }` and call `RLP.encode` / `RLP.decode`; the call sites and their
  arguments are unchanged.
- **Source-level differences** (`src/index.ts` of both packages, compared
  line by line): the `encode`, `_decode`, `encodeLength`, `decodeLength`,
  `toBytes` and `numberToHex` logic is the same. The differences are:
  1. errors are `EthereumJSError` instances instead of `Error`, with the same
     message text for every RLP error;
  2. the internal hex parser checks each character instead of using
     `parseInt`. A `0x` string containing non-hex characters now throws
     where the legacy parser silently kept a valid prefix (`'0x1g'`, `'0x+1'`
     and `'0x 1'` encoded as `0x01`, `'0x-1'` as `0x81ff`, `'0x12 '` as
     `0x820102`). In the other direction, the parser strips a `0x` itself
     after `toBytes` has already stripped one, so a doubled prefix is now
     accepted where the legacy parser threw: `'0x0x12'` encodes as `0x12` and
     `'0x0x'` as `0x80`;
  3. `decode` returns empty bytes only for `undefined`, `null` or empty input,
     and throws for other falsy values such as `0`, where the legacy package
     returned empty bytes;
  4. `decode(input, true)` copies the remainder instead of returning a view;
  5. the API is the named exports `encode`, `decode` and `RLP` instead of a
     default export.
- **Reachability of those differences**: (1) no SDK code catches RLP errors.
  (2) every string the SDK encodes is produced by its own `bufferToHex`
  (always well-formed lowercase hex) except the block proof returned by the
  optional proof-generation API. The only path to either half of (2) is
  therefore a malformed response from that external API: garbage characters
  now throw, and a doubled `0x` prefix is now accepted. Well-formed input
  encodes byte-identically.
  (3) the SDK decodes only a trie leaf value, which is always a `Uint8Array`.
  (4) stream decoding is not used. (5) only affects the import line.
- **Differential test**: `tests/unit/rlp-equivalence.test.ts`, 127 cases. It
  first ran with both packages installed and asserted identical encode bytes
  and identical decode structure for every input shape the SDK encodes:
  numbers and bigints at the single-byte, short and long boundaries, `null`,
  hex strings (empty, odd length, upper case, leading zeros, 20, 32, 256 and
  1,000 bytes), non-hex strings, byte arrays across the 55/56-byte boundary,
  receipt tuples, the ten-element exit-payload tuple, receipt-trie proof
  stacks built through `ProofUtil.getReceiptProof`, and the three recorded
  mainnet exit payloads re-encoded from SDK-shaped inputs. Both packages
  rejected nine malformed encodings with identical messages. Shapes that only
  malformed RPC or proof-API data can produce were added afterwards, with the
  legacy output computed from the published `rlp@3.0.0` source: `NaN`
  (encodes as `0x80` in both), numbers above 2^53 (identical), a negative
  number (both throw the same message), and the extra proof strings listed
  under (2) above. The legacy
  output is kept in the file as literal fixtures, so it remains a regression
  guard; the divergent inputs above are pinned as known differences.
- **Tree delta**: unique production packages (optional peers included) 40 →
  39; the only removal is `rlp@3.0.0`.
- **Evidence**: `npm view rlp version time license --json`;
  `npm view @ethereumjs/rlp version time license --json`;
  `pnpm --filter @polygonlabs/maticjs why @ethereumjs/rlp --prod`.

### 3.5 `@polygonlabs/verror`

First-party error-wrapping package, imported at `src/errors.ts:1`, with no
dependencies of its own. It is out of scope for this audit.

## 4. BEFORE measurements

Measured on 2026-11-04 after `pnpm install --frozen-lockfile`.

### 4.1 Production dependency tree

`pnpm --filter @polygonlabs/maticjs list --prod --depth Infinity` reports
**63 packages**; the JSON form yields **40 unique `name@version`** entries.
That includes the optional peers `viem@2.54.0` and `ethers@6.17.0`, which pnpm
installs in the workspace. The SDK-owned subtree, meaning everything reachable
from the five declared dependencies, is:

```text
@ethereumjs/mpt@10.1.2
├── @ethereumjs/rlp@10.1.2
├── @ethereumjs/util@10.1.2 (→ @ethereumjs/rlp@10.1.2, @noble/curves@2.2.0, @noble/hashes@2.2.0)
├── @noble/hashes@2.2.0
├── debug@4.4.3 (→ ms@2.1.3)
└── lru-cache@11.0.2
@polygonlabs/verror@1.1.0 (no dependencies)
ethereum-cryptography@2.2.1
├── @noble/curves@1.4.2 (→ @noble/hashes@1.4.0)
├── @noble/hashes@1.4.0
├── @scure/bip32@1.4.0 (→ @scure/base@1.1.9)
└── @scure/bip39@1.3.0 (→ @scure/base@1.1.9)
p-limit@6.2.0
└── yocto-queue@1.2.2
rlp@3.0.0 (no dependencies)
```

That is 18 unique packages (17 third-party plus `@polygonlabs/verror`).

### 4.2 On-disk size

Summed file sizes of the 18 packages above under `node_modules/.pnpm`
(excluding nested `node_modules`): **8,363 KB**. Largest: `@noble/curves@2.2.0`
1,831 KB, `@noble/curves@1.4.2` 1,463 KB, `@ethereumjs/util` 966 KB,
`@noble/hashes@2.2.0` 869 KB, `lru-cache` 789 KB, `@noble/hashes@1.4.0` 755 KB.

### 4.3 Packed tarball

`cd packages/maticjs && pnpm run build && npm pack --dry-run --json`:
**25 files, 183,846 bytes packed, 1,167,774 bytes unpacked.** Files outside
`dist/`: `CHANGELOG.md`, `LICENSE`, `MIGRATION.md`, `README.md`, `package.json`.
`dist/` contains no `/*! ... */` legal comments.

### 4.4 Test suite

`pnpm --filter @polygonlabs/maticjs test`: **Test Files 19 passed | 10 skipped
(29); Tests 121 passed | 33 skipped (154)**; 0 failed. The passing set includes
the live address-index tests (both networks) and the three byte-for-byte
exit-payload ground-truth tests (ERC-20, ERC-721, ERC-1155). The 33 skipped
tests are credential-gated integration tests.

### 4.5 Licences

`pnpm --filter @polygonlabs/maticjs licenses list --prod`:

| Licence | Packages |
| --- | --- |
| MIT | `@adraffy/ens-normalize`, `@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `@scure/base`, `@scure/bip32`, `@scure/bip39`, `@types/node`, `abitype`, `aes-js`, `debug`, `ethereum-cryptography`, `ethers`, `eventemitter3`, `isows`, `ms`, `ox`, `p-limit`, `undici-types`, `viem`, `ws`, `yocto-queue` |
| MPL-2.0 | `@ethereumjs/mpt`, `@ethereumjs/rlp`, `@ethereumjs/util`, `rlp` |
| ISC | `lru-cache` |
| 0BSD | `tslib` (via `ethers`) |
| Apache-2.0 | `typescript` (via the `viem` peer) |
| Unknown | `@polygonlabs/verror` (first-party; no licence field in its published metadata) |

### 4.6 Fresh npm install of the packed tarball (BEFORE)

The lockfile view above is what the workspace installs. A consumer who runs
`npm install <tarball>` gets a fresh resolution that ignores the lockfile, so
the same numbers were measured that way as well. The BEFORE tarball was built
from the commit this work started from.

Method, for both BEFORE and AFTER: `pnpm pack` the built SDK, then in an empty
directory run `npm init -y` and
`npm install --legacy-peer-deps --no-audit --no-fund <tarball>`. The optional
peers (`viem`, `ethers`) are deliberately not installed:
`--legacy-peer-deps` stops npm 7+ from installing peers automatically, so the
result is the SDK's own closure. The count is `npm ls --all --parseable`
minus the root line; the size is `du -sk node_modules`.

- Installed packages: **22** (the SDK itself plus 21 dependencies: 18 unique
  `name@version` entries and 3 nested copies of a version already present).
- `node_modules` size: **16,212 KB** (including the SDK's own 1,196 KB).
- Duplicates (two versions of one name): `@noble/curves` 1.4.2 and 2.4.0;
  `@noble/hashes` 1.4.0 and 2.4.0.
- Resolution note: the BEFORE specifiers were carets, so a fresh install took
  the newest in-range versions (`@ethereumjs/mpt` 10.1.3, `@ethereumjs/util`
  10.1.3, `@noble/curves` 2.4.0, `@noble/hashes` 2.4.0), which differ from the
  lockfile's.

```text
@polygonlabs/maticjs@3.9.13
├─┬ @ethereumjs/mpt@10.1.3
│ ├── @ethereumjs/rlp@10.1.3
│ ├─┬ @ethereumjs/util@10.1.3
│ │ ├── @ethereumjs/rlp@10.1.3 deduped
│ │ ├─┬ @noble/curves@2.4.0
│ │ │ └── @noble/hashes@2.4.0 deduped
│ │ └── @noble/hashes@2.4.0 deduped
│ ├── @noble/hashes@2.4.0
│ ├─┬ debug@4.4.3
│ │ └── ms@2.1.3
│ └── lru-cache@11.0.2
├── @polygonlabs/verror@1.2.0
├─┬ ethereum-cryptography@2.2.1
│ ├─┬ @noble/curves@1.4.2
│ │ └── @noble/hashes@1.4.0 deduped
│ ├── @noble/hashes@1.4.0
│ ├─┬ @scure/bip32@1.4.0
│ │ ├─┬ @noble/curves@1.4.2
│ │ │ └── @noble/hashes@1.4.0 deduped
│ │ ├── @noble/hashes@1.4.0
│ │ └── @scure/base@1.1.9
│ └─┬ @scure/bip39@1.3.0
│   ├── @noble/hashes@1.4.0
│   └── @scure/base@1.1.9 deduped
├── UNMET OPTIONAL DEPENDENCY ethers@^5.6.0 || ^6.0.0
├─┬ p-limit@6.2.0
│ └── yocto-queue@1.2.2
├── rlp@3.0.0
└── UNMET OPTIONAL DEPENDENCY viem@^2.0.0
```

## 5. AFTER measurements

Measured on 2026-11-04 with the same commands as section 4. Two views are
given because they answer different questions: the lockfile view is what the
workspace installs, and the fresh npm consumer view is what a plain consumer
gets.

### 5.1 Lockfile / workspace view

`pnpm --filter @polygonlabs/maticjs list --prod --depth Infinity` reports
**51 packages** (BEFORE: 63); the JSON form yields **31 unique `name@version`**
entries (BEFORE: 40), again including the optional peers `viem@2.54.0` and
`ethers@6.17.0`. The SDK-owned subtree is 9 unique packages (BEFORE: 18):

```text
@ethereumjs/mpt@10.1.2
├── @ethereumjs/rlp@10.1.2
├── @ethereumjs/util@10.1.2 (→ @ethereumjs/rlp@10.1.2, @noble/curves@2.2.0, @noble/hashes@2.2.0)
├── @noble/hashes@2.2.0
├── debug@4.4.3 (→ ms@2.1.3)
└── lru-cache@11.0.2
@ethereumjs/rlp@10.1.2
@noble/hashes@2.2.0
@polygonlabs/verror@1.1.0 (no dependencies)
```

- **On-disk size** of those 9 packages, measured as in
  [section 4.2](#42-on-disk-size): **5,443 KB** (BEFORE: 8,363 KB).
- **Packed tarball** (`npm pack --dry-run --json`): **26 files, 190,839 bytes
  packed, 1,189,127 bytes unpacked** (BEFORE: 25 files, 183,846 and
  1,167,774). The tarball is larger because it now carries the vendored
  limiter and `THIRD_PARTY_NOTICES.md`; what consumers install is smaller.
- **Tests**: `pnpm --filter @polygonlabs/maticjs test`: Test Files 22 passed |
  10 skipped (32); **Tests 299 passed | 33 skipped (332)**; 0 failed (BEFORE:
  121 passed | 33 skipped). The additions are the contract, differential and
  vendoring tests described in section 3. The live address-index tests and the
  three byte-for-byte exit-payload ground-truth tests pass.
- **Licences** (`pnpm --filter @polygonlabs/maticjs licenses list --prod`):

  | Licence | Packages |
  | --- | --- |
  | MIT | `@adraffy/ens-normalize`, `@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `@scure/base`, `@scure/bip32`, `@scure/bip39`, `@types/node`, `abitype`, `aes-js`, `debug`, `ethers`, `eventemitter3`, `isows`, `ms`, `ox`, `undici-types`, `viem`, `ws` |
  | MPL-2.0 | `@ethereumjs/mpt`, `@ethereumjs/rlp`, `@ethereumjs/util` |
  | ISC | `lru-cache` |
  | 0BSD | `tslib` (via `ethers`) |
  | Apache-2.0 | `typescript` (via the `viem` peer) |
  | Unknown | `@polygonlabs/verror` (first-party; no licence field in its published metadata) |

  No new row and no new licence family appeared. The vendored limiter is MIT
  and is covered by `THIRD_PARTY_NOTICES.md`.

### 5.2 Fresh npm consumer view

Same method as [section 4.6](#46-fresh-npm-install-of-the-packed-tarball-before)
(optional peers not installed, `--legacy-peer-deps`).

- Installed packages: **12** (the SDK itself plus 11 dependencies, all unique
  `name@version`). BEFORE: 22 (the SDK plus 21).
- `node_modules` size: **9,152 KB** (including the SDK's own 1,216 KB).
  BEFORE: 16,212 KB.
- Duplicates (two versions of one name): `@ethereumjs/rlp` 10.1.2 and 10.1.3;
  `@noble/hashes` 2.2.0 and 2.4.0. These come from the exact pins coexisting
  with the newer versions the trie's own dependencies resolve to, as
  described in [section 2.1](#21-version-pinning).
- The two views differ (9 unique packages by lockfile, 11 installed on a
  fresh install) because the fresh install resolves the trie's ranged
  dependencies to newer versions and so adds the two second copies above.

```text
@polygonlabs/maticjs@3.9.13
├─┬ @ethereumjs/mpt@10.1.2
│ ├── @ethereumjs/rlp@10.1.2 deduped
│ ├─┬ @ethereumjs/util@10.1.3
│ │ ├── @ethereumjs/rlp@10.1.3
│ │ ├─┬ @noble/curves@2.4.0
│ │ │ └── @noble/hashes@2.4.0
│ │ └── @noble/hashes@2.2.0 deduped
│ ├── @noble/hashes@2.2.0 deduped
│ ├─┬ debug@4.4.3
│ │ └── ms@2.1.3
│ └── lru-cache@11.0.2
├── @ethereumjs/rlp@10.1.2
├── @noble/hashes@2.2.0
├── @polygonlabs/verror@1.2.0
├── UNMET OPTIONAL DEPENDENCY ethers@^5.6.0 || ^6.0.0
└── UNMET OPTIONAL DEPENDENCY viem@^2.0.0
```

### 5.3 Usage smoke against the packed tarball

The packed tarball was installed into a fresh npm consumer together with
`viem@^2` and driven with live reads: it rebuilt the three recorded exit
payloads (ERC-20, ERC-721, ERC-1155) and compared them with the recorded bytes,
checked checkpointing, and resolved the live address index for both networks.
Summary lines:

```text
Running node v20.20.2 (npm v10.8.2)
payload match: erc20 erc721 erc1155
checkpointed: true
mainnet addresses: RootChainManager=0xA0c68C638235ee32657e8f720a23ceC1bFc77C77 keys=8
amoy addresses: RootChainManager=0x34F5A25B627f50Bb3f5cAb72807c4D4F405a9232 keys=7
(identical lines under v22.23.4 and v24.16.0)
browser smoke: 1 passed (3.4s), keccak oracle 4/4 match
```

In that consumer, none of `rlp`, `p-limit`, `yocto-queue` or
`ethereum-cryptography` is installed, and `THIRD_PARTY_NOTICES.md` is present
in the installed SDK.

## 6. Summary

| Measure | BEFORE | AFTER |
| --- | --- | --- |
| Direct third-party runtime dependencies | 4 | 3 |
| Lockfile view: packages listed by `pnpm list --prod` (peers included) | 63 | 51 |
| Lockfile view: unique production packages (peers included) | 40 | 31 |
| Lockfile view: unique SDK-owned packages | 18 | 9 |
| Lockfile view: SDK-owned on-disk size | 8,363 KB | 5,443 KB |
| Fresh npm consumer: installed packages (SDK included, peers not installed) | 22 | 12 |
| Fresh npm consumer: `node_modules` size | 16,212 KB | 9,152 KB |
| Fresh npm consumer: duplicate names | `@noble/curves`, `@noble/hashes` | `@ethereumjs/rlp`, `@noble/hashes` |
| Packed tarball (`npm pack --dry-run`) | 25 files, 183,846 bytes | 26 files, 190,839 bytes |
| Tests (`pnpm --filter @polygonlabs/maticjs test`) | 121 passed, 33 skipped | 299 passed, 33 skipped |

`@polygonlabs/maticjs` removes `rlp`, `ethereum-cryptography` and `p-limit`
(and with them `yocto-queue` and five `@noble`/`@scure` packages). Exit
payloads are byte-for-byte unchanged, as shown by the ground-truth tests and
the tarball smoke. The one behaviour change is for malformed input: block-proof
strings from the optional proof API that contain non-hex characters now throw
instead of being partially encoded (section 3.4).

### 6.1 Follow-up review: trie subtree and supply-chain posture

Reviewed 2026-11-05 against the tip of this audit. Measurement scripts and
raw outputs are described inline. Each number is reproducible with the
command given.

#### What the SDK uses from `@ethereumjs/mpt`

`src/utils/proof_util.ts` is the only importer. It calls `new
MerklePatriciaTrie()` with default options (no key hashing, cache size 0,
in-memory `MapDB`). It calls `put(RLP.encode(txIndex), receiptBytes)` once per
receipt, then `findPath(RLP.encode(txIndex), true)`, and reads `.node.value()`
and `.stack.map((n) => n.raw())`. It does not use checkpointing, the node
cache, persistence, deletion, or the trie's proof APIs.

The receipt-proof `root` placed in the exit payload is the block's
`receiptsRoot` as returned by RPC. Before returning a proof, the SDK now
verifies that the root of the trie it built equals that `receiptsRoot`, byte
for byte. On a mismatch it throws a `POSBridgeError` with code
`RECEIPTS_ROOT_MISMATCH` (block number, block hash and both roots in `info`)
instead of returning a payload that would be rejected on-chain. The trie
already holds its root, so the check adds no RPC call.

#### What the trie's subtree contains, and what runs

Runtime coverage (V8 `NODE_V8_COVERAGE`) of an import-only script is
compared with a full build-and-prove run over a 200-receipt trie:

| Package | Version | On disk | Runs on the SDK's path? |
| --- | --- | ---: | --- |
| `@ethereumjs/mpt` | 10.1.2 | 680 KB | Yes: trie insert, path walk, node encoding |
| `@ethereumjs/util` | 10.1.2 | 991 KB | A small part: lock, in-memory DB, task queue, byte helpers |
| `@noble/hashes` | 2.2.0 | 889 KB | Keccak-256 yes; SHA-2/HMAC only at import, for `@noble/curves` |
| `@ethereumjs/rlp` | 10.1.2 | 160 KB | Yes (also a direct dependency) |
| `@noble/curves` | 2.2.0 | 1,875 KB | Import only. `@ethereumjs/util`'s constants module evaluates a secp256k1 constant at load time. Coverage is identical with and without trie work |
| `lru-cache` | 11.0.2 | 808 KB | Never instantiated (cache size 0) |
| `debug`, `ms` | 4.4.3, 2.1.3 | 50 KB | One logger created per trie; it never logs unless `DEBUG` is set |

#### What bundling the subtree would ship

esbuild 0.25.12 bundled every public entry point with splitting, and kept the
optional peers and the first-party error package external. `debug` was
resolved through its `browser` field, because its Node entry requires `tty`
and `util`.

| | Minified | Unminified |
| --- | ---: | ---: |
| SDK code alone (today's equivalent) | 128,890 B | 259,532 B |
| SDK + whole trie subtree bundled | 217,435 B | 461,716 B |
| Added by the subtree, excluding RLP and Keccak (needed anyway) | ≈77 KB | ≈190 KB |
| Of which never executed (`@noble/curves`, `lru-cache`, SHA-2/HMAC) | ≈45 KB | — |

Tree-shaking cannot drop the unused part without modifying the bundled files,
which requires releasing those modifications under MPL-2.0. The reasons are a
top-level secp256k1 call in `@ethereumjs/util`, a statically reachable cache
class, and a logger created in the trie constructor. Bundling unmodified MPL-2.0
files into this MIT package is permitted as a "Larger Work" (MPL-2.0 §3.3). The
MPL-2.0 source must remain available and its notices kept (§3.2, §3.4).
`@ethereumjs/mpt@10.1.2` ships no licence file in its npm tarball, so the
licence text would have to come from the upstream repository. This is a
statement of facts, not legal advice.

A purpose-written receipt-trie proof builder is also realistic: roughly
120–200 lines and 2–4 KB minified, leaving only `@ethereumjs/rlp` and
`@noble/hashes` at runtime. It is consensus-critical code. The existing tests
cover three live blocks and one single-leaf trie, which is not a sufficient
oracle on its own. It would need a differential test against
`@ethereumjs/mpt` (kept as a development dependency) across trie sizes and
key-width boundaries, offline real-block fixtures asserting the computed root
equals `receiptsRoot`, and the runtime root check above.

#### Supply-chain posture of this repository

| Control | State |
| --- | --- |
| Exact pins on third-party runtime dependencies | Yes (`package.json`) |
| Committed lockfile; frozen installs in CI checks | Yes |
| Frozen install in the release (publish) job | **No.** The shared release workflow installs with `--no-frozen-lockfile`, so a release can resolve versions other than the tested lockfile |
| `minimumReleaseAge` | 14 days (`pnpm-workspace.yaml`), first-party scopes excluded. No locked package was younger than 14 days on 2026-11-05 (all 679 checked). With the pinned pnpm 10.30.3 the window applies when dependencies are resolved, not when installing from an existing lockfile |
| `blockExoticSubdeps`, `trustPolicy: no-downgrade`, build-script allowlist | Yes |
| Publish via npm trusted publishing (OIDC, no token) | Yes (`.github/workflows/npm-release-trigger.yml`, `id-token: write`). The trusted publisher must be registered on the npm package before the first CI publish. Provenance can be verified only after a CI publish |
| Dependency-change scanning on pull requests | Not enabled. A GitHub App such as Socket would add install-script, malware and typosquat alerts on dependency changes. A `socket.yml` is optional |
| Production `pnpm audit` | One high advisory, in `ws`, reached only through the optional `viem` peer. It is not a dependency this package ships |
| Development `pnpm audit` | Advisories in test and docs tooling (including `vitest`, `vite`, `js-yaml`, `markdown-it`). None ships in the package. Tracked separately |

LavaMoat and SES confine dependencies at runtime inside an application or its
build. A published library cannot apply them on its users' behalf; an
application that uses this SDK can adopt them. The library-side equivalents
are the controls above: exact pins, the release cool-down, provenance through
trusted publishing, pull-request dependency scanning, and optionally bundling
the audited tree.

#### Follow-up

The development-tooling advisories (`vitest`, `vite`, `js-yaml`,
`markdown-it` and others in test and docs tooling; none ships in the package)
are to be addressed in a separate dependency bump.

## 7. Reproduce

Run from the repository root after `pnpm install --frozen-lockfile`.

```bash
# Production tree and unique package count
pnpm --filter @polygonlabs/maticjs list --prod --depth Infinity
pnpm --filter @polygonlabs/maticjs list --prod --depth Infinity --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const seen=new Set();const walk=d=>{for(const [n,v] of Object.entries(d||{})){const k=n+"@"+v.version;if(!seen.has(k)){seen.add(k);walk(v.dependencies)}}};for(const p of JSON.parse(s))walk(p.dependencies);console.log(seen.size)})'

# Why a package is present
pnpm --filter @polygonlabs/maticjs why <pkg> --prod

# Registry facts
npm view <pkg> version maintainers dist.attestations repository.url license --json
npm view <pkg> time --json
npm view <pkg>@<version> dist.attestations.url

# Licences
pnpm --filter @polygonlabs/maticjs licenses list --prod

# Tarball contents and size
pnpm --filter @polygonlabs/maticjs run build
cd packages/maticjs && npm pack --dry-run --json

# Fresh npm consumer view (run once per tarball, BEFORE and AFTER)
pnpm --filter @polygonlabs/maticjs run build
cd packages/maticjs && pnpm pack --pack-destination <dir>
mkdir <consumer> && cd <consumer> && npm init -y
npm install --legacy-peer-deps --no-audit --no-fund <dir>/polygonlabs-maticjs-<version>.tgz
npm ls --all
npm ls --all --parseable | wc -l   # minus the root line
du -sk node_modules

# Tests
pnpm --filter @polygonlabs/maticjs test
pnpm --filter @polygonlabs/maticjs run test:pack
pnpm --filter @polygonlabs/maticjs-test-app run test:browser
```
