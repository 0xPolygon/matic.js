# Monorepo Migration Plan

This document tracks the planned work to convert `0xPolygon/matic.js` into a
modern, single-package PoS bridge SDK published as `@polygonlabs/pos-sdk` 1.0,
with viem and ethers (v5 + v6) supported via internal adapters built into the
core SDK. zkEVM support is extracted into its own `@polygonlabs/zkevm-sdk`
package on the same release schedule.

The PoS bridge SDK remains a first-class, supported product; the rebrand
reflects the ongoing token rename (MATIC → POL) and `@polygonlabs` org
consolidation, not deprecation of the SDK itself.

---

## Overview

| Phase | PR     | Description                                                                                  | Status |
| ----- | ------ | -------------------------------------------------------------------------------------------- | ------ |
| 1a    | PR 1   | Monorepo structure — move core to `packages/maticjs/`, add workspace tooling                | ✅ #463 |
| 1b    | PR 2   | ESLint, commitlint, vitest, GitHub Actions workflows                                         | ✅ #463 |
| 2a    | PR 3   | Core SDK rewrite at `@polygonlabs/pos-sdk` 1.0.0 (composition refactor, internal adapters)   | ⬜ next |
| 2b    | PR 4   | Extract zkEVM into `@polygonlabs/zkevm-sdk` 1.0.0                                            | ⬜      |
| 2c    | manual | Rename GitHub repo `0xPolygon/matic.js` → `0xPolygon/pos-sdk`; deprecate old npm packages   | ⬜      |

Out of scope: `maticjs-plasma` and `maticjs-staking` are domain bridge clients
maintained independently.

---

## Strategy

### Single-package SDK with internal adapters (Option B)

The current plugin model — `IPlugin.setup()` mutating module-level
`utils.Web3Client` — is replaced with **constructor-injected configuration
that accepts viem / ethers v5 / ethers v6 client objects directly**. The SDK
ships with internal adapter implementations for all three providers; the
consumer chooses which one by passing the matching config shape.

```ts
// viem
import { createPublicClient, createWalletClient } from 'viem';
import { POSClient } from '@polygonlabs/pos-sdk';
const pos = await POSClient.init({
  network: 'mainnet',
  parent: { publicClient, walletClient },
  child:  { publicClient: childPublic, walletClient: childWallet },
});

// ethers v5 or v6 — discriminated by which fields are present
const pos = await POSClient.init({
  network: 'mainnet',
  parent: { provider: parentProvider, signer: parentSigner },
  child:  { provider: childProvider,  signer: childSigner },
});
```

Why Option B over a separate plugin package per provider:
- One `pnpm install`; no plugin registration step
- No global mutation; multi-tenant safe
- Adapter code lives in the SDK and is type-checked against the SDK's internal
  needs — third-party plugin extension story is dropped, but this SDK has
  zero third-party plugins today
- One release cadence for the SDK + all three adapters; bug fixes ship together

Type-level peer deps on viem / ethers v5 / ethers v6 are declared as
`peerDependencies` with `peerDependenciesMeta.optional: true` so consumers
only need the libraries they actually use.

### Native `bigint` at the public API

The `BaseBigNumber` abstraction, `EmptyBigNumber` placeholder, and
`utils.BN` exports are all removed. The SDK accepts and returns native
`bigint` everywhere amounts cross the public API.

ethers v5 compatibility: v5's `BigNumberish` accepts `bigint` as input
(since 5.6), and v5 returns `BigNumber` for outputs which the v5 adapter
converts to `bigint` via `bn.toBigInt()` at the read boundary. Consumers
never see v5's `BigNumber` class.

ethers v6 and viem are already native `bigint` — no conversion needed.

### Composition over inheritance

The `BaseToken` → `POSToken` → `ERC20` inheritance chain is dismantled.
The same logic is reorganised as composed services:

- **`ContractCaller`** — owns transaction plumbing (gas estimation, nonce,
  EIP-1559 detection, read/write dispatch, contract loading). Constructor
  takes the chain client and the contract identity.
- **`POSBridgeHelpers`** — POS-specific predicate / exit / withdrawal
  helpers shared by ERC20/721/1155 leaf classes. Constructor takes
  the POS contracts accessor.
- **Leaf classes (`ERC20`, `ERC721`, `ERC1155`)** — own a `ContractCaller`
  and a `POSBridgeHelpers`; expose the public token API. No inheritance.
- **Non-token contract wrappers (`RootChainManager`, `RootChain`,
  `GasSwapper`)** — each owns a `ContractCaller` and exposes its
  contract-specific methods. Previously inherited `BaseToken` despite
  not being tokens.

Rationale: an `ERC20` *has-a* transaction-execution capability, it is not
a transaction; `RootChainManager` is not a token. Inheritance for code
reuse made non-token contracts pretend to be tokens. Composition removes
the "is-a" lie and makes each service unit-testable in isolation.

### Vendored ABIs, no runtime CDN dependency

Currently `ABIManager` fetches ABIs from
`https://static.polygon.technology/network/{net}/{ver}/...` on init and on
first contract use. Total per network: ~70 KB raw JSON, ~12-15 KB gzipped
in the npm tarball.

