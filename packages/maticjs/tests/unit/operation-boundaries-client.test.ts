/**
 * Every public async method of `POSClient`, `RootChain`, `RootChainManager`
 * and `GasSwapper` is driven twice against collaborators that all fail:
 *
 * - with an SDK condition, it must reject with exactly one operation error
 *   named after the method the consumer called, the condition still
 *   reachable as the root cause and any RPC token redacted;
 * - with a library error (what an adapter's ethers or viem call throws),
 *   it must reject with that same error object, unwrapped and unaltered.
 *
 * The method lists come from reflection over each prototype, so a public
 * method added later without a boundary wrap fails here rather than leaking
 * a bare SDK condition to consumers. Counts are checked against the number
 * of `withOperation(` calls in each source file for the same reason.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Adapter, Hex } from '../../src/adapter.ts';
import type { MaticjsOperationName, OperationMode } from '../../src/errors.ts';
import type { NetworkAddresses } from '../../src/networks.ts';

import {
  AddressLookupError,
  CheckpointReadError,
  DepositError,
  ExitError,
  BridgeStatusError,
  InitError,
  InvalidNumericValueError,
  isMaticjsError,
  NegativeIndexError,
  OnlyAllowedOnMainnetError,
  ProofBuildError,
  rootCause,
  Web3ClientNotInitializedError,
  withOperation
} from '../../src/errors.ts';
import { noopLogger } from '../../src/logger.ts';
import { POSClient } from '../../src/pos-client.ts';
import { GasSwapper } from '../../src/pos/gas_swapper.ts';
import { RootChain } from '../../src/pos/root_chain.ts';
import { RootChainManager } from '../../src/pos/root_chain_manager.ts';
import { __resetAddressCacheForTesting } from '../../src/services/address-service.ts';

const BOOM = 'boom http://rpc/?token=S';
const USER = '0x7777777777777777777777777777777777777777';
const TOKEN = '0x8888888888888888888888888888888888888888';
const BURN_TX = `0x${'ab'.repeat(32)}`;
const EVENT_SIG = `0x${'cd'.repeat(32)}`;
const CONTRACT: Hex = '0x9999999999999999999999999999999999999999';
const INDEX_URL = 'https://addresses.invalid/operation-boundaries-client/';

const ADDRESSES: NetworkAddresses = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666',
  GasSwapper: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
};

const OPERATION_NAMES: ReadonlySet<string> = new Set<MaticjsOperationName>([
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

/** Every method rejects (or, for the sync `keccak256`, throws) with `boom()`. */
function boomAdapter({ chainId }: { chainId?: number } = {}): Adapter {
  return {
    getChainId: () => (chainId === undefined ? Promise.reject(boom()) : Promise.resolve(chainId)),
    read: () => Promise.reject(boom()),
    write: () => Promise.reject(boom()),
    prepareWrite: () => Promise.reject(boom()),
    estimateGas: () => Promise.reject(boom()),
    getTransactionReceipt: () => Promise.reject(boom()),
    keccak256: () => {
      throw boom();
    },
    request: () => Promise.reject(boom())
  };
}

/**
 * The address index is served over a stubbed `fetch` so that `init` and
 * `getAddresses` — whose only dependency is the index, not an adapter —
 * can be driven into the same `BOOM` failure as every other method.
 */
let indexFails = false;
function stubIndexFetch(): void {
  vi.stubGlobal('fetch', () =>
    indexFails
      ? Promise.reject(new Error(BOOM))
      : Promise.resolve(new Response(JSON.stringify(ADDRESSES), { status: 200 }))
  );
}

function initClient(adapter: Adapter): Promise<POSClient> {
  return POSClient.init({
    network: 'amoy',
    parent: adapter,
    child: adapter,
    addressIndexUrl: INDEX_URL
  });
}

async function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
  let pending: Promise<unknown> | undefined;
  expect(() => {
    pending = call();
  }).not.throw();
  expect(pending).instanceOf(Promise);
  return pending?.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e
  );
}

