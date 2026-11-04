import { describe, expect, it } from 'vitest';

import { POSBridgeError } from '../../src/errors.ts';

/**
 * Pins the 0.x error-string compatibility contract (go-live review,
 * major): the old SDK threw plain `{ message, type }` objects with
 * lowercase-snake `ERROR_TYPE` strings, and consumer switches keyed on
 * `err.type` must keep working through the migration. Every condition
 * that existed in 0.x carries the EXACT legacy string — including the
 * two historical typos — on `err.type`; new-in-1.0 conditions carry
 * none. These strings are frozen: changing any value here is a breaking
 * change for migrated consumers.
 */

const LEGACY_CASES = [
  ['ALLOWED_ON_ROOT', 'allowed_on_root'],
  ['ALLOWED_ON_CHILD', 'allowed_on_child'],
  ['PROOF_API_NOT_SET', 'proof_api_not_set'],
  // Historical typo in 0.x, preserved verbatim on purpose.
  ['TX_OPTION_NOT_OBJECT', 'transation_object_not_object'],
  ['BURN_TX_NOT_CHECKPOINTED', 'burn_tx_not_checkpointed'],
  ['EIP1559_NOT_SUPPORTED', 'eip-1559_not_supported'],
  ['NULL_SPENDER_ADDRESS', 'null_spender_address'],
  // Historical singular form in 0.x, preserved verbatim on purpose.
  ['ALLOWED_ON_NON_NATIVE_TOKENS', 'allowed_on_non_native_token'],
  ['ONLY_ALLOWED_ON_MAINNET', 'allowed_on_mainnet'],
  ['CONTRACT_NOT_AVAILABLE_ON_NETWORK', 'bridge_adapter_address_not_passed']
] as const;

describe('POSBridgeError legacy `type` strings (0.x ERROR_TYPE parity)', () => {
  for (const [code, legacyType] of LEGACY_CASES) {
    it(`${code} carries legacy type '${legacyType}'`, () => {
      const err = new POSBridgeError(code, 'x');
      expect(err).property('type').equals(legacyType);
    });
  }

  it('new-in-1.0 codes carry no legacy type', () => {
    const err = new POSBridgeError('BRIDGE_EVENT_DECODE_FAILED', 'x');
    expect(err.type).equals(undefined);
  });

  it('legacy type survives a JSON round-trip alongside code', () => {
    const err = new POSBridgeError('BURN_TX_NOT_CHECKPOINTED', 'not yet');
    const parsed = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
    expect(parsed).property('code').equals('BURN_TX_NOT_CHECKPOINTED');
    expect(parsed).property('type').equals('burn_tx_not_checkpointed');
  });
});