The 1.0 SDK vendors all required ABIs as committed JSON imports under
`packages/pos-sdk/src/abi/`. The `ABIManager`, `ABIService`, the
module-level `service` singleton, and the `cache` map are deleted.
Network/contract address config is also vendored (the per-network
`index.json` content lives as a TS const map).

### Native `Error` subclasses

`ErrorHelper` + `ERROR_TYPE` enum + `.throw()` chaining are replaced with
plain native `Error` subclasses, each with a discriminator code field:

```ts
export class POSBridgeError extends Error {
  constructor(
    public readonly code: 'BURN_TX_NOT_CHECKPOINTED' | 'EIP1559_NOT_SUPPORTED' | ...,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) { super(message); this.name = 'POSBridgeError'; }
}
```

Consumers narrow on `error instanceof POSBridgeError && error.code === '...'`.
No `@polygonlabs/verror` (that's for backend services); no Zod runtime
validation (consumer bundle weight).

### Replace custom utilities with stdlib / well-maintained deps

| Current | Replacement |
| --- | --- |
| `utils/map_promise.ts` | `p-limit` (npm dep) |
| `utils/promise_resolve.ts` | inline `Promise.resolve(...)` |
| `utils/event_bus.ts` | deleted (unused) |
| `utils/merge.ts` | inline spread or `Object.assign` |
| `utils/keccak.ts` | retained — small wrapper over `ethereum-cryptography` used in proof building |

### Rebrand to `@polygonlabs/*` as a fresh 1.0 line

| Old (deprecate, no final release) | New (1.0.0) |
| --- | --- |
| `@maticnetwork/maticjs` | `@polygonlabs/pos-sdk` |
| `@maticnetwork/maticjs-ethers` | (folded into `@polygonlabs/pos-sdk` as the v5 adapter) |
| `@maticnetwork/maticjs-web3` | (EOL — no replacement) |
| *new* | `@polygonlabs/zkevm-sdk` |

Old GitHub repos `0xPolygon/maticjs-web3` and `0xPolygon/maticjs-ethers` are
archived with READMEs pointing to the new monorepo. `0xPolygon/matic.js` is
**renamed** to `0xPolygon/pos-sdk` — GitHub redirects preserve old URLs,
PRs/issues, releases, watchers, stars, and CI history.

### Node and ES targets

- `engines.node`: `">=20"` for both `@polygonlabs/*` packages
- TS `target: es2023`, `lib: ["es2023"]`, via `@tsconfig/node20`
- Drops Node 18 (EOL 2025-04-30)
- These are libraries, not services — they don't need the workspace's
  Node 24 default

### 1.0 API cleanup (in PR 2a)

Folded into the rewrite — one break, not two:

- Remove `export default defaultExport` from `src/index.ts`. Consumers
  migrate to `import { POSClient } from '@polygonlabs/pos-sdk'`.
- Delete `src/default.ts`.
- Convert all `enum` declarations to `const` objects + union types:
  `Permit` (`src/constant.ts`), `ERROR_TYPE` (`src/enums/error_type.ts`),
  `Log_Event_Signature` (`src/enums/log_event_signature.ts`). Enables
  `erasableSyntaxOnly: true` per team standards.
- Rename `etheriumSha3` → `keccak256` on the adapter interface.
- Fix typo enum key `transation_object_not_object` → drop entirely;
  replaced by error class.
- Remove unused `signTypedData` from the adapter contract — currently
  declared, called nowhere.
- After cleanup, remove the `no-default-export` ESLint override.

---

## Phase 1a — PR 1: Monorepo structure ✅

Structural reorganisation only. No source code changes. `pnpm publish` of
`@maticnetwork/maticjs` must produce an identical artefact before and after.

### New root files

- [x] `pnpm-workspace.yaml`
- [x] `.npmrc` — `link-workspace-packages=false`, `auto-install-peers=true`
- [x] `package.json` (root — private, devDeps only, `type: module`)
- [x] `tsconfig.json` (root) — `files: []`, references `packages/maticjs/tsconfig.build.json`
- [x] `.changeset/config.json` — `baseBranch: master`
- [x] `.nvmrc` — Node 24
- [x] `.prettierrc.json`
- [x] `.markdownlint-cli2.jsonc`
- [x] `.lintstagedrc.js`
- [x] `.husky/pre-commit`, `.husky/commit-msg`, `.husky/pre-push`
- [x] `MIGRATION.md` (scaffold)
- [x] `.github/CODEOWNERS`

### Move core package to `packages/maticjs/`

- [x] Move `src/`, `webpack.config.js`, `license.js`, `build_helper/` into `packages/maticjs/`
- [x] Move `examples/` to repo root (cleaner for external consumers)
- [x] Move manual dev scripts (`debug.js`, `ether.js`, `config.js`) to `manual/` at repo root
- [x] Delete root copies after move

### `packages/maticjs/package.json`

- [x] `repository` with `directory: packages/maticjs` (trusted publishing)
- [x] `publishConfig.access: public`
- [x] `MIGRATION.md` in `files` array
- [x] Remove `husky` hooks block; replace `npm run` with `pnpm run`
- [x] Add `typecheck` and `test` scripts
- [x] Add `@ethereumjs/common` and `safe-buffer` as explicit deps (pnpm strict isolation
      exposed these were direct imports but only transitive under npm)
- [x] Pin `typescript` to `^5.9.3` (tested clean; earlier apparent TS5 breakage was
      a mixed npm/pnpm resolution artefact)

### `packages/maticjs/tsconfig.json` + `tsconfig.build.json`

- [x] Standalone tsconfig (not extending root) — `module: commonjs`,
      `moduleResolution: node`, `skipLibCheck: true`, `strict: false`
- [x] `tsconfig.build.json` — composite, `rootDir: src`, used by project references
- [x] `tsconfig.json` includes `src/**/*`, `tests/**/*`, `vitest.config.ts`

### Tests

- [x] Delete broken nested test project (`test/package.json`, jest@27, npm link,
      live-RPC dependencies)
- [x] Migrate `specs/index.ts` → `packages/maticjs/tests/map-promise.test.ts` (vitest,
      7 passing unit tests, no network required)
- [x] Add `vitest.config.ts`

### Root `tslint.json` / `.eslintignore` / `package-lock.json`

- [x] Delete root `tslint.json`, `.eslintignore`, `package-lock.json`

---

## Phase 1b — PR 2: ESLint, workflows ✅

### ESLint + commitlint + markdownlint

- [x] `eslint.config.js` — `@polygonlabs/apps-team-lint@2.0.0`, `@tsconfig/node-ts`
      plugin extraction for `no-unused-vars` override
- [x] Fix all lint errors in `packages/maticjs/src/` (0 errors; 67 advisory
      `no-explicit-any` warnings in public plugin interfaces)
- [x] Two config-level overrides (not inline disables):
  - `no-require-imports` off for `http_request.ts` (webpack BUILD_ENV pattern)
  - `no-default-export` off for `src/index.ts` (semver-major API change, deferred)
- [x] `commitlint.config.js` — conventional commits
- [x] `markdownlint-cli2@^0.21.0`; fix all violations in existing `.md` files
- [x] Fix `README.md` (wrong org, npm commands, outdated structure)
- [x] Fix `examples/README.md` (npm install instructions, file: reference for local dev)

### GitHub Actions — public repo workflow pattern

- [x] Delete `.github/workflows/ci.yml` (npm-based)
- [x] Delete `.github/workflows/github_doc_deploy.yml` (dead since 2022)
- [x] `.github/actions/ci/action.yml` — verbatim copy
- [x] `.github/actions/upsert-changeset-comment/action.yml` — verbatim copy
- [x] `.github/actions/upsert-changeset-comment/dist/index.js` — compiled bundle
- [x] `.github/actions/upsert-changeset-comment/dist/package.json`
- [x] `ci-trigger.yml` — `branches: [master]`, calls `./.github/actions/ci`
- [x] `changeset-check.yml` — local `upsert-changeset-comment` reference
- [x] `changeset-check-trigger.yml` — `branches: [master]`
- [x] `npm-release.yml` — three `main`→`master` substitutions
- [x] `npm-release-trigger.yml` — `branches: [master]`
- [x] `claude-code-review.yml` + `claude-code-review-trigger.yml`
- [x] `claude.yml` + `claude-trigger.yml`

---

## Testing Strategy

Tests **must exercise the actual chain**. Mocked-RPC unit tests have repeatedly
hidden adapter and protocol bugs in this SDK's history. The 1.0 testing
strategy treats live testnet integration as the primary signal of correctness;
pure-function unit tests cover only what is genuinely computational.

### Test categories

**Unit tests (vitest, fast, no network)** — pure function correctness only:
- RLP encoding and merkle tree construction in proof builders
- Address parsing, hex conversion, keccak helpers
- Error class discriminator behaviour
- p-limit-based concurrency wrapping
- ABI-typed contract method shape construction (compile-time, not runtime)

**Integration tests (vitest, real Amoy + Sepolia testnets)** — every
non-trivial adapter and bridge operation:
- Per-adapter parity: same suite runs three times, once per adapter
  (viem / ethers v5 / ethers v6) against the same testnet contracts
- Read paths (`getBalance`, `getAllowance`, `getPredicateAddress`,
  `isCheckpointed`) — fast, no funds required
- Write paths (`approve`, `deposit`, `startWithdraw`) — funded test
  wallet, ~30s per test (gas + confirmation)
- Exit payload construction — uses **historical fixture burn tx hashes**
  whose checkpoints are already on Sepolia, so payload bytes can be
  computed and asserted byte-for-byte without waiting hours for fresh
  checkpoints
- Native bigint round-trip — values passed in match values returned out

**End-to-end cycle tests (release-tag and nightly)** — full deposit ↔
withdraw cycle per adapter:
- Deposit ERC20 from Sepolia → Amoy, wait for checkpoint, complete
  withdraw on Sepolia. Multi-hour test; runs on nightly cron and on
  release-tag CI only.

### Test infrastructure

| Concern | Approach |
|---|---|
| Test wallet | Dedicated funded account, never used elsewhere. Private key in CI secrets (`POS_SDK_TEST_PRIVATE_KEY`); per-developer account in `.env.test` for local |
| RPC URLs | `POS_SDK_TEST_PARENT_RPC` (Sepolia), `POS_SDK_TEST_CHILD_RPC` (Amoy). CI secrets; `.env.test.example` documents shape |
| Test ERC20 | Deploy once, persist address in `tests/fixtures/networks.ts`. Unlimited mintable so any test wallet can fund itself |
| Historical burn fixtures | Recorded burn tx hashes + expected exit payload bytes in `tests/fixtures/exits/*.json`. Refreshed only when contracts upgrade |
| Snapshot tests | Exit payload byte-for-byte snapshots — catches regressions in proof encoding without re-running the full burn cycle |
| Per-test isolation | Each test uses a fresh nonce; no shared mutable state between tests. Tests are concurrent-safe |
| Funding monitor | Workflow that warns on Slack when test wallet balance drops below threshold |

### CI matrix

| Trigger | Runs |
|---|---|
| PR / push | Unit tests + integration suite (read paths, small writes), all three adapters in parallel. ~5 min total |
| Nightly | All of PR + end-to-end deposit/withdraw cycle, all three adapters. ~3 hr total |
| Release tag | Same as nightly + smoke test installing the published tarball into a scratch project |

### Test directory structure

```
packages/pos-sdk/
├── src/
└── tests/
    ├── unit/                          # vitest, no network
    │   ├── proof-util.test.ts
    │   ├── merkle-tree.test.ts
    │   ├── errors.test.ts
    │   └── ...
    ├── integration/                   # vitest, live testnet
    │   ├── adapters/
    │   │   ├── viem.test.ts
    │   │   ├── ethers-v5.test.ts
    │   │   └── ethers-v6.test.ts
    │   ├── erc20.test.ts             # parameterised over adapter
    │   ├── erc721.test.ts
    │   ├── erc1155.test.ts
    │   ├── exit-payload.test.ts      # uses historical fixtures
    │   └── ...
    ├── e2e/                           # nightly only
    │   └── deposit-withdraw-cycle.test.ts
    └── fixtures/
        ├── networks.ts                # test ERC20/721/1155 addresses
        └── exits/                     # historical burn → expected payload
            ├── erc20-burn-12345.json
            └── ...
```

### How each phase verifies its work

Each phase below has an **explicit verification block** describing the test
classes that must pass before the PR is mergeable. No phase ships without
matching tests.

---

## Phase 2a — PR 3: Core SDK rewrite at `@polygonlabs/pos-sdk` 1.0.0 ⬜

Single PR. Substantial diff but architecturally cohesive — splitting it would
create unstable intermediate states (e.g., adapters implemented but composition
not yet refactored). Reviewers hold the whole picture either way.

Implementation order below is the order the agent doing the work should
follow; each block ends with what new tests validate it.

### A. Package skeleton + tooling

- [ ] Folder rename: `packages/maticjs/` → `packages/pos-sdk/`
- [ ] `package.json`:
  - `"name": "@polygonlabs/pos-sdk"`, `"version": "1.0.0"`
  - `"engines": { "node": ">=20" }`
  - `"type": "module"`
  - `"repository"` with `directory: packages/pos-sdk`
  - `"publishConfig": { "access": "public" }`
  - `"files": ["dist", "MIGRATION.md"]`
  - `"exports"` — CJS + ESM + types
  - `"peerDependencies"`: `viem: "^2.0.0"`, `ethers: "^5.5.1 || ^6.0.0"`
  - `"peerDependenciesMeta"`: all three marked `{ "optional": true }`
  - `"dependencies"`: `p-limit`, `ethereum-cryptography`, `rlp`
- [ ] `tsconfig.json` — extends `@tsconfig/node20`; `target: "es2023"`,
      `lib: ["es2023"]`, `strict: true`, `erasableSyntaxOnly: true`,
      `noUncheckedSideEffectImports: true`
- [ ] `tsconfig.build.json` — composite, `rootDir: src`
- [ ] `tsup.config.ts` — replaces webpack; CJS + ESM + DTS, target es2023
- [ ] Update root `tsconfig.json` references and `pnpm-workspace.yaml`
- [ ] Delete: `webpack.config.js`, `license.js`, `build_helper/`

### B. Vendor ABIs and network config

- [ ] Create `src/abi/` with one TS file per contract, each exporting
      `as const` for viem ABI inference:
  - `RootChainManager.ts`, `ChildERC20.ts`, `ChildERC721.ts`,
    `ChildERC1155.ts`, `ERC20Predicate.ts`, `ERC721Predicate.ts`,
    `ERC1155Predicate.ts`, `EtherPredicate.ts`, `GasSwapper.ts`
  - Source: `https://static.polygon.technology/network/{network}/v1/artifacts/pos/{name}.json`
- [ ] Create `src/networks.ts` — vendored address index per network
      (`mainnet` and `amoy`), typed as a `const` map
- [ ] Delete: `utils/abi_manager.ts`, `services/abi_service.ts`,
      `services/network_service.ts`, `services/index.ts`,
      `utils/http_request.ts`, `config.ts`
- [ ] **Verify (unit test)**: `tests/unit/abi-types.test.ts` —
      compile-time check that `as const` ABIs produce expected viem
      `Abi`-typed inference; runtime check that addresses round-trip

### C. Adapter layer

- [ ] `src/adapter.ts` — `Adapter` interface (~6 methods):
  ```ts
  interface Adapter {
    getChainId(): Promise<number>;
    read(req: ReadRequest): Promise<unknown>;
    write(req: WriteRequest): Promise<{ hash: string; confirmed(): Promise<Receipt> }>;
    estimateGas(req: WriteRequest): Promise<bigint>;
    getTransactionReceipt(hash: string): Promise<Receipt | null>;
    keccak256(data: Uint8Array | string): string;
  }
  ```
- [ ] `src/adapters/viem.ts` — implements `Adapter` over
      `PublicClient` + optional `WalletClient`. Native bigint throughout.
- [ ] `src/adapters/ethers-v5.ts` — implements `Adapter` over
      v5 `Provider` + optional `Signer`. Boundary conversion:
      `BigNumber.toBigInt()` on read, accepts `bigint` directly on write
      (v5 `BigNumberish` includes bigint).
- [ ] `src/adapters/ethers-v6.ts` — implements `Adapter` over
      v6 `Provider` + optional `Signer`. Native bigint; `getSigner()`
      is async — adapter constructor resolves it once.
- [ ] `src/adapters/select.ts` — discriminated-union config →
      adapter factory. Throws `POSBridgeError('UNSUPPORTED_PROVIDER', ...)`
      if config doesn't match any known shape.
- [ ] `src/adapters/sanitise.ts` — RPC token regex sanitisation applied
      to errors before they propagate to the consumer's logger
- [ ] **Verify (integration test)**: `tests/integration/adapters/{viem,ethers-v5,ethers-v6}.test.ts` —
      each adapter executes the same test plan against Amoy: `getChainId`,
      `read` (call `RootChainManager.tokenToType`), `write` (transfer 1 wei
      of test token), `getTransactionReceipt`. Assert identical observable
      behaviour across all three adapters.

### D. Composition refactor (kill `BaseToken` hierarchy)

- [ ] `src/internal/contract-caller.ts` — `ContractCaller` service.
      Owns: contract loading from vendored ABI + address, gas estimation,
      nonce, EIP-1559 detection, read/write dispatch via `Adapter`.
- [ ] `src/internal/pos-bridge-helpers.ts` — `POSBridgeHelpers` service.
      Owns: predicate address resolution, exit hash, `isWithdrawn` checks.
- [ ] Rewrite `src/pos/erc20.ts`, `erc721.ts`, `erc1155.ts` as plain
      classes composing `ContractCaller` + `POSBridgeHelpers`. No `extends`.
- [ ] Rewrite `src/pos/root_chain_manager.ts`, `root_chain.ts`,
      `gas_swapper.ts` as plain classes composing only `ContractCaller`.
- [ ] Delete: `utils/base_token.ts`, `pos/pos_token.ts`,
      `abstracts/base_big_number.ts`, `abstracts/base_contract.ts`,
      `abstracts/base_web3_client.ts`, `abstracts/contract_method.ts`,
      `abstracts/index.ts`, `implementation/bn.ts`, `implementation/index.ts`,
      `helpers/contract_write_result.ts`, `helpers/do_nothing.ts`
- [ ] **Verify (integration test)**: `tests/integration/erc20.test.ts` —
      live `getBalance`, `getAllowance`, `approve` against Amoy test ERC20.
      Parameterised over all three adapters.

### E. POSClient public API redesign

- [ ] `src/pos-client.ts`:
  ```ts
  type Network = 'mainnet' | 'amoy';

  type ParentClientConfig =
    | { publicClient: ViemPublicClient; walletClient?: ViemWalletClient }
    | { provider: EthersProvider; signer?: EthersSigner };  // v5 or v6

  type POSClientConfig = {
    network: Network;
    parent: ParentClientConfig;
    child: ParentClientConfig;
    logger?: Logger;             // pino-shaped, structural
    proofConcurrency?: number;   // default 4
    proofApi?: { url: string };  // optional fast-exit; explicit, not auto-detected
  };

  class POSClient {
    static async init(config: POSClientConfig): Promise<POSClient>;
    readonly parent: { erc20(addr): ERC20; erc721(addr): ERC721; erc1155(addr): ERC1155 };
    readonly child:  { erc20(addr): ERC20; erc721(addr): ERC721; erc1155(addr): ERC1155 };
    readonly rootChainManager: RootChainManager;
  }
  ```
- [ ] Drop: `version` config field (single canonical ABI set vendored)
- [ ] Drop: `isParent: boolean` parameter on token factories (replaced by
      `parent`/`child` namespaces)
- [ ] Drop: `UnstoppableDomains` integration entirely. Delete
      `resolution: unknown = {}` field and `set_proof_api_url.ts`.
- [ ] Drop: `log: true` boolean config; replaced by `logger?: Logger`
- [ ] **Verify (integration test)**: `tests/integration/pos-client-init.test.ts` —
      construct `POSClient` with each adapter shape, call `parent.erc20(addr)`
      and `child.erc20(addr)`, verify chain selection.

### F. Logger interface and error sanitisation

- [ ] `src/logger.ts` — pino-shaped structural interface:
  ```ts
  export interface Logger {
    trace(obj: object, msg?: string): void;
    debug(obj: object, msg?: string): void;
    info(obj: object, msg?: string): void;
    warn(obj: object, msg?: string): void;
    error(obj: object, msg?: string): void;
  }
  ```
- [ ] No runtime dep on `pino` or `@polygonlabs/logger`. Both satisfy
      the interface structurally — consumers plug in whichever they use.
- [ ] Default: `noopLogger` (no-op for every level) when not provided.
- [ ] RPC token sanitisation — apply regex
      `/(\?|&)token=[^&\s"]+/g` to error messages before passing to
      `logger.error()` so consumers using non-sanitising loggers don't leak.
- [ ] **Verify (unit test)**: `tests/unit/sanitise.test.ts` — error
      messages with RPC tokens have tokens replaced with `***` before
      logging, and original error object's `cause` is preserved.

### G. Transaction result API redesign

- [ ] New shape: `interface TxResult { hash: string; confirmed(): Promise<Receipt> }`
- [ ] `hash` is a string already known when the method resolves (tx submitted)
- [ ] `confirmed()` returns the receipt promise; resolves on first confirmation
- [ ] Drop: lazy `getTransactionHash()` pattern entirely
- [ ] Drop: `option.returnTransaction` mode entirely. Consumers needing
      to populate-without-sending use their provider library directly
      (viem `prepareTransactionRequest`, ethers `populateTransaction`).
- [ ] Update every method on `ERC20`/`ERC721`/`ERC1155`/`RootChainManager`
      to return `Promise<TxResult>` directly
- [ ] **Verify (integration test)**: `tests/integration/tx-result.test.ts` —
      `await pos.parent.erc20(addr).approve(1n)` returns a `TxResult` with
      a defined `hash` immediately and a `confirmed()` that resolves to
      a real receipt within 60s on Sepolia.

### H. Native bigint pass

- [ ] Replace all `TYPE_AMOUNT` (`string | number | BigNumberish`) on the
      public API with `bigint`. Update parameter and return types.
- [ ] Internal adapter boundaries handle:
  - viem: native bigint, no conversion
  - ethers v5: input `bigint` → `BigNumber.from(bigint)`; output
    `BigNumber` → `bn.toBigInt()`
  - ethers v6: native bigint, no conversion
- [ ] `utils/converter.ts`:
  - Keep `toHex(bigint | string | number): \`0x\${string}\``
  - Drop `toBN`, drop any `BigNumber` references
- [ ] **Verify (integration test)**: `tests/integration/bigint-roundtrip.test.ts` —
      pass `1234567890123456789012345n` through approve→getAllowance and
      assert the same bigint comes back, on all three adapters.

### I. Error class redesign

- [ ] `src/errors.ts`:
  ```ts
  export type POSBridgeErrorCode =
    | 'BURN_TX_NOT_CHECKPOINTED'
    | 'EIP1559_NOT_SUPPORTED'
    | 'PROOF_API_NOT_SET'
    | 'INVALID_TOKEN_TYPE'
    | 'BRIDGE_ADAPTER_NOT_FOUND'
    | 'TX_OPTION_NOT_OBJECT'
    | 'UNSUPPORTED_PROVIDER'
    | 'UNSUPPORTED_NETWORK';

  export class POSBridgeError extends Error {
    constructor(
      public readonly code: POSBridgeErrorCode,
      message: string,
      public readonly context?: Record<string, unknown>,
    ) { super(message); this.name = 'POSBridgeError'; }
  }
  ```
- [ ] Replace every `ErrorHelper.throw()` and `logger.error(...).throw()`
      callsite with `throw new POSBridgeError('CODE', '...', { ctx })`
- [ ] Delete: `utils/error_helper.ts`, `enums/error_type.ts`,
      `enums/index.ts`, `enums/log_event_signature.ts` (move event sigs
      to a const map in `src/constant.ts`)
- [ ] **Verify (unit test)**: `tests/unit/errors.test.ts` — every code is
      thrown by at least one source location; `instanceof POSBridgeError`
      narrowing works for each.

### J. Method naming pass

- [ ] `withdrawStart` → `startWithdraw`
- [ ] `withdrawExit` → `completeWithdraw`
- [ ] `withdrawExitFaster` → `completeWithdrawFast`
- [ ] Native ETH ergonomics — audit `depositEther`, `depositEtherWithGas`,
      `depositWithGas`. Decide during implementation: unify into
      `pos.eth.deposit(...)` namespace OR fold into a single `deposit`
      with an `asNative: true` option. Land whichever is cleaner.
- [ ] `etheriumSha3` → `keccak256` on the `Adapter` interface (already in plan)
- [ ] Document every rename in `MIGRATION.md`

### K. Module audit (relevance check)

For each, decide during implementation: keep / simplify / delete. Document
the call in PR description.

- [ ] `pos/gas_swapper.ts` — verify still relevant; check on-chain whether
      `GasSwapper` is still deployed and used post-POL migration
- [ ] `pos/find_checkpoint_slot.ts` — bisect-search across checkpoints.
      `RootChain` exposes `NewHeaderBlock` events; consider replacing
      bisect with direct event filter (faster, simpler)
- [ ] `services/network_service.ts` — fast-exit proof API client.
      Has been deleted in section B; replaced by explicit `proofApi` config
- [ ] `utils/proof_util.ts` — large, central to exit flow. Review for
      `: any` removals and async/await migration but don't restructure
- [ ] `utils/exit_util.ts` — same
- [ ] Comment-removal pass: dead `withdrawExitMany`/`withdrawExitFasterMany`
      blocks in `pos/erc721.ts`; any other commented code

### L. Replace custom utilities

- [ ] `utils/map_promise.ts` → `p-limit`. Update call sites in
      `proof_util.ts` and elsewhere.
- [ ] Delete: `utils/promise_resolve.ts`, `utils/event_bus.ts`,
      `utils/merge.ts`, `utils/not_implemented.ts`, `utils/use.ts`,
      `utils/resolve.ts`
- [ ] Keep: `utils/keccak.ts`, `utils/buffer-utils.ts`,
      `utils/merkle_tree.ts`
- [ ] Rename `requestConcurrency` → `proofConcurrency` (top-level config
      field; only affects proof building)
- [ ] **Verify (unit test)**: `tests/unit/p-limit.test.ts` — concurrent
      RPC calls in proof building respect `proofConcurrency: 2` (no more
      than 2 in flight at any time).

### M. Source-level cleanup

- [ ] Replace every `.then()` chain with async/await
- [ ] Replace every `: any` with proper type or `unknown`
- [ ] Remove `signTypedData` from adapter contract (declared, never called)
- [ ] Delete: `src/default.ts`, `defaultExport`, `src/utils/index.ts`
      barrel re-exports of deleted modules
- [ ] Public `src/index.ts`:
  ```ts
  export { POSClient } from './pos-client';
  export { POSBridgeError, type POSBridgeErrorCode } from './errors';
  export { type Logger } from './logger';
  export { type Network, type POSClientConfig, type TxResult, type Receipt } from './types';
  // No default export. No internal exports.
  ```

### N. Documentation

- [ ] Top-level `README.md` rewrite — install, init examples for each
      provider, breaking-change pointer to MIGRATION.md
- [ ] `packages/pos-sdk/MIGRATION.md` — comprehensive 3.9.x → 1.0.0 guide:
  - Package rename
  - Plugin removal (`use(...)` → just pass clients in config)
  - `bigint` everywhere
  - Method rename table
  - Error class change
  - `parent`/`child` namespacing
  - Dropped: UnstoppableDomains, custom logger flag, `returnTransaction`,
    `version`, `log`
- [ ] `examples/` — rewrite all to `@polygonlabs/pos-sdk` 1.0 API,
      one example per provider
- [ ] `manual/` debug scripts updated

### O. Tests

(Test infrastructure described in **Testing Strategy** above. This block
lists which test files must exist and pass before merge.)

- [ ] `tests/fixtures/networks.ts` — test ERC20/721/1155 addresses on Amoy
- [ ] `tests/fixtures/exits/` — at least 3 historical burn → exit-payload
      fixtures (one per token type)
- [ ] `tests/unit/` — proof-util, merkle-tree, errors, sanitise, p-limit,
      abi-types
- [ ] `tests/integration/adapters/{viem,ethers-v5,ethers-v6}.test.ts` —
      adapter parity
- [ ] `tests/integration/pos-client-init.test.ts`
- [ ] `tests/integration/erc20.test.ts` — parameterised over adapter
- [ ] `tests/integration/erc721.test.ts` — parameterised
- [ ] `tests/integration/erc1155.test.ts` — parameterised
- [ ] `tests/integration/exit-payload.test.ts` — historical fixtures,
      byte-for-byte payload assertion
- [ ] `tests/integration/tx-result.test.ts`
- [ ] `tests/integration/bigint-roundtrip.test.ts`
- [ ] `tests/e2e/deposit-withdraw-cycle.test.ts` — full cycle, gated by
      env var so it doesn't run on every PR
- [ ] CI workflow updates: split `ci-trigger.yml` into PR-fast and
      nightly-full; pass test wallet credentials via secrets

### P. Changeset

- [ ] `pnpm exec changeset add` — major bump (`1.0.0`) documenting the
      rename + complete API redesign. Body leads with:
      "**`@maticnetwork/maticjs` is renamed to `@polygonlabs/pos-sdk`** —
      install the new package. The 1.0 release is a complete API redesign;
      see MIGRATION.md for the full guide."

---

## Phase 2b — PR 4: Extract `@polygonlabs/zkevm-sdk` 1.0.0 ⬜

Move zkEVM client out of the core SDK so it can be deprecated independently
when zkEVM is wound down. Ships clean (not deprecated) at 1.0.0.

### `packages/zkevm-sdk/` structure

- [ ] Create `packages/zkevm-sdk/`
- [ ] Copy `packages/pos-sdk/src/zkevm/` → `packages/zkevm-sdk/src/`
- [ ] Apply the same architectural patterns from Phase 2a:
  - Composition over inheritance (parallel `ContractCaller` for zkEVM
    contracts; if substantially identical to the POS-SDK one, factor
    into an internal-only shared package or just duplicate)
  - Native bigint throughout
  - Vendored ABIs (`PolygonZkEVMBridge.ts`, etc.)
  - Same `Adapter` interface and adapter implementations
  - `POSBridgeError`-equivalent `ZkEvmBridgeError`
- [ ] Public surface: `ZkEvmClient` (renamed from `ZkEvmClient`, capital
      EVM consistent). Decide naming during implementation.

### `packages/zkevm-sdk/package.json`

- [ ] `"name": "@polygonlabs/zkevm-sdk"`, `"version": "1.0.0"`
- [ ] `"engines": { "node": ">=20" }`
- [ ] `"repository"` with `directory: packages/zkevm-sdk`
- [ ] `"publishConfig": { "access": "public" }`
- [ ] `"files": ["dist", "MIGRATION.md"]`
- [ ] Same `peerDependencies` shape as `pos-sdk` (viem / ethers v5 / v6,
      all optional)
- [ ] Same tsup / tsconfig / vitest config as `pos-sdk`

### Code-share decision

- [ ] During implementation, decide whether to factor the `Adapter`
      interface and adapter implementations into an internal,
      unpublished workspace package (`packages/internal-adapters/`)
      consumed by both `pos-sdk` and `zkevm-sdk`. Prefer duplication if
      the shared surface is small enough (<300 lines) — easier to evolve
      independently.

### Tests

Same testing strategy as Phase 2a, scaled to zkEVM operations:

- [ ] `tests/unit/` — pure-function tests for zkEVM-specific encoding
- [ ] `tests/integration/` — live zkEVM Cardona testnet (or successor),
      adapter parity per zkEVM bridge operation
- [ ] `tests/e2e/` — full bridge cycle on testnet, nightly only

### Core SDK update

- [ ] Remove `packages/pos-sdk/src/zkevm/` entirely
- [ ] Remove zkEVM exports from `packages/pos-sdk/src/index.ts`
- [ ] Document in `pos-sdk/MIGRATION.md`: "zkEVM support moved to
      `@polygonlabs/zkevm-sdk` — `import { ZkEvmClient } from '@polygonlabs/zkevm-sdk'`"

### Changeset

- [ ] `pnpm exec changeset add` — minor bump for new `@polygonlabs/zkevm-sdk`
- [ ] `pnpm exec changeset add` — patch bump for `@polygonlabs/pos-sdk`
      noting the zkEVM extraction (already covered in Phase 2a's MIGRATION
      if 2a and 2b ship together; otherwise dedicated entry)

---

## Phase 2c — Manual: rename repo, deprecate old packages, archive old repos

Manual / out-of-PR. Runs after Phases 2a + 2b are merged and the
`@polygonlabs/*` packages are published to npm.

### GitHub repo rename

- [ ] Rename `0xPolygon/matic.js` → `0xPolygon/pos-sdk` via Settings →
      General → Repository name
- [ ] Verify GitHub redirects work for old URL (web + git clone)
- [ ] Update local workspace remote: `git -C ... remote set-url origin
      git@github.com:0xPolygon/pos-sdk.git`
- [ ] Update `repositories/apps-team-ops/src/registry.json` references
      if any
- [ ] Update repo URL in any other workspace cross-references

### npm deprecations

- [ ] `npm deprecate "@maticnetwork/maticjs@<=3.9.x"
      "Renamed to @polygonlabs/pos-sdk. Migration guide:
      https://github.com/0xPolygon/pos-sdk/blob/main/packages/pos-sdk/MIGRATION.md"`
- [ ] `npm deprecate "@maticnetwork/maticjs-ethers@*"
      "Folded into @polygonlabs/pos-sdk 1.0 (built-in ethers v5 + v6 adapters).
      See https://github.com/0xPolygon/pos-sdk"`
- [ ] `npm deprecate "@maticnetwork/maticjs-web3@*"
      "End of life — web3.js itself is EOL. Use @polygonlabs/pos-sdk with
      viem / ethers v5 / ethers v6."`

### GitHub repo archival

- [ ] `0xPolygon/maticjs-web3` — README pointer → archive
- [ ] `0xPolygon/maticjs-ethers` — README pointer → archive

### Verification

- [ ] Install `@polygonlabs/pos-sdk` and `@polygonlabs/zkevm-sdk` in a
      scratch project; run a deposit + withdraw flow against Amoy
- [ ] `npm view @maticnetwork/maticjs` shows the deprecation message
- [ ] `npm view @maticnetwork/maticjs-ethers` shows the deprecation message
- [ ] `git clone https://github.com/0xPolygon/matic.js.git` redirects to
      `pos-sdk` and clones successfully

---

## Deferred (not in scope for this migration)

| Item | Reason |
|---|---|
| Type-safe contract methods exposed in public API | The `as const` ABI work in Phase 2a covers internal correctness; exposing typed contract handles to consumers is a separate effort |
| `@polygonlabs/zkevm-sdk` deprecation | Ships clean at 1.0.0; deprecate when zkEVM EOL date is set |
| `maticjs-plasma` rename / migration | Domain bridge client; remains independent |
| `maticjs-staking` rename / migration | Domain bridge client; remains independent |
| Optional `@polygonlabs/pos-sdk-unstoppable-domains` extension | Build only if real demand surfaces post-1.0 |
