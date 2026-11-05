---
'@polygonlabs/maticjs': patch
---

Fewer third-party runtime dependencies and a smaller install: a fresh `npm install` of the SDK, without the optional `viem` or `ethers` peers, now brings in 12 packages and about 9.2 MB instead of 22 packages and about 16.2 MB. Produced exit payloads are byte-for-byte unchanged.

- The legacy `rlp` package is replaced by `@ethereumjs/rlp`, which the Merkle Patricia trie dependency already installs.
- `ethereum-cryptography` is replaced by `@noble/hashes`, which the Merkle Patricia trie dependency already installs.
- The concurrency limiter (`p-limit` and its queue, `yocto-queue`) is now bundled verbatim instead of installed, with its MIT attribution in `THIRD_PARTY_NOTICES.md`.
- Third-party runtime dependencies are pinned to exact versions.
- Malformed block-proof strings from the optional proof API now throw instead of being partially encoded.
