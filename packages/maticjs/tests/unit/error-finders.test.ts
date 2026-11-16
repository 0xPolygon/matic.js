import type { JsonRpcError, JsonRpcPayload, JsonRpcResult } from 'ethers';

import { JsonRpcApiProvider, Network } from 'ethers';
import { providers as v5providers, Wallet as V5Wallet } from 'ethers-v5';
import {
  createWalletClient,
  custom,
  TransactionNotFoundError as ViemTransactionNotFoundError
} from 'viem';
import { describe, expect, it } from 'vitest';

import { VError } from '@polygonlabs/verror';

import type { Receipt } from '../../src/adapter.ts';

import {
  BurnTxNotCheckpointedError,
  DepositError,
  ExitError,
  HttpRequestFailedError,
  isMaticjsError,
  NegativeIndexError,
  rootCause,
  TransactionNotFoundError,
  TransactionRevertedError,
  withOperation
} from '../../src/errors.ts';

/**
 * The name-based recognition surface: per-class `find` / `has`,
 * `isMaticjsError`, and `rootCause`. Everything here must work without
 * `instanceof`, because a second copy of the package, or an error read
 * back from JSON, fails `instanceof` but keeps `name`.
 */

const HASH = `0x${'ab'.repeat(32)}` as const;
const RECEIPT: Receipt = { transactionHash: HASH, status: 'reverted', blockNumber: 9n, logs: [] };
const OP = { operation: 'completeWithdraw', mode: 'write' } as const;

const reverted = (): TransactionRevertedError =>
  new TransactionRevertedError(`Transaction ${HASH} reverted`, {
    info: { transactionHash: HASH, receipt: RECEIPT }
  });

describe('find / has', () => {
  it('locate a condition error nested two causes deep', () => {
    const condition = reverted();
    const middle = new Error('middle', { cause: condition });
    const outer = new ExitError({ info: OP, cause: middle });

    const found = TransactionRevertedError.find(outer);
    expect(found).property('message').equals(condition.message);
    expect(found?.info.receipt.status).equals('reverted');
    expect(TransactionRevertedError.has(outer)).equals(true);
    expect(ExitError.find(outer)).equals(outer);
  });

  it('return null / false when the class is not in the chain', () => {
    const outer = new ExitError({ info: OP, cause: reverted() });
    expect(BurnTxNotCheckpointedError.find(outer)).equals(null);
    expect(BurnTxNotCheckpointedError.has(outer)).equals(false);
    expect(TransactionRevertedError.find(new Error('x'))).equals(null);
    expect(TransactionRevertedError.find(null)).equals(null);
    expect(TransactionRevertedError.find('TransactionRevertedError')).equals(null);
    expect(TransactionRevertedError.has(undefined)).equals(false);
  });

  it('locate a plain object with the right name (another copy of the package)', () => {
    const foreign = {
      name: 'TransactionRevertedError',
      message: 'reverted',
      info: { transactionHash: HASH, receipt: RECEIPT }
    };
    expect(TransactionRevertedError.find(foreign)).equals(foreign);
    expect(TransactionRevertedError.has(foreign)).equals(true);
  });

  it('locate the class in a JSON round-trip of the whole chain', () => {
    const outer = new ExitError({ info: OP, cause: reverted() });
    const parsed: unknown = JSON.parse(JSON.stringify(outer));

    expect(ExitError.find(parsed)).property('name').equals('ExitError');
    const found = TransactionRevertedError.find(parsed);
    expect(found).property('name').equals('TransactionRevertedError');
    expect(found).nested.property('info.receipt.blockNumber').equals('9');
  });

  it('ignore an object whose name matches but lacks a message or info', () => {
    expect(TransactionRevertedError.find({ name: 'TransactionRevertedError' })).equals(null);
    expect(TransactionRevertedError.has({ name: 'TransactionRevertedError' })).equals(false);
  });

  it("ignore viem's own TransactionNotFoundError, which shares the name but carries no info", () => {
    const viemErr = new ViemTransactionNotFoundError({ hash: HASH });
    expect(viemErr).property('name').equals('TransactionNotFoundError');
    expect(TransactionNotFoundError.find(viemErr)).equals(null);
    expect(TransactionNotFoundError.has(viemErr)).equals(false);
    expect(isMaticjsError(viemErr)).equals(false);
    const wrapped = new ExitError({ info: OP, cause: viemErr });
    expect(TransactionNotFoundError.has(wrapped)).equals(false);
  });

  it('agree with VError.findCauseByName on live chains', () => {
    const outer = new ExitError({ info: OP, cause: new Error('mid', { cause: reverted() }) });
    expect(TransactionRevertedError.find(outer)).equals(
      VError.findCauseByName(outer, 'TransactionRevertedError')
    );
  });

  it('terminate on a circular cause chain', () => {
    const loop = new Error('loop');
    Object.defineProperty(loop, 'cause', { value: loop });
    expect(TransactionRevertedError.find(loop)).equals(null);
    expect(isMaticjsError(loop)).equals(false);
  });
});

