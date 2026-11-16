/**
 * Argument and chain-side guards on every Promise-returning public method
 * must surface as a REJECTED promise, never as a synchronous throw.
 *
 * A consumer writing `token.approve(x).catch(handle)` (or attaching
 * `.then(ok, fail)`) only sees failures that arrive through the promise.
 * A guard that throws before the promise exists escapes that handler
 * entirely and lands in the caller's stack instead. Each case below
 * therefore asserts that the call itself does not throw, and that the
 * promise it returns rejects with the public method's operation error
 * carrying the guard's named error as its condition — proof that the
 * operation wrapping kept guard failures asynchronous.
 *
 * Every guard here fails before touching a collaborator, so the adapter,
 * bridge and root-chain-manager stubs are never reached.
 */
import { describe, expect, it } from 'vitest';

import type {
  Adapter,
  PreparedTx,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';
import type { POSBridgeHelpers } from '../../src/internal/pos-bridge-helpers.ts';
import type { NetworkAddresses } from '../../src/networks.ts';
import type { RootChainManager } from '../../src/pos/root_chain_manager.ts';

import {
  AllowedOnChildError,
  AllowedOnRootError,
  BatchSizeLimitExceededError,
  ContractNotAvailableOnNetworkError,
  NegativeIndexError,
  NullSpenderAddressError
} from '../../src/errors.ts';
import { encodeAbiParameters } from '../../src/internal/abi-encode.ts';
import { noopLogger } from '../../src/logger.ts';
import { POSClient } from '../../src/pos-client.ts';
import { ERC20 } from '../../src/pos/erc20.ts';
import { ERC721 } from '../../src/pos/erc721.ts';
import { ERC1155 } from '../../src/pos/erc1155.ts';

const TOKEN = '0x5555555555555555555555555555555555555555' as const;
const USER = '0x7777777777777777777777777777777777777777';
const BURN_TX = `0x${'ab'.repeat(32)}`;
const TOO_MANY = Array.from({ length: 21 }, (_, i) => BigInt(i));

const ADDRESSES: NetworkAddresses = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666'
};

/** Adapter whose every method fails the test if reached. */
function unreachableAdapter(): Adapter {
  const unreached = (): never => {
    throw new Error('adapter should not be reached: the guard must fail first');
  };
  return {
    getChainId: () => Promise.resolve(unreached()),
    read: (_req: ReadRequest) => Promise.resolve(unreached()),
    write: (_req: WriteRequest) => Promise.resolve(unreached() as TxResult),
    prepareWrite: (_req: WriteRequest) => Promise.resolve(unreached() as PreparedTx),
    estimateGas: (_req: WriteRequest) => Promise.resolve(unreached() as bigint),
    getTransactionReceipt: (_hash: string) => Promise.resolve(unreached() as Receipt | null),
    keccak256: () => unreached(),
    request: <T>() => Promise.resolve(unreached() as T)
  };
}

const bridgeStub = {} as POSBridgeHelpers;
const rootChainManagerStub = {} as RootChainManager;

function tokenConfig(isParent: boolean) {
  const adapter = unreachableAdapter();
  return {
    tokenAddress: TOKEN,
    isParent,
    adapter,
    bridge: bridgeStub,
    rootChainManager: rootChainManagerStub,
    parentAdapter: adapter,
    encodeParameters: encodeAbiParameters,
    logger: noopLogger
  };
}

/**
 * Calls `call` and asserts it returned a promise (no synchronous throw)
 * that rejects with the operation error `operation`, whose cause chain
 * holds `condition`.
 */
async function expectRejection({
  call,
  condition,
  operation
}: {
  call: () => Promise<unknown>;
  condition: ErrorClass;
  operation?: string;
}): Promise<void> {
  let pending: Promise<unknown> | undefined;
  expect(() => {
    pending = call();
  }).not.throw();
  expect(pending).instanceOf(Promise);
  const err: unknown = await pending?.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(condition.has(err)).equals(true);
  if (operation !== undefined) expect(err).property('name').equals(operation);
}

type ErrorClass = { readonly has: (err: unknown) => boolean };

