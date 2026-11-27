import { describe, expect, it, vi } from 'vitest';

import type { Adapter, Hex } from '../../src/adapter.ts';
import type { LibraryName } from './contract-call-harness.ts';

import { StakeManagerABI } from '../../src/abi/index.ts';
import {
  AdapterResultMismatchError,
  isMaticjsError,
  MATICJS_ERROR_NAMES
} from '../../src/errors.ts';
import * as root from '../../src/index.ts';
import { ContractCaller } from '../../src/internal/contract-caller.ts';
import { noopLogger } from '../../src/logger.ts';
import { adapterOver, LIBRARIES, RecordingAdapter, RequestLog } from './contract-call-harness.ts';

/**
 * A read result that does not match the ABI is worded for whoever has to act:
 * a hand-written adapter is told what its `read()` must return, the SDK's own
 * adapters (viem, ethers v5, ethers v6) are reported as the SDK's bug. Which
 * kind an adapter is comes from a registry the built-in adapters join when they
 * are constructed, so each case below builds the real adapter.
 */

const ADDRESS: Hex = '0x00000000000000000000000000000000000000c1';

const callerOver = (adapter: Adapter): ContractCaller<typeof StakeManagerABI> =>
  new ContractCaller({
    adapter,
    getAddress: () => Promise.resolve(ADDRESS),
    abi: StakeManagerABI,
    isParent: true,
    logger: noopLogger
  });

/** What `locked()` rejects with when the adapter answers with a string. */
const lockedRejection = async (adapter: Adapter): Promise<unknown> => {
  try {
    await callerOver(adapter).read('locked', []);
  } catch (err) {
    return err;
  }
  throw new Error('expected the read to reject');
};

/** The three real adapters, each answering `locked()` with a string, which the ABI says is a bool. */
const builtInReturningString = (library: LibraryName): Adapter => {
  const adapter = adapterOver({ library, node: { chainId: 1, rpc: () => '0x' } });
  vi.spyOn(adapter, 'read').mockResolvedValue('false');
  return adapter;
};

const CUSTOM_MESSAGE =
  "Your adapter's read() returned a string for locked output 0 (the ABI declares bool). " +
  'read() must return the value viem or ethers produces for that output.';
const BUILT_IN_MESSAGE =
  'The built-in adapter returned a string for locked output 0 (the ABI declares bool). ' +
  'This should not happen with valid data; report it as an issue against @polygonlabs/maticjs.';

describe('which message a mismatch carries', () => {
  it('tells a hand-written adapter what read() must return', async () => {
    const adapter = new RecordingAdapter({
      side: 'parent',
      log: new RequestLog(),
      answers: { locked: 'false' }
    });
    const err = await lockedRejection(adapter);
    expect(err).instanceOf(AdapterResultMismatchError);
    expect(err).property('message').equals(CUSTOM_MESSAGE);
  });

  it.each(LIBRARIES)('reports a mismatch from the %s adapter as an SDK issue', async (library) => {
    const err = await lockedRejection(builtInReturningString(library));
    expect(err).instanceOf(AdapterResultMismatchError);
    expect(err).property('message').equals(BUILT_IN_MESSAGE);
  });

  it('treats an adapter that only wraps a built-in one as hand-written', async () => {
    const inner = builtInReturningString('viem');
    const wrapper = new RecordingAdapter({ side: 'parent', log: new RequestLog() });
    wrapper.read = (req) => inner.read(req);
    const err = await lockedRejection(wrapper);
    expect(err).property('message').equals(CUSTOM_MESSAGE);
  });
});

describe('AdapterResultMismatchError', () => {
  const info = {
    method: 'locked',
    field: 'locked.0',
    expectedType: 'bool',
    receivedType: 'string'
  } as const;

  it('is one of the SDK names and is exported from the root entry', () => {
    expect(MATICJS_ERROR_NAMES.has('AdapterResultMismatchError')).equals(true);
    expect(root.AdapterResultMismatchError).equals(AdapterResultMismatchError);
  });

  it('is recognised and found by name, also after a JSON round trip', () => {
    const err = new AdapterResultMismatchError('m', { info });
    expect(isMaticjsError(err)).equals(true);
    const wrapped = new Error('outer', { cause: err });
    expect(AdapterResultMismatchError.find(wrapped)).property('info').deep.equals(info);
    expect(AdapterResultMismatchError.has(wrapped)).equals(true);

    const parsed: unknown = JSON.parse(JSON.stringify(err));
    expect(isMaticjsError(parsed)).equals(true);
    expect(AdapterResultMismatchError.has(parsed)).equals(true);
    expect(AdapterResultMismatchError.has(new Error('other'))).equals(false);
  });

  it('never carries a cause', async () => {
    const adapter = new RecordingAdapter({
      side: 'parent',
      log: new RequestLog(),
      answers: { locked: 'false' }
    });
    const err = await lockedRejection(adapter);
    expect(err).instanceOf(AdapterResultMismatchError);
    if (!(err instanceof AdapterResultMismatchError)) return;
    expect(err.cause).equal(undefined);
    expect(err.info).deep.equals(info);
  });
});
