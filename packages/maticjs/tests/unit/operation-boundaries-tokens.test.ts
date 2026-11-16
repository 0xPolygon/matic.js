/**
 * Every public async method of the token classes is driven twice against
 * collaborators whose every call fails:
 *
 * - with an SDK condition, it must reject with exactly one operation error
 *   named after the method the consumer called: the mapped operation error,
 *   `info.operation`, the condition reachable as the root cause, the token
 *   redacted from the top-level message, and no second operation layer;
 * - with a token-bearing library error (what an adapter's ethers or viem
 *   call throws), it must reject with that same object, unwrapped and with
 *   its message unaltered.
 *
 * Methods are found by reflection, so a public method added without a
 * boundary wrap (or without a row in the table below) fails this file
 * rather than slipping through.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Adapter } from '../../src/adapter.ts';
import type { POSBridgeHelpers } from '../../src/internal/pos-bridge-helpers.ts';
import type { GasSwapper } from '../../src/pos/gas_swapper.ts';
import type { RootChainManager } from '../../src/pos/root_chain_manager.ts';

import {
  AddressLookupError,
  ApproveError,
  CheckpointReadError,
  ConfirmationError,
  DepositError,
  ExitError,
  BridgeStatusError,
  InitError,
  isMaticjsError,
  PermitError,
  ProofBuildError,
  rootCause,
  StakingReadError,
  StakingWriteError,
  TokenReadError,
  TransferError,
  Web3ClientNotInitializedError,
  WithdrawStartError
} from '../../src/errors.ts';
import { noopLogger } from '../../src/logger.ts';
import { ERC20 } from '../../src/pos/erc20.ts';
import { ERC721 } from '../../src/pos/erc721.ts';
import { ERC1155 } from '../../src/pos/erc1155.ts';

const TOKEN = '0x5555555555555555555555555555555555555555' as const;
const USER = '0x7777777777777777777777777777777777777777';
const MINTABLE_PREDICATE = '0x4444444444444444444444444444444444444444';
const BURN_TX = `0x${'ab'.repeat(32)}`;

const BOOM = 'boom http://rpc/?token=S';

/**
 * What the failing collaborators throw: one library error object, so a test
 * can assert identity, or an SDK condition carrying the same text.
 */
const LIBRARY_ERROR = new Error(BOOM);
let failure: 'library' | 'condition' = 'condition';
const boom = (): Error =>
  failure === 'library'
    ? LIBRARY_ERROR
    : new Web3ClientNotInitializedError(BOOM, { info: { method: 'stub' } });

/** Any property read yields a function that rejects with `boom()`. */
const rejectingStub = (): object =>
  new Proxy(
    {},
    {
      get: () => () => Promise.reject(boom())
    }
  );

const OPERATION_CLASSES = [
  InitError,
  AddressLookupError,
  TokenReadError,
  CheckpointReadError,
  BridgeStatusError,
  ProofBuildError,
  ApproveError,
  DepositError,
  WithdrawStartError,
  ExitError,
  TransferError,
  ConfirmationError,
  StakingReadError,
  StakingWriteError,
  PermitError
];

const config = (isParent: boolean) => {
  const adapter = rejectingStub() as Adapter;
  return {
    tokenAddress: TOKEN,
    isParent,
    adapter,
    bridge: rejectingStub() as POSBridgeHelpers,
    rootChainManager: rejectingStub() as RootChainManager,
    gasSwapper: rejectingStub() as GasSwapper,
    parentAdapter: adapter,
    encodeParameters: () => '0x',
    logger: noopLogger,
    mintablePredicateAddress: MINTABLE_PREDICATE
  };
};

type Row = readonly [error: string, chain: 'parent' | 'child', args: readonly unknown[]];

type Suite = {
  name: string;
  file: string;
  prototype: object;
  make: (isParent: boolean) => object;
  /** TS-private helpers, which reflection still sees on the prototype. */
  privateMembers: readonly string[];
  rows: Readonly<Record<string, Row>>;
};

const single = { tokenId: 1n, amount: 1n, userAddress: USER };
const batch = { tokenIds: [1n], amounts: [1n], userAddress: USER };
const transfer1155 = { tokenId: 1n, amount: 1n, from: USER, to: USER };

