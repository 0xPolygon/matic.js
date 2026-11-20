# Plasma ground-truth fixtures

These fixtures record what the 3.x Plasma plugin encodes. They show that the
Plasma surface in this package produces the same bytes the 3.x plugin produced
for the same inputs. Plasma writes move funds, so "looks equivalent" is not
enough. A port that drifts by one argument still produces a valid transaction,
but it is the wrong one.

## What is recorded

`calldata-3x.json` holds one entry per Plasma write the 3.x plugin can encode.
Each entry has the 3.x method name, the contract and on-chain function, the
arguments decoded back out of the bytes, the exact `to` and `data` the plugin
returned, and the `value`. The entries are:

- `approve`, once for the MATIC root token and once for the POL root token,
  with the spender left to default to the deposit manager
- `approveMax` on the POL root token
- `deposit` of the POL root token
- `withdrawStart` on the native child token `0x…1010`, which also sends the
  amount as `value`, and on one non-native child token
- `withdrawConfirm` for the burn named in the entry's `burnTxHash` field
- `withdrawExit` on the MATIC root token, and `PlasmaClient.withdrawExit` with
  two tokens (the batch form)

`value` is a decimal string. 3.x hands it back as a hex string only for the
native withdraw and leaves it unset otherwise; unset is recorded as `"0"`.

The file carries a `PROVENANCE` string with the exact versions and recording
date.

## What is not recorded

`depositEther` is absent on purpose. The 3.x method cannot be reached. The
client's `depositEther` calls `depositEther__`, while the token class defines
`depositEther_`, so calling it throws `depositEther__ is not a function` before
anything is encoded. There is no calldata to record, and nothing for this
package to match.

`transfer`, the ERC-721 methods and the fast confirm are also not recorded.
They are outside what this package ports.

## Versions

- `@maticnetwork/maticjs-plasma@1.1.0`
- `@maticnetwork/maticjs@3.9.13`
- `@maticnetwork/maticjs-web3@1.0.5` with `web3@1.10.4`
- Network: mainnet. Addresses came from the plugin's own address index.

## Fixed inputs

The sender is `0x1111…1111` and the user argument is `0x2222…2222`. The amount
is `1000000000000000001`. The gas limit is `500000` and the nonce is `7`; they
are supplied only so 3.x skips gas estimation and the nonce lookup, and neither
reaches the calldata. The full set is in the `inputs` block of
`calldata-3x.json`, and the contract addresses are in its `addresses` block.

The amount is the only numeric argument of any write except `approveMax`, so no
two same-typed arguments of one write can be swapped unnoticed. `deposit` is
the one write with several addresses, and its token and user addresses differ.

## How they were captured

The 3.x packages were installed with `--ignore-scripts` in a scratch directory
outside this repository. They were never added as dependencies here. The plugin
was initialised against mainnet through a small web3 provider wrapper for each
chain, with these behaviours:

- It answered `eth_accounts`, `eth_chainId` and `net_version` locally.
- It refused every method that is not a read. That covers every sending and
  signing method, so no key existed or could have been used.
- It forwarded reads to a public RPC endpoint only for the entry that needs
  chain state (`withdrawConfirm`). Every other entry was captured with no RPC
  endpoint configured at all. The only network access was the fetch of the
  plugin's address index and ABIs.

Every write was called with `returnTransaction: true`. In that mode the 3.x
core returns the transaction config (`to`, `data`) instead of sending it. The
gas limit and nonce were supplied, so no estimation ran.

The capture was cross-checked: every `data` decodes against the signature of
the function listed in its entry, and the `args` in the entry are the decoded
values.

### Recording the `withdrawConfirm` entry

`withdrawConfirm` builds its payload from the burn transaction, its block and
the checkpoint that covers it, so it needs a checkpointed Plasma burn and RPC
endpoints for both chains. Initialise the plugin as above with both wrappers
forwarding reads, then:

```js
const tx = await plasma
  .erc20(MATIC_ROOT, true)
  .withdrawConfirm(burnTxHash, { returnTransaction: true, from, gasLimit, nonce });
// tx.to is the ERC20 predicate from the registry, tx.data is
// startExitWithBurntTokens(bytes payload)
```

Record `{ method: 'withdrawConfirm', contract: 'ERC20Predicate', function:
'startExitWithBurntTokens', args: [payload], to, data, value: '0' }`, plus the
`token` and `burnTxHash` fields, and merge it into the entries in the order
above. The slow confirm is the one recorded. The payload is deterministic for a
burn once its checkpoint exists, so the burn hash identifies the entry.

## Re-capturing

Repeat the recipe above with the same package versions and the same fixed
inputs. A newer plugin or core version is a different recording.

## When a test against these fixtures fails

A mismatch means this package's encoding has changed from what 3.x sends. Find
out why. Never regenerate a fixture to make a test pass: the fixtures are the
specification, and a re-recorded fixture proves nothing.
