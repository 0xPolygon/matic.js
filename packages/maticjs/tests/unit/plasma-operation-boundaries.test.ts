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
import type { PlasmaBridgeServices } from '../../src/plasma/erc20.ts';

import { PlasmaDepositManagerABI } from '../../src/abi/plasma/DepositManager.ts';
import { PlasmaERC20PredicateABI } from '../../src/abi/plasma/ERC20Predicate.ts';
import { RootChainABI } from '../../src/abi/RootChain.ts';
import {
  ContractNotAvailableOnNetworkError,
  isMaticjsError,
  rootCause,
  Web3ClientNotInitializedError
} from '../../src/errors.ts';
import { createBridgeChildClient } from '../../src/internal/bridge-child-client.ts';
import { ContractCaller } from '../../src/internal/contract-caller.ts';
import { ExitProofBuilder } from '../../src/internal/exit-proof.ts';
import { ProofApiClient } from '../../src/internal/proof-api-client.ts';
import { noopLogger } from '../../src/logger.ts';
import { PlasmaERC20 } from '../../src/plasma/erc20.ts';
import { PlasmaClient } from '../../src/plasma/plasma-client.ts';
import { PlasmaWithdrawManager } from '../../src/plasma/withdraw-manager.ts';
import { __resetAddressCacheForTesting } from '../../src/services/address-service.ts';

/**
 * Every public async Plasma method is driven twice against an adapter and
 * address lookup that always fail:
 *
 * - with an SDK condition, it must reject with exactly one operation error
 *   named for the call (its error class, `info.operation`, `info.mode`),
 *   the condition reachable as the root cause and the RPC token kept out
 *   of the top-level message;
 * - with a token-bearing library error (what an adapter's ethers or viem
 *   call throws), it must reject with that same object, unwrapped and with
 *   its message unaltered.
 *
 * Methods are found by reflection and compared with the tables below, so a
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
const TOKEN: Hex = '0x5555555555555555555555555555555555555555';
const USER: Hex = '0x7777777777777777777777777777777777777777';
const BURN = `0x${'ab'.repeat(32)}`;

const PLASMA_ONLY = {
  RootChain: ADDR,
  DepositManager: ADDR,
  WithdrawManager: ADDR,
  PlasmaERC20Predicate: ADDR,
  ExitNFT: ADDR,
  MaticToken: ADDR,
  PolToken: ADDR
};

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
const read = (error: string): Expected => ({ error, mode: 'read' });
const write = (error: string): Expected => ({ error, mode: 'write' });
const prepare = (error: string): Expected => ({ error, mode: 'prepare' });

/** Each row: what the call must reject with, and the arguments it is given. */
type Row = Expected & { args: readonly unknown[]; chain: 'parent' | 'child' };

const PLASMA_ERC20: Record<string, Row> = {
  getBalance: { ...read('TokenReadError'), chain: 'parent', args: [USER] },
  getAllowance: { ...read('TokenReadError'), chain: 'parent', args: [USER] },
  approve: { ...write('ApproveError'), chain: 'parent', args: [1n] },
  prepareApprove: { ...prepare('ApproveError'), chain: 'parent', args: [1n] },
  approveMax: { ...write('ApproveError'), chain: 'parent', args: [] },
  prepareApproveMax: { ...prepare('ApproveError'), chain: 'parent', args: [] },
  deposit: { ...write('DepositError'), chain: 'parent', args: [1n, USER] },
  prepareDeposit: { ...prepare('DepositError'), chain: 'parent', args: [1n, USER] },
  startWithdraw: { ...write('WithdrawStartError'), chain: 'child', args: [1n] },
  prepareStartWithdraw: { ...prepare('WithdrawStartError'), chain: 'child', args: [1n] },
  confirmWithdraw: { ...write('ExitError'), chain: 'parent', args: [BURN] },
  prepareConfirmWithdraw: { ...prepare('ExitError'), chain: 'parent', args: [BURN] },
  confirmWithdrawFast: { ...write('ExitError'), chain: 'parent', args: [BURN] },
  prepareConfirmWithdrawFast: { ...prepare('ExitError'), chain: 'parent', args: [BURN] },
  completeWithdraw: { ...write('ExitError'), chain: 'parent', args: [] },
  prepareCompleteWithdraw: { ...prepare('ExitError'), chain: 'parent', args: [] },
  getCompleteWithdrawGasLimit: { ...read('ExitError'), chain: 'parent', args: [] },
  getWithdrawStatus: {
    ...read('BridgeStatusError'),
    chain: 'parent',
    args: [{ burnTxHash: BURN }]
  }
};