/** Operation errors in `err`'s cause chain, outermost first. */
function operationLayers(err: unknown): string[] {
  const names: string[] = [];
  const seen = new Set<unknown>();
  for (let link: unknown = err; link instanceof Error && !seen.has(link); link = link.cause) {
    seen.add(link);
    if (OPERATION_NAMES.has(link.name)) names.push(link.name);
  }
  return names;
}

type OperationClass = { readonly name: string; readonly has: (err: unknown) => boolean };

/**
 * `sdkFetch`: the method's only failing dependency is the SDK's own HTTP
 * fetch of the address index, which is an SDK condition either way.
 */
type Case = {
  error: OperationClass;
  mode: OperationMode;
  call: () => Promise<unknown>;
  sdkFetch?: boolean;
};

function assertBoomBoundary({
  err,
  error,
  operation,
  mode
}: {
  err: unknown;
  error: OperationClass;
  operation: string;
  mode: OperationMode;
}): void {
  expect(err).instanceOf(Error);
  expect(err).property('name', error.name);
  expect(error.has(err)).equals(true);
  expect(err).nested.property('info.operation', operation);
  expect(err).nested.property('info.mode', mode);
  expect(rootCause(err)).property('message').match(/^boom/);
  expect(err).property('message').contains('boom').contains('token=***').not.contains('token=S');
  expect(isMaticjsError(err)).equals(true);
  expect(operationLayers(err)).deep.equals([error.name]);
}

/** Public async methods by reflection; the exclusions are named so a new method can't hide. */
function publicMethods({
  proto,
  exclude
}: {
  proto: object;
  exclude: readonly string[];
}): string[] {
  return Object.getOwnPropertyNames(proto)
    .filter((n) => n !== 'constructor' && !n.startsWith('_') && !exclude.includes(n))
    .filter((n) => typeof Object.getOwnPropertyDescriptor(proto, n)?.value === 'function')
    .sort();
}

function withOperationCount(file: string): number {
  const source = readFileSync(join(__dirname, '..', '..', 'src', file), 'utf8');
  return source.split('withOperation(').length - 1;
}

function runBoundaryCases({
  label,
  file,
  methods,
  cases
}: {
  label: string;
  file: string;
  methods: () => string[];
  cases: Record<string, Case>;
}): void {
  describe(`${label} operation boundaries`, () => {
    it('covers every public async method, one withOperation call each', () => {
      const reflected = methods();
      const wrapped = withOperationCount(file);
      console.info(`${label}: ${String(reflected.length)} public async methods`);
      expect(Object.keys(cases).sort()).deep.equals(reflected);
      expect(reflected).length(wrapped);
    });

    for (const [operation, { error, mode, call, sdkFetch }] of Object.entries(cases)) {
      it(`${operation} rejects with ${error.name} over an SDK condition`, async () => {
        const err = await rejectionOf(call);
        assertBoomBoundary({ err, error, operation, mode });
      });

      it(`${operation} rethrows a library error unchanged`, async () => {
        failure = 'library';
        const err = await rejectionOf(call);
        if (sdkFetch === true) {
          assertBoomBoundary({ err, error, operation, mode });
          return;
        }
        expect(err).equals(LIBRARY_ERROR);
        expect(err).property('message').equals(BOOM);
        expect(isMaticjsError(err)).equals(false);
      });
    }
  });
}

stubIndexFetch();
afterEach(() => {
  indexFails = false;
  failure = 'condition';
});

// ─── POSClient ──────────────────────────────────────────────────────────────

let pos!: POSClient;
beforeAll(async () => {
  pos = await initClient(boomAdapter());
});

