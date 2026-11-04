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

The sender is `0x1111…1111` and the user argument is `0x2222…2222`. Amounts,
the Heimdall fee and the maximum shares to burn are `10^18`. The minimum shares
to mint is `0`. Validator ids are `7` and `8`, the unbond nonce is `1` and the
commission rate is `10`. The signer public key is `0x04` followed by 64 `0xab`
bytes. The permit deadline is `1700000000`, with `v = 27`, `r = 0x11…11` and
`s = 0x22…22`. Both boolean flags are `true`. The validator share address is
`0x3333…3333`; ValidatorShare calldata does not depend on it. The full set is
in the `inputs` block of `calldata-3x.json`.

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
frozen so its `now + 30 min` deadline is the fixed `1700000000`.

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