const SUITES: readonly Suite[] = [
  {
    name: 'ERC20',
    file: 'erc20.ts',
    prototype: ERC20.prototype,
    make: (isParent) => new ERC20(config(isParent)),
    privateMembers: ['requireParent', 'requireChild', 'requireGasSwapper'],
    rows: {
      getBalance: ['TokenReadError', 'parent', [USER]],
      getAllowance: ['TokenReadError', 'parent', [USER]],
      approve: ['ApproveError', 'parent', [1n]],
      prepareApprove: ['ApproveError', 'parent', [1n]],
      approveMax: ['ApproveError', 'parent', []],
      prepareApproveMax: ['ApproveError', 'parent', []],
      deposit: ['DepositError', 'parent', [1n, USER]],
      prepareDeposit: ['DepositError', 'parent', [1n, USER]],
      depositWithGas: ['DepositError', 'parent', [1n, USER, 1n, '0x']],
      prepareDepositWithGas: ['DepositError', 'parent', [1n, USER, 1n, '0x']],
      startWithdraw: ['WithdrawStartError', 'child', [1n]],
      prepareStartWithdraw: ['WithdrawStartError', 'child', [1n]],
      completeWithdraw: ['ExitError', 'parent', [BURN_TX]],
      prepareCompleteWithdraw: ['ExitError', 'parent', [BURN_TX]],
      completeWithdrawFast: ['ExitError', 'parent', [BURN_TX]],
      prepareCompleteWithdrawFast: ['ExitError', 'parent', [BURN_TX]],
      getWithdrawExitStatus: ['BridgeStatusError', 'parent', [BURN_TX]],
      transfer: ['TransferError', 'parent', [1n, USER]],
      prepareTransfer: ['TransferError', 'parent', [1n, USER]]
    }
  },
  {
    name: 'ERC721',
    file: 'erc721.ts',
    prototype: ERC721.prototype,
    make: (isParent) => new ERC721(config(isParent)),
    privateMembers: ['validateBatch', 'validateIndices', 'requireParent', 'requireChild'],
    rows: {
      getTokensCount: ['TokenReadError', 'parent', [USER]],
      getTokenIdAtIndexForUser: ['TokenReadError', 'parent', [0, USER]],
      getAllTokens: ['TokenReadError', 'parent', [USER]],
      isApproved: ['TokenReadError', 'parent', [1n]],
      isApprovedAll: ['TokenReadError', 'parent', [USER]],
      approve: ['ApproveError', 'parent', [1n]],
      prepareApprove: ['ApproveError', 'parent', [1n]],
      approveAll: ['ApproveError', 'parent', []],
      prepareApproveAll: ['ApproveError', 'parent', []],
      deposit: ['DepositError', 'parent', [1n, USER]],
      prepareDeposit: ['DepositError', 'parent', [1n, USER]],
      depositMany: ['DepositError', 'parent', [[1n], USER]],
      prepareDepositMany: ['DepositError', 'parent', [[1n], USER]],
      startWithdraw: ['WithdrawStartError', 'child', [1n]],
      prepareStartWithdraw: ['WithdrawStartError', 'child', [1n]],
      startWithdrawWithMetaData: ['WithdrawStartError', 'child', [1n]],
      prepareStartWithdrawWithMetaData: ['WithdrawStartError', 'child', [1n]],
      startWithdrawMany: ['WithdrawStartError', 'child', [[1n]]],
      prepareStartWithdrawMany: ['WithdrawStartError', 'child', [[1n]]],
      completeWithdraw: ['ExitError', 'parent', [BURN_TX]],
      prepareCompleteWithdraw: ['ExitError', 'parent', [BURN_TX]],
      completeWithdrawOnIndex: ['ExitError', 'parent', [BURN_TX, 0]],
      prepareCompleteWithdrawOnIndex: ['ExitError', 'parent', [BURN_TX, 0]],
      completeWithdrawFast: ['ExitError', 'parent', [BURN_TX]],
      prepareCompleteWithdrawFast: ['ExitError', 'parent', [BURN_TX]],
      getWithdrawExitStatus: ['BridgeStatusError', 'parent', [BURN_TX]],
      getWithdrawExitStatusOnIndex: ['BridgeStatusError', 'parent', [BURN_TX, 0]],
      getWithdrawExitStatusOnIndices: ['BridgeStatusError', 'parent', [BURN_TX, [0]]],
      transfer: ['TransferError', 'parent', [1n, USER, USER]],
      prepareTransfer: ['TransferError', 'parent', [1n, USER, USER]]
    }
  },
  {
    name: 'ERC1155',
    file: 'erc1155.ts',
    prototype: ERC1155.prototype,
    make: (isParent) => new ERC1155(config(isParent)),
    privateMembers: ['approveAllInner', 'prepareApproveAllInner', 'requireParent', 'requireChild'],
    rows: {
      getBalance: ['TokenReadError', 'parent', [USER, 1n]],
      isApprovedAll: ['TokenReadError', 'parent', [USER]],
      approveAll: ['ApproveError', 'parent', []],
      prepareApproveAll: ['ApproveError', 'parent', []],
      approveAllForMintable: ['ApproveError', 'parent', []],
      prepareApproveAllForMintable: ['ApproveError', 'parent', []],
      deposit: ['DepositError', 'parent', [single]],
      prepareDeposit: ['DepositError', 'parent', [single]],
      depositMany: ['DepositError', 'parent', [batch]],
      prepareDepositMany: ['DepositError', 'parent', [batch]],
      startWithdraw: ['WithdrawStartError', 'child', [1n, 1n]],
      prepareStartWithdraw: ['WithdrawStartError', 'child', [1n, 1n]],
      startWithdrawMany: ['WithdrawStartError', 'child', [[1n], [1n]]],
      prepareStartWithdrawMany: ['WithdrawStartError', 'child', [[1n], [1n]]],
      completeWithdraw: ['ExitError', 'parent', [BURN_TX]],
      prepareCompleteWithdraw: ['ExitError', 'parent', [BURN_TX]],
      completeWithdrawFast: ['ExitError', 'parent', [BURN_TX]],
      prepareCompleteWithdrawFast: ['ExitError', 'parent', [BURN_TX]],
      completeWithdrawMany: ['ExitError', 'parent', [BURN_TX]],
      prepareCompleteWithdrawMany: ['ExitError', 'parent', [BURN_TX]],
      completeWithdrawFastMany: ['ExitError', 'parent', [BURN_TX]],
      prepareCompleteWithdrawFastMany: ['ExitError', 'parent', [BURN_TX]],
      getWithdrawExitStatus: ['BridgeStatusError', 'parent', [BURN_TX]],
      getWithdrawExitStatusMany: ['BridgeStatusError', 'parent', [BURN_TX]],
      transfer: ['TransferError', 'parent', [transfer1155]],
      prepareTransfer: ['TransferError', 'parent', [transfer1155]]
    }
  }
];

