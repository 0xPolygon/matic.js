---
'@maticnetwork/maticjs': patch
---

Surface the real cause when network/ABI metadata fails to load. `HttpRequest` now checks `res.ok` and reports the HTTP status plus a body snippet (and flags non-JSON responses) instead of letting `res.json()` throw a context-free parse error, and `Web3SideChainClient.init` preserves that underlying error — as the message and as `cause` — rather than discarding it and rethrowing a bare `network <x> - <v> is not supported`. A transport or CDN failure (non-2xx, HTML error/challenge page, timeout) is now diagnosable instead of masquerading as an unsupported network.