const PLASMA_CLIENT: Record<string, Row> = {
  processExits: { ...write('ExitError'), chain: 'parent', args: [{ tokens: [TOKEN] }] },
  prepareProcessExits: { ...prepare('ExitError'), chain: 'parent', args: [{ tokens: [TOKEN] }] },
  getProcessExitsGasLimit: { ...read('ExitError'), chain: 'parent', args: [{ tokens: [TOKEN] }] },
  getWithdrawStatus: {
    ...read('BridgeStatusError'),
    chain: 'parent',
    args: [{ burnTxHash: BURN }]
  }
};

/** Prototype members that are not public methods: TypeScript `private` is erased at runtime. */
const NOT_PUBLIC = new Set([
  'constructor',
  'exitPayload',
  'queueToken',
  'requireParent',
  'requireChild'
]);

const publicMethods = (proto: object): string[] =>
  Object.getOwnPropertyNames(proto)
    .filter((name) => !NOT_PUBLIC.has(name))
    .sort();

const withOperationCount = (file: string): number =>
  readFileSync(join(import.meta.dirname, '../../src/plasma', file), 'utf8')
    .split('\n')
    .filter((line) => line.includes('withOperation(')).length;

const rejectionOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
};

const invoke = async ({
  target,
  name,
  args
}: {
  target: object;
  name: string;
  args: readonly unknown[];
}): Promise<unknown> => {
  const fn: unknown = Reflect.get(target, name);
  if (typeof fn !== 'function') throw new Error(`${name} is not a method`);
  return Reflect.apply(fn, target, args);
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
  expect(err, operation).property('message').contains('boom');
  expect(err, operation).property('message').contains('token=***');
  expect(err, operation).property('message').not.contains('token=S');
  expect(isMaticjsError(err), operation).equals(true);
  expect(operationLayers(err), operation).equals(1);
};

const assertPassThrough = ({ err, operation }: { err: unknown; operation: string }): void => {
  expect(err, operation).equals(LIBRARY_ERROR);
  expect(err, operation).property('message').equals(BOOM);
  expect(isMaticjsError(err), operation).equals(false);
};

// --- the collaborators, real objects over adapters and lookups that fail ---

const failingCaller = ({ abi }: { abi: readonly unknown[] }): ContractCaller =>
  new ContractCaller({
    adapter: new RejectingAdapter(),
    getAddress: () => Promise.reject(boom()),
    abi,
    isParent: true,
    logger: noopLogger,
    chainId: 1
  });

/**
 * `withProofApi` gives the exit-proof builder a proof API client, which the
 * fast confirm requires: without one it stops at `ProofApiNotSetError`
 * before it reaches anything that fails. The API itself is a failing fetch,
 * so the call falls back to local construction and fails on the child chain.
 */
const failingBridge = ({ withProofApi }: { withProofApi: boolean }): PlasmaBridgeServices => {
  const adapter = new RejectingAdapter();
  return {
    depositManager: failingCaller({ abi: PlasmaDepositManagerABI }),
    predicate: failingCaller({ abi: PlasmaERC20PredicateABI }),
    withdrawManager: new PlasmaWithdrawManager({
      adapter,
      getWithdrawManagerAddress: () => Promise.reject(boom()),
      logger: noopLogger,
      chainId: 1
    }),
    exitProof: new ExitProofBuilder({
      rootChainCaller: failingCaller({ abi: RootChainABI }),
      childClient: createBridgeChildClient(adapter),
      ...(withProofApi
        ? {
            proofApiClient: new ProofApiClient({
              baseUrl: 'https://proof.example.test',
              network: 'amoy'
            })
          }
        : {}),
      logger: noopLogger,
      proofConcurrency: 1
    }),
    getAddresses: () => Promise.reject(boom()),
    readStatus: () => Promise.reject(boom())
  };
};

const failingToken = ({
  isParent,
  operation
}: {
  isParent: boolean;
  operation: string;
}): PlasmaERC20 =>
  new PlasmaERC20({
    tokenAddress: TOKEN,
    isParent,
    adapter: new RejectingAdapter(),
    chainId: 1,
    logger: noopLogger,
    bridge: failingBridge({ withProofApi: operation.includes('Fast') })
  });

const failingClient = (): Promise<PlasmaClient> =>
  PlasmaClient.init({
    network: 'amoy',
    parent: new RejectingAdapter(),
    child: new RejectingAdapter(),
    addresses: PLASMA_ONLY
  });