const posCases: Record<string, Case> = {
  init: {
    error: InitError,
    mode: 'init',
    sdkFetch: true,
    call: () => {
      __resetAddressCacheForTesting();
      indexFails = true;
      return initClient(boomAdapter());
    }
  },
  getAddresses: {
    error: AddressLookupError,
    mode: 'read',
    sdkFetch: true,
    call: () => {
      __resetAddressCacheForTesting();
      indexFails = true;
      return pos.getAddresses();
    }
  },
  getPredicateAddress: {
    error: AddressLookupError,
    mode: 'read',
    call: () => pos.getPredicateAddress(TOKEN)
  },
  isWithdrawn: {
    error: BridgeStatusError,
    mode: 'read',
    call: () => pos.isWithdrawn(BURN_TX, EVENT_SIG)
  },
  isWithdrawnOnIndex: {
    error: BridgeStatusError,
    mode: 'read',
    call: () => pos.isWithdrawnOnIndex(BURN_TX, EVENT_SIG, 0)
  },
  isCheckpointed: {
    error: BridgeStatusError,
    mode: 'read',
    call: () => pos.isCheckpointed(BURN_TX)
  },
  isDeposited: { error: BridgeStatusError, mode: 'read', call: () => pos.isDeposited(BURN_TX) },
  buildExitPayload: {
    error: ProofBuildError,
    mode: 'read',
    call: () => pos.buildExitPayload(BURN_TX, EVENT_SIG)
  },
  buildExitPayloadOnIndex: {
    error: ProofBuildError,
    mode: 'read',
    call: () => pos.buildExitPayloadOnIndex(BURN_TX, EVENT_SIG, 0)
  },
  buildExitPayloads: {
    error: ProofBuildError,
    mode: 'read',
    call: () => pos.buildExitPayloads(BURN_TX, EVENT_SIG)
  },
  getBlockProof: {
    error: ProofBuildError,
    mode: 'read',
    call: () => pos.getBlockProof(1, { start: 0, end: 3 })
  },
  depositEther: { error: DepositError, mode: 'write', call: () => pos.depositEther(1n, USER) },
  prepareDepositEther: {
    error: DepositError,
    mode: 'prepare',
    call: () => pos.prepareDepositEther(1n, USER)
  },
  depositEtherWithGas: {
    error: DepositError,
    mode: 'write',
    call: () => pos.depositEtherWithGas(1n, USER, 1n, '0x')
  },
  prepareDepositEtherWithGas: {
    error: DepositError,
    mode: 'prepare',
    call: () => pos.prepareDepositEtherWithGas(1n, USER, 1n, '0x')
  }
};

runBoundaryCases({
  label: 'POSClient',
  file: 'pos-client.ts',
  // `init` is static; `getProofApi` is a sync accessor; `requireGasSwapper`
  // is private (TypeScript privacy is invisible to reflection).
  methods: () =>
    [
      'init',
      ...publicMethods({
        proto: POSClient.prototype,
        exclude: ['getProofApi', 'requireGasSwapper']
      })
    ].sort(),
  cases: posCases
});

// ─── RootChain / RootChainManager / GasSwapper ─────────────────────────────

const contractConfig = {
  adapter: boomAdapter(),
  getAddress: () => Promise.resolve(CONTRACT),
  logger: noopLogger
};
const rootChain = new RootChain(contractConfig);
const rootChainManager = new RootChainManager(contractConfig);
const gasSwapper = new GasSwapper(contractConfig);

runBoundaryCases({
  label: 'RootChain',
  file: 'pos/root_chain.ts',
  methods: () => publicMethods({ proto: RootChain.prototype, exclude: [] }),
  cases: {
    getLastChildBlock: {
      error: CheckpointReadError,
      mode: 'read',
      call: () => rootChain.getLastChildBlock()
    },
    findRootBlockFromChild: {
      error: CheckpointReadError,
      mode: 'read',
      call: () => rootChain.findRootBlockFromChild(1n)
    }
  }
});

runBoundaryCases({
  label: 'RootChainManager',
  file: 'pos/root_chain_manager.ts',
  methods: () => publicMethods({ proto: RootChainManager.prototype, exclude: [] }),
  cases: {
    deposit: {
      error: DepositError,
      mode: 'write',
      call: () => rootChainManager.deposit(USER, TOKEN, '0x00')
    },
    prepareDeposit: {
      error: DepositError,
      mode: 'prepare',
      call: () => rootChainManager.prepareDeposit(USER, TOKEN, '0x00')
    },
    exit: { error: ExitError, mode: 'write', call: () => rootChainManager.exit('0x00') },
    prepareExit: {
      error: ExitError,
      mode: 'prepare',
      call: () => rootChainManager.prepareExit('0x00')
    },
    isExitProcessed: {
      error: BridgeStatusError,
      mode: 'read',
      call: () => rootChainManager.isExitProcessed(BURN_TX)
    }
  }
});

