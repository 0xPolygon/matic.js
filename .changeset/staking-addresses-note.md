---
'@polygonlabs/maticjs': patch
---

Passing a full bridge address index as `addresses` to `StakingClient.init` is deprecated and will be removed in the next major version. Pass the three staking addresses (`StakeManager`, `MaticToken`, `PolToken`) instead. Nothing changes in this release: both forms are accepted and behave as before.
