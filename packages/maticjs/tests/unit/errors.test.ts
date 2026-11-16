import { inspect } from 'node:util';

import { HttpRequestError } from 'viem';
import { describe, expect, it } from 'vitest';

import { VError } from '@polygonlabs/verror';

import type { Receipt } from '../../src/adapter.ts';
import type { MaticjsErrorName } from '../../src/errors.ts';

import * as errors from '../../src/errors.ts';

const {
  AddressLookupError,
  AllowedOnChildError,
  AllowedOnRootError,
  ApproveError,
  BatchSizeLimitExceededError,
  BridgeEventDecodeFailedError,
  BufferTypeRequiredError,
  BurnTxNotCheckpointedError,
  CheckpointReadError,
  ConfirmationError,
  ContractNotAvailableOnNetworkError,
  DepositError,
  Eip1559NotSupportedError,
  ExitError,
  BridgeStatusError,
  FeeEstimationFailedError,
  HttpRequestFailedError,
  IndexOutOfBoundsError,
  InitError,
  InvalidHexStringError,
  InvalidNumericValueError,
  InvalidTokenTypeError,
  LogNotFoundInReceiptError,
  MATICJS_ERROR_NAMES,
  MerkleTreeDepthExceededError,
  MerkleTreeRequiresLeavesError,
  NegativeBigNumberError,
  NegativeIndexError,
  NullSpenderAddressError,
  OnlyAllowedOnMainnetError,
  PermitError,
  PermitNotSupportedError,
  UntrustedPredicateError,
  CheckpointRangeInvalidError,
  DepositNotReplayableError,
  ProofApiNotSetError,
  ProofBuildError,
  ProofNodeKeyMismatchError,
  ReceiptsRootMismatchError,
  StakingReadError,
  StakingWriteError,
  StateSyncedEventNotFoundError,
  TokenReadError,
  TransactionHashRequiredError,
  TransactionNotFoundError,
  TransactionReplacedError,
  TransactionRevertedError,
  TransferError,
  TxOptionNotObjectError,
  UnsupportedKeccakBitWidthError,
  UnsupportedNetworkError,
  Web3ClientNotInitializedError,
  WithdrawStartError,
  withOperation
} = errors;

const HASH = `0x${'ab'.repeat(32)}` as const;
const TOKEN = `0x${'11'.repeat(20)}` as const;
const RECEIPT: Receipt = {
  transactionHash: HASH,
  status: 'reverted',
  blockNumber: 123n,
  logs: [{ address: TOKEN, logIndex: 0, data: '0x', topics: [] }]
};
const OP = { operation: 'completeWithdraw', mode: 'write' } as const;

