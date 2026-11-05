import type { JsonRpcError, JsonRpcPayload, JsonRpcResult } from 'ethers';

import { JsonRpcApiProvider, JsonRpcSigner, Network } from 'ethers';
import { providers as v5providers } from 'ethers-v5';
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  custom,
  UserRejectedRequestError
} from 'viem';
import { describe, expect, it } from 'vitest';

import type { Adapter, Hex } from '../../src/adapter.ts';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { rootCause } from '../../src/errors.ts';
import { noopLogger } from '../../src/logger.ts';
import { ERC20 } from '../../src/pos/erc20.ts';
import { RootChainManager } from '../../src/pos/root_chain_manager.ts';
import { expectLibraryErrorByIdentity, recordingAdapter } from './library-errors.ts';

/**
 * Falsification matrix, wallet row: the user's wallet refuses the exit
 * transaction. The write goes through a REMOTE signer for each library
 * (viem wallet client with a JSON-RPC account, ethers v6 and v5
 * `JsonRpcSigner`), so the wallet's answer to `eth_sendTransaction` is the
 * error. Only the JSON-RPC transport is stubbed.
 *
 * What a consumer must see on every row: the very error the library threw
 * for the wallet's answer, by identity, with nothing of the SDK's around
 * it, and the wallet's text and numeric code where that library keeps them.
 * The one documented exception is ethers v5 with the legacy "User denied
 * transaction signature" text: v5 replaces the wallet's error with its own
 * ACTION_REJECTED and discards the original, so neither the text nor 4001
 * survives.
 *
 * Part of the enforcement of AGENTS.md, "Error ownership (mandatory)": the
 * rows asserting the thrown object IS the library's must stay green and
 * must not be weakened.
 */

const AMOY = 80002;
const TOKEN = '0x3333333333333333333333333333333333333333';
const ROOT_CHAIN_MANAGER = '0x1111111111111111111111111111111111111111';
const WALLET = '0x5555555555555555555555555555555555555555';
const BURN_TX = `0x${'ab'.repeat(32)}`;

const USER_REJECTED = 'User rejected the request';
const USER_DENIED = 'User denied transaction signature';
const INSUFFICIENT_FUNDS =
  'insufficient funds for gas * price + value: balance 0, tx cost 1, overshot 1';

const toQuantity = (v: bigint | number): string => `0x${v.toString(16)}`;

/** The wallet's JSON-RPC error for `eth_sendTransaction`. */
type WalletError = { code: number; message: string };

/** A node behind a wallet that refuses every `eth_sendTransaction`. */
class RefusingWallet {
  readonly methods: string[] = [];
  readonly refusal: WalletError;

  constructor(refusal: WalletError) {
    this.refusal = refusal;
  }

  answer(method: string): unknown {
    this.methods.push(method);
    switch (method) {
      case 'eth_chainId':
        return toQuantity(AMOY);
      case 'net_version':
        return String(AMOY);
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return [WALLET];
      case 'eth_blockNumber':
        return '0x64';
      case 'eth_estimateGas':
        return toQuantity(100_000n);
      case 'eth_sendTransaction':
        throw thrown(this.refusal);
      default:
        throw thrown({ code: -32601, message: `stub wallet: unexpected RPC ${method}` });
    }
  }
}

/** An EIP-1193 / ethers v5 transport error: message plus numeric code. */
const thrown = ({ code, message }: WalletError): Error =>
  Object.assign(new Error(message), { code });

const codeAndMessage = (err: unknown): WalletError => {
  const code: unknown = err instanceof Error ? Reflect.get(err, 'code') : undefined;
  return {
    code: typeof code === 'number' ? code : -32603,
    message: err instanceof Error ? err.message : String(err)
  };
};

// --- transports: the only stubbed layer --------------------------------------

class V5StubProvider extends v5providers.StaticJsonRpcProvider {
  private readonly wallet: RefusingWallet;

  constructor(wallet: RefusingWallet) {
    super('http://stub.invalid', { chainId: AMOY, name: 'stub' });
    this.wallet = wallet;
  }

  override async send(method: string): Promise<unknown> {
    return this.wallet.answer(method);
  }
}

class V6StubProvider extends JsonRpcApiProvider {
  private readonly wallet: RefusingWallet;

  constructor(wallet: RefusingWallet) {
    super(Network.from(AMOY), { staticNetwork: true, batchMaxCount: 1 });
    this.wallet = wallet;
  }

  override async _send(
    payload: JsonRpcPayload | JsonRpcPayload[]
  ): Promise<Array<JsonRpcResult | JsonRpcError>> {
    const batch = Array.isArray(payload) ? payload : [payload];
    return batch.map((p) => {
      try {
        return { id: p.id, result: this.wallet.answer(p.method) };
      } catch (err) {
        return { id: p.id, error: codeAndMessage(err) };
      }
    });
  }
}

