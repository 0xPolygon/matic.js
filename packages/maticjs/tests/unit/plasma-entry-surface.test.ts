/**
 * Where the Plasma-only errors and event topics are exported from. They are
 * defined in `errors.ts` and `plasma/events.ts` so the ownership gate and the
 * name arrays keep one source of truth; what moves is which entry exports
 * them, and the root entry must keep recognising errors it no longer exports.
 */
import { describe, expect, it } from 'vitest';

import * as root from '../../src/index.ts';
import * as plasma from '../../src/plasma/index.ts';

const PLASMA_ERROR_NAMES = [
  'ExitNotStartedError',
  'ExitQueueEmptyError',
  'ExitGasLimitTooLowError',
  'NativeBurnValueMismatchError',
  'ChildBurnValueNotAllowedError'
] as const;

/** The classes as the Plasma entry exports them, by name. */
const CLASSES: Record<
  (typeof PLASMA_ERROR_NAMES)[number],
  { find: (err: unknown) => unknown; has: (err: unknown) => boolean }
> = {
  ExitNotStartedError: plasma.ExitNotStartedError,
  ExitQueueEmptyError: plasma.ExitQueueEmptyError,
  ExitGasLimitTooLowError: plasma.ExitGasLimitTooLowError,
  NativeBurnValueMismatchError: plasma.NativeBurnValueMismatchError,
  ChildBurnValueNotAllowedError: plasma.ChildBurnValueNotAllowedError
};

/** One real instance per class, built through the Plasma entry only. */
const instances = [
  new plasma.ExitNotStartedError('exit not started', {
    info: { burnTxHash: '0xaa', confirmTxHash: '0xbb', reason: 'no-exit-started-log' }
  }),
  new plasma.ExitQueueEmptyError('queue empty', { info: { tokens: ['0xcc'] } }),
  new plasma.ExitGasLimitTooLowError('gas too low', { info: { gasLimit: 1n, minimum: 2n } }),
  new plasma.NativeBurnValueMismatchError('value mismatch', { info: { amount: 1n, value: 2n } }),
  new plasma.ChildBurnValueNotAllowedError('value not allowed', { info: { value: 1n } })
];

describe('the root entry does not export what only Plasma raises', () => {
  it.each(PLASMA_ERROR_NAMES)('has no %s', (name) => {
    expect(root).not.property(name);
  });

  it('keeps the seven 4.0.0 keys on LogEventSignature', () => {
    expect(Object.keys(root.LogEventSignature)).deep.equals([
      'StateSynced',
      'Erc20Transfer',
      'Erc721Transfer',
      'Erc1155Transfer',
      'Erc721BatchTransfer',
      'Erc1155BatchTransfer',
      'Erc721TransferWithMetadata'
    ]);
  });
});

describe('the Plasma entry exports them and the root entry still recognises them', () => {
  it.each(PLASMA_ERROR_NAMES)('exports %s', (name) => {
    expect(CLASSES[name]).property('find').a('function');
  });

  it('builds one instance per class in the order the names are listed', () => {
    expect(instances.map((e) => e.name)).deep.equals([...PLASMA_ERROR_NAMES]);
  });

  it.each(PLASMA_ERROR_NAMES.map((name, at) => [name, at] as const))(
    '%s is in the root MATICJS_ERROR_NAMES and recognised by the root isMaticjsError',
    (name, at) => {
      expect(root.MATICJS_ERROR_NAMES).include(name);
      expect(root.isMaticjsError(instances[at])).equals(true);
    }
  );

  it.each(PLASMA_ERROR_NAMES.map((name, at) => [name, at] as const))(
    '%s.find locates the error when it is thrown through the Plasma entry and wrapped',
    (name, at) => {
      const cause = instances[at];
      const wrapped = new plasma.ExitError({
        cause,
        info: { operation: 'completeWithdraw', mode: 'write' }
      });
      const found = CLASSES[name].find(wrapped);
      expect(found).property('name').equals(name);
      expect(found).property('info').deep.equals(cause?.info);
      expect(CLASSES[name].has(wrapped)).equals(true);
      expect(CLASSES[name].has(new Error('plain'))).equals(false);
    }
  );

  it('shares MATICJS_ERROR_NAMES, isMaticjsError and rootCause with the root entry', () => {
    expect(plasma.MATICJS_ERROR_NAMES).equals(root.MATICJS_ERROR_NAMES);
    expect(plasma.isMaticjsError).equals(root.isMaticjsError);
    expect(plasma.rootCause).equals(root.rootCause);
  });
});

describe('PlasmaEventSignature', () => {
  it('is exported from the Plasma entry only, with the two topics the bridge reads', () => {
    expect(root).not.property('PlasmaEventSignature');
    expect(Object.keys(plasma.PlasmaEventSignature)).deep.equals(['Erc20Withdraw', 'ExitStarted']);
  });
});
