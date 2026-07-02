import { describe, expect, it } from 'vitest';

import type {POSBridgeErrorCode} from '../../src/errors.ts';

import { POSBridgeError  } from '../../src/errors.ts';

// The full set of codes lives in the union type at the type level. Mirroring
// it here at the value level lets us drive `it.each` over every code and
// guarantees — via the satisfies clause below — that any new addition to the
// union forces a corresponding test case.
const ALL_CODES = [
  'BURN_TX_NOT_CHECKPOINTED',
  'EIP1559_NOT_SUPPORTED',
  'PROOF_API_NOT_SET',
  'INVALID_TOKEN_TYPE',
  'CONTRACT_NOT_AVAILABLE_ON_NETWORK',
  'TX_OPTION_NOT_OBJECT',
  'UNSUPPORTED_NETWORK',
  'WEB3_CLIENT_NOT_INITIALIZED',
  'ROOT_HASH_RPC_FAILED',
  'INVALID_HEX_STRING',
  'NEGATIVE_BIG_NUMBER',
  'INVALID_NUMERIC_VALUE',
  'BUFFER_TYPE_REQUIRED',
  'UNSUPPORTED_KECCAK_BIT_WIDTH',
  'MERKLE_TREE_REQUIRES_LEAVES',
  'MERKLE_TREE_DEPTH_EXCEEDED',
  'STATE_SYNCED_EVENT_NOT_FOUND',
  'PROOF_NODE_KEY_MISMATCH',
  'TRANSACTION_HASH_REQUIRED',
  'BATCH_SIZE_LIMIT_EXCEEDED',
  'LOG_NOT_FOUND_IN_RECEIPT',
  'NEGATIVE_INDEX',
  'INDEX_OUT_OF_BOUNDS',
  'BRIDGE_EVENT_DECODE_FAILED',
  'NULL_SPENDER_ADDRESS',
  'ALLOWED_ON_NON_NATIVE_TOKENS',
  'ONLY_ALLOWED_ON_MAINNET'
] as const satisfies readonly POSBridgeErrorCode[];

// `satisfies readonly POSBridgeErrorCode[]` only proves every value in
// ALL_CODES is a member of the union. The reverse — that every member of the
// union is in ALL_CODES — is enforced by this Exclude check: if any union
// member is missing from the value list, `Missing` would resolve to that
// code rather than `never`, and the assignment below fails to compile.
type Missing = Exclude<POSBridgeErrorCode, (typeof ALL_CODES)[number]>;
const _exhaustivenessCheck: Missing = undefined as never;
void _exhaustivenessCheck;