runBoundaryCases({
  label: 'GasSwapper',
  file: 'pos/gas_swapper.ts',
  methods: () => publicMethods({ proto: GasSwapper.prototype, exclude: [] }),
  cases: {
    depositWithGas: {
      error: DepositError,
      mode: 'write',
      call: () => gasSwapper.depositWithGas(TOKEN, '0x00', USER, '0x')
    },
    prepareDepositWithGas: {
      error: DepositError,
      mode: 'prepare',
      call: () => gasSwapper.prepareDepositWithGas(TOKEN, '0x00', USER, '0x')
    }
  }
});

// ─── Guards and collapse ────────────────────────────────────────────────────

describe('client boundaries: guards keep their condition under the operation layer', () => {
  it('init with a bad proofConcurrency → InitError over InvalidNumericValueError', async () => {
    const err = await rejectionOf(() =>
      POSClient.init({
        network: 'amoy',
        parent: boomAdapter(),
        child: boomAdapter(),
        addresses: ADDRESSES,
        proofConcurrency: 0
      })
    );
    expect(err).property('name', 'InitError');
    expect(err).nested.property('info.operation', 'init');
    expect(InvalidNumericValueError.has(err)).equals(true);
    expect(operationLayers(err)).deep.equals(['InitError']);
  });

  it('depositEtherWithGas off mainnet → DepositError over OnlyAllowedOnMainnetError', async () => {
    const amoy = await initClient(boomAdapter({ chainId: 80002 }));
    const err = await rejectionOf(() => amoy.depositEtherWithGas(1n, USER, 1n, '0x'));
    expect(err).property('name', 'DepositError');
    expect(err).nested.property('info.operation', 'depositEtherWithGas');
    expect(OnlyAllowedOnMainnetError.has(err)).equals(true);
    expect(operationLayers(err)).deep.equals(['DepositError']);
  });

  it('buildExitPayloadOnIndex with a negative index → ProofBuildError over NegativeIndexError', async () => {
    const err = await rejectionOf(() => pos.buildExitPayloadOnIndex(BURN_TX, EVENT_SIG, -1));
    expect(err).property('name', 'ProofBuildError');
    expect(err).nested.property('info.operation', 'buildExitPayloadOnIndex');
    expect(err).nested.property('info.index', -1);
    expect(NegativeIndexError.has(err)).equals(true);
    expect(operationLayers(err)).deep.equals(['ProofBuildError']);
  });
});

describe('client boundaries: nested public calls collapse to one layer', () => {
  it('depositEtherWithGas → GasSwapper.depositWithGas yields one DepositError named by the outer call', async () => {
    const mainnet = await initClient(boomAdapter({ chainId: 1 }));
    const err = await rejectionOf(() => mainnet.depositEtherWithGas(1n, USER, 1n, '0x'));
    assertBoomBoundary({
      err,
      error: DepositError,
      operation: 'depositEtherWithGas',
      mode: 'write'
    });
    // The inner call's context survives the collapse.
    expect(err).nested.property('info.method', 'swapAndBridge');
    expect(err)
      .nested.property('info.tokenAddress')
      .equals('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
  });

  it('a token-class wrap around RootChainManager.exit yields one ExitError named by the outer call', async () => {
    // Stands in for ERC20.completeWithdraw, which delegates to
    // RootChainManager.exit under its own ExitError wrap.
    const err = await rejectionOf(() =>
      withOperation({
        error: ExitError,
        info: { operation: 'completeWithdraw', mode: 'write', tokenAddress: TOKEN },
        run: () => rootChainManager.exit('0x00')
      })
    );
    assertBoomBoundary({ err, error: ExitError, operation: 'completeWithdraw', mode: 'write' });
    expect(err).nested.property('info.method', 'exit');
    expect(err).nested.property('info.tokenAddress', TOKEN);
  });

  it('a library error passes through both layers as the same object', async () => {
    failure = 'library';
    const err = await rejectionOf(() =>
      withOperation({
        error: ExitError,
        info: { operation: 'completeWithdraw', mode: 'write', tokenAddress: TOKEN },
        run: () => rootChainManager.exit('0x00')
      })
    );
    expect(err).equals(LIBRARY_ERROR);
  });
});
