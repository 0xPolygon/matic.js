---
'@maticnetwork/maticjs': patch
---

Disable HTTP keep-alive on the network-config and ABI metadata fetches to fix intermittent `FetchError: Premature close` failures.

Node 19+ enables HTTP keep-alive by default. node-fetch then reuses a connection the upstream CDN has already idle-closed, and the next gzip response fails mid-decompression — surfacing as the misleading `network <net> - <ver> is not supported`. It reproduces 100% from datacenter/CI egress and intermittently elsewhere. These fetches run once per client init and are cached, so opening a fresh connection per request only costs a TLS handshake at startup. This complements the transient-retry added in #481, which could not recover when every reused socket was already stale. The browser build is unaffected (`window.fetch` ignores the agent).
