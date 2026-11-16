import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  Adapter,
  Hex,
  PreparedTx,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';

import { isMaticjsError, rootCause, Web3ClientNotInitializedError } from '../../src/errors.ts';
import { noopLogger } from '../../src/logger.ts';
import { __resetAddressCacheForTesting } from '../../src/services/address-service.ts';
import { StakeManager } from '../../src/staking/stake-manager.ts';
import { StakingClient } from '../../src/staking/staking-client.ts';
import { StakingToken } from '../../src/staking/staking-token.ts';
import { ValidatorShare } from '../../src/staking/validator-share.ts';

/**
 * Every public async staking method is driven twice against an adapter and
 * address lookup that always fail:
 *
 * - with an SDK condition, it must reject with exactly one operation error
 *   named for the call, the condition reachable as the root cause and the
 *   RPC token kept out of the top-level message;
 * - with a token-bearing library error (what an adapter's ethers or viem
 *   call throws), it must reject with that same object, unwrapped and with
 *   its message unaltered.
 *
 * Methods are found by reflection and compared with the table below, so a
 * public method added later without a wrap (or without a table row) fails
 * here rather than leaking a bare SDK condition to consumers.
 */

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

const ADDR: Hex = '0x1111111111111111111111111111111111111111';

// One object satisfies every staking params type: each method reads only
// its own fields.
const PARAMS = {
  amount: 1n,
  minSharesToMint: 1n,
  maxSharesToBurn: 1n,
  user: ADDR,
  owner: ADDR,
  value: 1n,
  validatorId: 1n,
  fromValidatorId: 1n,
  toValidatorId: 2n,
  stakeRewards: false,
  heimdallFee: 1n,
  acceptDelegation: false,
  signerPubkey: `0x${'ab'.repeat(64)}`,
  commissionRate: 1n,
  nonce: 1n,
  deadline: 1n,
  v: 27,
  r: `0x${'11'.repeat(32)}`,
  s: `0x${'22'.repeat(32)}`
};

const OPERATION_NAMES = new Set([
  'InitError',
  'AddressLookupError',
  'TokenReadError',
  'CheckpointReadError',
  'BridgeStatusError',
  'ProofBuildError',
  'ApproveError',
  'DepositError',
  'WithdrawStartError',
  'ExitError',
  'TransferError',
  'ConfirmationError',
  'StakingReadError',
  'StakingWriteError',
  'PermitError'
]);

class RejectingAdapter implements Adapter {
  getChainId(): Promise<number> {
    return Promise.reject(boom());
  }
  read(_req: ReadRequest): Promise<unknown> {
    return Promise.reject(boom());
  }
  write(_req: WriteRequest): Promise<TxResult> {
    return Promise.reject(boom());
  }
  prepareWrite(_req: WriteRequest): Promise<PreparedTx> {
    return Promise.reject(boom());
  }
  estimateGas(_req: WriteRequest): Promise<bigint> {
    return Promise.reject(boom());
  }
  getTransactionReceipt(_hash: string): Promise<Receipt | null> {
    return Promise.reject(boom());
  }
  keccak256(_data: Uint8Array | string): string {
    throw boom();
  }
  request<T>(_method: string, _params: readonly unknown[]): Promise<T> {
    return Promise.reject(boom());
  }
}

type Expected = { error: string; mode: string };
const read = (error = 'StakingReadError'): Expected => ({ error, mode: 'read' });
const write: Expected = { error: 'StakingWriteError', mode: 'write' };
const prepare: Expected = { error: 'StakingWriteError', mode: 'prepare' };
const address: Expected = { error: 'AddressLookupError', mode: 'read' };

