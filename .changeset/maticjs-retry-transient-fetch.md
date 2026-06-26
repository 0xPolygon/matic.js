---
'@maticnetwork/maticjs': patch
---

Retry transient network failures when fetching network/ABI metadata. The config-store fetch (`ABIManager.init` → `HttpRequest`) now retries connection-level errors with exponential backoff, fixing intermittent `Premature close` / `ECONNRESET` failures from stale keep-alive sockets (Node 19+ keeps HTTP connections alive by default) that previously surfaced as a misleading "network mainnet - v1 is not supported". The retry/backoff and transient-error classification are extracted into a shared `retryTransient` helper now used by both the metadata fetch and the receipt-proof RPC reads (replacing the bespoke inline retry in `getReceiptProof`); the shared classifier also recognises node-fetch's `Premature close`, which the old inline predicate missed.
