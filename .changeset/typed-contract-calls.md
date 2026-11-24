---
'@polygonlabs/maticjs': patch
---

Fix: values read from a contract are now validated against the contract's ABI before the SDK uses them, and the SDK's own contract calls are checked against the ABIs at compile time.

The transactions the SDK builds are byte-for-byte the same, and no documented API changes. Two things you could observe do change:

- **A malformed read now fails cleanly.** When a node, or a custom adapter, returns a value that does not match the contract's ABI, the call rejects with `BridgeEventDecodeFailedError`, whose `info.field` names the method and field. Before, such a value could surface as a `TypeError` or `SyntaxError`, or be used as it was. A read now returns the same value on viem, ethers v5 and ethers v6.
- **The `caller` members are no longer exposed.** `rootChainManager.caller`, `rootChain.caller` and the gas swapper's `caller` were marked `@internal` and documented as not part of the public API. They are now private and absent from the type declarations. If you were reaching through them, call the contract with your own client and the ABIs from `@polygonlabs/maticjs/abi`.
