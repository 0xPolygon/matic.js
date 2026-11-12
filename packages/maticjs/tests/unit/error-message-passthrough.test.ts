import type { JsonRpcError, JsonRpcPayload, JsonRpcResult } from 'ethers';

import { JsonRpcApiProvider, Network } from 'ethers';
import { providers as v5providers, Wallet as V5Wallet } from 'ethers-v5';
import { HttpRequestError } from 'viem';
import { describe, expect, it } from 'vitest';

import { sanitiseRpcFetchError, VError } from '@polygonlabs/verror';

import { redactTokens, sanitiseError } from '../../src/adapters/sanitise.ts';
import {
  DepositError,
  ExitError,
  HttpRequestFailedError,
  ProofBuildError,
  withOperation
} from '../../src/errors.ts';

/**
 * Consumers classify failures by matching the wallet's or node's own text
 * on the top-level `err.message` (a rejection, a revert reason, a nonce
 * clash). A library error reaches them through `withOperation` as the same
 * object, so that text is exactly what the library wrote. An operation
 * error's own message, built over an SDK condition, must keep the text
 * below it verbatim and untruncated, while still redacting RPC tokens.
 */

const PASSTHROUGH = [
  'User rejected the request',
  'exceeds balance',
  'nonce too low',
  'transaction underpriced',
  'execution reverted: Cooldown',
  'EXIT_ALREADY_PROCESSED'
] as const;

const OP = { operation: 'completeWithdraw', mode: 'write' } as const;
const AMOY = 80002;
const FROM = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
const TO = '0x2222222222222222222222222222222222222222';

const caught = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
};

describe.each(PASSTHROUGH)('"%s" through an operation error', (text) => {
  const causeMessage = `${text} http://rpc.example/?token=SECRET`;
  const make = (): ExitError => new ExitError({ info: OP, cause: new Error(causeMessage) });

  it('stays in the top-level message verbatim, with the token redacted', () => {
    const err = make();
    expect(err.message).contains(text);
    expect(err.message).contains('token=***');
    expect(err.message).not.contains('SECRET');
  });

  it('is not truncated', () => {
    expect(make().message.length).least(redactTokens(causeMessage).length);
  });

  it('never leaks the token through the stack', () => {
    expect(make().stack ?? '').not.contains('SECRET');
  });

  it('survives JSON.stringify without the token', () => {
    const json = JSON.stringify(make());
    expect(json).contains(text);
    expect(json).not.contains('SECRET');
  });

  it('is in VError.fullStack', () => {
    expect(VError.fullStack(make())).contains(text);
  });

  it('is kept by both redactors (they only rewrite token / URL text)', () => {
    const sdkClean = sanitiseError(new Error(causeMessage));
    expect(sdkClean).property('message').contains(text);

    // viem's own fetch error, which verror's fingerprint-gated sanitiser
    // recognises and reduces to the URL origin.
    const viemFetch = new HttpRequestError({
      url: 'https://rpc.example/?token=SECRET',
      details: text,
      body: { method: 'eth_sendRawTransaction' }
    });
    const verrorClean = sanitiseRpcFetchError(viemFetch) ?? viemFetch;
    expect(verrorClean.message).contains(text);
    expect(verrorClean.message).not.contains('SECRET');
  });

  it('withOperation rethrows the library error itself, its message untouched', async () => {
    const libraryError = new Error(causeMessage);
    const err = await caught(() =>
      withOperation({
        error: DepositError,
        info: OP,
        run: () => Promise.reject(libraryError)
      })
    );
    expect(err).equals(libraryError);
    expect(err).property('message').equals(causeMessage);
  });
});

