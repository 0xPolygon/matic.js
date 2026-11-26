import { describe, expect, it } from 'vitest';

import type { Hex, PreparedTx, ReadRequest, TxResult, WriteRequest } from '../../src/adapter.ts';
import type { WriteCall } from '../../src/internal/abi-types.ts';
import type { ContractCallerOptions } from '../../src/internal/contract-caller.ts';
import type { RequestRow } from './contract-call-harness.ts';

import { ChildERC20ABI, StakeManagerABI } from '../../src/abi/index.ts';
import { BridgeEventDecodeFailedError, TxOptionNotObjectError } from '../../src/errors.ts';
import { ContractCaller } from '../../src/internal/contract-caller.ts';
import { noopLogger } from '../../src/logger.ts';
import { OTHER, RecordingAdapter, RequestLog, rowsOf, USER } from './contract-call-harness.ts';

/**
 * The caller is generic over its ABI and decodes every read, but the requests
 * it hands the adapter must not move: the rows below are the 4.0 caller's
 * requests for the token ABI, written out by hand so a change to what a typed
 * call sends fails against a stated expectation, not a value recomputed from
 * the code under test.
 */

const TOKEN: Hex = '0x00000000000000000000000000000000000000c1';
const SPENDER: Hex = '0x2222222222222222222222222222222222222222';

const FULL_OPTIONS: ContractCallerOptions = {
  from: USER,
  value: 11n,
  gasLimit: 500_000n,
  maxFeePerGas: 30n,
  maxPriorityFeePerGas: 2n,
  nonce: 9,
  chainId: 1
};

const stringArg = (value: string) => ({ type: 'string', value });
const bigintArg = (n: bigint) => ({ type: 'bigint', value: { $bigint: n.toString() } });
const APPROVE_ARGS = [stringArg(SPENDER), bigintArg(5n)];
const ROW = { side: 'parent', contract: 'ChildERC20ABI', address: TOKEN } as const;

const BALANCE_OF: RequestRow = {
  ...ROW,
  kind: 'read',
  functionName: 'balanceOf',
  args: [stringArg(USER)],
  blockTag: null
};
const ESTIMATE_APPROVE: RequestRow = {
  ...ROW,
  kind: 'estimateGas',
  functionName: 'approve',
  args: APPROVE_ARGS
};
/** A write whose gas limit the caller took from the estimate (21000 + headroom, scaled). */
const WRITE_APPROVE: RequestRow = {
  ...ROW,
  kind: 'write',
  functionName: 'approve',
  args: APPROVE_ARGS,
  gasLimit: { $bigint: '24149' },
  chainId: 1
};
const WRITE_APPROVE_EVERY_OPTION: RequestRow = {
  ...ROW,
  kind: 'write',
  functionName: 'approve',
  args: APPROVE_ARGS,
  from: USER,
  value: { $bigint: '11' },
  gasLimit: { $bigint: '500000' },
  maxFeePerGas: { $bigint: '30' },
  maxPriorityFeePerGas: { $bigint: '2' },
  nonce: 9,
  chainId: 1
};
const PREPARE_APPROVE: RequestRow = {
  ...ROW,
  kind: 'prepareWrite',
  functionName: 'approve',
  args: APPROVE_ARGS
};

const world = ({ answers }: { answers?: Record<string, unknown> } = {}) => {
  const log = new RequestLog();
  const adapter = new RecordingAdapter({ side: 'parent', log, answers });
  const caller = new ContractCaller({
    adapter,
    getAddress: () => Promise.resolve(TOKEN),
    abi: ChildERC20ABI,
    isParent: true,
    logger: noopLogger
  });
  return { log, adapter, caller };
};