describe('isMaticjsError', () => {
  it('is true for an SDK error', () => {
    expect(isMaticjsError(new NegativeIndexError('x', { info: { index: -1 } }))).equals(true);
  });

  it('is true for a consumer VError wrapping an SDK error', () => {
    const wrapped = new VError('my app failed', { cause: new ExitError({ info: OP }) });
    expect(isMaticjsError(wrapped)).equals(true);
  });

  it('is true for a plain object carrying one of the names and an info object', () => {
    expect(isMaticjsError({ name: 'HttpRequestFailedError', message: 'x', info: {} })).equals(true);
    expect(isMaticjsError({ name: 'HttpRequestFailedError', message: 'x' })).equals(false);
  });

  it('is false for anything else', () => {
    expect(isMaticjsError(new Error('x'))).equals(false);
    expect(isMaticjsError(new VError('x'))).equals(false);
    expect(isMaticjsError(null)).equals(false);
    expect(isMaticjsError('HttpRequestFailedError')).equals(false);
    expect(isMaticjsError({ name: 'POSBridgeError' })).equals(false);
  });
});

describe("a consumer's own VError reusing an operation name", () => {
  // verror gives every instance `info = {}`, so name + info object alone
  // would take these for the SDK's DepositError.
  class ConsumerDepositError extends VError {
    override readonly name = 'DepositError';
  }
  const consumerErrors: Array<[string, Error]> = [
    ['without info', new ConsumerDepositError('my deposit failed')],
    ['with info', new ConsumerDepositError('my deposit failed', { info: { amount: '1' } })],
    [
      'with a partial operation info',
      new ConsumerDepositError('my deposit failed', { info: { operation: 'deposit' } })
    ]
  ];
  const sdkDeposit = (): DepositError =>
    new DepositError({ info: { operation: 'depositEther', mode: 'write' } });

  /** What `withOperation` rejects with when `run` throws `thrown`. */
  const rejectionFor = (thrown: Error): Promise<unknown> =>
    withOperation({
      error: ExitError,
      info: OP,
      run: () => {
        throw thrown;
      }
    }).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e
    );

  it.each(consumerErrors)('is not recognised %s, live or wrapped', (_label, consumer) => {
    expect(isMaticjsError(consumer)).equals(false);
    expect(DepositError.has(consumer)).equals(false);
    expect(DepositError.find(consumer)).equals(null);
    const wrapped = new VError('my app failed', { cause: consumer });
    expect(isMaticjsError(wrapped)).equals(false);
    expect(DepositError.find(wrapped)).equals(null);
  });

  it.each(consumerErrors)(
    'is rethrown unchanged by withOperation %s, as it is not an SDK error',
    async (_label, consumer) => {
      expect(await rejectionFor(consumer)).equals(consumer);
    }
  );

  it("the SDK's DepositError is still recognised, live and after a JSON round-trip", async () => {
    const live = sdkDeposit();
    expect(isMaticjsError(live)).equals(true);
    expect(DepositError.find(live)).equals(live);
    const parsed: unknown = JSON.parse(JSON.stringify(live));
    expect(isMaticjsError(parsed)).equals(true);
    expect(DepositError.has(parsed)).equals(true);
    expect(DepositError.find(parsed)).nested.property('info.operation').equals('depositEther');
    // Collapsed: one ExitError layer whose cause is not another DepositError.
    const collapsed = await rejectionFor(live);
    expect(collapsed).property('name').equals('ExitError');
    expect(collapsed).not.nested.property('cause.name');
  });
});

// --- rootCause over the real libraries' error shapes -------------------------
//
// Only the JSON-RPC transport is stubbed; the libraries build their own
// errors from the JSON-RPC error body, so the shapes below are the ones a
// consumer actually receives.

const FROM = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
const TO = '0x2222222222222222222222222222222222222222';
const TEST_KEY = `0x${'11'.repeat(32)}`;
const AMOY = 80002;