describe('plasma operation boundaries', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAddressCacheForTesting();
    failure = 'condition';
  });

  describe('coverage', () => {
    it('PlasmaERC20: the table covers every public method, one wrap each', () => {
      const methods = publicMethods(PlasmaERC20.prototype);
      expect(methods).deep.equals(Object.keys(PLASMA_ERC20).sort());
      expect(withOperationCount('erc20.ts')).equals(methods.length);
    });

    it('PlasmaClient: the table covers every public method, one wrap each, plus init', () => {
      const methods = publicMethods(PlasmaClient.prototype);
      expect(methods).deep.equals([...Object.keys(PLASMA_CLIENT), 'getAddresses'].sort());
      expect(withOperationCount('plasma-client.ts')).equals(methods.length + 1);
    });

    it('PlasmaWithdrawManager: processExits, prepareProcessExits and getProcessExitsGasLimit are the three wraps', () => {
      // The queue read and the gas helpers are called from inside those
      // wraps and must not add an operation layer of their own.
      expect(withOperationCount('withdraw-manager.ts')).equals(3);
    });
  });

  describe('PlasmaERC20', () => {
    it.each(Object.entries(PLASMA_ERC20))(
      '%s rethrows a library error unchanged',
      async (operation, row) => {
        failure = 'library';
        vi.stubGlobal('fetch', () => Promise.reject(boom()));
        const target = failingToken({ isParent: row.chain === 'parent', operation });
        const err = await rejectionOf(() => invoke({ target, name: operation, args: row.args }));
        assertPassThrough({ err, operation });
      }
    );

    it.each(Object.entries(PLASMA_ERC20))(
      '%s rejects with one operation error',
      async (operation, row) => {
        vi.stubGlobal('fetch', () => Promise.reject(boom()));
        const target = failingToken({ isParent: row.chain === 'parent', operation });
        const err = await rejectionOf(() => invoke({ target, name: operation, args: row.args }));
        assertBoundary({ err, operation, expected: row });
        expect(err, operation).nested.property('info.tokenAddress').equals(TOKEN);
      }
    );
  });

  describe('PlasmaClient', () => {
    it.each(Object.entries(PLASMA_CLIENT))(
      '%s rethrows a library error unchanged',
      async (operation, row) => {
        failure = 'library';
        const target = await failingClient();
        const err = await rejectionOf(() => invoke({ target, name: operation, args: row.args }));
        assertPassThrough({ err, operation });
      }
    );

    it.each(Object.entries(PLASMA_CLIENT))(
      '%s rejects with one operation error',
      async (operation, row) => {
        const target = await failingClient();
        const err = await rejectionOf(() => invoke({ target, name: operation, args: row.args }));
        assertBoundary({ err, operation, expected: row });
      }
    );

    it('init rejects with one InitError over the lookup failure', async () => {
      vi.stubGlobal('fetch', () => Promise.reject(boom()));
      const err = await rejectionOf(() =>
        PlasmaClient.init({
          network: 'mainnet',
          parent: new RejectingAdapter(),
          child: new RejectingAdapter(),
          addressIndexUrl: 'https://address-index.test/plasma-boundaries'
        })
      );
      assertBoundary({ err, operation: 'init', expected: { error: 'InitError', mode: 'init' } });
    });

    it('getAddresses rejects with one AddressLookupError over the missing-contract condition', async () => {
      // A background refresh that drops a Plasma contract is rejected inside
      // the address source and the last good addresses keep being served, so
      // the lookup fails only on a foreground read: here the cache is emptied
      // and the index served now lacks a contract. No library error can come
      // out of it.
      const full = {
        ...PLASMA_ONLY,
        RootChainManager: ADDR,
        ERC20Predicate: ADDR,
        ERC721Predicate: ADDR,
        ERC1155Predicate: ADDR,
        EtherPredicate: ADDR
      };
      let served: Record<string, unknown> = full;
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(served))));
      const client = await PlasmaClient.init({
        network: 'amoy',
        parent: new RejectingAdapter(),
        child: new RejectingAdapter(),
        addressIndexUrl: 'https://address-index.test/plasma-boundaries'
      });
      const { ExitNFT: _dropped, ...without } = full;
      served = without;
      __resetAddressCacheForTesting();

      const err = await rejectionOf(() => client.getAddresses());

      expect(err).property('name').equals('AddressLookupError');
      expect(err).nested.property('info.operation').equals('getAddresses');
      expect(err).nested.property('info.mode').equals('read');
      expect(ContractNotAvailableOnNetworkError.has(err)).equals(true);
      expect(operationLayers(err)).equals(1);
    });
  });
});
