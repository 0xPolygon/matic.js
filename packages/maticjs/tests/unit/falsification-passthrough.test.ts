import { providers as v5providers, Wallet as V5Wallet } from 'ethers-v5';
import { createPublicClient, createWalletClient, custom } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import type { Adapter } from '../../src/adapter.ts';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { isMaticjsError } from '../../src/errors.ts';
import { noopLogger } from '../../src/logger.ts';
import { ERC20 } from '../../src/pos/erc20.ts';
import { RootChainManager } from '../../src/pos/root_chain_manager.ts';
import { expectLibraryErrorByIdentity, recordingAdapter } from './library-errors.ts';

/**
 * Falsification row for the error contract itself: an error thrown by the
 * consumer's wallet, RPC node or client library is not the SDK's, so every
 * public method rethrows it as the very object that was thrown. Nothing
 * wraps it, clones it or rewrites its message (even one carrying an RPC
 * token: it is the consumer's own error).
 *
 * Where the test owns the thrown object, the assertion is identity with
 * it; where the library builds its own error around the node's answer, it
 * is identity with what the adapter call rejected with.
 *
 * Part of the enforcement of AGENTS.md, "Error ownership (mandatory)": the
 * rows asserting the thrown object IS the library's must stay green and
 * must not be weakened.
 */

const AMOY = 80002;
const TOKEN = '0x3333333333333333333333333333333333333333';
const USER = '0x7777777777777777777777777777777777777777';
const ROOT_CHAIN_MANAGER = '0x1111111111111111111111111111111111111111';
const BURN_TX = `0x${'ab'.repeat(32)}`;
const TEST_KEY = `0x${'11'.repeat(32)}` as const;

const owned = (): Error =>
  Object.assign(new Error('node said no http://rpc.example/?token=SECRET'), { code: -32000 });

const parentToken = (adapter: Adapter): ERC20 =>
  new ERC20({
    tokenAddress: TOKEN,
    isParent: true,
    adapter,
    parentAdapter: adapter,
    // Only `buildExitPayload` is reached on these paths. `as never` is the
    // one cast: the bridge is a test seam, not what is falsified.
    bridge: { buildExitPayload: () => Promise.resolve('0x1234') } as never,
    rootChainManager: new RootChainManager({
      adapter,
      getAddress: () => Promise.resolve(ROOT_CHAIN_MANAGER),
      logger: noopLogger
    }),
    encodeParameters: () => '0x',
    logger: noopLogger
  });

const rejectionOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e
  );

/** An adapter whose every call rejects with `thrown`. */
const rejectingAdapter = (thrown: Error): Adapter => ({
  getChainId: () => Promise.resolve(AMOY),
  read: () => Promise.reject(thrown),
  write: () => Promise.reject(thrown),
  prepareWrite: () => Promise.reject(thrown),
  estimateGas: () => Promise.reject(thrown),
  getTransactionReceipt: () => Promise.reject(thrown),
  keccak256: () => {
    throw thrown;
  },
  request: () => Promise.reject(thrown)
});

describe('error ownership: library errors pass through by identity', () => {
  it.each([
    ['getBalance (read)', (t: ERC20) => t.getBalance(USER)],
    ['approve (write)', (t: ERC20) => t.approve(1n, { spenderAddress: USER })],
    ['prepareApprove (prepare)', (t: ERC20) => t.prepareApprove(1n, { spenderAddress: USER })],
    ['completeWithdraw (write)', (t: ERC20) => t.completeWithdraw(BURN_TX)]
  ])('%s rethrows the adapter error as the same object', async (_label, call) => {
    const thrown = owned();
    const err = await rejectionOf(call(parentToken(rejectingAdapter(thrown))));

    expect(err).equals(thrown);
    expect(err).property('message').equals(thrown.message);
    expect(isMaticjsError(err)).equals(false);
  });

  it("ethers v5: the error ethers built for the node's answer reaches getBalance as the same object", async () => {
    class FailingProvider extends v5providers.StaticJsonRpcProvider {
      override async send(method: string): Promise<unknown> {
        if (method === 'eth_chainId') return `0x${AMOY.toString(16)}`;
        throw owned();
      }
    }
    const provider = new FailingProvider('http://stub.invalid', { chainId: AMOY, name: 'stub' });
    const { adapter, thrown } = recordingAdapter(
      ethersV5Adapter({ provider, signer: new V5Wallet(TEST_KEY, provider) })
    );

    const err = await rejectionOf(parentToken(adapter).getBalance(USER));

    expectLibraryErrorByIdentity({ err, thrown });
  });

  it("viem: the error viem built for the node's answer reaches getBalance as the same object", async () => {
    const transport = custom({
      request: () => Promise.reject(owned())
    });
    const { adapter, thrown } = recordingAdapter(
      viemAdapter({
        public: createPublicClient({ transport }),
        wallet: createWalletClient({ account: privateKeyToAccount(TEST_KEY), transport })
      })
    );

    const err = await rejectionOf(parentToken(adapter).getBalance(USER));

    expectLibraryErrorByIdentity({ err, thrown });
  });
});
