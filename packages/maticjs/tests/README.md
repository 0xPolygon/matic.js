# `@polygonlabs/maticjs` tests

Three layers of tests live under this directory:

| Layer | Files | Network needed | Run by default? |
| --- | --- | --- | --- |
| Unit | `tests/unit/`, `tests/proof-util-receipt-bytes.test.ts`, `tests/root-chain-find-root-block.test.ts` | None | Yes |
| Integration | `tests/integration/**` | Sepolia + Amoy testnets | **Skipped** without env vars |
| End-to-end | `tests/e2e/**` | Sepolia + Amoy testnets, ~4 h | **Skipped** unless `POS_SDK_TEST_E2E_ENABLED=true` |

`pnpm test` runs every test file. Tests that need credentials gate
themselves on `process.env.*` via `describe.skipIf(...)` so the suite
exits cleanly with no failures when the env is unset — the unit layer
covers the pure-function surface, and the integration / e2e layers
become live tests only when CI (or a developer) opts in.

## Running unit tests

```bash
pnpm exec vitest run tests/unit
```

These have no external dependencies and run in well under a second.

## Running integration tests

The integration suite signs and broadcasts real transactions against
Sepolia (parent) and Amoy (child), so it needs:

1. **A funded test wallet.** A wallet seeded with:
   - Sepolia ETH for `approve` / `deposit` / `exit` gas.
   - Amoy POL for child-chain `transfer` and burn gas.
   - A balance of the test tokens listed in
     [`fixtures/networks.ts`](./fixtures/networks.ts) — see
     "Acquiring test tokens" below.
2. **RPC URLs** for both chains. Polygon's eRPC proxy works; Alchemy /
   Infura / public Sepolia and Amoy endpoints all work too.
3. **The four environment variables** documented in
   `../.env.test.example`.

Easiest setup is `cp ../.env.test.example ../.env.test`, fill in the
values, and run with a `dotenv` runner:

```bash
# from packages/maticjs
pnpm dlx dotenvx run -f .env.test -- pnpm exec vitest run tests/integration
```

Inside CI the env vars come from secrets — see
[`../../.github/workflows/ci-trigger.yml`](../../.github/workflows/ci-trigger.yml).

### Acquiring test tokens

The test contract addresses in `fixtures/networks.ts` point to the
PoS bridge's Dummy* test tokens on Sepolia and Amoy (the
`POSContracts.Tokens` entries in the Amoy address index). Each Sepolia
token has a public mint that any wallet can call; the Amoy tokens are
their bridge-mapped children and can only be funded by depositing from
Sepolia (the child contracts let only the ChildChainManager mint).

| Token | Sepolia mint | Amoy |
| --- | --- | --- |
| Dummy ERC20 (DERC20) | `mint(uint256 amount)` — mints to the caller | n/a — deposit from parent |
| Dummy ERC721 (DERC721) | `mint(uint256 tokenId)` — mints to the caller | n/a — deposit from parent |
| Dummy ERC1155 | `mint(address to, uint256 id, uint256 amount)` | n/a — deposit from parent |

The Sepolia ERC-20 has no `mint(address,uint256)` overload; calling
that signature reverts. The ERC-1155 tests read tokenId `1`, so mint
that id.

Faucets that drip Sepolia ETH and Amoy POL rotate frequently. Check
the Polygon docs page (`https://docs.polygon.technology/`) for the
current recommended faucet — common providers include
`sepoliafaucet.com`, Alchemy's faucet, and the Polygon Labs Amoy
faucet.

If a fixture address has been redeployed since this README was
written, update `fixtures/networks.ts` with the new address and add a
note here.

### Rate-limit notes

Public RPC endpoints for Sepolia and Amoy throttle aggressively. The
integration suite serialises burn-tx replay (one read at a time) and
honours `proofConcurrency: 4` for receipt-trie reconstruction — both
of which keep the suite under typical free-tier 25 RPS limits. If you
see `429` errors, drop `proofConcurrency` to 2 in the test setup or
switch to a paid provider.

### Live mainnet state-sync test (read-only)

`tests/integration/live-mainnet-state-sync.test.ts` checks
`getDepositStatus` against real mainnet state syncs: fx-tunnel messages
(which it reads like any deposit) and PoS deposits, some delivered after a
replay and some whose delivery failed, before or since the Uburu fork (state
ids 3212421 and 3192364 are the unreplayed ones). It signs nothing and needs no
key, only two RPC URLs, and is skipped unless both are set:

- `POS_SDK_TEST_MAINNET_PARENT_RPC` — Ethereum mainnet.
- `POS_SDK_TEST_MAINNET_CHILD_RPC` — Polygon PoS mainnet.

They are variables rather than built-in URLs because public endpoints
differ in what they serve (old receipts, log ranges); the test uses only
a receipt lookup and latest-state `eth_call`s, which free endpoints
answer. If the failed deposit is ever replayed on-chain, the test fails
with "fixture replayed" so the fixture is rotated deliberately.