// One factory per class, keyed by the class name. Typed as a record over
// the name union so a class added to the union without a factory here, or
// a factory for a name that is not in the union, fails to compile.
const FACTORIES: Record<MaticjsErrorName, () => Error> = {
  AllowedOnRootError: () =>
    new AllowedOnRootError('m', {
      info: { action: 'deposit', isParent: false, tokenAddress: TOKEN }
    }),
  AllowedOnChildError: () =>
    new AllowedOnChildError('m', {
      info: { action: 'withdraw', isParent: true, tokenAddress: TOKEN }
    }),
  BurnTxNotCheckpointedError: () =>
    new BurnTxNotCheckpointedError('m', { info: { burnTxHash: HASH } }),
  Eip1559NotSupportedError: () =>
    new Eip1559NotSupportedError('m', { info: { chainId: 1, isParent: true } }),
  ProofApiNotSetError: () => new ProofApiNotSetError('m'),
  InvalidTokenTypeError: () => new InvalidTokenTypeError('m', { info: { tokenAddress: TOKEN } }),
  ContractNotAvailableOnNetworkError: () =>
    new ContractNotAvailableOnNetworkError('m', { info: { contract: 'GasSwapper' } }),
  TxOptionNotObjectError: () =>
    new TxOptionNotObjectError('m', { info: { method: 'deposit', received: 'string' } }),
  UnsupportedNetworkError: () =>
    new UnsupportedNetworkError('m', { info: { expected: 1, actual: 2 } }),
  Web3ClientNotInitializedError: () => new Web3ClientNotInitializedError('m'),
  InvalidHexStringError: () => new InvalidHexStringError('m', { info: { length: 3 } }),
  NegativeBigNumberError: () => new NegativeBigNumberError('m', { info: { value: '-1' } }),
  InvalidNumericValueError: () =>
    new InvalidNumericValueError('m', { info: { value: Number.NaN } }),
  BufferTypeRequiredError: () => new BufferTypeRequiredError('m', { info: { received: 'string' } }),
  UnsupportedKeccakBitWidthError: () =>
    new UnsupportedKeccakBitWidthError('m', { info: { bits: 128 } }),
  MerkleTreeRequiresLeavesError: () => new MerkleTreeRequiresLeavesError('m'),
  MerkleTreeDepthExceededError: () =>
    new MerkleTreeDepthExceededError('m', { info: { depth: 99 } }),
  StateSyncedEventNotFoundError: () =>
    new StateSyncedEventNotFoundError('m', { info: { transactionHash: HASH } }),
  ProofNodeKeyMismatchError: () =>
    new ProofNodeKeyMismatchError('m', { info: { transactionIndex: 0 } }),
  ReceiptsRootMismatchError: () =>
    new ReceiptsRootMismatchError('m', {
      info: {
        blockNumber: 1,
        blockHash: HASH,
        expectedReceiptsRoot: HASH,
        computedReceiptsRoot: HASH
      }
    }),
  TransactionHashRequiredError: () =>
    new TransactionHashRequiredError('m', { info: { eventSignature: '0x' } }),
  TransactionNotFoundError: () =>
    new TransactionNotFoundError('m', { info: { transactionHash: HASH } }),
  TransactionRevertedError: () =>
    new TransactionRevertedError('m', { info: { transactionHash: HASH, receipt: RECEIPT } }),
  TransactionReplacedError: () =>
    new TransactionReplacedError('m', {
      info: { transactionHash: HASH, replacementHash: HASH, reason: 'cancelled', receipt: RECEIPT }
    }),
  FeeEstimationFailedError: () =>
    new FeeEstimationFailedError('m', { info: { method: 'eth_feeHistory', chainId: 1 } }),
  HttpRequestFailedError: () =>
    new HttpRequestFailedError('m', { info: { url: 'https://x', status: 500 } }),
  BatchSizeLimitExceededError: () =>
    new BatchSizeLimitExceededError('m', { info: { count: 21, max: 20 } }),
  LogNotFoundInReceiptError: () =>
    new LogNotFoundInReceiptError('m', { info: { eventSignature: '0x', transactionHash: HASH } }),
  NegativeIndexError: () => new NegativeIndexError('m', { info: { index: -1 } }),
  IndexOutOfBoundsError: () => new IndexOutOfBoundsError('m', { info: { index: 5, available: 1 } }),
  BridgeEventDecodeFailedError: () =>
    new BridgeEventDecodeFailedError('m', { info: { field: 'x', valueType: 'undefined' } }),
  NullSpenderAddressError: () =>
    new NullSpenderAddressError('m', { info: { tokenAddress: TOKEN } }),
  OnlyAllowedOnMainnetError: () => new OnlyAllowedOnMainnetError('m', { info: { chainId: 80002 } }),
  PermitNotSupportedError: () =>
    new PermitNotSupportedError('m', { info: { token: TOKEN, method: 'permit' } }),
  UntrustedPredicateError: () =>
    new UntrustedPredicateError('m', { info: { tokenAddress: TOKEN, predicate: TOKEN } }),
  CheckpointRangeInvalidError: () =>
    new CheckpointRangeInvalidError('m', {
      info: { start: '0', end: '1', txBlockNumber: 5, reason: 'not-containing' }
    }),
  DepositNotReplayableError: () =>
    new DepositNotReplayableError('m', {
      info: { transactionHash: TOKEN, status: { deposited: true } }
    }),
  InitError: () => new InitError({ info: { operation: 'init', mode: 'init' } }),
  AddressLookupError: () =>
    new AddressLookupError({ info: { operation: 'getAddresses', mode: 'read' } }),
  TokenReadError: () => new TokenReadError({ info: { operation: 'getBalance', mode: 'read' } }),
  CheckpointReadError: () =>
    new CheckpointReadError({ info: { operation: 'getLastChildBlock', mode: 'read' } }),
  BridgeStatusError: () =>
    new BridgeStatusError({ info: { operation: 'getCheckpointStatus', mode: 'read' } }),
  ProofBuildError: () =>
    new ProofBuildError({ info: { operation: 'buildExitPayload', mode: 'read' } }),
  ApproveError: () => new ApproveError({ info: { operation: 'approve', mode: 'write' } }),
  DepositError: () => new DepositError({ info: { operation: 'deposit', mode: 'write' } }),
  WithdrawStartError: () =>
    new WithdrawStartError({ info: { operation: 'startWithdraw', mode: 'write' } }),
  ExitError: () => new ExitError({ info: OP }),
  TransferError: () => new TransferError({ info: { operation: 'transfer', mode: 'prepare' } }),
  ConfirmationError: () =>
    new ConfirmationError({ info: { operation: 'confirmed', mode: 'confirm' } }),
  StakingReadError: () =>
    new StakingReadError({ info: { operation: 'getValidator', mode: 'read' } }),
  StakingWriteError: () => new StakingWriteError({ info: { operation: 'restake', mode: 'write' } }),
  PermitError: () => new PermitError({ info: { operation: 'preparePermit', mode: 'prepare' } })
};

