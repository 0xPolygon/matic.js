import type { TransactionRequest as V6TransactionRequest } from 'ethers';
import type { Deferrable } from 'ethers-v5/lib/utils.js';

import {
  AbstractProvider,
  AbstractSigner,
  FeeData,
  Network,
  Signature,
  TransactionResponse as V6TransactionResponse
} from 'ethers';
import {
  BigNumber,
  Signer as V5Signer,
  providers as v5providers,
  utils as v5utils
} from 'ethers-v5';
import { createPublicClient, createWalletClient, custom } from 'viem';
import { polygonAmoy } from 'viem/chains';
import { describe, expect, it, vi } from 'vitest';

import type { Adapter, Hex } from '../../src/adapter.ts';

import { ChildERC20ABI } from '../../src/abi/index.ts';
import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { POSBridgeError } from '../../src/errors.ts';
import { ContractCaller } from '../../src/internal/contract-caller.ts';
import { noopLogger } from '../../src/logger.ts';

/**
 * The cross-chain mis-send guard must compare the expected chain with the
 * chain the SIGNING wallet is on — not with the read RPC's chain. A
 * browser wallet whose user switched networks keeps the dapp's RPC on the
 * original chain, so an RPC-side check passes while the wallet signs and
 * broadcasts on the other chain.
 *
 * Every adapter is driven through real library objects (viem clients on a
 * stub transport; ethers provider/signer subclasses) so the check goes
 * through the same calls a consumer's wallet would answer.
 */

const AMOY = 80002;
const ETHEREUM = 1;
const HASH = '0x1111111111111111111111111111111111111111111111111111111111111111';
const FROM = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';

interface Harness {
  adapter: Adapter;
  /** Number of transactions handed to the wallet for signing/broadcast. */
  broadcasts: () => number;
}

/** `signerChain: null` builds a read-only adapter (no wallet / signer). */
interface HarnessParams {
  rpcChain: number;
  signerChain: number | null;
}

// --- viem -----------------------------------------------------------------

const chainTransport = (chainId: number) =>
  custom({
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
      throw new Error(`stub transport: unexpected RPC ${method}`);
    }
  });

const viemHarness = ({
  rpcChain,
  signerChain,
  pinWalletChain = false
}: HarnessParams & { pinWalletChain?: boolean }): Harness => {
  const publicClient = createPublicClient({ transport: chainTransport(rpcChain) });
  if (signerChain === null) {
    return { adapter: viemAdapter({ public: publicClient }), broadcasts: () => 0 };
  }
  // Without `chain`, the wallet client mirrors an injected browser wallet:
  // viem has nothing to assert the wallet's chain against.
  const walletClient = createWalletClient({
    account: FROM,
    transport: chainTransport(signerChain),
    ...(pinWalletChain ? { chain: polygonAmoy } : {})
  });
  const writeSpy = vi.spyOn(walletClient, 'writeContract').mockResolvedValue(HASH);
  return {
    adapter: viemAdapter({ public: publicClient, wallet: walletClient }),
    broadcasts: () => writeSpy.mock.calls.length
  };
};

// --- ethers v6 ------------------------------------------------------------

class V6ChainProvider extends AbstractProvider {
  readonly fixedChainId: number;

  constructor(chainId: number) {
    super();
    this.fixedChainId = chainId;
  }

  override async getNetwork(): Promise<Network> {
    return Network.from(this.fixedChainId);
  }

  // The adapter records the chain head before broadcasting, so a
  // replacement scan has somewhere to start.
  override async getBlockNumber(): Promise<number> {
    return 100;
  }

  // A pre-London (gasPrice-only) chain: the adapter then skips its
  // priority-fee lookup, keeping these tests about the chain guard alone.
  override async getFeeData(): Promise<FeeData> {
    return new FeeData(null, null, null);
  }
}

class V6RecordingSigner extends AbstractSigner {
  readonly sent: V6TransactionRequest[] = [];

  async getAddress(): Promise<string> {
    return FROM;
  }

  connect(provider: AbstractProvider | null): V6RecordingSigner {
    return new V6RecordingSigner(provider);
  }

  async signTransaction(): Promise<string> {
    throw new Error('stub signer: signTransaction not supported');
  }

  async signMessage(): Promise<string> {
    throw new Error('stub signer: signMessage not supported');
  }

  async signTypedData(): Promise<string> {
    throw new Error('stub signer: signTypedData not supported');
  }

  override async sendTransaction(tx: V6TransactionRequest): Promise<V6TransactionResponse> {
    this.sent.push(tx);
    const provider = this.provider;
    if (provider === null) throw new Error('stub signer: no provider');
    return new V6TransactionResponse(
      {
        blockNumber: null,
        blockHash: null,
        hash: HASH,
        index: 0,
        type: 2,
        to: TOKEN,
        from: FROM,
        nonce: 0,
        gasLimit: 21_000n,
        gasPrice: 0n,
        maxPriorityFeePerGas: null,
        maxFeePerGas: null,
        data: '0x',
        value: 0n,
        chainId: BigInt(AMOY),
        signature: Signature.from(),
        accessList: null,
        authorizationList: null
      },
      provider
    );
  }
}