## Recording exit-payload fixtures

The byte-snapshot tests in `tests/integration/exit-payload.test.ts`
verify that the exit payload constructed locally matches the bytes
captured from a known-good run. The fixture files
(`tests/fixtures/exits/*-burn-1.json`) ship as placeholders containing
a `RECORDING_INSTRUCTIONS` key — the byte-snapshot tests skip while
that key is present and re-enable themselves once the file holds a
real `{ burnTxHash, network, expectedPayloadHex }` triple.

Recording procedure:

1. With a funded wallet, burn a small unit of the test token on Amoy:

   ```ts
   // ERC-20 example
   const burnTx = await pos.child.erc20(amoyTokenAddr).startWithdraw(1n);
   const burnReceipt = await burnTx.confirmed();
   ```

2. Wait until the burn block has been checkpointed to Sepolia. The
   simplest check is to poll the parent chain's
   `RootChain.getLastChildBlock()` — when it crosses the burn's
   blockNumber, the checkpoint is in. Real-world wait time on
   Amoy↔Sepolia is currently ~30–90 minutes per checkpoint.

3. Capture the payload bytes by calling the bridge helper directly
   (the `completeWithdraw` flow on the SDK constructs the same
   payload):

   ```ts
   // exposes the inner POSBridgeHelpers; not part of the public surface
   // — script-only, see the SDK source for the import path.
   const payloadHex = await bridge.buildExitPayload(
     burnReceipt.transactionHash,
     LogEventSignature.Erc20Transfer,
     /* isFast */ false
   );
   ```

4. Write the file:

   ```json
   {
     "burnTxHash": "0x...",
     "network": "amoy",
     "expectedPayloadHex": "0xf90..."
   }
   ```

The same procedure applies for ERC-721 and ERC-1155, swapping the
event signature and using `child.erc721(addr).startWithdraw(tokenId)`
or `child.erc1155(addr).startWithdraw(tokenId, amount)` to source the
burn.

## End-to-end cycle test

`tests/e2e/deposit-withdraw-cycle.test.ts` runs the full
deposit → checkpoint → exit cycle for each of the three adapters. It
is gated by `POS_SDK_TEST_E2E_ENABLED=true` because each adapter run
takes 30–90 minutes (waiting for a real checkpoint) and the full
matrix takes ~4 hours. Run it manually with:

```bash
POS_SDK_TEST_E2E_ENABLED=true \
  pnpm dlx dotenvx run -f .env.test -- pnpm exec vitest run tests/e2e
```

In CI the cycle test runs only on the nightly schedule defined in
`.github/workflows/ci-nightly.yml`.

## Adding a new test

- **Unit (no network) tests** live under `tests/unit/`. They never need
  `skipIf` — they always run.
- **Integration tests** must start with the `HAS_CREDS` gate the other
  files in `tests/integration/` use. Never use `skipIf(true)` or
  comment-out a failing test to make CI green.
- **Mocking the chain or proof generation in a test labelled
  "integration" is forbidden** — these tests exist specifically to
  validate the live behaviour, and a mock defeats their purpose.
  Mocking the upstream HTTP fetch in `tests/unit/address-service.test.ts`
  is fine because that file deliberately exercises the cache layer in
  isolation.

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
- **Live reads** (`tests/integration/staking-reads.test.ts`) replay every read
  at a pinned finalized block (mainnet `26343957`, Sepolia `12064934`) and
  compare the decoded values with `reads-mainnet.json` and `reads-sepolia.json`.
  They need no credentials, but they do need an **archive-capable** RPC,
  because a pruned node cannot serve a historical block. The defaults are
  `https://eth.drpc.org` and `https://sepolia.gateway.tenderly.co`; override
  them with `POS_SDK_TEST_MAINNET_PARENT_RPC` (mainnet) and
  `POS_SDK_TEST_PARENT_RPC` (Sepolia). State at a finalized block never
  changes, so a mismatch means decoding changed.
- **Writes** (`tests/integration/staking-write.test.ts`) are skipped unless the
  same `POS_SDK_TEST_*` credentials as the other integration tests are set.
  For each adapter they broadcast a 1-wei POL `approveStakeManager`, wait for
  confirmation and read the allowance back. They also check that
  `prepareApproveStakeManager` returns the bytes the adapter library's own
  encoder produces, and that a mainnet adapter holding a Sepolia signer is
  refused with `UNSUPPORTED_NETWORK` before anything is broadcast. No
  delegation write is broadcast: that
  needs funded POL and a live validator share on Sepolia, so delegation
  calldata is covered by the ground-truth tier only.

Re-record the read fixtures only after an intentional decoding change, by
building the package and running
`node packages/maticjs/scripts/record-staking-read-fixtures.mjs` from the
workspace root. Never re-record a ground-truth fixture to make a test pass.
