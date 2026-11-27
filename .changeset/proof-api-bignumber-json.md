---
'@polygonlabs/maticjs': patch
---

The slow exit path now uses the proof-generation API's checkpoint lookup when `proofGenerationApiUrl` is set

The API's `block-included` endpoint returns `start` and `end` as ethers BigNumber JSON (`{"type":"BigNumber","hex":"0x…"}`), which the client rejected as "not a number". Every slow-path exit (`completeWithdraw`, or `buildExitPayload` with `isFast` false) then logged a warning and looked the checkpoint up on-chain instead. The results were correct, but the API never helped. The client now accepts that shape alongside plain numbers and numeric strings. Responses that are genuinely malformed are still rejected, with the same warning and on-chain fallback.