const NAMES: MaticjsErrorName[] = [...MATICJS_ERROR_NAMES];

/** Awaits `run` and returns what it rejected with. */
const rejection = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
};

describe('error classes', () => {
  it('there are exactly 52 named classes and MATICJS_ERROR_NAMES lists each once', () => {
    expect(Object.keys(FACTORIES).length).equals(52);
    expect(MATICJS_ERROR_NAMES.size).equals(52);
    expect([...Object.keys(FACTORIES)].sort()).deep.equals([...NAMES].sort());
  });

  it('every exported class is in the factory table (no class left untested)', () => {
    const exportedClasses = Object.entries(errors)
      .filter(([, value]) => typeof value === 'function' && /^[A-Z]\w*Error$/.test(value.name))
      .map(([key]) => key)
      .sort();
    expect(exportedClasses).deep.equals([...NAMES].sort());
  });

  it.each(NAMES)('%s constructs, with a literal name equal to its class name', (name) => {
    const factory = FACTORIES[name];
    const err = factory();
    expect(err).property('name').equals(name);
    expect(err.constructor.name).equals(name);
    expect(err).instanceOf(VError);
    expect(err.stack ?? '').match(new RegExp(`^${name}: `));
  });

  it('no class carries a `code`, live or serialised', () => {
    for (const factory of Object.values(FACTORIES)) {
      const err = factory();
      expect('code' in err).equals(false);
      expect(JSON.parse(JSON.stringify(err))).not.property('code');
    }
  });

  it('JSON.stringify emits the name (serialised by VError) and the info', () => {
    const err = new UnsupportedNetworkError('wrong chain', { info: { expected: 1, actual: 137 } });
    const round: unknown = JSON.parse(JSON.stringify(err));
    expect(round).property('name').equals('UnsupportedNetworkError');
    expect(round).property('message').equals('wrong chain');
    expect(round).property('info').deep.equals({ expected: 1, actual: 137 });
  });

  it('a bigint receipt in info round-trips as a decimal string; the live error keeps the bigint', () => {
    const err = new TransactionRevertedError('reverted', {
      info: { transactionHash: HASH, receipt: RECEIPT }
    });
    const round: unknown = JSON.parse(JSON.stringify(err));
    expect(round).nested.property('info.receipt.blockNumber').equals('123');
    expect(round).nested.property('info.receipt.logs[0].logIndex').equals(0);
    expect(err.info.receipt.blockNumber).equals(123n);
  });

  it('bigints inside a serialised cause are stringified too', () => {
    const inner = new TransactionRevertedError('reverted', {
      info: { transactionHash: HASH, receipt: RECEIPT }
    });
    const err = new ConfirmationError({
      info: { operation: 'confirmed', mode: 'confirm' },
      cause: inner
    });
    const round: unknown = JSON.parse(JSON.stringify(err));
    expect(round).nested.property('cause.info.receipt.blockNumber').equals('123');
  });

  it('keeps the cause and appends its message (VError accumulation)', () => {
    const inner = new Error('rpc dropped the request');
    const err = new HttpRequestFailedError('request failed', {
      info: { url: 'https://api.example' },
      cause: inner
    });
    expect(err.cause).property('message').equals(inner.message);
    expect(err.message).equals('request failed: rpc dropped the request');
    expect(err).property('shortMessage').equals('request failed');
  });

  it('redacts ?token= in its own message and stack, but leaves the cause object untouched', () => {
    const inner = new Error('fetch https://rpc.example/?token=SECRET failed');
    const err = new HttpRequestFailedError('request failed', {
      info: { url: 'https://rpc.example' },
      cause: inner
    });
    expect(err.message).contains('token=***');
    expect(err.message).not.contains('SECRET');
    expect(err.stack ?? '').not.contains('SECRET');
    expect(inner.message).contains('SECRET');
  });

  it('toJSON redacts tokens in nested causes and info', () => {
    const inner = Object.assign(new Error('boom ?token=SECRET'), {
      info: { url: 'https://x/?token=SECRET' }
    });
    const err = new HttpRequestFailedError('request failed', {
      info: { url: 'https://x/?a=1&token=SECRET' },
      cause: inner
    });
    const json = JSON.stringify(err);
    expect(json).not.contains('SECRET');
    expect(json).contains('token=***');
  });

  it('typed info is readable without narrowing', () => {
    const err = new IndexOutOfBoundsError('out of range', { info: { index: 4, available: 2 } });
    const available: number = err.info.available;
    expect(available).equals(2);
  });

  it('operation errors name the operation and keep the cause message', () => {
    const cause = new BurnTxNotCheckpointedError('Burn transaction is not checkpointed yet', {
      info: { burnTxHash: HASH }
    });
    const err = new ExitError({ info: OP, cause });
    expect(err.message).equals('completeWithdraw failed: Burn transaction is not checkpointed yet');
    expect(err.info).deep.equals(OP);
    expect(err.cause).property('name').equals('BurnTxNotCheckpointedError');
    expect(err.cause).property('message').equals(cause.message);
    expect(VError.fullStack(err)).contains('caused by: BurnTxNotCheckpointedError');
  });
});