type Case = readonly [
  name: string,
  call: () => Promise<unknown>,
  condition: ErrorClass,
  operation: string
];

function runCases(cases: readonly Case[]): void {
  for (const [name, call, condition, operation] of cases) {
    it(`${name} rejects with ${operation} caused by the named error`, async () => {
      await expectRejection({ call, condition, operation });
    });
  }
}

describe('ERC20 guard failures reject', () => {
  const child = new ERC20(tokenConfig(false));
  const parent = new ERC20(tokenConfig(true));

  runCases([
    [
      'approve (child, no spender)',
      () => child.approve(1n),
      NullSpenderAddressError,
      'ApproveError'
    ],
    [
      'prepareApprove (child, no spender)',
      () => child.prepareApprove(1n),
      NullSpenderAddressError,
      'ApproveError'
    ],
    [
      'approveMax (child, no spender)',
      () => child.approveMax(),
      NullSpenderAddressError,
      'ApproveError'
    ],
    [
      'prepareApproveMax (child, no spender)',
      () => child.prepareApproveMax(),
      NullSpenderAddressError,
      'ApproveError'
    ],
    ['deposit (child)', () => child.deposit(1n, USER), AllowedOnRootError, 'DepositError'],
    [
      'prepareDeposit (child)',
      () => child.prepareDeposit(1n, USER),
      AllowedOnRootError,
      'DepositError'
    ],
    [
      'startWithdraw (parent)',
      () => parent.startWithdraw(1n),
      AllowedOnChildError,
      'WithdrawStartError'
    ],
    [
      'prepareStartWithdraw (parent)',
      () => parent.prepareStartWithdraw(1n),
      AllowedOnChildError,
      'WithdrawStartError'
    ],
    [
      'completeWithdrawFast (child)',
      () => child.completeWithdrawFast(BURN_TX),
      AllowedOnRootError,
      'ExitError'
    ],
    [
      'prepareCompleteWithdrawFast (child)',
      () => child.prepareCompleteWithdrawFast(BURN_TX),
      AllowedOnRootError,
      'ExitError'
    ]
  ]);
});

describe('ERC721 guard failures reject', () => {
  const child = new ERC721(tokenConfig(false));
  const parent = new ERC721(tokenConfig(true));

  runCases([
    ['approve (child)', () => child.approve(1n), AllowedOnRootError, 'ApproveError'],
    ['prepareApprove (child)', () => child.prepareApprove(1n), AllowedOnRootError, 'ApproveError'],
    ['approveAll (child)', () => child.approveAll(), AllowedOnRootError, 'ApproveError'],
    [
      'prepareApproveAll (child)',
      () => child.prepareApproveAll(),
      AllowedOnRootError,
      'ApproveError'
    ],
    [
      'isApprovedAll (child)',
      () => child.isApprovedAll(USER),
      AllowedOnRootError,
      'TokenReadError'
    ],
    ['deposit (child)', () => child.deposit(1n, USER), AllowedOnRootError, 'DepositError'],
    [
      'prepareDeposit (child)',
      () => child.prepareDeposit(1n, USER),
      AllowedOnRootError,
      'DepositError'
    ],
    [
      'depositMany (child)',
      () => child.depositMany([1n], USER),
      AllowedOnRootError,
      'DepositError'
    ],
    [
      'prepareDepositMany (child)',
      () => child.prepareDepositMany([1n], USER),
      AllowedOnRootError,
      'DepositError'
    ],
    [
      'depositMany (batch too large)',
      () => parent.depositMany(TOO_MANY, USER),
      BatchSizeLimitExceededError,
      'DepositError'
    ],
    [
      'prepareDepositMany (batch too large)',
      () => parent.prepareDepositMany(TOO_MANY, USER),
      BatchSizeLimitExceededError,
      'DepositError'
    ],
    [
      'startWithdraw (parent)',
      () => parent.startWithdraw(1n),
      AllowedOnChildError,
      'WithdrawStartError'
    ],
    [
      'prepareStartWithdraw (parent)',
      () => parent.prepareStartWithdraw(1n),
      AllowedOnChildError,
      'WithdrawStartError'
    ],
    [
      'startWithdrawWithMetaData (parent)',
      () => parent.startWithdrawWithMetaData(1n),
      AllowedOnChildError,
      'WithdrawStartError'
    ],
    [
      'prepareStartWithdrawWithMetaData (parent)',
      () => parent.prepareStartWithdrawWithMetaData(1n),
      AllowedOnChildError,
      'WithdrawStartError'
    ],
    [
      'startWithdrawMany (parent)',
      () => parent.startWithdrawMany([1n]),
      AllowedOnChildError,
      'WithdrawStartError'
    ],
    [
      'startWithdrawMany (batch too large)',
      () => child.startWithdrawMany(TOO_MANY),
      BatchSizeLimitExceededError,
      'WithdrawStartError'
    ],
    [
      'prepareStartWithdrawMany (batch too large)',
      () => child.prepareStartWithdrawMany(TOO_MANY),
      BatchSizeLimitExceededError,
      'WithdrawStartError'
    ]
  ]);
});