const v6Harness = ({ rpcChain, signerChain }: HarnessParams): Harness => {
  const provider = new V6ChainProvider(rpcChain);
  if (signerChain === null) {
    return { adapter: ethersV6Adapter({ provider }), broadcasts: () => 0 };
  }
  const signer = new V6RecordingSigner(new V6ChainProvider(signerChain));
  return {
    adapter: ethersV6Adapter({ provider, signer }),
    broadcasts: () => signer.sent.length
  };
};

// --- ethers v5 ------------------------------------------------------------

class V5ChainProvider extends v5providers.BaseProvider {
  readonly fixedChainId: number;

  constructor(chainId: number) {
    super(chainId);
    this.fixedChainId = chainId;
  }

  override async getNetwork(): Promise<v5providers.Network> {
    return { name: 'stub', chainId: this.fixedChainId };
  }

  // A pre-London (gasPrice-only) chain: the adapter then skips its
  // priority-fee lookup, keeping these tests about the chain guard alone.
  override async getFeeData(): Promise<v5providers.FeeData> {
    return {
      lastBaseFeePerGas: null,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      gasPrice: null
    };
  }
}

class V5RecordingSigner extends V5Signer {
  readonly sent: Array<Deferrable<v5providers.TransactionRequest>> = [];

  constructor(provider: v5providers.Provider) {
    super();
    // ethers v5 signers expose their provider as a read-only property;
    // `Signer.getChainId()` reads the network from it.
    v5utils.defineReadOnly(this, 'provider', provider);
  }

  async getAddress(): Promise<string> {
    return FROM;
  }

  connect(provider: v5providers.Provider): V5RecordingSigner {
    return new V5RecordingSigner(provider);
  }

  async signTransaction(): Promise<string> {
    throw new Error('stub signer: signTransaction not supported');
  }

  async signMessage(): Promise<string> {
    throw new Error('stub signer: signMessage not supported');
  }

  override async sendTransaction(
    tx: Deferrable<v5providers.TransactionRequest>
  ): Promise<v5providers.TransactionResponse> {
    this.sent.push(tx);
    return {
      hash: HASH,
      confirmations: 0,
      from: FROM,
      nonce: 0,
      gasLimit: BigNumber.from(21_000),
      data: '0x',
      value: BigNumber.from(0),
      chainId: AMOY,
      wait: () => Promise.reject(new Error('stub signer: wait not supported'))
    };
  }
}

const v5Harness = ({ rpcChain, signerChain }: HarnessParams): Harness => {
  const provider = new V5ChainProvider(rpcChain);
  if (signerChain === null) {
    return { adapter: ethersV5Adapter({ provider }), broadcasts: () => 0 };
  }
  const signer = new V5RecordingSigner(new V5ChainProvider(signerChain));
  return {
    adapter: ethersV5Adapter({ provider, signer }),
    broadcasts: () => signer.sent.length
  };
};

// --- shared cases ---------------------------------------------------------

const withdraw = (chainId?: number) => ({
  address: TOKEN as Hex,
  abi: ChildERC20ABI,
  functionName: 'withdraw',
  args: [1n],
  gasLimit: 100_000n,
  ...(chainId === undefined ? {} : { chainId })
});

const settle = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e
  );

const harnesses: Array<[string, (p: HarnessParams) => Harness]> = [
  ['viem', viemHarness],
  ['ethers v6', v6Harness],
  ['ethers v5', v5Harness]
];

