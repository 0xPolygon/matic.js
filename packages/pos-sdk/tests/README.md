# `@polygonlabs/pos-sdk` tests

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
   - A balance of the mintable test tokens listed in
     [`fixtures/networks.ts`](./fixtures/networks.ts) — see
     "Acquiring test tokens" below.
2. **RPC URLs** for both chains. Polygon's eRPC proxy works; Alchemy /
   Infura / public Sepolia and Amoy endpoints all work too.
3. **The four environment variables** documented in
   `../.env.test.example`.

Easiest setup is `cp ../.env.test.example ../.env.test`, fill in the
values, and run with a `dotenv` runner:

```bash
# from packages/pos-sdk
pnpm dlx dotenvx run -f .env.test -- pnpm exec vitest run tests/integration
```

Inside CI the env vars come from secrets — see
[`../../.github/workflows/ci-trigger.yml`](../../.github/workflows/ci-trigger.yml).

### Acquiring test tokens

The test contract addresses in `fixtures/networks.ts` point to the
canonical Polygon Labs mintable test deployments on Sepolia and Amoy.
Each has a public `mint(...)` function that any wallet can call.

| Token | Sepolia mint | Amoy mint |
| --- | --- | --- |
| TEST20 (ERC-20) | `mint(address,uint256)` | `mint(address,uint256)` |
| TEST721 (ERC-721) | `mint(uint256 tokenId)` | n/a — bridge from parent |
| TEST1155 (ERC-1155) | `mint(address,uint256,uint256)` | `mint(address,uint256,uint256)` |

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
