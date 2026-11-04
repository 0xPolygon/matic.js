/**
 * Argument and chain-side guards on every Promise-returning public method
 * must surface as a REJECTED promise, never as a synchronous throw.
 *
 * A consumer writing `token.approve(x).catch(handle)` (or attaching
 * `.then(ok, fail)`) only sees failures that arrive through the promise.
 * A guard that throws before the promise exists escapes that handler
 * entirely and lands in the caller's stack instead. Each case below
 * therefore asserts two things: the call itself does not throw, and the
 * promise it returns rejects with the guard's `POSBridgeError` code.
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
import type { POSBridgeErrorCode } from '../../src/errors.ts';
import type { POSBridgeHelpers } from '../../src/internal/pos-bridge-helpers.ts';
import type { NetworkAddresses } from '../../src/networks.ts';
import type { RootChainManager } from '../../src/pos/root_chain_manager.ts';

import { POSBridgeError } from '../../src/errors.ts';
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
 * that rejects with a `POSBridgeError` carrying `code`.
 */
async function expectRejection(
  call: () => Promise<unknown>,
  code: POSBridgeErrorCode
): Promise<void> {
  let pending: Promise<unknown> | undefined;
  expect(() => {
    pending = call();
  }).not.throw();
  expect(pending).instanceOf(Promise);
  const err: unknown = await pending?.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).instanceOf(POSBridgeError);
  expect(err).property('code', code);
}

type Case = readonly [name: string, call: () => Promise<unknown>, code: POSBridgeErrorCode];

function runCases(cases: readonly Case[]): void {
  for (const [name, call, code] of cases) {
    it(`${name} rejects with ${code}`, async () => {
      await expectRejection(call, code);
    });
  }
}

describe('ERC20 guard failures reject', () => {
  const child = new ERC20(tokenConfig(false));
  const parent = new ERC20(tokenConfig(true));

  runCases([
    ['approve (child, no spender)', () => child.approve(1n), 'NULL_SPENDER_ADDRESS'],
    ['prepareApprove (child, no spender)', () => child.prepareApprove(1n), 'NULL_SPENDER_ADDRESS'],
    ['approveMax (child, no spender)', () => child.approveMax(), 'NULL_SPENDER_ADDRESS'],
    [
      'prepareApproveMax (child, no spender)',
      () => child.prepareApproveMax(),
      'NULL_SPENDER_ADDRESS'
    ],
    ['deposit (child)', () => child.deposit(1n, USER), 'ALLOWED_ON_ROOT'],
    ['prepareDeposit (child)', () => child.prepareDeposit(1n, USER), 'ALLOWED_ON_ROOT'],
    ['startWithdraw (parent)', () => parent.startWithdraw(1n), 'ALLOWED_ON_CHILD'],
    ['prepareStartWithdraw (parent)', () => parent.prepareStartWithdraw(1n), 'ALLOWED_ON_CHILD'],
    ['completeWithdrawFast (child)', () => child.completeWithdrawFast(BURN_TX), 'ALLOWED_ON_ROOT'],
    [
      'prepareCompleteWithdrawFast (child)',
      () => child.prepareCompleteWithdrawFast(BURN_TX),
      'ALLOWED_ON_ROOT'
    ]
  ]);
});