describe('requests are what the 4.0 caller sent, through each call shape', () => {
  it('read: the strict signature and the pinned block', async () => {
    const plain = world();
    await plain.caller.read('balanceOf', [USER]);
    expect(rowsOf(plain.log)).deep.equal([BALANCE_OF]);

    const pinned = world();
    await pinned.caller.read('balanceOf', [USER], { blockTag: 'finalized' });
    expect(rowsOf(pinned.log)).deep.equal([{ ...BALANCE_OF, blockTag: 'finalized' }]);
  });

  it('write: estimate then send, by method name and by descriptor', async () => {
    const expected = [ESTIMATE_APPROVE, WRITE_APPROVE];
    const byName = world();
    await byName.caller.write('approve', [SPENDER, 5n]);
    const byDescriptor = world();
    await byDescriptor.caller.write({ method: 'approve', args: [SPENDER, 5n] });
    for (const w of [byName, byDescriptor]) {
      expect(rowsOf(w.log)).deep.equal(expected);
    }
  });

  it('write: every option reaches the adapter, and a given gas limit skips the estimate', async () => {
    const expected = [WRITE_APPROVE_EVERY_OPTION];
    const byName = world();
    await byName.caller.write('approve', [SPENDER, 5n], FULL_OPTIONS);
    const byDescriptor = world();
    await byDescriptor.caller.write({ method: 'approve', args: [SPENDER, 5n] }, FULL_OPTIONS);
    expect(rowsOf(byName.log)).deep.equal(expected);
    expect(rowsOf(byDescriptor.log)).deep.equal(expected);
  });

  it('write: the internal gas headroom is added to the estimate', async () => {
    const w = world();
    await w.caller.write('approve', [SPENDER, 5n], {}, { gasHeadroom: 1000n });
    const written = w.log.entries.find((e) => e.kind === 'write');
    expect(written?.req).property('gasLimit', 25_149n);
    const described = world();
    await described.caller.write(
      { method: 'approve', args: [SPENDER, 5n] },
      {},
      { gasHeadroom: 1000n }
    );
    expect(described.log.entries.find((e) => e.kind === 'write')?.req).property(
      'gasLimit',
      25_149n
    );
  });

  it('prepareWrite: by method name and by descriptor', async () => {
    const expected = [PREPARE_APPROVE];
    const byName = world();
    await byName.caller.prepareWrite('approve', [SPENDER, 5n]);
    const byDescriptor = world();
    await byDescriptor.caller.prepareWrite({ method: 'approve', args: [SPENDER, 5n] });
    expect(rowsOf(byName.log)).deep.equal(expected);
    expect(rowsOf(byDescriptor.log)).deep.equal(expected);
  });

  // `from` and `value` pass through unchanged, and `from` falls back to the caller's default sender.
  it('prepareWrite and estimateGas pass `from` and `value` through, with the default sender as fallback', async () => {
    const withOptions = world();
    await withOptions.caller.prepareWrite('approve', [SPENDER, 5n], { from: USER, value: 11n });
    await withOptions.caller.estimateGas('approve', [SPENDER, 5n], { from: USER, value: 11n });
    for (const row of rowsOf(withOptions.log)) {
      expect(row).property('from', USER);
      expect(row).deep.property('value', { $bigint: '11' });
    }

    const log = new RequestLog();
    const withDefault = new ContractCaller({
      adapter: new RecordingAdapter({ side: 'parent', log }),
      getAddress: () => Promise.resolve(TOKEN),
      abi: ChildERC20ABI,
      isParent: true,
      logger: noopLogger,
      defaultFrom: OTHER
    });
    await withDefault.prepareWrite({ method: 'approve', args: [SPENDER, 5n] });
    await withDefault.estimateGas({ method: 'approve', args: [SPENDER, 5n] });
    for (const row of rowsOf(log)) expect(row).property('from', OTHER);
  });

  it('estimateGas: the same estimate request a write makes, with the multiplier applied', async () => {
    const expected = [ESTIMATE_APPROVE];
    const byName = world();
    expect(await byName.caller.estimateGas('approve', [SPENDER, 5n])).equal(24_149n);
    const byDescriptor = world();
    expect(await byDescriptor.caller.estimateGas({ method: 'approve', args: [SPENDER, 5n] })).equal(
      24_149n
    );
    expect(rowsOf(byName.log)).deep.equal(expected);
    expect(rowsOf(byDescriptor.log)).deep.equal(expected);
  });
});

