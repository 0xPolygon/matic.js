import { BaseError as ViemBaseError } from 'viem';
import { expect } from 'vitest';

import type { Adapter, TxResult } from '../../src/adapter.ts';

import { isMaticjsError, MATICJS_ERROR_NAMES } from '../../src/errors.ts';

/**
 * Helpers for the falsification matrix: they prove that an error raised by
 * ethers, viem, the wallet or the node reaches the consumer as the very
 * object the library threw, and that the SDK never hangs one under an SDK
 * error as its `cause`.
 */

/**
 * True for an error built by ethers (v5 or v6) or viem. ethers tags its
 * errors with a string `code` plus `reason` (v5) or `shortMessage` (v6);
 * viem's all extend its `BaseError`. SDK errors carry neither a string
 * `code` nor viem's base class.
 */
export const isLibraryError = (value: unknown): boolean => {
  if (value instanceof ViemBaseError) return true;
  if (!(value instanceof Error)) return false;
  const code: unknown = Reflect.get(value, 'code');
  return typeof code === 'string' && ('reason' in value || 'shortMessage' in value);
};

/**
 * Fails when an SDK error in `err`'s chain has an ethers or viem error as
 * its cause. The walk follows SDK errors only: below the first link that is
 * not the SDK's (a fetch or parser error), the chain is that error's own.
 * A library error may reach the consumer only on its own.
 */
const SDK_NAMES: ReadonlySet<string> = MATICJS_ERROR_NAMES;

export const expectNoLibraryCause = (err: unknown): void => {
  const seen = new Set<unknown>();
  let link: unknown = err;
  while (link instanceof Error && SDK_NAMES.has(link.name) && !seen.has(link)) {
    seen.add(link);
    const cause: unknown = link.cause;
    expect(
      isLibraryError(cause),
      `${link.name} has a library error as its cause: ${String(cause)}`
    ).equals(false);
    link = cause;
  }
};

/**
 * Wraps an adapter so every rejection (and synchronous throw) of its
 * methods, and of `confirmed()` on the results of `write`, is recorded
 * before being passed on unchanged. A test then asserts the consumer's
 * error is one of these by identity.
 */
export const recordingAdapter = (
  adapter: Adapter
): { adapter: Adapter; thrown: readonly unknown[] } => {
  const thrown: unknown[] = [];
  const record = (err: unknown): never => {
    thrown.push(err);
    throw err;
  };
  const watchTx = (result: TxResult): TxResult => ({
    ...result,
    confirmed: () => result.confirmed().catch(record)
  });
  const call = <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return run().catch(record);
    } catch (err) {
      return record(err);
    }
  };
  const recorded: Adapter = {
    getChainId: () => call(() => adapter.getChainId()),
    read: (req) => call(() => adapter.read(req)),
    write: (req) => call(() => adapter.write(req)).then(watchTx),
    prepareWrite: (req) => call(() => adapter.prepareWrite(req)),
    estimateGas: (req) => call(() => adapter.estimateGas(req)),
    getTransactionReceipt: (hash) => call(() => adapter.getTransactionReceipt(hash)),
    keccak256: (data) => {
      try {
        return adapter.keccak256(data);
      } catch (err) {
        return record(err);
      }
    },
    request: <T>(method: string, params: readonly unknown[]) =>
      call(() => adapter.request<T>(method, params))
  };
  return { adapter: recorded, thrown };
};

/**
 * The wallet's or node's own error as the transport raised it: an `Error`
 * with the numeric JSON-RPC code. ethers v5 passes such an error through
 * untouched unless it recognises the text.
 */
const isRawRpcError = (value: unknown): boolean =>
  value instanceof Error && typeof Reflect.get(value, 'code') === 'number';

/**
 * The consumer's error is exactly what the library threw: the same object
 * an adapter call rejected with, a library error (or the wallet's own raw
 * error), and nothing of the SDK's.
 */
export const expectLibraryErrorByIdentity = ({
  err,
  thrown
}: {
  err: unknown;
  thrown: readonly unknown[];
}): void => {
  expect(thrown.length, 'no adapter call rejected').greaterThan(0);
  expect(thrown).include(err);
  expect(isLibraryError(err) || isRawRpcError(err)).equals(true);
  expect(isMaticjsError(err)).equals(false);
};
