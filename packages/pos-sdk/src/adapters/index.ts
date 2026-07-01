// Public surface of the adapter layer's shared helpers.
//
// The individual adapters (viem / ethers v5 / ethers v6) are NOT
// re-exported here — each lives behind its own package subpath
// (`@polygonlabs/pos-sdk/viem`, `/ethers-v5`, `/ethers-v6`) so a
// consumer pulls in only the web3 library they actually use. This
// barrel intentionally imports none of them, keeping the main entry
// free of any viem / ethers value-import.
//
// `sanitiseError` is exposed because consumer error-handling paths
// (Sentry forwarders, custom log middleware) need to redact RPC tokens
// from errors that bubble up through the SDK. It has no web3 dependency,
// so it is safe to surface from the main entry.

export { sanitiseError } from './sanitise.js';