/** An adapter whose every contract call rejects with the same object. */
class FailingAdapter extends RecordingAdapter {
  readonly #failure: unknown;
  constructor(failure: unknown) {
    super({ side: 'parent', log: new RequestLog() });
    this.#failure = failure;
  }
  override read(_req: ReadRequest): Promise<unknown> {
    return Promise.reject(this.#failure);
  }
  override write(_req: WriteRequest): Promise<TxResult> {
    return Promise.reject(this.#failure);
  }
  override prepareWrite(_req: WriteRequest): Promise<PreparedTx> {
    return Promise.reject(this.#failure);
  }
  override estimateGas(_req: WriteRequest): Promise<bigint> {
    return Promise.reject(this.#failure);
  }
}

const failingCaller = (failure: unknown): ContractCaller<typeof ChildERC20ABI> =>
  new ContractCaller({
    adapter: new FailingAdapter(failure),
    getAddress: () => Promise.resolve(TOKEN),
    abi: ChildERC20ABI,
    isParent: true,
    logger: noopLogger
  });

const outcome = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to reject');
};

describe('a library error reaches the caller as the same object', () => {
  // Stands in for an ethers or viem error: an Error carrying a library-style `code`.
  const libraryError = Object.assign(new Error('execution reverted'), {
    code: 'CALL_EXCEPTION',
    reason: 'execution reverted'
  });

  it.each([
    ['read', (c: ContractCaller<typeof ChildERC20ABI>) => c.read('balanceOf', [USER])],
    ['write', (c: ContractCaller<typeof ChildERC20ABI>) => c.write('approve', [SPENDER, 1n])],
    [
      'write by descriptor',
      (c: ContractCaller<typeof ChildERC20ABI>) =>
        c.write({ method: 'approve', args: [SPENDER, 1n] })
    ],
    [
      'prepareWrite',
      (c: ContractCaller<typeof ChildERC20ABI>) => c.prepareWrite('approve', [SPENDER, 1n])
    ],
    [
      'estimateGas',
      (c: ContractCaller<typeof ChildERC20ABI>) => c.estimateGas('approve', [SPENDER, 1n])
    ]
  ])('%s', async (_name, run) => {
    const thrown = await outcome(() => run(failingCaller(libraryError)));
    expect(thrown).equal(libraryError);
  });
});

describe('a read is validated against the ABI', () => {
  it('returns one bigint whatever the library handed back', async () => {
    const ethersV5BigNumber = { toString: () => '123' };
    for (const raw of [123n, '123', 123, ethersV5BigNumber]) {
      const { caller } = world({ answers: { balanceOf: raw } });
      expect(await caller.read('balanceOf', [USER])).equal(123n);
    }
  });

  it('rejects a malformed result with BridgeEventDecodeFailedError naming the field and no cause', async () => {
    const { caller } = world({ answers: { balanceOf: 'not a number' } });
    const err = await outcome(() => caller.read('balanceOf', [USER]));
    expect(err).instanceOf(BridgeEventDecodeFailedError);
    if (!(err instanceof BridgeEventDecodeFailedError)) return;
    expect(err.info).property('field', 'balanceOf.0');
    expect(err.info).property('valueType', 'string');
    expect(err.cause).equal(undefined);
  });

  it('rejects a bool that arrives as a string, which would otherwise be truthy', async () => {
    const log = new RequestLog();
    const caller = new ContractCaller({
      adapter: new RecordingAdapter({ side: 'parent', log, answers: { locked: 'false' } }),
      getAddress: () => Promise.resolve(TOKEN),
      abi: StakeManagerABI,
      isParent: true,
      logger: noopLogger
    });
    const err = await outcome(() => caller.read('locked', []));
    expect(err).instanceOf(BridgeEventDecodeFailedError);
  });

  it('decodes a multi-output read to a positional tuple', async () => {
    const log = new RequestLog();
    const raw = Object.assign(
      [
        1n,
        '2',
        { toString: () => '3' },
        4,
        5n,
        `0x${'ab'.repeat(20)}`,
        `0x${'cd'.repeat(20)}`,
        1,
        7n,
        8n,
        9n,
        10n,
        11n
      ],
      { amount: 'a name an ethers Result carries, ignored' }
    );
    const caller = new ContractCaller({
      adapter: new RecordingAdapter({ side: 'parent', log, answers: { validators: raw } }),
      getAddress: () => Promise.resolve(TOKEN),
      abi: StakeManagerABI,
      isParent: true,
      logger: noopLogger
    });
    const decoded = await caller.read('validators', [1n]);
    expect(decoded[0]).equal(1n);
    expect(decoded[1]).equal(2n);
    expect(decoded[2]).equal(3n);
    expect(decoded[5]).equal(`0x${'ab'.repeat(20)}`);
    expect(decoded[7]).equal(1n);
  });

  it('fails a method the ABI does not carry with a plain Error, not an SDK error', async () => {
    const { caller } = world({ answers: { missingMethod: 1n } });
    // A plain-JS caller can name a method the ABI lacks; the compiler rejects it.
    // @ts-expect-error not a function of the token ABI
    const err = await outcome(() => caller.read('missingMethod', []));
    expect(err).instanceOf(Error);
    expect(err).not.instanceOf(BridgeEventDecodeFailedError);
    expect(err).property('message').include('missingMethod');
  });
});

const APPROVE: WriteCall<typeof ChildERC20ABI> = { method: 'approve', args: [SPENDER, 1n] };

type CallName = 'read' | 'write' | 'prepareWrite' | 'estimateGas' | 'writeByDescriptor';
const CALL_NAMES: CallName[] = [
  'read',
  'write',
  'prepareWrite',
  'estimateGas',
  'writeByDescriptor'
];

describe('options are still checked up front', () => {
  const callsWith = (caller: ContractCaller<typeof ChildERC20ABI>) => ({
    // A plain-JS caller can hand any value as options; the types forbid it, the checks must not.
    // @ts-expect-error options is deliberately not a ContractCallerOptions
    read: (options: unknown) => caller.read('balanceOf', [USER], options),
    // @ts-expect-error options is deliberately not a ContractCallerOptions
    write: (options: unknown) => caller.write('approve', [SPENDER, 1n], options),
    // @ts-expect-error options is deliberately not a ContractCallerOptions
    prepareWrite: (options: unknown) => caller.prepareWrite('approve', [SPENDER, 1n], options),
    // @ts-expect-error options is deliberately not a ContractCallerOptions
    estimateGas: (options: unknown) => caller.estimateGas('approve', [SPENDER, 1n], options),
    // @ts-expect-error options is deliberately not a ContractCallerOptions
    writeByDescriptor: (options: unknown) => caller.write(APPROVE, options)
  });

  const named: Record<CallName, string> = {
    read: 'read',
    write: 'write',
    prepareWrite: 'prepareWrite',
    estimateGas: 'estimateGas',
    writeByDescriptor: 'write'
  };

  it.each(CALL_NAMES)(
    '%s rejects options that are not an object, naming the method',
    async (call) => {
      const { caller } = world();
      for (const options of [null, 'x', 5, [], true]) {
        const err = await outcome(() => callsWith(caller)[call](options));
        expect(err).instanceOf(TxOptionNotObjectError);
        expect(err).nested.property('info.method', named[call]);
      }
    }
  );

  it('rejects a call that is neither a method name nor a { method, args } descriptor', async () => {
    const { caller } = world();
    // @ts-expect-error a plain-JS caller can pass anything as the first argument
    const err = await outcome(() => caller.write({ method: 'approve' }, {}));
    expect(err).instanceOf(Error);
    expect(err).not.instanceOf(TxOptionNotObjectError);
  });
});