describe('no RPC token survives on an SDK error', () => {
  const SECRET = 'SECRET123';
  const surfaces = (err: Error): Record<string, string> => ({
    message: err.message,
    stack: err.stack ?? '',
    fullStack: VError.fullStack(err),
    inspect: inspect(err, { depth: Infinity }),
    json: JSON.stringify(err)
  });

  it('a token in a raw cause is absent from message, stack, fullStack, inspect and JSON', () => {
    const err = new ExitError({
      info: OP,
      cause: new Error(`fetch failed https://rpc.example/?token=${SECRET}`)
    });
    for (const [surface, text] of Object.entries(surfaces(err))) {
      expect(text, surface).not.contains(SECRET);
    }
    expect(err.message).contains('token=***');
  });

  it('a token is absent from shortMessage and info at construction', () => {
    const err = new HttpRequestFailedError('GET https://p/x?token=S failed', {
      info: { url: 'https://p/x?token=S' }
    });
    expect(err.shortMessage).not.contains('token=S');
    expect(err.shortMessage).contains('token=***');
    expect(err.info.url).equals('https://p/x?token=***');
  });

  it('info is deep-redacted, keeps its bigints and leaves the caller object alone', () => {
    const raw = { nested: { url: `https://rpc.example/?token=${SECRET}` }, amount: 5n };
    const err = new HttpRequestFailedError('bad body', { info: { raw } });
    expect(err.info).nested.property('raw.nested.url').equals('https://rpc.example/?token=***');
    expect(err.info).nested.property('raw.amount').equals(5n);
    expect(raw.nested.url).contains(SECRET);
    for (const [surface, text] of Object.entries(surfaces(err))) {
      expect(text, surface).not.contains(SECRET);
    }
  });

  it('a token deep in a library cause (info, .error, nested cause) never reaches inspect or fullStack', () => {
    const library = Object.assign(new Error('could not coalesce error'), {
      code: 'UNKNOWN_ERROR',
      error: { code: -32000, message: `upstream https://rpc.example/?token=${SECRET}` },
      info: { requestUrl: `https://rpc.example/?token=${SECRET}` }
    });
    const err = new DepositError({
      info: { operation: 'deposit', mode: 'write' },
      cause: new Error('mid', { cause: library })
    });
    for (const [surface, text] of Object.entries(surfaces(err))) {
      expect(text, surface).not.contains(SECRET);
    }
    expect(errors.rootCause(err)).property('code').equals(-32000);
  });

  it('the stored cause keeps its prototype, name, code and own fields', () => {
    const cause = Object.assign(new TypeError('boom ?token=zzz'), { code: 'E_X', extra: 1 });
    const err = new ExitError({ info: OP, cause });
    expect(err.cause).instanceOf(TypeError);
    expect(err.cause).property('name').equals('TypeError');
    expect(err.cause).property('code').equals('E_X');
    expect(err.cause).property('extra').equals(1);
    expect(err.cause).property('message').equals('boom ?token=***');
  });

  it('a condition-error cause keeps its class, info, legacy type and toJSON', () => {
    const condition = new NullSpenderAddressError('no spender', { info: { tokenAddress: TOKEN } });
    const err = new ApproveError({
      info: { operation: 'approve', mode: 'write' },
      cause: condition
    });
    expect(err.cause).instanceOf(NullSpenderAddressError);
    expect(err.cause).property('type').equals('null_spender_address');
    expect(err.cause).nested.property('info.tokenAddress').equals(TOKEN);
    expect(JSON.parse(JSON.stringify(err)))
      .nested.property('cause.type')
      .equals('null_spender_address');
  });
});