describe.each(harnesses)('%s adapter — signing-wallet chain guard', (name, build) => {
  it('rejects a wallet on the wrong chain before broadcasting', async () => {
    // RPC on Amoy, wallet switched to Ethereum: the RPC-side check alone
    // would pass because the expected chain IS the RPC chain.
    const h = build({ rpcChain: AMOY, signerChain: ETHEREUM });
    const err = await settle(h.adapter.write(withdraw(AMOY)));
    expect(err).instanceOf(POSBridgeError);
    expect(err).property('code').equals('UNSUPPORTED_NETWORK');
    expect(err).nested.property('info.expected').equals(AMOY);
    expect(err).nested.property('info.actual').equals(ETHEREUM);
    expect(h.broadcasts()).equals(0);
  });

  it('broadcasts when the wallet is on the expected chain', async () => {
    const h = build({ rpcChain: AMOY, signerChain: AMOY });
    const result = await h.adapter.write(withdraw());
    expect(result).property('hash').equals(HASH);
    expect(h.broadcasts()).equals(1);
  });

  it('re-reads the wallet chain on every write (no caching across a network switch)', async () => {
    let walletChain = AMOY;
    const switching = buildSwitching(name, () => walletChain);
    await switching.adapter.write(withdraw());
    walletChain = ETHEREUM;
    const err = await settle(switching.adapter.write(withdraw()));
    expect(err).property('code').equals('UNSUPPORTED_NETWORK');
    expect(switching.broadcasts()).equals(1);
  });

  it('checks the wallet chain when the adapter is called with no explicit chainId', async () => {
    const h = build({ rpcChain: AMOY, signerChain: ETHEREUM });
    const err = await settle(h.adapter.write(withdraw()));
    expect(err).property('code').equals('UNSUPPORTED_NETWORK');
    expect(err).nested.property('info.expected').equals(AMOY);
    expect(err).nested.property('info.actual').equals(ETHEREUM);
    expect(h.broadcasts()).equals(0);
  });

  it('default SDK path: ContractCaller.write with no chainId option still runs the wallet check', async () => {
    const h = build({ rpcChain: AMOY, signerChain: ETHEREUM });
    const caller = new ContractCaller({
      adapter: h.adapter,
      getAddress: () => Promise.resolve(TOKEN),
      abi: ChildERC20ABI,
      isParent: false,
      logger: noopLogger
    });
    const err = await settle(caller.write('withdraw', [1n], { gasLimit: 100_000n }));
    expect(err).property('code').equals('UNSUPPORTED_NETWORK');
    expect(err).nested.property('info.expected').equals(AMOY);
    expect(err).nested.property('info.actual').equals(ETHEREUM);
    expect(h.broadcasts()).equals(0);
  });

  it('read-only (no wallet): getChainId reports the RPC chain and writes still need a wallet', async () => {
    const h = build({ rpcChain: AMOY, signerChain: null });
    expect(await h.adapter.getChainId()).equals(AMOY);
    const err = await settle(h.adapter.write(withdraw(AMOY)));
    expect(err).property('code').equals('WEB3_CLIENT_NOT_INITIALIZED');
  });

  it('getChainId keeps reporting the RPC chain even when the wallet is elsewhere', async () => {
    const h = build({ rpcChain: AMOY, signerChain: ETHEREUM });
    expect(await h.adapter.getChainId()).equals(AMOY);
  });
});

describe('ethers v6 adapter — signer without a provider', () => {
  it('refuses to broadcast because the signer chain cannot be verified', async () => {
    const signer = new V6RecordingSigner(null);
    const adapter = ethersV6Adapter({ provider: new V6ChainProvider(AMOY), signer });
    const err = await settle(adapter.write(withdraw(AMOY)));
    expect(err).property('code').equals('WEB3_CLIENT_NOT_INITIALIZED');
    expect(signer.sent).lengthOf(0);
  });
});

describe('viem adapter — wallet client without a pinned chain', () => {
  it('rejects when the unpinned wallet is on the wrong chain', async () => {
    const h = viemHarness({ rpcChain: AMOY, signerChain: ETHEREUM, pinWalletChain: false });
    const err = await settle(h.adapter.write(withdraw(AMOY)));
    expect(err).property('code').equals('UNSUPPORTED_NETWORK');
    expect(h.broadcasts()).equals(0);
  });

  it('broadcasts when the wallet is pinned to the matching chain', async () => {
    const h = viemHarness({ rpcChain: AMOY, signerChain: AMOY, pinWalletChain: true });
    const result = await h.adapter.write(withdraw(AMOY));
    expect(result).property('hash').equals(HASH);
    expect(h.broadcasts()).equals(1);
  });
});

/**
 * Build a harness whose wallet reports whatever chain `current()` returns
 * at call time — models a user switching networks between two writes.
 */
function buildSwitching(name: string, current: () => number): Harness {
  if (name === 'viem') {
    const walletClient = createWalletClient({
      account: FROM,
      transport: custom({
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_chainId') return `0x${current().toString(16)}`;
          throw new Error(`stub transport: unexpected RPC ${method}`);
        }
      })
    });
    const writeSpy = vi.spyOn(walletClient, 'writeContract').mockResolvedValue(HASH);
    return {
      adapter: viemAdapter({
        public: createPublicClient({ transport: chainTransport(AMOY) }),
        wallet: walletClient
      }),
      broadcasts: () => writeSpy.mock.calls.length
    };
  }
  if (name === 'ethers v6') {
    class Switching extends V6ChainProvider {
      override async getNetwork(): Promise<Network> {
        return Network.from(current());
      }
    }
    const signer = new V6RecordingSigner(new Switching(AMOY));
    return {
      adapter: ethersV6Adapter({ provider: new V6ChainProvider(AMOY), signer }),
      broadcasts: () => signer.sent.length
    };
  }
  class Switching extends V5ChainProvider {
    override async getNetwork(): Promise<v5providers.Network> {
      return { name: 'stub', chainId: current() };
    }
  }
  const signer = new V5RecordingSigner(new Switching(AMOY));
  return {
    adapter: ethersV5Adapter({ provider: new V5ChainProvider(AMOY), signer }),
    broadcasts: () => signer.sent.length
  };
}