const publicMethods = (suite: Suite): string[] =>
  Object.getOwnPropertyNames(suite.prototype).filter(
    (name) =>
      name !== 'constructor' &&
      !name.startsWith('_') &&
      !suite.privateMembers.includes(name) &&
      typeof Reflect.get(suite.prototype, name) === 'function'
  );

const wrapCount = (file: string): number => {
  const source = readFileSync(join(__dirname, '..', '..', 'src', 'pos', file), 'utf8');
  return source.match(/withOperation\(/g)?.length ?? 0;
};

const modeOf = (operation: string, error: string): string => {
  if (operation.startsWith('prepare')) return 'prepare';
  if (error === 'TokenReadError' || error === 'BridgeStatusError') return 'read';
  return 'write';
};

const invoke = async (target: object, name: string, args: readonly unknown[]): Promise<unknown> => {
  const fn: unknown = Reflect.get(target, name);
  if (typeof fn !== 'function') throw new Error(`${name} is not a method`);
  return Promise.resolve(Reflect.apply(fn, target, args)).then(
    () => null,
    (e: unknown) => e
  );
};

let total = 0;

for (const suite of SUITES) {
  describe(`${suite.name} operation boundaries`, () => {
    const methods = publicMethods(suite);
    const wraps = wrapCount(suite.file);
    total += methods.length;
    console.info(
      `${suite.name}: ${methods.length} public async methods, ${wraps} withOperation( calls`
    );

    it('has one table row and one withOperation call per public method', () => {
      expect([...methods].sort()).deep.equal(Object.keys(suite.rows).sort());
      expect(wraps).equal(methods.length);
    });

    const instances = { parent: suite.make(true), child: suite.make(false) };

    for (const [operation, [error, chain, args]] of Object.entries(suite.rows)) {
      it(`${operation} rethrows a library error unchanged`, async () => {
        failure = 'library';
        try {
          const err = await invoke(instances[chain], operation, args);
          expect(err).equals(LIBRARY_ERROR);
          expect(err).property('message').equals(BOOM);
          expect(isMaticjsError(err)).equal(false);
        } finally {
          failure = 'condition';
        }
      });

      it(`${operation} rejects with one ${error} over an SDK condition`, async () => {
        const err = await invoke(instances[chain], operation, args);

        expect(err).property('name', error);
        expect(err).nested.property('info.operation', operation);
        expect(err).nested.property('info.mode', modeOf(operation, error));
        expect(err).nested.property('info.tokenAddress', TOKEN);
        expect(rootCause(err)).property('message').match(/^boom/);
        expect(err).property('message').include('boom').include('token=***');
        expect(err).property('message').not.include('token=S');
        expect(isMaticjsError(err)).equal(true);
        const cause: unknown = Reflect.get(Object(err), 'cause');
        for (const op of OPERATION_CLASSES) expect(op.has(cause)).equal(false);
      });
    }
  });
}

describe('token operation boundaries: totals', () => {
  it('covers every public async method of the three token classes', () => {
    console.info(`token classes: ${total} public async methods`);
    expect(total).equal(19 + 30 + 26);
  });
});