const STAKE_MANAGER: Record<string, Expected> = {
  getAddress: address,
  migrateDelegation: write,
  prepareMigrateDelegation: prepare,
  restake: write,
  prepareRestake: prepare,
  withdrawValidatorRewards: write,
  prepareWithdrawValidatorRewards: prepare,
  topUpHeimdallFee: write,
  prepareTopUpHeimdallFee: prepare,
  unstake: write,
  prepareUnstake: prepare,
  claimUnstaked: write,
  prepareClaimUnstaked: prepare,
  stakeForMatic: write,
  prepareStakeForMatic: prepare,
  stakeFor: write,
  prepareStakeFor: prepare,
  updateCommissionRate: write,
  prepareUpdateCommissionRate: prepare,
  updateSigner: write,
  prepareUpdateSigner: prepare,
  getValidator: read(),
  getValidatorContract: read(),
  getValidatorId: read(),
  getDelegatedAmount: read(),
  getValidatorStake: read(),
  getMinDeposit: read(),
  getMinHeimdallFee: read(),
  getWithdrawalDelay: read(),
  getCheckpointReward: read(),
  isLocked: read(),
  getCurrentEpoch: read(),
  getTotalStaked: read()
};

const VALIDATOR_SHARE: Record<string, Expected> = {
  delegateMatic: write,
  prepareDelegateMatic: prepare,
  delegate: write,
  prepareDelegate: prepare,
  delegateWithPermit: write,
  prepareDelegateWithPermit: prepare,
  claimUndelegated: write,
  prepareClaimUndelegated: prepare,
  undelegate: write,
  prepareUndelegate: prepare,
  restakeRewards: write,
  prepareRestakeRewards: prepare,
  withdrawRewards: write,
  prepareWithdrawRewards: prepare,
  getExchangeRate: read(),
  getLiquidRewards: read(),
  getMinAmount: read(),
  getBalance: read(),
  getTotalStake: read(),
  getUnbond: read(),
  getUnbondNew: read(),
  getUnbondNonce: read(),
  getValidatorId: read()
};

const STAKING_TOKEN: Record<string, Expected> = {
  getAddress: address,
  approveStakeManager: write,
  prepareApproveStakeManager: prepare,
  approveMaxForStakeManager: write,
  prepareApproveMaxForStakeManager: prepare,
  getBalance: read(),
  getAllowanceForStakeManager: read(),
  getNonce: read(),
  preparePermit: { error: 'PermitError', mode: 'prepare' }
};

// Prototype members that are not public async methods: TypeScript
// `private` is erased at runtime, so reflection sees the helpers too.
const NOT_PUBLIC = new Set([
  'constructor',
  'write',
  'prepare',
  'readBigInt',
  'readUnbond',
  'assertPermit',
  // Synchronous: binds an address and returns a handle.
  'validatorShare'
]);

const publicMethods = (proto: object): string[] =>
  Object.getOwnPropertyNames(proto)
    .filter((name) => !NOT_PUBLIC.has(name))
    .sort();

const withOperationCount = (file: string): number =>
  readFileSync(join(import.meta.dirname, '../../src/staking', file), 'utf8')
    .split('\n')
    .filter((line) => line.includes('withOperation(')).length;

/** Calls `name` on `target`, passing the shared params only to methods that take them. */
const invoke = async (target: object, name: string): Promise<unknown> => {
  const fn: unknown = Reflect.get(target, name);
  if (typeof fn !== 'function') throw new Error(`${name} is not a method`);
  // `(params, options?)` methods declare two parameters; `(options?)` ones one or none.
  const args = fn.length >= 2 ? [PARAMS] : [];
  return Reflect.apply(fn, target, args);
};

const rejectionOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
};

const operationLayers = (err: unknown): number => {
  let count = 0;
  const seen = new Set<unknown>();
  for (
    let link: unknown = err;
    link instanceof Error && !seen.has(link);
    link = Reflect.get(link, 'cause')
  ) {
    seen.add(link);
    if (OPERATION_NAMES.has(link.name)) count += 1;
  }
  return count;
};

const assertBoundary = ({
  err,
  operation,
  expected
}: {
  err: unknown;
  operation: string;
  expected: Expected;
}): void => {
  expect(err, operation).property('name').equals(expected.error);
  expect(err, operation).nested.property('info.operation').equals(operation);
  expect(err, operation).nested.property('info.mode').equals(expected.mode);
  expect(rootCause(err), operation).property('message').match(/^boom/);
  expect(err, operation).property('message').contains('boom').and.contains('token=***');
  expect(err, operation).property('message').not.contains('token=S');
  expect(isMaticjsError(err), operation).equals(true);
  expect(operationLayers(err), operation).equals(1);
};

