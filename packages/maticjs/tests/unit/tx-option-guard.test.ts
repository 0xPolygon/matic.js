/**
 * Transaction options that are not a plain object must reject the call with
 * `TxOptionNotObjectError`, as 3.x did. Plain-JS callers can pass a string,
 * an array or `null`; without the guard those read as "no overrides" or fail
 * with an unrelated TypeError far from the cause.
 *
 * The guard fires before any collaborator is touched, so the adapter, bridge
 * and root-chain-manager stubs are never reached.
 */
import { describe, expect, it } from 'vitest';

import type { Adapter } from '../../src/adapter.ts';
import type { POSBridgeHelpers } from '../../src/internal/pos-bridge-helpers.ts';
import type { RootChainManager } from '../../src/pos/root_chain_manager.ts';

import { TxOptionNotObjectError } from '../../src/errors.ts';
import { encodeAbiParameters } from '../../src/internal/abi-encode.ts';
import { noopLogger } from '../../src/logger.ts';
import { ERC20 } from '../../src/pos/erc20.ts';

const TOKEN = '0x5555555555555555555555555555555555555555' as const;
const USER = '0x7777777777777777777777777777777777777777';

const adapter = {} as Adapter;
const token = new ERC20({
  tokenAddress: TOKEN,
  isParent: true,
  adapter,
  bridge: {} as POSBridgeHelpers,
  rootChainManager: {} as RootChainManager,
  parentAdapter: adapter,
  encodeParameters: encodeAbiParameters,
  logger: noopLogger
});

const BAD_OPTIONS: readonly [label: string, value: never, received: string][] = [
  ['string', 'x' as never, 'string'],
  ['array', [] as never, 'array'],
  ['null', null as never, 'null']
];

const rejection = async (call: () => Promise<unknown>): Promise<unknown> => {
  let pending: Promise<unknown> | undefined;
  expect(() => {
    pending = call();
  }).not.throw();
  expect(pending).instanceOf(Promise);
  return pending?.then(
    () => undefined,
    (e: unknown) => e
  );
};

// Each public method rejects with its operation error; the options guard is
// the condition in its cause chain.
const CALLS: readonly [
  operation: string,
  operationError: string,
  call: (options: never) => Promise<unknown>
][] = [
  ['transfer', 'TransferError', (options) => token.transfer(1n, USER, options)],
  ['approve', 'ApproveError', (options) => token.approve(1n, options)],
  ['prepareApprove', 'ApproveError', (options) => token.prepareApprove(1n, options)],
  ['getAllowance', 'TokenReadError', (options) => token.getAllowance(USER, options)]
];

describe('ERC20 rejects non-object transaction options', () => {
  for (const [label, value, received] of BAD_OPTIONS) {
    for (const [operation, operationError, call] of CALLS) {
      it(`${operation} rejects ${label} options as ${operationError}`, async () => {
        const err = await rejection(() => call(value));
        expect(TxOptionNotObjectError.has(err)).equals(true);
        expect(TxOptionNotObjectError.find(err)).property('info').property('received', received);
        expect(err).property('name').equals(operationError);
        expect(err).nested.property('info.operation', operation);
      });
    }
  }
});