describe('toJSON', () => {
  it("keeps each nested link's legacy type when verror's fetch sanitiser clones the chain", () => {
    const fetchError = new HttpRequestError({
      url: 'https://rpc.example/?token=SECRET',
      details: 'fetch failed',
      body: { method: 'eth_call' }
    });
    const condition = new NullSpenderAddressError('no spender', {
      info: { tokenAddress: TOKEN },
      cause: fetchError
    });
    const err = new ExitError({ info: OP, cause: condition });
    const json = JSON.stringify(err);
    expect(json).not.contains('SECRET');
    const round: unknown = JSON.parse(json);
    expect(round).nested.property('cause.name').equals('NullSpenderAddressError');
    expect(round).nested.property('cause.type').equals('null_spender_address');
  });

  it('serialises Error-valued info without throwing', () => {
    const inner = Object.assign(new Error('inner ?token=SECRET'), { amount: 5n });
    const err = new HttpRequestFailedError('bad body', { info: { raw: inner } });
    const json = JSON.stringify(err);
    expect(json).not.contains('SECRET');
    const round: unknown = JSON.parse(json);
    expect(round).nested.property('info.raw.message').equals('inner ?token=***');
    expect(round).nested.property('info.raw.amount').equals('5');
  });

  it('serialises cyclic info without throwing', () => {
    const raw: Record<string, unknown> = { amount: 7n };
    raw['self'] = raw;
    const err = new HttpRequestFailedError('bad body', { info: { raw } });
    const round: unknown = JSON.parse(JSON.stringify(err));
    expect(round).nested.property('info.raw.amount').equals('7');
    expect(round).nested.property('info.raw.self').equals('[Circular]');
  });
});

