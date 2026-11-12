# Staking ground-truth fixtures

These fixtures record what the 3.x staking plugin encodes. They show that the
staking surface in this package produces the same bytes the 3.x plugin produced
for the same inputs. Staking writes move funds, so "looks equivalent" is not
enough. A port that drifts by one argument still produces a valid transaction,
but it is the wrong one.

## What is recorded

- `calldata-3x.json` holds 19 entries: one per staking write, with the approve
  write captured once for the MATIC token and once for the POL token. Each entry
  has the 3.x method name, the contract and on-chain function, the arguments,
  and the exact `to` and `data` the plugin returned.
- `permit-typed-data-3x.json` holds the EIP-712 `Permit` typed data the plugin
  built for a POL permit, as it was handed to the wallet. It also holds the
  EIP-712 digest of that typed data.

Both files carry a `PROVENANCE` string with the exact versions and recording
date.

## Versions

- `@maticnetwork/maticjs-staking@1.2.0-beta.5`, the version a staking frontend
  runs in production
- `@maticnetwork/maticjs@3.9.13`. A re-capture on `3.9.7` produced identical
  bytes.
- `@maticnetwork/maticjs-web3@1.0.5` with `web3@1.10.4`
- Network: mainnet. Addresses came from the plugin's own address index.

## Fixed inputs

The sender is `0x1111…1111` and the user argument is `0x2222…2222`. The amount
is `1000000000000000001`, the Heimdall fee is `2000000000000000003`, the
maximum shares to burn is `3000000000000000007` and the minimum shares to mint
is `5`. The validator id is `7`, the source and destination validator ids for a
migration are `11` and `13`, the unbond nonce is `17` and the commission rate is
`19`. The signer public key is `0x04` followed by 64 `0xab` bytes. The permit
deadline is `1700000023`, with `v = 27`, `r = 0x11…11` and `s = 0x22…22`. Both
boolean flags are `true`. The validator share address is `0x3333…3333`;
ValidatorShare calldata does not depend on it. The full set is in the `inputs`
block of `calldata-3x.json`.

### Why every value is different

A byte-for-byte match proves the arguments are in the right order only when
the arguments that could be swapped have different values. If the amount and
the Heimdall fee were equal, a port that passed them to `stakeFor` the wrong way
round would still produce the recorded bytes and pass. So, within every write,
all arguments of the same ABI type are pairwise distinct, and the numeric
inputs are distinct across the whole set. The values are odd and uneven on
purpose, so one cannot stand in for another.

The calldata test enforces this when it loads: it decodes each recorded `data`
and fails if two same-typed arguments of one write are equal. Booleans are the
one exception. A boolean has only two values, but no write takes two booleans,
so a boolean can never be swapped with a sibling of the same type.

## How they were captured

The 3.x packages were installed in a scratch directory outside this repository.
They were never added as dependencies here. The plugin was initialised against
mainnet through a small web3 provider wrapper with these behaviours:

- It answered `eth_accounts`, `eth_chainId` and `net_version` locally.
- It intercepted `eth_signTypedData_v4`: it recorded the typed data and
  returned a fixed dummy signature, so no key ever signed anything.
- It refused every sending or signing method.
- It forwarded only reads to a public RPC endpoint.

Every write was called with `returnTransaction: true`. In that mode the 3.x
core returns the transaction config (`to`, `data`) instead of sending it. Gas
limit and gas price were supplied, so no estimation ran. The permit typed data
came from the POL token's `getPermitData(amount, stakeManager)`, with the clock
frozen so its `now + 30 min` deadline is the fixed `1700000023`.

The capture was cross-checked in three ways:

- every `data` decodes against the function signature listed in its entry, back
  to the fixed inputs
- the digest was recomputed by hand from the EIP-712 type hashes
- the domain separator matches the POL token's on-chain `DOMAIN_SEPARATOR()`

To re-capture, repeat the recipe above with the same package versions. A newer
plugin or core version is a different recording.

## When a test against these fixtures fails

A mismatch means this package's encoding has changed from what 3.x sends. Find
out why. Never regenerate a fixture to make a test pass: the fixtures are the
specification, and a re-recorded fixture proves nothing.

When computing the permit digest with viem, give `chainId` as a `number`, or
pass the `EIP712Domain` type list explicitly. If viem derives the domain type
from a domain whose `chainId` is a `bigint`, it leaves `chainId` out and returns
a different digest.

## Live-read fixtures

`reads-mainnet.json` and `reads-sepolia.json` are not 3.x ground truth.
They were recorded by this package's own staking reads at a pinned,
finalized block (`scripts/record-staking-read-fixtures.mjs`), so they pin
today's decoding against regressions rather than prove it correct. Their
struct field order was checked by hand against the contract ABIs.