describe('library text below the top-level message', () => {
  class V6FailingProvider extends JsonRpcApiProvider {
    constructor() {
      super(Network.from(AMOY), { staticNetwork: true, batchMaxCount: 1 });
    }

    override async _send(
      payload: JsonRpcPayload | JsonRpcPayload[]
    ): Promise<Array<JsonRpcError | JsonRpcResult>> {
      const batch = Array.isArray(payload) ? payload : [payload];
      return batch.map((p) => ({
        id: p.id,
        error: { code: 3, message: 'execution reverted: Cooldown ?token=SECRET' }
      }));
    }
  }

  it('ethers v6 CALL_EXCEPTION from estimateGas reaches the consumer as ethers built it', async () => {
    const run = () => new V6FailingProvider().estimateGas({ from: FROM, to: TO });
    const libraryError = await caught(run);
    expect(libraryError).property('code').equals('CALL_EXCEPTION');

    const err = await caught(() => withOperation({ error: ExitError, info: OP, run: () => run() }));
    expect(err).property('name').equals('Error');
    expect(err).property('code').equals('CALL_EXCEPTION');
    // ethers keeps the node's revert text at info.error.message.
    expect(err).nested.property('info.error.message').contains('execution reverted: Cooldown');
  });

  it('ethers v5 INSUFFICIENT_FUNDS reaches the consumer as ethers built it', async () => {
    class V5FailingProvider extends v5providers.StaticJsonRpcProvider {
      constructor() {
        super('http://stub.invalid', { chainId: AMOY, name: 'stub' });
      }

      override async send(method: string): Promise<unknown> {
        if (method === 'eth_blockNumber') return '0x1';
        throw Object.assign(
          new Error('insufficient funds for gas * price + value: balance 0, tx cost 1, overshot 1'),
          { code: -32000 }
        );
      }
    }
    const raw = await new V5Wallet(`0x${'11'.repeat(32)}`).signTransaction({
      chainId: AMOY,
      nonce: 0,
      gasLimit: 21000,
      gasPrice: 1,
      to: TO,
      value: 1
    });
    let libraryError: unknown;
    const err = await caught(() =>
      withOperation({
        error: DepositError,
        info: OP,
        run: () =>
          new V5FailingProvider().sendTransaction(raw).catch((e: unknown) => {
            libraryError = e;
            throw e;
          })
      })
    );
    expect(err).equals(libraryError);
    expect(err).property('code').equals('INSUFFICIENT_FUNDS');
    // ethers v5 keeps the node's text one `error` below its own message.
    expect(err).nested.property('error.message').contains('insufficient funds for gas');
  });

  it('a hand-built CALL_EXCEPTION shape (message without the text, info.error with it) gets the text', () => {
    const cause = Object.assign(
      new Error('missing revert data (action="estimateGas", data=null)'),
      {
        code: 'CALL_EXCEPTION',
        info: { error: { code: 3, message: 'execution reverted: EXIT_ALREADY_PROCESSED' } }
      }
    );
    const err = new ExitError({ info: OP, cause });
    expect(err.message).contains('execution reverted: EXIT_ALREADY_PROCESSED');
  });

  it('is not appended again when the chain carries it with a token (compared redacted)', () => {
    const text = 'execution reverted: Cooldown https://rpc.example/?token=SECRET';
    const cause = Object.assign(new Error(text), { error: { code: 3, message: text } });
    const err = new ExitError({ info: OP, cause });
    expect(err.message.split('execution reverted: Cooldown').length - 1).equals(1);
    expect(err.message).not.contains('root cause');
    expect(err.message).not.contains('SECRET');
  });

  it('keeps the separator when the cause message ends in a token', () => {
    const cause = Object.assign(
      new Error('missing revert data https://rpc.example/?token=SECRET'),
      {
        info: { error: { code: 3, message: 'execution reverted: EXIT_ALREADY_PROCESSED' } }
      }
    );
    const err = new ExitError({ info: OP, cause });
    expect(err.message).contains(
      '?token=***; root cause: execution reverted: EXIT_ALREADY_PROCESSED'
    );
  });

  it('is not appended when the chain already carries it', () => {
    const err = new ExitError({ info: OP, cause: new Error('nonce too low') });
    expect(err.message).equals('completeWithdraw failed: nonce too low');
  });
});

describe('operation message over an SDK condition with its own cause', () => {
  it("names the call, gives the condition's summary once, and appends the parser's text", () => {
    const parserError = new SyntaxError('Unexpected token < in JSON at position 0');
    const condition = new HttpRequestFailedError('GET https://proof.example/?token=SECRET failed', {
      info: { url: 'https://proof.example/?token=***' },
      cause: parserError
    });
    const err = new ProofBuildError({
      info: { operation: 'buildExitPayload', mode: 'read' },
      cause: condition
    });
    expect(err.message).equals(
      'buildExitPayload failed: GET https://proof.example/?token=*** failed; root cause: Unexpected token < in JSON at position 0'
    );
    expect(err.message).not.contains('SECRET');
  });
});