describe('ERC1155 guard failures reject', () => {
  const child = new ERC1155(tokenConfig(false));
  const parent = new ERC1155(tokenConfig(true));
  const single = { tokenId: 1n, amount: 1n, userAddress: USER };
  const batch = { tokenIds: [1n], amounts: [1n], userAddress: USER };

  runCases([
    [
      'isApprovedAll (child)',
      () => child.isApprovedAll(USER),
      AllowedOnRootError,
      'TokenReadError'
    ],
    ['approveAll (child)', () => child.approveAll(), AllowedOnRootError, 'ApproveError'],
    [
      'prepareApproveAll (child)',
      () => child.prepareApproveAll(),
      AllowedOnRootError,
      'ApproveError'
    ],
    [
      'approveAllForMintable (child)',
      () => child.approveAllForMintable(),
      AllowedOnRootError,
      'ApproveError'
    ],
    [
      'approveAllForMintable (no mintable predicate)',
      () => parent.approveAllForMintable(),
      ContractNotAvailableOnNetworkError,
      'ApproveError'
    ],
    [
      'prepareApproveAllForMintable (no mintable predicate)',
      () => parent.prepareApproveAllForMintable(),
      ContractNotAvailableOnNetworkError,
      'ApproveError'
    ],
    ['deposit (child)', () => child.deposit(single), AllowedOnRootError, 'DepositError'],
    [
      'prepareDeposit (child)',
      () => child.prepareDeposit(single),
      AllowedOnRootError,
      'DepositError'
    ],
    ['depositMany (child)', () => child.depositMany(batch), AllowedOnRootError, 'DepositError'],
    [
      'prepareDepositMany (child)',
      () => child.prepareDepositMany(batch),
      AllowedOnRootError,
      'DepositError'
    ],
    [
      'startWithdraw (parent)',
      () => parent.startWithdraw(1n, 1n),
      AllowedOnChildError,
      'WithdrawStartError'
    ],
    [
      'prepareStartWithdraw (parent)',
      () => parent.prepareStartWithdraw(1n, 1n),
      AllowedOnChildError,
      'WithdrawStartError'
    ],
    [
      'startWithdrawMany (parent)',
      () => parent.startWithdrawMany([1n], [1n]),
      AllowedOnChildError,
      'WithdrawStartError'
    ],
    [
      'prepareStartWithdrawMany (parent)',
      () => parent.prepareStartWithdrawMany([1n], [1n]),
      AllowedOnChildError,
      'WithdrawStartError'
    ]
  ]);
});

describe('POSClient flat helpers: guard failures reject', () => {
  const posPromise = POSClient.init({
    network: 'amoy',
    parent: unreachableAdapter(),
    child: unreachableAdapter(),
    addresses: ADDRESSES
  });

  it('buildExitPayloadOnIndex (negative index) rejects with NegativeIndexError', async () => {
    const pos = await posPromise;
    await expectRejection({
      call: () => pos.buildExitPayloadOnIndex(BURN_TX, '0x', -1),
      condition: NegativeIndexError,
      operation: 'ProofBuildError'
    });
  });
});