type RpcError = { code: number; message: string };

/** ethers v6 provider whose node answers every call with `error`. */
class V6FailingProvider extends JsonRpcApiProvider {
  private readonly rpcError: RpcError;

  constructor(rpcError: RpcError) {
    super(Network.from(AMOY), { staticNetwork: true, batchMaxCount: 1 });
    this.rpcError = rpcError;
  }

  override async _send(
    payload: JsonRpcPayload | JsonRpcPayload[]
  ): Promise<Array<JsonRpcError | JsonRpcResult>> {
    const batch = Array.isArray(payload) ? payload : [payload];
    return batch.map((p) => ({ id: p.id, error: this.rpcError }));
  }
}

/** ethers v5 provider whose node fails `eth_sendRawTransaction` with `error`. */
class V5FailingProvider extends v5providers.StaticJsonRpcProvider {
  private readonly rpcError: RpcError;

  constructor(rpcError: RpcError) {
    super('http://stub.invalid', { chainId: AMOY, name: 'stub' });
    this.rpcError = rpcError;
  }

  override async send(method: string): Promise<unknown> {
    if (method === 'eth_blockNumber') return '0x1';
    throw Object.assign(new Error(this.rpcError.message), { code: this.rpcError.code });
  }
}

const caught = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
};

describe('rootCause', () => {
  it('viem: walks the cause chain to the wallet error carrying 4001', async () => {
    const wallet = createWalletClient({
      transport: custom({
        request: async () => {
          throw { code: 4001, message: 'User rejected the request' };
        }
      })
    });
    const err = await caught(() =>
      wallet.request({ method: 'eth_sendTransaction', params: [{ from: FROM, to: TO }] })
    );
    const root = rootCause(
      new ExitError({ info: OP, cause: err instanceof Error ? err : undefined })
    );
    expect(root).property('code').equals(4001);
    expect(root).property('message').contains('User rejected the request');
  });

  it('ethers v6 UNKNOWN_ERROR: hops to the raw error at `.error`', async () => {
    const provider = new V6FailingProvider({ code: 4001, message: 'User rejected the request' });
    const err = await caught(() => provider.send('eth_sendTransaction', [{ from: FROM, to: TO }]));
    expect(err).property('code').equals('UNKNOWN_ERROR');
    expect(rootCause(err)).deep.equals({ code: 4001, message: 'User rejected the request' });
  });

  it('ethers v6 ACTION_REJECTED: hops to the raw error at `info.error`', async () => {
    const provider = new V6FailingProvider({
      code: 4001,
      message: 'User denied transaction signature'
    });
    const err = await caught(() => provider.send('eth_sendTransaction', [{ from: FROM, to: TO }]));
    expect(err).property('code').equals('ACTION_REJECTED');
    expect(rootCause(err)).property('code').equals(4001);
  });

  it('ethers v6 CALL_EXCEPTION from estimateGas: hops to `info.error` with the revert text', async () => {
    const provider = new V6FailingProvider({ code: 3, message: 'execution reverted: Cooldown' });
    const err = await caught(() => provider.estimateGas({ from: FROM, to: TO }));
    expect(err).property('code').equals('CALL_EXCEPTION');
    expect(err).property('message').not.contains('Cooldown');
    expect(rootCause(err)).property('message').equals('execution reverted: Cooldown');
  });

  it('ethers v5 INSUFFICIENT_FUNDS from a raw send: hops to `.error` (-32000), with no info', async () => {
    const provider = new V5FailingProvider({
      code: -32000,
      message: 'insufficient funds for gas * price + value: balance 0, tx cost 1, overshot 1'
    });
    const raw = await new V5Wallet(TEST_KEY).signTransaction({
      chainId: AMOY,
      nonce: 0,
      gasLimit: 21000,
      gasPrice: 1,
      to: TO,
      value: 1
    });
    const err = await caught(() => provider.sendTransaction(raw));
    expect(err).property('code').equals('INSUFFICIENT_FUNDS');
    expect(err).not.property('info');
    const root = rootCause(err);
    expect(root).property('code').equals(-32000);
    expect(root).property('message').contains('insufficient funds for gas');
  });

  it('a plain Error with no cause is its own root', () => {
    const plain = new Error('plain');
    expect(rootCause(plain)).equals(plain);
  });

  it('returns the deepest Error through a 3-deep chain whose middle link is a plain Error', () => {
    const deepest = new HttpRequestFailedError('http 500', {
      info: { url: 'https://x', status: 500 }
    });
    const middle = new Error('middle', { cause: deepest });
    const outer = new ExitError({ info: OP, cause: middle });
    expect(rootCause(outer)).property('name').equals('HttpRequestFailedError');
    expect(rootCause(outer)).property('message').equals(deepest.message);
  });

  it('treats an object-valued, non-Error cause as the last link', () => {
    const raw = { code: 4001, message: 'User rejected the request' };
    expect(rootCause(new Error('w', { cause: raw }))).equals(raw);
    expect(rootCause(new ExitError({ info: OP, cause: new Error('w', { cause: raw }) })))
      .property('code')
      .equals(4001);
  });

  it('keeps hopping `error` / `info.error` until no object is left (ethers v5 over HTTP)', () => {
    const node = { code: 3, message: 'execution reverted: Cooldown' };
    const serverError = Object.assign(new Error('processing response error'), {
      code: 'SERVER_ERROR',
      error: node
    });
    const gasError = Object.assign(new Error('cannot estimate gas'), {
      code: 'UNPREDICTABLE_GAS_LIMIT',
      error: serverError
    });
    expect(rootCause(new ExitError({ info: OP, cause: gasError })))
      .property('code')
      .equals(3);
  });

  it('stops on an `error` cycle and after a bounded number of hops', () => {
    const loop: { message: string; error?: unknown } = { message: 'loop' };
    loop.error = loop;
    expect(rootCause(new Error('w', { cause: loop }))).equals(loop);

    type Link = { depth: number; error?: Link };
    const top: Link = { depth: 0 };
    let link = top;
    for (let depth = 1; depth <= 20; depth++) {
      link.error = { depth };
      link = link.error;
    }
    expect(rootCause(new Error('w', { cause: top })))
      .property('depth')
      .equals(8);
  });

  it('returns null for a non-Error', () => {
    expect(rootCause('boom')).equals(null);
    expect(rootCause({ message: 'not an Error' })).equals(null);
    expect(rootCause(undefined)).equals(null);
  });

  describe('through an operation error (the stored cause is a redacted copy)', () => {
    const wrap = (err: unknown): ExitError =>
      new ExitError({ info: OP, cause: err instanceof Error ? err : undefined });

    it('viem chain: 4001', async () => {
      const wallet = createWalletClient({
        transport: custom({
          request: async () => {
            throw { code: 4001, message: 'User rejected the request' };
          }
        })
      });
      const err = await caught(() =>
        wallet.request({ method: 'eth_sendTransaction', params: [{ from: FROM, to: TO }] })
      );
      expect(rootCause(wrap(err)))
        .property('code')
        .equals(4001);
    });

    it('ethers v6 UNKNOWN_ERROR `.error`: 4001', async () => {
      const provider = new V6FailingProvider({ code: 4001, message: 'User rejected the request' });
      const err = await caught(() =>
        provider.send('eth_sendTransaction', [{ from: FROM, to: TO }])
      );
      expect(rootCause(wrap(err)))
        .property('code')
        .equals(4001);
    });

    it('ethers v6 ACTION_REJECTED `info.error`: 4001', async () => {
      const provider = new V6FailingProvider({
        code: 4001,
        message: 'User denied transaction signature'
      });
      const err = await caught(() =>
        provider.send('eth_sendTransaction', [{ from: FROM, to: TO }])
      );
      expect(rootCause(wrap(err)))
        .property('code')
        .equals(4001);
    });

    const v5Send = async (rpcError: RpcError): Promise<unknown> => {
      const raw = await new V5Wallet(TEST_KEY).signTransaction({
        chainId: AMOY,
        nonce: 0,
        gasLimit: 21000,
        gasPrice: 1,
        to: TO,
        value: 1
      });
      return caught(() => new V5FailingProvider(rpcError).sendTransaction(raw));
    };

    it('ethers v5 rethrown raw error: 4001', async () => {
      const err = await v5Send({ code: 4001, message: 'User rejected the request' });
      expect(rootCause(wrap(err)))
        .property('code')
        .equals(4001);
    });

    it('ethers v5 INSUFFICIENT_FUNDS `.error`: the node code', async () => {
      const err = await v5Send({
        code: -32000,
        message: 'insufficient funds for gas * price + value: balance 0, tx cost 1, overshot 1'
      });
      expect(rootCause(wrap(err)))
        .property('code')
        .equals(-32000);
    });
  });
});
