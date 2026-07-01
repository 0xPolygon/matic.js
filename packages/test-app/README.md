# @polygonlabs/pos-sdk-test-app

Browser smoke test for `@polygonlabs/pos-sdk`.

This is a private workspace package (`private: true`) that loads the
SDK's ESM bundle into a real Chromium browser via Playwright and asserts
that every public symbol is reachable, callable, and produces the
expected output without tripping any Node-only globals (`Buffer`,
`process`, `crypto.randomBytes`, …).

## Why this exists

The two SDKs are bundled by tsup and shipped to consumers as ESM. The
intent is browser-safe — the public surface is provider-agnostic and
all crypto routes through `ethereum-cryptography` (which uses
`@noble/hashes`, browser-safe by design). But "this code path doesn't
*reference* a Node global" is not the same as "this code path doesn't
*evaluate* one at runtime", and the only reliable way to verify the
latter is to load the bundled output into a real browser. That is what
this package does.

The Vite build deliberately does **not** install
`vite-plugin-node-polyfills` or any `Buffer` / `process` shim. The
realistic deployment surface for these SDKs is a Vite app whose author
did not opt into Node polyfills; that is the configuration we test.

## Running locally

The SDKs must be built first because the test app consumes the
published `dist/` bundles via the workspace's `exports` map (no
`@polygonlabs/source` condition is configured in this repo).

```sh
# from the repo root
pnpm install
pnpm -r run build
pnpm --filter @polygonlabs/pos-sdk-test-app run typecheck
pnpm --filter @polygonlabs/pos-sdk-test-app run build
pnpm --filter @polygonlabs/pos-sdk-test-app run test
```

Iterating against a live page:

```sh
pnpm --filter @polygonlabs/pos-sdk-test-app run dev
# open the printed URL; the smoke harness writes its result blob into
# the `#result` element on load.
```

## Playwright browsers

`pnpm run test` requires the Playwright Chromium binary. If it is
absent, the spec auto-skips with a remediation message instead of
failing. Install once per machine:

```sh
pnpm exec playwright install --with-deps chromium
```

CI is expected to run the same install step before invoking the test.

## What gets exercised

- `POSClient.init({ … })` with a viem parent + child config and a
  pre-resolved `addresses` override (so no CDN fetch is made).
- `pos.parent.erc20(addr).prepareApprove(amount, { spenderAddress })`
  to drive the dynamic-imported viem `encodeFunctionData` path.
- `POSBridgeError` instantiation with `code` + `context` + `cause`,
  asserting all three are reachable.
- `sanitiseError(err)` on a synthetic RPC URL containing a `?token=…`
  query and asserting the token is redacted to `***`.
- `noopLogger` — every method is invoked.
- `createAddressFetcher`'s initial-override path, exercised
  transparently by the second `prepareApprove` call (no second CDN
  fetch — the cached value is returned).
- `keccak256` from `ethereum-cryptography/keccak` — the same module
  the SDK adapter delegates to. Verifies the noble-hashes path
  bundles for the browser.

The Playwright spec also captures every `console.error` and `pageerror`
during the run; any of those fail the test. That is the catch-all
mechanism for `Buffer is not defined`-class regressions.