describe('ERC721 guard failures reject', () => {
  const child = new ERC721(tokenConfig(false));
  const parent = new ERC721(tokenConfig(true));

  runCases([
    ['approve (child)', () => child.approve(1n), 'ALLOWED_ON_ROOT'],
    ['prepareApprove (child)', () => child.prepareApprove(1n), 'ALLOWED_ON_ROOT'],
    ['approveAll (child)', () => child.approveAll(), 'ALLOWED_ON_ROOT'],
    ['prepareApproveAll (child)', () => child.prepareApproveAll(), 'ALLOWED_ON_ROOT'],
    ['isApprovedAll (child)', () => child.isApprovedAll(USER), 'ALLOWED_ON_ROOT'],
    ['deposit (child)', () => child.deposit(1n, USER), 'ALLOWED_ON_ROOT'],
    ['prepareDeposit (child)', () => child.prepareDeposit(1n, USER), 'ALLOWED_ON_ROOT'],
    ['depositMany (child)', () => child.depositMany([1n], USER), 'ALLOWED_ON_ROOT'],
    ['prepareDepositMany (child)', () => child.prepareDepositMany([1n], USER), 'ALLOWED_ON_ROOT'],
    [
      'depositMany (batch too large)',
      () => parent.depositMany(TOO_MANY, USER),
      'BATCH_SIZE_LIMIT_EXCEEDED'
    ],
    [
      'prepareDepositMany (batch too large)',
      () => parent.prepareDepositMany(TOO_MANY, USER),
      'BATCH_SIZE_LIMIT_EXCEEDED'
    ],
    ['startWithdraw (parent)', () => parent.startWithdraw(1n), 'ALLOWED_ON_CHILD'],
    ['prepareStartWithdraw (parent)', () => parent.prepareStartWithdraw(1n), 'ALLOWED_ON_CHILD'],
    [
      'startWithdrawWithMetaData (parent)',
      () => parent.startWithdrawWithMetaData(1n),
      'ALLOWED_ON_CHILD'
    ],
    [
      'prepareStartWithdrawWithMetaData (parent)',
      () => parent.prepareStartWithdrawWithMetaData(1n),
      'ALLOWED_ON_CHILD'
    ],
    ['startWithdrawMany (parent)', () => parent.startWithdrawMany([1n]), 'ALLOWED_ON_CHILD'],
    [
      'startWithdrawMany (batch too large)',
      () => child.startWithdrawMany(TOO_MANY),
      'BATCH_SIZE_LIMIT_EXCEEDED'
    ],
    [
      'prepareStartWithdrawMany (batch too large)',
      () => child.prepareStartWithdrawMany(TOO_MANY),
      'BATCH_SIZE_LIMIT_EXCEEDED'
    ]
  ]);
});

describe('ERC1155 guard failures reject', () => {
  const child = new ERC1155(tokenConfig(false));
  const parent = new ERC1155(tokenConfig(true));
  const single = { tokenId: 1n, amount: 1n, userAddress: USER };
  const batch = { tokenIds: [1n], amounts: [1n], userAddress: USER };

  runCases([
    ['isApprovedAll (child)', () => child.isApprovedAll(USER), 'ALLOWED_ON_ROOT'],
    ['approveAll (child)', () => child.approveAll(), 'ALLOWED_ON_ROOT'],
    ['prepareApproveAll (child)', () => child.prepareApproveAll(), 'ALLOWED_ON_ROOT'],
    ['approveAllForMintable (child)', () => child.approveAllForMintable(), 'ALLOWED_ON_ROOT'],
    [
      'approveAllForMintable (no mintable predicate)',
      () => parent.approveAllForMintable(),
      'CONTRACT_NOT_AVAILABLE_ON_NETWORK'
    ],
    [
      'prepareApproveAllForMintable (no mintable predicate)',
      () => parent.prepareApproveAllForMintable(),
      'CONTRACT_NOT_AVAILABLE_ON_NETWORK'
    ],
    ['deposit (child)', () => child.deposit(single), 'ALLOWED_ON_ROOT'],
    ['prepareDeposit (child)', () => child.prepareDeposit(single), 'ALLOWED_ON_ROOT'],
    ['depositMany (child)', () => child.depositMany(batch), 'ALLOWED_ON_ROOT'],
    ['prepareDepositMany (child)', () => child.prepareDepositMany(batch), 'ALLOWED_ON_ROOT'],
    ['startWithdraw (parent)', () => parent.startWithdraw(1n, 1n), 'ALLOWED_ON_CHILD'],
    [
      'prepareStartWithdraw (parent)',
      () => parent.prepareStartWithdraw(1n, 1n),
      'ALLOWED_ON_CHILD'
    ],
    ['startWithdrawMany (parent)', () => parent.startWithdrawMany([1n], [1n]), 'ALLOWED_ON_CHILD'],
    [
      'prepareStartWithdrawMany (parent)',
      () => parent.prepareStartWithdrawMany([1n], [1n]),
      'ALLOWED_ON_CHILD'
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

  it('buildExitPayloadOnIndex (negative index) rejects with NEGATIVE_INDEX', async () => {
    const pos = await posPromise;
    await expectRejection(() => pos.buildExitPayloadOnIndex(BURN_TX, '0x', -1), 'NEGATIVE_INDEX');
  });
});