const v5Adapter = (wallet: RefusingWallet): Adapter => {
  const provider = new V5StubProvider(wallet);
  return ethersV5Adapter({ provider, signer: provider.getSigner(WALLET) });
};

const v6Adapter = (wallet: RefusingWallet): Adapter => {
  const provider = new V6StubProvider(wallet);
  return ethersV6Adapter({ provider, signer: new JsonRpcSigner(provider, WALLET) });
};

const viemStubAdapter = (wallet: RefusingWallet): Adapter => {
  const transport = custom({
    request: async ({ method }: { method: string }) => wallet.answer(method)
  });
  return viemAdapter({
    public: createPublicClient({ transport }),
    // No local account: viem sends `eth_sendTransaction` for the address.
    wallet: createWalletClient({ transport }),
    account: WALLET as Hex
  });
};

type Library = 'ethers v5' | 'ethers v6' | 'viem';

const harnesses: Array<[Library, (wallet: RefusingWallet) => Adapter]> = [
  ['ethers v5', v5Adapter],
  ['ethers v6', v6Adapter],
  ['viem', viemStubAdapter]
];

const parentToken = (adapter: Adapter): ERC20 =>
  new ERC20({
    tokenAddress: TOKEN,
    isParent: true,
    adapter,
    parentAdapter: adapter,
    // Only `buildExitPayload` is reached on this path. `as never` is the
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

const exitThrough = async (
  build: (wallet: RefusingWallet) => Adapter,
  refusal: WalletError
): Promise<{ err: unknown; wallet: RefusingWallet; thrown: readonly unknown[] }> => {
  const wallet = new RefusingWallet(refusal);
  const { adapter, thrown } = recordingAdapter(build(wallet));
  const err = await parentToken(adapter)
    .completeWithdraw(BURN_TX)
    .then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e
    );
  return { err, wallet, thrown };
};

describe.each(harnesses)('%s — the wallet refuses the exit (remote signer)', (_library, build) => {
  it('EIP-1193 user rejection {4001, "User rejected the request"}: the library error as-is, 4001 at its root', async () => {
    const { err, wallet, thrown } = await exitThrough(build, {
      code: 4001,
      message: USER_REJECTED
    });

    expect(wallet.methods).include('eth_sendTransaction');
    expectLibraryErrorByIdentity({ err, thrown });
    expect(err).property('message').contains(USER_REJECTED);
    const root = rootCause(err);
    expect(root).property('message').contains(USER_REJECTED);
    expect(root).property('code').equals(4001);
  });

  it('insufficient funds {-32000}: the library error as-is, -32000 at its root', async () => {
    const { err, thrown } = await exitThrough(build, {
      code: -32000,
      message: INSUFFICIENT_FUNDS
    });

    expectLibraryErrorByIdentity({ err, thrown });
    const root = rootCause(err);
    expect(root).property('message').contains(INSUFFICIENT_FUNDS);
    expect(root).property('code').equals(-32000);
  });
});

describe('legacy wallet text {4001, "User denied transaction signature"}', () => {
  it("viem's own error, as-is, holds its UserRejectedRequestError with the text and 4001", async () => {
    const { err, thrown } = await exitThrough(viemStubAdapter, {
      code: 4001,
      message: USER_DENIED
    });

    expectLibraryErrorByIdentity({ err, thrown });
    if (!(err instanceof BaseError)) throw new Error('expected a viem error');
    const rejected = err.walk((e) => e instanceof UserRejectedRequestError);
    expect(rejected).instanceOf(UserRejectedRequestError);
    expect(rejected).property('code').equals(4001);
    expect(rootCause(err)).property('message').contains(USER_DENIED);
  });

  it('ethers v6 ACTION_REJECTED, as-is, keeps the wallet error at info.error: text and 4001 reachable', async () => {
    const { err, thrown } = await exitThrough(v6Adapter, { code: 4001, message: USER_DENIED });

    expectLibraryErrorByIdentity({ err, thrown });
    expect(err).property('code').equals('ACTION_REJECTED');
    expect(err).nested.property('info.error.code').equals(4001);
    expect(rootCause(err)).property('message').contains(USER_DENIED);
  });

  it('ethers v5 (the documented gap): its own ACTION_REJECTED, as-is; the text and 4001 are gone', async () => {
    const { err, thrown } = await exitThrough(v5Adapter, { code: 4001, message: USER_DENIED });

    expectLibraryErrorByIdentity({ err, thrown });
    // What IS observable: ethers v5's classification and its own message.
    expect(err).property('code').equals('ACTION_REJECTED');
    expect(err).property('message').contains('user rejected transaction');
    // What is NOT: v5 dropped the wallet's error, so neither its text nor
    // its number is anywhere a consumer can read.
    expect(rootCause(err)).property('code').not.equals(4001);
    expect(err).property('message').not.contains(USER_DENIED);
  });
});