const config = {
  adapter: new RejectingAdapter(),
  getAddress: () => Promise.reject(boom()),
  logger: noopLogger,
  l1ChainId: 1
};

describe('staking operation boundaries', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAddressCacheForTesting();
    failure = 'condition';
  });

  const assertPassThrough = ({ err, operation }: { err: unknown; operation: string }): void => {
    expect(err, operation).equals(LIBRARY_ERROR);
    expect(err, operation).property('message').equals(BOOM);
    expect(isMaticjsError(err), operation).equals(false);
  };

  it.each([
    ['StakeManager', STAKE_MANAGER, () => new StakeManager(config)],
    ['ValidatorShare', VALIDATOR_SHARE, () => new ValidatorShare({ ...config, address: ADDR })],
    [
      'StakingToken',
      STAKING_TOKEN,
      () =>
        new StakingToken({
          ...config,
          getStakeManagerAddress: () => Promise.reject(boom()),
          supportsPermit: true,
          tokenLabel: 'PolToken'
        })
    ]
  ])('%s: every method rethrows a library error unchanged', async (_name, table, make) => {
    failure = 'library';
    const target = make();
    for (const operation of Object.keys(table)) {
      assertPassThrough({ err: await rejectionOf(() => invoke(target, operation)), operation });
    }
  });

  it.each([
    ['StakeManager', StakeManager.prototype, STAKE_MANAGER, 'stake-manager.ts'],
    ['ValidatorShare', ValidatorShare.prototype, VALIDATOR_SHARE, 'validator-share.ts'],
    ['StakingToken', StakingToken.prototype, STAKING_TOKEN, 'staking-token.ts']
  ])('%s: the table covers every public method, one wrap each', (_name, proto, table, file) => {
    const methods = publicMethods(proto);
    expect(methods).deep.equals(Object.keys(table).sort());
    expect(withOperationCount(file)).equals(methods.length);
  });

  it('StakingClient: init and getAddresses are the wrapped surface', () => {
    expect(publicMethods(StakingClient.prototype)).deep.equals(['getAddresses']);
    expect(withOperationCount('staking-client.ts')).equals(2);
  });

  it.each(Object.entries(STAKE_MANAGER))('StakeManager.%s', async (operation, expected) => {
    const target = new StakeManager(config);
    const err = await rejectionOf(() => invoke(target, operation));
    assertBoundary({ err, operation, expected });
  });

  it.each(Object.entries(VALIDATOR_SHARE))('ValidatorShare.%s', async (operation, expected) => {
    const target = new ValidatorShare({ ...config, address: ADDR });
    const err = await rejectionOf(() => invoke(target, operation));
    assertBoundary({ err, operation, expected });
  });

  // POL, so the permit methods reach the chain instead of stopping at the
  // MATIC permit guard.
  it.each(Object.entries(STAKING_TOKEN))('StakingToken.%s', async (operation, expected) => {
    const target = new StakingToken({
      ...config,
      getStakeManagerAddress: () => Promise.reject(boom()),
      supportsPermit: true,
      tokenLabel: 'PolToken'
    });
    const err = await rejectionOf(() => invoke(target, operation));
    assertBoundary({ err, operation, expected });
  });

  it('StakingClient.init', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(boom()));
    const err = await rejectionOf(() =>
      StakingClient.init({
        network: 'mainnet',
        parent: new RejectingAdapter(),
        addressIndexUrl: 'https://address-index.test/staking-boundaries'
      })
    );
    assertBoundary({ err, operation: 'init', expected: { error: 'InitError', mode: 'init' } });
  });

  it('StakingClient.getAddresses', async () => {
    const client = await StakingClient.init({
      network: 'mainnet',
      parent: new RejectingAdapter(),
      addresses: { StakeManager: ADDR, MaticToken: ADDR, PolToken: ADDR }
    });
    vi.spyOn(client['fetcher'], 'get').mockRejectedValue(boom());
    const err = await rejectionOf(() => client.getAddresses());
    assertBoundary({ err, operation: 'getAddresses', expected: address });
  });
});
