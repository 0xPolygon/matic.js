# AGENTS.md

Instructions for anyone, human or agent, changing this repository. `CLAUDE.md`
imports this file, so every agent reads the same rules.

## Orientation

This is the monorepo for `@polygonlabs/maticjs`, the TypeScript SDK for the
Polygon PoS bridge and staking over viem, ethers v5 or ethers v6. The SDK
lives in `packages/maticjs` (source in `src`, the per-library adapters in
`src/adapters`, tests in `tests`). `packages/test-app` is a private browser
smoke test of the built package, and `examples` holds standalone consumer
scripts outside the workspace. Releases are versioned with changesets
(`.changeset`). For commands, read the `scripts` of the root `package.json`
and of each package's `package.json`, rather than relying on a copy here.

## Error ownership (mandatory)

- **An SDK error is thrown only for a condition the SDK's own code
  detected.**
- **Any error from ethers, viem, the wallet or the RPC transport is rethrown
  exactly as it came:**
  - never wrapped in an SDK class;
  - never used as the `cause` of an SDK error;
  - never cloned or altered.
- Consumers handle library errors with their library's own idioms.
- The guarantee in `packages/maticjs/README.md` ("Errors"), that errors from
  ethers, viem, your wallet or your RPC transport are rethrown unchanged, is
  a public contract. Changing it is a breaking change to the API.

**The test of any change:** "if the thing that failed is code we do not own,
we do not throw our error."

Why:

- Ownership should match the error's type. An SDK error class tells the
  consumer the SDK found the problem; on a library failure that is false.
- The adapters exist so consumers keep their library's error handling: the
  codes, classes and fields they already branch on (`4001`, `CALL_EXCEPTION`,
  viem's `BaseError.walk`).
- The SDK cannot faithfully re-expose three libraries' error models. Any
  wrapper loses or misstates part of one of them.

The only allowed causes on SDK errors are the SDK's own fetch and parse
failures: the network error and JSON parse error from the SDK's own HTTP
helper, and the errors of the URL, quantity and hex parsers it calls. The
operation wrapper may also carry an SDK error it raised itself. No adapter
sets a cause.

History: an earlier version minted SDK error codes from `wait()` errors, and
a later rework generalised that to wrapping every downstream error. Both were
reverted.

### Enforcement

Two checks enforce this rule. Both must stay green, and neither may be
weakened, loosened or narrowed to make a change pass:

- The identity falsification tests,
  `packages/maticjs/tests/unit/falsification-passthrough.test.ts`,
  `falsification-wallet.test.ts`, `falsification-revert.test.ts` and
  `falsification-rpc.test.ts` in the same directory. On viem, ethers v5 and
  ethers v6 they assert that a wallet rejection, an `estimateGas` revert, a
  `wait()` revert, a `wait()` replacement and a node error during the fee
  lookup reach the consumer as the very object the library threw. viem
  raises no error for a mined revert or a replacement, so for viem those two
  are SDK conditions, and the tests assert that no library error sits in
  their cause chain.
- The static gate, `packages/maticjs/scripts/check-error-ownership.mjs`. It
  fails on a `cause` or an SDK error class built in an error handler that
  checks an ethers or viem error, on any `cause` in `src/adapters`, and on
  any `cause` site missing from its allowlist. The allowlist lives in that
  script and nowhere else. `tests/unit/no-library-cause.test.ts` runs it in
  CI, and `pnpm --filter @polygonlabs/maticjs run check:error-ownership`
  runs it by hand.

A new `cause` site in `src` must be one of the SDK's own fetch or parse
failures, added to the gate's allowlist with a one-line reason.

## Status reads answer with a reason, they don't throw (mandatory)

One method per question, and it returns the answer together with why: an
object with the answer plus a string-literal `reason` (never a numeric code).
Do not add a boolean predicate beside a status read. Two calls can disagree
(the chain moves between them), and every caller then has to combine them.

- `is*` / `has*` is only for a reasonless chain fact (`isApproved`,
  `isApprovedAll`, `isExitProcessed`, `isLocked`) and always resolves a
  boolean, `false` when unmet.
- A method that returns an object is never named `is*`: an object is always
  truthy, so `if (await isCheckpointed(x))` would silently pass.
- Errors are only for what the SDK cannot resolve: invalid input (an empty
  hash, a negative index, a bad address), a transaction that does not exist,
  and ethers, viem, wallet and RPC failures, rethrown unchanged under "Error
  ownership". The answer is never an error.
- Methods that REQUIRE the condition (`completeWithdraw`, `buildExitPayload`,
  `exit`, `replayDeposit`) keep rejecting with the condition error when it is
  unmet.

Example: `pos.getCheckpointStatus(burnTx)` resolves `{ checkpointed: true }`,
or `{ checkpointed: false, reason: 'pending' | 'not-checkpointed' }`; it does
not reject with `BurnTxNotCheckpointedError`. `buildExitPayload` on the same
burn still does.

A status read whose unmet answer has a remedy in the SDK names it in its JSDoc
(`'delivery-failed'` → `replayDeposit`), so a reader of the types is led to the
fix rather than to the contracts.

Enforced by `packages/maticjs/tests/unit/status-reads.test.ts`. Its
registries must list every `is*` / `has*` method (each resolves `false` when
unmet and declares a boolean return type) and every `get*Status` method (a
case per reason value, returned without throwing), so a new one without a
test fails CI.
