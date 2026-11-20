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

When the key is present, the compose script also exports
`REQUIRE_LIVE_RPC=1`. With it set, the gated files fail instead of
skipping if `POS_SDK_TEST_PARENT_RPC` or `POS_SDK_TEST_CHILD_RPC` is
unset, so an emptied or renamed URL variable cannot turn the live tier
into a silent skip on a green run. Set it locally to check the same
thing: `REQUIRE_LIVE_RPC=1 pnpm test` fails without the URLs.

### Rate-limit notes

Public RPC endpoints for Sepolia and Amoy throttle aggressively. The
exit-payload file serialises burn-tx replay (one read at a time) and
honours `proofConcurrency: 4` for receipt-trie reconstruction, which keeps
it under typical free-tier 25 RPS limits. If you see `429` errors, set the
`POS_SDK_TEST_*` URLs to a paid or keyed provider.

### Live mainnet state-sync test (read-only)

`tests/live/state-sync.live.test.ts` checks
`getDepositStatus` against real mainnet state syncs: fx-tunnel messages
(which it reads like any deposit) and PoS deposits, some delivered after a
replay and some whose delivery failed, before or since the Uburu fork (state
ids 3212421 and 3192364 are the unreplayed ones). It also simulates
`prepareReplayDeposit`'s calldata for those two with `eth_call` and asserts
the StateReceiver accepts the record (the revert, when there is one, is the
receiving contract's, not the SDK's). The `'payload'` replay cannot run on the
devnet, so the unit stub and this simulation are its only coverage. It signs
nothing and needs no key, only two RPC URLs, and is skipped unless both are set:

- `POS_SDK_TEST_MAINNET_PARENT_RPC` — Ethereum mainnet.
- `POS_SDK_TEST_MAINNET_CHILD_RPC` — Polygon PoS mainnet.

They are variables rather than built-in URLs because public endpoints
differ in what they serve (old receipts, log ranges); the test uses only
a receipt lookup and latest-state `eth_call`s, which free endpoints
answer. If the failed deposit is ever replayed on-chain, the test fails
with "fixture replayed" so the fixture is rotated deliberately.

## Recording exit-payload fixtures

`tests/live/exit-payload.live.test.ts` rebuilds the exit payload for real
mainnet burns of all three token standards, plus one burn of the native
token (the Plasma withdraw log), and compares it byte for byte with
`tests/fixtures/exits/*-burn-1.json`. Those fixtures were taken from
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
it exactly. It reads mainnet only and needs no key. The Plasma fixture is
recorded separately with `node scripts/record-exit-fixture.mjs --plasma`,
which does the same for a recent burn of the native token and also records
the burn log's topics (the root token and the burner). `--plasma` needs a
child-chain RPC that serves `eth_getLogs` over a few thousand blocks; set
`POS_SDK_TEST_MAINNET_CHILD_RPC` if the default does not.

### Offline cassettes

The live test depends on public RPCs, so a `429` can fail it for reasons
unrelated to the code. `tests/unit/exit-payload-golden.test.ts` checks the
same fixtures with no network. For each burn it replays a **cassette**
(`tests/fixtures/exits/cassettes/*-burn-1.json`): the parent and child RPC
responses the SDK's local payload construction consumed, plus the resolved
address index. `tests/unit/cassette-adapter.ts` is an `Adapter` that serves
them, keyed by method and canonicalised params, and throws on a request
with no recorded response, so a change that makes the SDK ask for something
new fails the test instead of reaching a live endpoint.

Cassettes are as immutable as the fixtures. Re-record them only when the
RPC calls the construction makes change on purpose, and never to turn the
golden test green:

```bash
node scripts/record-exit-fixture.mjs --cassette           # all four
node scripts/record-exit-fixture.mjs --cassette erc20     # one
```

`--cassette` never rewrites a `*-burn-1.json` fixture, and refuses to write
a cassette whose payload differs from the fixture's `expectedPayloadHex`.
Recording the three older burns needs an archive-capable child RPC (the
default works). Each cassette stays under 1.5 MB.

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

## Plasma tests

Plasma writes move funds too, so the suite pins the calldata to what the 3.x
Plasma plugin produced instead of to what "looks equivalent". Two committed
fixtures stand behind that, and neither needs credentials or a network:

- **Calldata ground truth** (`tests/fixtures/plasma/calldata-3x.json`, described
  in [`fixtures/plasma/README.md`](./fixtures/plasma/README.md)) holds the `to`,
  `data` and `value` the 3.x plugin encoded for each Plasma write it can build
  (approve, deposit, the child-chain burn, the confirm, and the exit, single and
  batch), with the decoded arguments and the fixed inputs they were encoded from.
  `tests/unit/plasma-calldata-ground-truth.test.ts` encodes the same writes
  with the SDK and compares the bytes. The fixture is the specification: when a test against it fails, find out
  why the encoding changed, and never re-record it to turn the test green.
- **Exit payloads** are checked against the Plasma burn fixture and its offline
  cassette, which are recorded and replayed like the other burns. See
  [Recording exit-payload fixtures](#recording-exit-payload-fixtures) and
  [Offline cassettes](#offline-cassettes) rather than repeating them here. The
  confirm entry of the calldata fixture contains that burn's expected payload
  byte for byte, so the two fixtures check each other.

`tests/live/plasma-exit-payload.live.test.ts` is the ground truth for the Plasma
fast confirm. It prepares the confirm calldata for the recorded mainnet Plasma burn
twice with `PlasmaClient`: once through `confirmWithdrawFast` against the production
proof-generation API, and once through `confirmWithdraw`, which builds the payload
locally from RPC on a client with no proof API configured. It asserts the two are
identical and that the payload equals the recorded one. There is no 3.x fast confirm
to compare with and the devnet has no proof API, so this is where the API path meets
a real chain. It is read-only (both calls are `prepare*`; nothing is signed or sent)
and, like `exit-payload.live.test.ts`, always runs with no credentials, using public
RPCs overridable with `POS_SDK_TEST_MAINNET_PARENT_RPC` and
`POS_SDK_TEST_MAINNET_CHILD_RPC`. Because the fast path falls back to local
construction when the API fails, the test also fails if that fallback was logged, so
a green run means the API payload was used. A `429` is a reason to re-run once; a byte
difference is a defect.

The withdrawal flow itself (burn, checkpoint, confirm, process) runs against the
kurtosis devnet in [`packages/e2e`](../../e2e/README.md), like every other write.

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