describe('withOperation', () => {
  it('passes the result through', async () => {
    const value = await withOperation({ error: DepositError, info: OP, run: async () => 42 });
    expect(value).equals(42);
  });

  it('turns a synchronous throw inside run into a rejection', async () => {
    let returned = false;
    const pending = withOperation({
      error: ExitError,
      info: OP,
      run: () => {
        throw new NegativeIndexError('index must not be negative', { info: { index: -1 } });
      }
    });
    returned = true;
    const err = await rejection(() => pending);
    expect(returned).equals(true);
    expect(err).property('name').equals('ExitError');
    expect(NegativeIndexError.has(err)).equals(true);
  });

  it('rethrows a non-SDK Error unchanged, by identity', async () => {
    const libraryError = Object.assign(new Error('boom http://rpc/?token=S'), { code: 4001 });
    const err = await rejection(() =>
      withOperation({ error: ApproveError, info: OP, run: () => Promise.reject(libraryError) })
    );
    expect(err).equals(libraryError);
    expect(err).property('message').equals('boom http://rpc/?token=S');
  });

  it('rethrows a non-Error throw unchanged', async () => {
    const raw = { code: 4001, message: 'User rejected the request' };
    expect(
      await rejection(() =>
        withOperation({ error: ApproveError, info: OP, run: () => Promise.reject(raw) })
      )
    ).equals(raw);
    expect(
      await rejection(() =>
        withOperation({ error: ExitError, info: OP, run: () => Promise.reject('plain string') })
      )
    ).equals('plain string');
  });

  it('collapses a nested operation error: one layer, outer name and operation, merged info, inner cause kept', async () => {
    const condition = new TransactionNotFoundError('not found', {
      info: { transactionHash: HASH }
    });
    const err = await rejection(() =>
      withOperation({
        error: ExitError,
        info: { operation: 'completeWithdrawFast', mode: 'write', isFast: true },
        run: () =>
          withOperation({
            error: ProofBuildError,
            info: { operation: 'buildExitPayload', mode: 'read', burnTxHash: HASH },
            run: () => Promise.reject(condition)
          })
      })
    );
    expect(err).property('name').equals('ExitError');
    expect(err).nested.property('cause.name').equals('TransactionNotFoundError');
    expect(err).nested.property('cause.message').equals(condition.message);
    expect(err).property('info').deep.equals({
      operation: 'completeWithdrawFast',
      mode: 'write',
      isFast: true,
      burnTxHash: HASH
    });
    expect(ProofBuildError.has(err)).equals(false);
    expect(err).property('message').equals('completeWithdrawFast failed: not found');
  });

  it('an explicit undefined in the outer info does not clobber the inner value', async () => {
    const err = await rejection(() =>
      withOperation({
        error: ExitError,
        info: { operation: 'completeWithdraw', mode: 'write', burnTxHash: undefined },
        run: () =>
          withOperation({
            error: ProofBuildError,
            info: { operation: 'buildExitPayload', mode: 'read', burnTxHash: HASH },
            run: () =>
              Promise.reject(
                new TransactionNotFoundError('boom', { info: { transactionHash: HASH } })
              )
          })
      })
    );
    expect(err).nested.property('info.burnTxHash').equals(HASH);
    expect(err).nested.property('info.operation').equals('completeWithdraw');
  });

  it('rethrows an unprintable non-Error value unchanged', async () => {
    const unprintable: unknown = Object.create(null);
    const err = await rejection(() =>
      withOperation({ error: ExitError, info: OP, run: () => Promise.reject(unprintable) })
    );
    expect(err).equals(unprintable);
  });
});
