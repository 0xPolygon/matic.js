# `@polygonlabs/maticjs` tests

Two layers of tests live under this directory. A third, the end-to-end
tier, lives in its own package:

| Layer | Files | Network needed | Run by default? |
| --- | --- | --- | --- |
| Unit | `tests/unit/`, `tests/proof-util-receipt-bytes.test.ts`, `tests/root-chain-find-root-block.test.ts` | None | Yes |
| Live read | `tests/live/**` | Public networks, reads only | Partly: see below |
| End-to-end | `packages/e2e` | Local kurtosis devnet | No, `pnpm run e2e` |

`pnpm test` runs every file under `tests/`. The live-read layer never
signs or sends anything, so it needs no key. Its files fall into two
groups:

- The bridge-token and adapter files (`erc20`, `erc721`, `erc1155`,
  `adapters/*`) gate on `POS_SDK_TEST_PARENT_RPC` and
  `POS_SDK_TEST_CHILD_RPC` (Sepolia and Amoy) with `describe.skipIf`. They
  make many calls across three adapters, which free public endpoints
  throttle, so without the URLs they skip instead of failing on a `429`.
- The exit-payload, staking-read, permit-domain and live-CDN files always
  run. They fall back to public endpoints, because a broken default path
  that no test exercises is how a release ships broken while CI stays
  green.

## Running unit tests

```bash
pnpm exec vitest run tests/unit
```

These have no external dependencies and run in well under a second.

## Running live-read tests

The live-read files need only RPC URLs. Polygon's eRPC proxy works;
Alchemy, Infura and public Sepolia and Amoy endpoints work too. The
Sepolia URL also feeds the staking reads, which replay a pinned block, so
it must be archive-capable (see "Staking tests"). Copy the example and
fill in the URLs:

```bash
# from packages/maticjs
cp .env.test.example .env.test
pnpm dlx dotenvx run -f .env.test -- pnpm exec vitest run tests/live
```

In CI the URLs are composed from repo variables plus one API key; see
[`../../.github/workflows/ci-trigger.yml`](../../.github/workflows/ci-trigger.yml).
Fork PRs get no secrets, so there the gated files skip.

### Rate-limit notes

Public RPC endpoints for Sepolia and Amoy throttle aggressively. The
exit-payload file serialises burn-tx replay (one read at a time) and
honours `proofConcurrency: 4` for receipt-trie reconstruction, which keeps
it under typical free-tier 25 RPS limits. If you see `429` errors, set the
`POS_SDK_TEST_*` URLs to a paid or keyed provider.

## Recording exit-payload fixtures

`tests/live/exit-payload.live.test.ts` rebuilds the exit payload for real
mainnet burns of all three token standards and compares it byte for byte
with `tests/fixtures/exits/*-burn-1.json`. Those fixtures were taken from
the production proof-generation API and checked against the SDK's local
construction when recorded. Checkpoint data never changes, so the fixtures
do not go stale; a mismatch means the encoding changed.

Re-record only after an intentional protocol change, from
`packages/maticjs` after `pnpm run build`:

```bash
node scripts/record-exit-fixture.mjs
```

The script finds a recent checkpointed burn per standard, fetches its
payload from the proof API, and refuses to write unless the SDK reproduces
it exactly. It reads mainnet only and needs no key.

## End-to-end tests (kurtosis devnet)

Every write path (approvals, deposits, exits, `TxResult` behaviour,
staking writes) runs in [`packages/e2e`](../../e2e/README.md) against a
local kurtosis PoS devnet, where checkpoints take seconds and the devnet's
own admin account pays for everything. From the workspace root:

```bash
pnpm run e2e
```

See [`../../e2e/README.md`](../../e2e/README.md) for booting the devnet
and running one file.

## Adding a new test

- **Unit (no network) tests** live under `tests/unit/`. They never need
  `skipIf`; they always run.
- **Live-read tests** live under `tests/live/` and are named
  `*.live.test.ts`. A file that would hammer the testnets gates on
  `HAS_LIVE_RPC` from `tests/live/helpers.ts`; build adapters without a
  signer. Never use `skipIf(true)` or comment out a failing test to make
  CI green.
- **Writes** go to `packages/e2e`, never here.
- **Mocking the chain or proof generation in a live test is forbidden**:
  these tests exist to validate live behaviour, and a mock defeats their
  purpose. Mocking the upstream HTTP fetch in
  `tests/unit/address-service.test.ts` is fine because that file
  deliberately exercises the cache layer in isolation.

## Staking tests

Staking writes move funds, so the suite pins the encoding to what the 3.x
staking plugin produced rather than to what "looks equivalent":

- The ground-truth test (`tests/unit/staking-calldata-ground-truth.test.ts`)
  compares the calldata and the permit typed data and digest against the
  captured 3.x output in [`fixtures/staking/`](./fixtures/staking/README.md).
  It needs no credentials, makes no network calls, and always runs with the
  unit suite. The other `tests/unit/staking-*.test.ts` files (routing, client,
  permit, types) check the 4.0 behaviour on its own terms and are not ground
  truth.
- When one fails, find out why the encoding changed. Never re-record a fixture
  to turn the test green; the fixtures are the specification.

The staking suite has three tiers, from cheapest to most demanding:

- **Calldata ground truth** (`tests/unit/staking-calldata-ground-truth.test.ts`)
  encodes the 19 recorded writes through each of the viem, ethers v5 and
  ethers v6 adapters and compares the bytes with `calldata-3x.json`. It also
  checks that `preparePermit` hashes to the recorded permit digest. It needs
  no network.
- **Live reads** (`tests/live/staking-reads.live.test.ts`) replay every read
  at a pinned finalized block (mainnet `26343957`, Sepolia `12064934`) and
  compare the decoded values with `reads-mainnet.json` and `reads-sepolia.json`.
  They need no credentials, but they do need an **archive-capable** RPC,
  because a pruned node cannot serve a historical block. The defaults are
  `https://eth.drpc.org` and `https://sepolia.gateway.tenderly.co`; override
  them with `POS_SDK_TEST_MAINNET_PARENT_RPC` (mainnet) and
  `POS_SDK_TEST_PARENT_RPC` (Sepolia). State at a finalized block never
  changes, so a mismatch means decoding changed.
- **Writes** run on the kurtosis devnet in `packages/e2e`: approvals,
  delegation, and the wrong-chain refusal, through all three adapters.
  [`packages/e2e/STAKING-COVERAGE.md`](../../e2e/STAKING-COVERAGE.md)
  records which writes run there, which are gated, and why.
  `preparePermit` cannot run on the devnet, so
  `tests/live/staking-permit-domain.live.test.ts` checks it read-only
  against mainnet POL.

Re-record the read fixtures only after an intentional decoding change, by
building the package and running
`node packages/maticjs/scripts/record-staking-read-fixtures.mjs` from the
workspace root. Never re-record a ground-truth fixture to make a test pass.
