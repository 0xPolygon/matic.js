import { describe, expect, it } from 'vitest';

import type { LegacyErrorType } from '../../src/errors.ts';

import {
  AllowedOnChildError,
  AllowedOnRootError,
  BridgeEventDecodeFailedError,
  BurnTxNotCheckpointedError,
  ContractNotAvailableOnNetworkError,
  Eip1559NotSupportedError,
  NullSpenderAddressError,
  OnlyAllowedOnMainnetError,
  ProofApiNotSetError,
  TxOptionNotObjectError
} from '../../src/errors.ts';

/**
 * Pins the 0.x error-string compatibility contract: the old SDK threw plain
 * `{ message, type }` objects with lowercase-snake `ERROR_TYPE` strings, and
 * consumer switches keyed on `err.type` must keep working. Every condition
 * that existed in 0.x and can still be raised carries the EXACT legacy
 * string — including the historical `transation` typo — on `err.type`;
 * new conditions carry none. These strings are frozen: changing any value
 * here is a breaking change for migrated consumers.
 */

const TOKEN = `0x${'11'.repeat(20)}` as const;

const LEGACY_CASES: Array<[string, () => { type?: LegacyErrorType }, LegacyErrorType]> = [
  [
    'AllowedOnRootError',
    () =>
      new AllowedOnRootError('x', { info: { action: 'a', isParent: false, tokenAddress: TOKEN } }),
    'allowed_on_root'
  ],
  [
    'AllowedOnChildError',
    () =>
      new AllowedOnChildError('x', { info: { action: 'a', isParent: true, tokenAddress: TOKEN } }),
    'allowed_on_child'
  ],
  ['ProofApiNotSetError', () => new ProofApiNotSetError('x'), 'proof_api_not_set'],
  // Historical typo in 0.x, preserved verbatim on purpose.
  [
    'TxOptionNotObjectError',
    () => new TxOptionNotObjectError('x', { info: { method: 'deposit', received: 'string' } }),
    'transation_object_not_object'
  ],
  [
    'BurnTxNotCheckpointedError',
    () => new BurnTxNotCheckpointedError('x'),
    'burn_tx_not_checkpointed'
  ],
  [
    'Eip1559NotSupportedError',
    () => new Eip1559NotSupportedError('x', { info: { chainId: 1, isParent: true } }),
    'eip-1559_not_supported'
  ],
  [
    'NullSpenderAddressError',
    () => new NullSpenderAddressError('x', { info: { tokenAddress: TOKEN } }),
    'null_spender_address'
  ],
  [
    'OnlyAllowedOnMainnetError',
    () => new OnlyAllowedOnMainnetError('x', { info: { chainId: 80002 } }),
    'allowed_on_mainnet'
  ],
  [
    'ContractNotAvailableOnNetworkError',
    () => new ContractNotAvailableOnNetworkError('x'),
    'bridge_adapter_address_not_passed'
  ]
];

describe('legacy `type` strings (0.x ERROR_TYPE parity)', () => {
  it('nine conditions carry a legacy type', () => {
    expect(LEGACY_CASES.length).equals(9);
  });

  it.each(LEGACY_CASES)('%s carries its legacy type', (_name, make, legacyType) => {
    expect(make()).property('type').equals(legacyType);
  });

  it('a condition new in 4.0 carries no legacy type', () => {
    const err = new BridgeEventDecodeFailedError('x');
    expect('type' in err).equals(false);
  });

  it.each(LEGACY_CASES)(
    '%s keeps its legacy type and name through JSON',
    (name, make, legacyType) => {
      const parsed: unknown = JSON.parse(JSON.stringify(make()));
      expect(parsed).property('type').equals(legacyType);
      expect(parsed).property('name').equals(name);
    }
  );
});
