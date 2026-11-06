# @polygonlabs/maticjs-e2e

End-to-end tests for `@polygonlabs/maticjs` against a local Polygon PoS devnet.

The unit tests in `packages/maticjs` mock the chain. They cannot show that a deposit, its checkpoint and its exit land on chain, because those paths need a real L1, a real L2, real state sync and real checkpoints. This package runs those paths against [kurtosis-pos](https://github.com/0xPolygon/kurtosis-pos), a devnet that deploys the same pos-portal bridge and staking contracts as the public networks. It checkpoints every few seconds, so a deposit, burn and exit cycle takes minutes instead of hours.

It is private and never published. It is opt-in: the root `pnpm test` does not run it, because this package has no `test` script.

## How a run works

`pnpm run e2e` (from the repo root) runs `scripts/run-e2e.sh`, which:

1. builds the SDK (`pnpm --filter @polygonlabs/maticjs run build`), because the tests import the built package, as a consumer does;
2. runs `up`, which reads the running devnet (the kurtosis enclave named by `KURTOSIS_ENCLAVE`, default `pos`), waits until L2 is at block 256 or later and heimdall has acknowledged a checkpoint, and prints the devnet's RPC URLs, chain ids and contract addresses as `export` lines that the script evals;
3. runs `seed`, which funds the test keys (see below);
4. runs the tests (`test:e2e`);
5. only if asked, with `--down` or `E2E_DOWN=1` (`pnpm run e2e -- --down`), runs `down`, which tears the devnet down.

`run-e2e.sh` does not start the devnet. You start it, as below, so by default it leaves the devnet running when it finishes: a devnet you booted may be one you, or another session, still need. CI boots its own devnet and passes `--down` to remove it. If a step fails, the script stops there, before any teardown, and the devnet stays up for inspection. Run `pnpm --filter @polygonlabs/maticjs-e2e run down` when you are done with it.

## Running locally (cold start)

Locally the devnet is booted from source. The published snapshot image is `linux/amd64` only, so it is used in CI and not on Apple silicon.

You need Docker (Engine 25 or later) running and the [kurtosis CLI](https://docs.kurtosis.com/install).

```bash
# Once, on Apple silicon: kurtosis-pos's toolbox image is amd64-only.
# Pull the image named by `toolbox_image` in kurtosis-pos's
# src/config/constants.star, as linux/amd64.
docker pull --platform linux/amd64 <toolbox_image>

# Boot the devnet from a kurtosis-pos checkout at v1.4.8 (about 3 minutes with cached images).
git clone --branch v1.4.8 https://github.com/0xPolygon/kurtosis-pos.git
cd kurtosis-pos
kurtosis run --enclave pos --args-file <path-to-matic.js>/packages/e2e/kurtosis-params.yml .

# Run the tier from the matic.js checkout. It reads the enclave named `pos`.
cd <path-to-matic.js>
pnpm install
pnpm run e2e              # the devnet stays up afterwards
pnpm run e2e -- --down    # or: also remove the enclave when the run passes
```

### Which enclave the harness reads

The harness reads the enclave named by `KURTOSIS_ENCLAVE`, and `pos` when it is unset. The name you boot with and the name the run reads must match. Set it when you boot under another name, for example because a `pos` enclave from another checkout or session is already running and you want a devnet of your own:

```bash
kurtosis run --enclave my-devnet --args-file <path-to-matic.js>/packages/e2e/kurtosis-params.yml .
KURTOSIS_ENCLAVE=my-devnet pnpm run e2e
```

Pass the same `KURTOSIS_ENCLAVE` to every harness command you run by hand (`up`, `down`), or they read `pos` instead.

### How long a run takes

Expect about 25 minutes from a cold start, most of it quiet:

- about 3 minutes for `kurtosis run` to boot the devnet;
- about 4 minutes for the SDK build, `up` (waiting for L2 block 256 and the first checkpoint) and `seed`;
- about 17 minutes for the tests, of which the validator-owner file takes about 5, mostly the 60-second liveness watch after each of its three writes.

Each bridge and staking cycle waits for state sync or a checkpoint, and takes 90 to 180 seconds with nothing printed in between. Long silences are normal. Every wait has a hard cap and fails with the condition it was waiting for, so a stuck devnet does not hang the run.

### Skips by design

A passing run reports some skipped tests. They are expected:

- `pol.preparePermit`, one row per adapter in `staking-writes.e2e.test.ts`. The devnet's POL has no ERC-5267 `eip712Domain()`, which `preparePermit` reads; see `STAKING-COVERAGE.md`.
- The GATED block in `staking-validator.e2e.test.ts` (`stakeFor`, `stakeForMatic`, `unstake`, `claimUnstaked`, `updateSigner`, `migrateDelegation`). Each would stop the single-validator devnet or needs a second validator; see `STAKING-COVERAGE.md`.
- In snapshot mode only, the validator-owner rows in `staking-validator.e2e.test.ts`. They sign with validator 1's owner key, which `up` reads from the kurtosis enclave, and a restored snapshot has no enclave to read it from.

`kurtosis-params.yml` selects an anvil L1, which boots faster than the default geth and lighthouse L1. `up` waits for the devnet to be ready, so you can start `pnpm run e2e` as soon as `kurtosis run` returns.

Teardown is opt-in. `down` removes the enclave that `up` read, by its UUID, and only when you run it (directly, or through `--down`). `up` records whether `.github/scripts/e2e-setup.sh` booted that enclave or `up` attached to one already running, and `down` reports which it removed. The kurtosis engine you started with `kurtosis run` keeps running; stop it with `kurtosis engine stop` when you no longer need it.

Never pipe kurtosis CLI output into `head`: closing the pipe can kill an auto-started engine mid-start and leave a container that blocks every later `engine start`.

## Running in CI

CI cold-starts the devnet from kurtosis-pos source with the same `kurtosis-params.yml` as a local run (`.github/scripts/e2e-setup.sh`). It checks kurtosis-pos out at a pinned commit and installs a pinned kurtosis CLI `.deb`, verified by its sha256. It then runs `pnpm run e2e -- --down`, so the devnet it booted is removed when the suite passes.

### Snapshot (opt-in)

A manual dispatch with `use_snapshot=true` restores the published kurtosis-pos snapshot image with `docker compose` instead. It is not the default because its geth and lighthouse L1 stops minting blocks once the image is more than a few minutes old: the beacon chain's genesis time is part of the restored state, and a lone lighthouse whose head slot is far behind the wall-clock slot never counts itself synced, so it never proposes. The readiness check fails fast on that stall and prints the L1 head block's age. Set `E2E_SNAPSHOT_ADDRESSES_JSON` to the `contractAddresses.json` extracted from the image. `up` then reads addresses from that file and uses the snapshot's fixed host ports (L1 `8545`, L2 `9545`, heimdall `1317`). `down` stops that compose project (`docker compose --file <dir of the JSON>/docker-compose.yaml down --volumes`) and nothing else. The snapshot's contract addresses are the same as a cold start's, because kurtosis-pos deploys deterministically.

## Running one file

```bash
export KURTOSIS_ENCLAVE=pos   # the enclave you booted
pnpm --filter @polygonlabs/maticjs run build
env_exports=$(pnpm --filter @polygonlabs/maticjs-e2e run --silent up)
eval "$env_exports"
pnpm --filter @polygonlabs/maticjs-e2e run seed
pnpm --filter @polygonlabs/maticjs-e2e run test:e2e test/bridge-erc20.e2e.test.ts
```

## Keys and funding

There are no secrets. Every key the tests sign with is derived from a fixed public string:

```text
privateKey = keccak256("maticjs-e2e:<suite>:<adapter>")
```

They are public by construction. Never fund one on a real network. There is one key per suite and adapter, so each key has a single writer and its nonces never race. The adapter rows inside a test file can then run at the same time, and a failure points at one suite and one adapter.

| Suite | Used by |
|---|---|
| `tx-result` | `tx-result.e2e.test.ts` |
| `bigint` | `bigint-roundtrip.e2e.test.ts` |
| `adapter-parity` | `adapter-parity.e2e.test.ts` |
| `bridge-erc20` | `bridge-erc20.e2e.test.ts` |
| `bridge-erc721` | `bridge-erc721.e2e.test.ts` |
| `bridge-erc1155` | `bridge-erc1155.e2e.test.ts` |
| `bridge-ether` | `bridge-ether.e2e.test.ts` |
| `staking` | `staking-writes.e2e.test.ts` |
| `staking-delegation` | `staking-delegation.e2e.test.ts` |

Each suite has three keys, one per adapter: `viem`, `ethers-v5`, `ethers-v6`.

`staking-validator.e2e.test.ts` is the exception. Its writes are allowed only to the owner of a validator, so it signs with the key that owns the devnet's validator 1. That key is public devnet material: kurtosis-pos generates it into its committed list of prefunded accounts, stakes validator 1 for its address, and writes the same key into heimdall's `priv_validator_key.json`. `up` reads it from that file in the enclave's heimdall keys artifact, checks it against the address in the file, and the test checks on chain that it owns validator 1. All three adapter rows sign with this one key, so they run one after another.

`seed` funds them from the kurtosis-pos admin account, whose key is public devnet material documented by kurtosis-pos. It checks each balance first and only sends when a balance is short, so running it twice sends nothing the second time. Per key it ensures:

- at least 5 ETH on L1 and 5 of the native token on L2 (the admin sends 10);
- for the staking suites, at least 200 POL (the admin sends 500);
- for the `staking` keys, at least 50 MATIC (the admin sends 100), for `delegateMatic`;
- for validator 1's owner key, at least 10 POL (the admin sends 50), for `restake`;
- at least 1 DummyERC20 (it mints 2), one DummyERC721 and 10 of DummyERC1155 id 1 on L1, minted by the key itself (the devnet's Dummy tokens let any account mint);
- for the `adapter-parity` keys, a small DummyERC20 balance on L2, bridged with a real deposit.

## Which SDK build the tests use

The tests import the SDK only through its public entry points (`@polygonlabs/maticjs`, `/viem`, `/ethers-v5`, `/ethers-v6`, `/staking`), and those resolve to the built `dist/`, the files that ship to npm. `src/` is never imported.

The built adapters import their web3 library by its bare name. Both `/ethers-v5` and `/ethers-v6` import `ethers`, and a consumer's install decides which major that is. In this workspace the SDK is a symlink to `packages/maticjs`, where `ethers` is v6, so Node alone would hand the ethers v5 adapter ethers 6. `vitest.e2e.config.ts` resolves those imports from this package instead, the way a consumer's install would: `ethers` imported by the ethers v5 adapter becomes this package's `ethers-v5` alias (ethers 5), and every other `viem` or `ethers` import, from the SDK or from the tests, becomes this package's copy. The SDK and the tests therefore share one copy of each library. This needs no second package and no lockfile tricks, and `pnpm install --frozen-lockfile` covers it.

## What lives here, and what does not

Here: tests that need a real chain. These are bridge deposits and exits for ERC-20, ERC-721, ERC-1155 and ether through all three adapters, staking writes, and transaction-result behaviour on a real node.

Not here:

- unit tests and anything that can run without a chain: `packages/maticjs/tests/unit`;
- read-only checks against the public networks: `packages/maticjs/tests/live`;
- the SDK's source. This package never changes it. A defect the tier finds is fixed in the SDK, not worked around here.
