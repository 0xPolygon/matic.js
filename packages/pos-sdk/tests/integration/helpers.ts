/**
 * Shared helpers for the integration suite.
 *
 * The functions here read the `POS_SDK_TEST_*` environment variables
 * into a typed bundle. Each integration test reads that bundle, builds
 * the relevant per-library adapter via its factory (`viemAdapter` /
 * `ethersV5Adapter` / `ethersV6Adapter`), and threads it into a
 * `POSClient.init` call (or constructs an adapter directly for the
 * adapter-parity tests).
 *
 * # No mocks
 *
 * Every adapter built here talks to the real Sepolia / Amoy testnets.
 * The only conditional logic is the `HAS_CREDS` gate that lets a
 * `describe.skipIf(!HAS_CREDS)` skip when the env is unset.
 */
import type { Hex } from '../../src/index.js';

/** True when every required env var is set; used as the `skipIf` guard. */
export const HAS_CREDS =
  typeof process.env['POS_SDK_TEST_PRIVATE_KEY'] === 'string' &&
  process.env['POS_SDK_TEST_PRIVATE_KEY'] !== '' &&
  typeof process.env['POS_SDK_TEST_PARENT_RPC'] === 'string' &&
  process.env['POS_SDK_TEST_PARENT_RPC'] !== '' &&
  typeof process.env['POS_SDK_TEST_CHILD_RPC'] === 'string' &&
  process.env['POS_SDK_TEST_CHILD_RPC'] !== '';

/** True iff the operator opted into the long-running e2e cycle test. */
export const E2E_ENABLED = process.env['POS_SDK_TEST_E2E_ENABLED'] === 'true';

/**
 * Read an env var that must be present. The integration tests gate
 * themselves on `HAS_CREDS`, so this is only reachable inside a
 * `describe.skipIf(!HAS_CREDS)` body — meaning it never throws in
 * practice. The check exists to keep type narrowing strict without
 * sprinkling non-null assertions through every call site.
 */
export function envOrThrow(name: string): string {
  const v = process.env[name];
  if (typeof v !== 'string' || v === '') {
    throw new Error(`Required env var ${name} is unset`);
  }
  return v;
}

export interface ChainEnv {
  parentRpc: string;
  childRpc: string;
  privateKey: Hex;
}

/**
 * Read the test env into a typed bundle. Called once per integration
 * file (inside the skip-gated describe).
 */
export function readChainEnv(): ChainEnv {
  const pk = envOrThrow('POS_SDK_TEST_PRIVATE_KEY');
  if (!pk.startsWith('0x')) {
    throw new Error('POS_SDK_TEST_PRIVATE_KEY must be 0x-prefixed');
  }
  return {
    parentRpc: envOrThrow('POS_SDK_TEST_PARENT_RPC'),
    childRpc: envOrThrow('POS_SDK_TEST_CHILD_RPC'),
    privateKey: pk as Hex
  };
}

/**
 * Read env when creds are present; otherwise return a non-null
 * placeholder so the surrounding `describe.skipIf(!HAS_CREDS)` body's
 * test callbacks are still type-safe to compile. The placeholder is
 * never reached at runtime — the skip gate ensures no `it()` body
 * executes — but TypeScript doesn't model `skipIf`, so a sentinel keeps
 * the code free of `!` non-null assertions.
 */
export function readChainEnvOrPlaceholder(): ChainEnv {
  if (HAS_CREDS) return readChainEnv();
  return {
    parentRpc: 'http://placeholder',
    childRpc: 'http://placeholder',
    privateKey: ('0x' + '00'.repeat(32)) as Hex
  };
}

/**
 * Sanity check used by every integration file: emits a single warning
 * line if `HAS_CREDS` is false. Vitest reports skipped tests, so this
 * is a developer-aid log rather than a critical signal.
 */
export function noteSkippedIfNoCreds(label: string): void {
  if (!HAS_CREDS) {
    process.stderr.write(
      `[pos-sdk integration] ${label} skipped — POS_SDK_TEST_* env unset\n`
    );
  }
}