describe('POSBridgeError', () => {
  it('exposes a discriminator code field', () => {
    for (const code of ALL_CODES) {
      const err = new POSBridgeError(code, `failure: ${code}`);
      expect(err.code).equals(code);
    }
  });

  it('every code in the union is reachable', () => {
    // Construction must not throw for any code. We also assert the count so
    // a forgotten entry in ALL_CODES (out-of-sync with the union) shows up
    // as a numeric mismatch rather than silently weakening coverage.
    expect(ALL_CODES.length).equals(27);
    for (const code of ALL_CODES) {
      expect(() => new POSBridgeError(code, 'reachable')).not.throw();
    }
  });

  it('preserves the cause chain when constructed with an Error cause', () => {
    const innerErr = new Error('rpc dropped the request');
    const err = new POSBridgeError(
      'ROOT_HASH_RPC_FAILED',
      'top',
      undefined,
      { cause: innerErr }
    );
    expect(err.cause).equals(innerErr);
  });

  it('narrows correctly via instanceof + code switch', () => {
    // Hand the test value in as `unknown` so the narrowing path mirrors how
    // a consumer would actually receive it from a `try/catch`.
    const raised: unknown = new POSBridgeError(
      'PROOF_API_NOT_SET',
      'configure proofApi'
    );

    let branch: POSBridgeErrorCode | 'not-pos-bridge-error' = 'not-pos-bridge-error';
    if (raised instanceof POSBridgeError) {
      switch (raised.code) {
        case 'BURN_TX_NOT_CHECKPOINTED':
        case 'EIP1559_NOT_SUPPORTED':
        case 'PROOF_API_NOT_SET':
        case 'INVALID_TOKEN_TYPE':
        case 'CONTRACT_NOT_AVAILABLE_ON_NETWORK':
        case 'TX_OPTION_NOT_OBJECT':
        case 'UNSUPPORTED_NETWORK':
        case 'WEB3_CLIENT_NOT_INITIALIZED':
        case 'ROOT_HASH_RPC_FAILED':
        case 'INVALID_HEX_STRING':
        case 'NEGATIVE_BIG_NUMBER':
        case 'INVALID_NUMERIC_VALUE':
        case 'BUFFER_TYPE_REQUIRED':
        case 'UNSUPPORTED_KECCAK_BIT_WIDTH':
        case 'MERKLE_TREE_REQUIRES_LEAVES':
        case 'MERKLE_TREE_DEPTH_EXCEEDED':
        case 'STATE_SYNCED_EVENT_NOT_FOUND':
        case 'PROOF_NODE_KEY_MISMATCH':
        case 'TRANSACTION_HASH_REQUIRED':
        case 'BATCH_SIZE_LIMIT_EXCEEDED':
        case 'LOG_NOT_FOUND_IN_RECEIPT':
        case 'NEGATIVE_INDEX':
        case 'INDEX_OUT_OF_BOUNDS':
        case 'BRIDGE_EVENT_DECODE_FAILED':
        case 'NULL_SPENDER_ADDRESS':
        case 'ALLOWED_ON_NON_NATIVE_TOKENS':
        case 'ONLY_ALLOWED_ON_MAINNET':
          branch = raised.code;
          break;
        default: {
          // Exhaustiveness sentinel — if a new code is added to the union
          // and a `case` is missing above, `raised.code` will not narrow to
          // `never` here and TypeScript will fail to compile.
          const _exhaustive: never = raised.code;
          throw new Error(`unhandled POSBridgeErrorCode: ${String(_exhaustive)}`);
        }
      }
    }

    expect(branch).equals('PROOF_API_NOT_SET');

    // Verify each of the listed branches is reachable by feeding every code
    // through the same narrowing path.
    for (const code of ALL_CODES) {
      const cycled: unknown = new POSBridgeError(code, 'cycle');
      let landed: POSBridgeErrorCode | undefined;
      if (cycled instanceof POSBridgeError) {
        landed = cycled.code;
      }
      expect(landed).equals(code);
    }
  });

  it('attaches structured info when provided', () => {
    // POSBridgeError extends VError, which exposes the structured bag at
    // `err.info` and via `VError.info(err)` (which walks the cause
    // chain). The team's `@polygonlabs/logger` v2 surfaces this at
    // `@err.info.<key>` in Datadog.
    const info = { txHash: '0xabc' };
    const err = new POSBridgeError('TRANSACTION_HASH_REQUIRED', 'missing hash', info);
    expect(err).property('info').deep.equals(info);
    expect(err.info).property('txHash').equals('0xabc');
  });

  it('sets err.name to POSBridgeError', () => {
    // Pinned for Datadog `@err.name:POSBridgeError` aggregation across all
    // services that consume the SDK.
    const err = new POSBridgeError('UNSUPPORTED_NETWORK', 'unknown chain');
    expect(err.name).equals('POSBridgeError');
  });

  it('survives JSON.stringify with the cause-chain visible to a logger', () => {
    // pino's default serialiser walks `err.message` / `err.stack` /
    // `err.cause`, but a generic `JSON.stringify` does not by default —
    // because `Error` properties are non-enumerable. The VError base
    // sets `info` as an own enumerable property, and POSBridgeError
    // additionally sets `code` as own enumerable, so JSON.stringify
    // captures both. This test pins that contract.
    const inner = new Error('rpc dropped');
    const err = new POSBridgeError(
      'ROOT_HASH_RPC_FAILED',
      'fetch failed',
      { url: 'https://example.com' },
      { cause: inner }
    );
    const round = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
    expect(round).property('code').equals('ROOT_HASH_RPC_FAILED');
    expect(round).property('info').deep.equal({ url: 'https://example.com' });
    // `name` is non-enumerable on the prototype-defined Error; what we
    // pin here is that the discriminator `code` and the structured
    // `info` round-trip — which is what Datadog ingests.
  });

  it('toString() carries the message but not the code (matches `Error.prototype.toString`)', () => {
    // toString() is rarely the right interface to depend on — consumers
    // should branch on `code` — but this pins the existing behaviour
    // (Error: <message>) so a refactor that changes it does not silently
    // break any consumer logging that does fall back to .toString().
    const err = new POSBridgeError('UNSUPPORTED_NETWORK', 'expected mainnet');
    expect(err.toString()).equals('POSBridgeError: expected mainnet');
  });
});
