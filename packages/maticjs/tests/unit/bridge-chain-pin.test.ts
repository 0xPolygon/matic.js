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
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from '../../src/adapter.ts';
import type { NetworkAddresses } from '../../src/networks.ts';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { InvalidNumericValueError, UnsupportedNetworkError } from '../../src/errors.ts';
import { POSBridgeHelpers } from '../../src/internal/pos-bridge-helpers.ts';
import { L1_CHAIN_ID, L2_CHAIN_ID } from '../../src/networks.ts';
import { POSClient } from '../../src/pos-client.ts';
import { ERC20 } from '../../src/pos/erc20.ts';
import { ERC721 } from '../../src/pos/erc721.ts';
import { ERC1155 } from '../../src/pos/erc1155.ts';

/**
 * A hostile RPC reports an attacker-chosen chain id, and the unpinned local
 * signer behind it reports the same one. Before the bridge pinned its chain
 * ids, the adapters compared the RPC's answer with itself and signed.
 * Every bridge write must now reject with `UnsupportedNetworkError` before
 * the wallet is asked to sign or broadcast anything.
 */

const HOSTILE_CHAIN = 5;
const HASH = '0x1111111111111111111111111111111111111111111111111111111111111111';
const FROM = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const USER = '0x7777777777777777777777777777777777777777';
const BURN_TX = `0x${'ab'.repeat(32)}`;
const PREDICATE = '0x2222222222222222222222222222222222222223';
const GAS = { gasLimit: 100_000n };

const ADDRESSES: NetworkAddresses = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: PREDICATE,
  ERC721Predicate: '0x3333333333333333333333333333333333333334',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666',
  MintableERC1155Predicate: '0x8888888888888888888888888888888888888888'
};

interface Harness {
  adapter: Adapter;
  /** Transactions handed to the wallet for signing or broadcast. */
  broadcasts: () => number;
}

// --- viem -----------------------------------------------------------------

const viemHarness = (chainId: number): Harness => {
  let wireSends = 0;
  const transport = custom({
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
      if (method.startsWith('eth_send') || method.startsWith('eth_sign')) wireSends += 1;
      throw new Error(`stub transport: unexpected RPC ${method}`);
    }
  });
  const publicClient = createPublicClient({ transport });
  const walletClient = createWalletClient({ account: FROM, transport });
  const writeSpy = vi.spyOn(walletClient, 'writeContract').mockResolvedValue(HASH);
  return {
    adapter: viemAdapter({ public: publicClient, wallet: walletClient }),
    broadcasts: () => writeSpy.mock.calls.length + wireSends
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
  override async getBlockNumber(): Promise<number> {
    return 100;
  }
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
        chainId: BigInt(HOSTILE_CHAIN),
        signature: Signature.from(),
        accessList: null,
        authorizationList: null
      },
      provider
    );
  }
}

const v6Harness = (chainId: number): Harness => {
  const signer = new V6RecordingSigner(new V6ChainProvider(chainId));
  return {
    adapter: ethersV6Adapter({ provider: new V6ChainProvider(chainId), signer }),
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
      chainId: HOSTILE_CHAIN,
      wait: () => Promise.reject(new Error('stub signer: wait not supported'))
    };
  }
}

const v5Harness = (chainId: number): Harness => {
  const signer = new V5RecordingSigner(new V5ChainProvider(chainId));
  return {
    adapter: ethersV5Adapter({ provider: new V5ChainProvider(chainId), signer }),
    broadcasts: () => signer.sent.length
  };
};

const harnesses: Array<[string, (chainId: number) => Harness]> = [
  ['viem', viemHarness],
  ['ethers v6', v6Harness],
  ['ethers v5', v5Harness]
];

const settle = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e
  );

type Write = (pos: POSClient) => Promise<unknown>;

const parent20 = (pos: POSClient) => pos.parent.erc20(TOKEN);
const child20 = (pos: POSClient) => pos.child.erc20(TOKEN);
const parent721 = (pos: POSClient) => pos.parent.erc721(TOKEN);
const child721 = (pos: POSClient) => pos.child.erc721(TOKEN);
const parent1155 = (pos: POSClient) => pos.parent.erc1155(TOKEN);
const child1155 = (pos: POSClient) => pos.child.erc1155(TOKEN);

/**
 * One entry per public write. The coverage test below fails when a write
 * method appears on the clients or token classes without an entry here, so a
 * new write cannot ship without a hostile-RPC case.
 */
const WRITES: Record<string, Write> = {
  'POSClient.depositEther': (pos) => pos.depositEther(1n, USER, GAS),
  'ERC20.approve': (pos) => parent20(pos).approve(1n, { ...GAS, spenderAddress: PREDICATE }),
  'ERC20.approveMax': (pos) => parent20(pos).approveMax({ ...GAS, spenderAddress: PREDICATE }),
  'ERC20.deposit': (pos) => parent20(pos).deposit(1n, USER, GAS),
  'ERC20.startWithdraw': (pos) => child20(pos).startWithdraw(1n, GAS),
  'ERC20.completeWithdraw': (pos) => parent20(pos).completeWithdraw(BURN_TX, GAS),
  'ERC20.completeWithdrawFast': (pos) => parent20(pos).completeWithdrawFast(BURN_TX, GAS),
  'ERC20.transfer': (pos) => child20(pos).transfer(1n, USER, GAS),
  'ERC721.approve': (pos) => parent721(pos).approve(1n, GAS),
  'ERC721.approveAll': (pos) => parent721(pos).approveAll(GAS),
  'ERC721.deposit': (pos) => parent721(pos).deposit(1n, USER, GAS),
  'ERC721.depositMany': (pos) => parent721(pos).depositMany([1n], USER, GAS),
  'ERC721.startWithdraw': (pos) => child721(pos).startWithdraw(1n, GAS),
  'ERC721.startWithdrawWithMetaData': (pos) => child721(pos).startWithdrawWithMetaData(1n, GAS),
  'ERC721.startWithdrawMany': (pos) => child721(pos).startWithdrawMany([1n], GAS),
  'ERC721.completeWithdraw': (pos) => parent721(pos).completeWithdraw(BURN_TX, GAS),
  'ERC721.completeWithdrawOnIndex': (pos) => parent721(pos).completeWithdrawOnIndex(BURN_TX, 0, GAS),
  'ERC721.completeWithdrawFast': (pos) => parent721(pos).completeWithdrawFast(BURN_TX, GAS),
  'ERC721.transfer': (pos) => child721(pos).transfer(1n, FROM, USER, GAS),
  'ERC1155.approveAll': (pos) => parent1155(pos).approveAll(GAS),
  'ERC1155.approveAllForMintable': (pos) => parent1155(pos).approveAllForMintable(GAS),
  'ERC1155.deposit': (pos) =>
    parent1155(pos).deposit({ tokenId: 1n, amount: 1n, userAddress: USER }, GAS),
  'ERC1155.depositMany': (pos) =>
    parent1155(pos).depositMany({ tokenIds: [1n], amounts: [1n], userAddress: USER }, GAS),
  'ERC1155.startWithdraw': (pos) => child1155(pos).startWithdraw(1n, 1n, GAS),
  'ERC1155.startWithdrawMany': (pos) => child1155(pos).startWithdrawMany([1n], [1n], GAS),
  'ERC1155.completeWithdraw': (pos) => parent1155(pos).completeWithdraw(BURN_TX, GAS),
  'ERC1155.completeWithdrawFast': (pos) => parent1155(pos).completeWithdrawFast(BURN_TX, GAS),
  'ERC1155.completeWithdrawMany': (pos) => parent1155(pos).completeWithdrawMany(BURN_TX, GAS),
  'ERC1155.completeWithdrawFastMany': (pos) =>
    parent1155(pos).completeWithdrawFastMany(BURN_TX, GAS),
  'ERC1155.transfer': (pos) =>
    child1155(pos).transfer({ tokenId: 1n, amount: 1n, from: FROM, to: USER }, GAS)
};

/**
 * Writes the reflection skips on purpose. The `*WithGas` deposits are
 * mainnet-only and refuse before any write unless the RPC claims chain 1;
 * on mainnet the swapper's caller is pinned to 1 like every other bridge
 * contract, so the same adapter check covers it.
 */
const EXCLUDED = new Set(['depositEtherWithGas', 'depositWithGas']);

const READ_OR_HELPER = /^(get|is|has|prepare|build|require|validate|constructor|approveAllInner)/;

const writeMethodsOf = (label: string, proto: object): string[] =>
  Object.getOwnPropertyNames(proto)
    .filter((name) => !READ_OR_HELPER.test(name) && !EXCLUDED.has(name))
    .map((name) => `${label}.${name}`);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bridge writes pin the chain ids', () => {
  it('pins mainnet 1/137 and amoy 11155111/80002', () => {
    expect(L1_CHAIN_ID).deep.equals({ mainnet: 1, amoy: 11155111 });
    expect(L2_CHAIN_ID).deep.equals({ mainnet: 137, amoy: 80002 });
  });

  it('has a hostile-RPC case for every public write method', () => {
    const found = [
      ...writeMethodsOf('POSClient', POSClient.prototype).filter((n) => n !== 'POSClient.init'),
      ...writeMethodsOf('ERC20', ERC20.prototype),
      ...writeMethodsOf('ERC721', ERC721.prototype),
      ...writeMethodsOf('ERC1155', ERC1155.prototype)
    ].sort();
    expect(found).deep.equals(Object.keys(WRITES).sort());
  });

  describe.each(harnesses)('%s: RPC and signer both report an attacker-chosen chain', (_n, build) => {
    for (const [name, write] of Object.entries(WRITES)) {
      it(`${name} rejects with UnsupportedNetworkError before signing`, async () => {
        vi.spyOn(POSBridgeHelpers.prototype, 'buildExitPayload').mockResolvedValue('0x01');
        vi.spyOn(POSBridgeHelpers.prototype, 'buildExitPayloadOnIndex').mockResolvedValue('0x01');
        vi.spyOn(POSBridgeHelpers.prototype, 'getPredicateAddress').mockResolvedValue(PREDICATE);
        const parent = build(HOSTILE_CHAIN);
        const child = build(HOSTILE_CHAIN);
        const pos = await POSClient.init({
          network: 'amoy',
          parent: parent.adapter,
          child: child.adapter,
          addresses: ADDRESSES
        });

        const err = await settle(write(pos));

        const mismatch = UnsupportedNetworkError.find(err);
        expect(mismatch).not.equals(null);
        expect(parent.broadcasts()).equals(0);
        expect(child.broadcasts()).equals(0);
      });
    }

    it('names the pinned chain, not the RPC chain, as the expectation', async () => {
      const parent = build(HOSTILE_CHAIN);
      const pos = await POSClient.init({
        network: 'amoy',
        parent: parent.adapter,
        child: build(HOSTILE_CHAIN).adapter,
        addresses: ADDRESSES
      });
      const err = await settle(pos.depositEther(1n, USER, GAS));
      const mismatch = UnsupportedNetworkError.find(err);
      expect(mismatch).nested.property('info.expected').equals(L1_CHAIN_ID.amoy);
      expect(mismatch).nested.property('info.actual').equals(HOSTILE_CHAIN);
    });
  });

  it('an explicit options.chainId still overrides the pin (forks)', async () => {
    const parent = v6Harness(HOSTILE_CHAIN);
    const pos = await POSClient.init({
      network: 'amoy',
      parent: parent.adapter,
      child: v6Harness(HOSTILE_CHAIN).adapter,
      addresses: ADDRESSES
    });
    await pos.depositEther(1n, USER, { ...GAS, chainId: HOSTILE_CHAIN });
    expect(parent.broadcasts()).equals(1);
  });

  it('viem signs for the pinned chain: writeContract receives a chain with the expected id', async () => {
    const chainTransport = custom({
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return `0x${L1_CHAIN_ID.amoy.toString(16)}`;
        throw new Error(`stub transport: unexpected RPC ${method}`);
      }
    });
    const walletClient = createWalletClient({ account: FROM, transport: chainTransport });
    const writeSpy = vi.spyOn(walletClient, 'writeContract').mockResolvedValue(HASH);
    const pos = await POSClient.init({
      network: 'amoy',
      parent: viemAdapter({
        public: createPublicClient({ transport: chainTransport }),
        wallet: walletClient
      }),
      child: v6Harness(L2_CHAIN_ID.amoy).adapter,
      addresses: ADDRESSES
    });
    await pos.depositEther(1n, USER, GAS);
    expect(writeSpy.mock.calls).length(1);
    expect(writeSpy.mock.calls[0]).nested.property('0.chain.id').equals(L1_CHAIN_ID.amoy);
  });
});

describe('chainIds override declares fork and devnet chain ids', () => {
  const FORK = { parent: 3151908, child: 4927 };

  describe.each(harnesses)('%s', (_n, build) => {
    const WRITES_UNDER_TEST: Array<[string, Write, 'parent' | 'child']> = [
      ['ERC20.deposit', (pos) => parent20(pos).deposit(1n, USER, GAS), 'parent'],
      ['ERC20.completeWithdraw', (pos) => parent20(pos).completeWithdraw(BURN_TX, GAS), 'parent'],
      ['ERC20.startWithdraw', (pos) => child20(pos).startWithdraw(1n, GAS), 'child']
    ];

    const initFork = async (parentChain: number, childChain: number) => {
      const parent = build(parentChain);
      const child = build(childChain);
      const pos = await POSClient.init({
        network: 'amoy',
        parent: parent.adapter,
        child: child.adapter,
        addresses: ADDRESSES,
        chainIds: FORK
      });
      return { pos, parent, child };
    };

    for (const [name, write, side] of WRITES_UNDER_TEST) {
      it(`${name} goes through on a chain that matches the declared ids`, async () => {
        vi.spyOn(POSBridgeHelpers.prototype, 'buildExitPayload').mockResolvedValue('0x01');
        vi.spyOn(POSBridgeHelpers.prototype, 'getPredicateAddress').mockResolvedValue(PREDICATE);
        const { pos, parent, child } = await initFork(FORK.parent, FORK.child);

        await write(pos);

        expect(parent.broadcasts()).equals(side === 'parent' ? 1 : 0);
        expect(child.broadcasts()).equals(side === 'child' ? 1 : 0);
      });

      it(`${name} rejects with UnsupportedNetworkError before signing when the RPC reports another chain`, async () => {
        vi.spyOn(POSBridgeHelpers.prototype, 'buildExitPayload').mockResolvedValue('0x01');
        vi.spyOn(POSBridgeHelpers.prototype, 'getPredicateAddress').mockResolvedValue(PREDICATE);
        const { pos, parent, child } = await initFork(L1_CHAIN_ID.amoy, L2_CHAIN_ID.amoy);

        const mismatch = UnsupportedNetworkError.find(await settle(write(pos)));

        expect(mismatch).not.equals(null);
        expect(mismatch).nested.property('info.expected').equals(FORK[side]);
        expect(parent.broadcasts()).equals(0);
        expect(child.broadcasts()).equals(0);
      });
    }
  });

  it('the signed tx carries the declared parent id (viem)', async () => {
    const chainTransport = custom({
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return `0x${FORK.parent.toString(16)}`;
        throw new Error(`stub transport: unexpected RPC ${method}`);
      }
    });
    const walletClient = createWalletClient({ account: FROM, transport: chainTransport });
    const writeSpy = vi.spyOn(walletClient, 'writeContract').mockResolvedValue(HASH);
    const pos = await POSClient.init({
      network: 'amoy',
      parent: viemAdapter({
        public: createPublicClient({ transport: chainTransport }),
        wallet: walletClient
      }),
      child: v6Harness(FORK.child).adapter,
      addresses: ADDRESSES,
      chainIds: FORK
    });
    await pos.depositEther(1n, USER, GAS);
    expect(writeSpy.mock.calls[0]).nested.property('0.chain.id').equals(FORK.parent);
  });

  it('the signed tx carries the declared ids (ethers v6)', async () => {
    const parentSigner = new V6RecordingSigner(new V6ChainProvider(FORK.parent));
    const childSigner = new V6RecordingSigner(new V6ChainProvider(FORK.child));
    const pos = await POSClient.init({
      network: 'amoy',
      parent: ethersV6Adapter({ provider: new V6ChainProvider(FORK.parent), signer: parentSigner }),
      child: ethersV6Adapter({ provider: new V6ChainProvider(FORK.child), signer: childSigner }),
      addresses: ADDRESSES,
      chainIds: FORK
    });
    await pos.depositEther(1n, USER, GAS);
    await pos.child.erc20(TOKEN).startWithdraw(1n, GAS);
    expect(parentSigner.sent[0]).property('chainId').equals(BigInt(FORK.parent));
    expect(childSigner.sent[0]).property('chainId').equals(BigInt(FORK.child));
  });

  // The v5 adapter hands the signer no chainId field; the signer's own
  // network is what signs, so the declared id is proven by the pre-sign
  // check passing on a matching chain and rejecting on any other.
  it('ethers v5 sends on the declared chains', async () => {
    const parentSigner = new V5RecordingSigner(new V5ChainProvider(FORK.parent));
    const childSigner = new V5RecordingSigner(new V5ChainProvider(FORK.child));
    const pos = await POSClient.init({
      network: 'amoy',
      parent: ethersV5Adapter({ provider: new V5ChainProvider(FORK.parent), signer: parentSigner }),
      child: ethersV5Adapter({ provider: new V5ChainProvider(FORK.child), signer: childSigner }),
      addresses: ADDRESSES,
      chainIds: FORK
    });
    await pos.depositEther(1n, USER, GAS);
    await pos.child.erc20(TOKEN).startWithdraw(1n, GAS);
    expect(parentSigner.sent).length(1);
    expect(childSigner.sent).length(1);
  });

  const BAD: Array<[string, { parent: number; child: number }]> = [
    ['zero parent', { parent: 0, child: 4927 }],
    ['negative child', { parent: 3151908, child: -1 }],
    ['fractional parent', { parent: 1.5, child: 4927 }],
    ['NaN child', { parent: 3151908, child: Number.NaN }],
    ['unsafe integer', { parent: 2 ** 53, child: 4927 }]
  ];
  it.each(BAD)('init rejects invalid chainIds: %s', async (_label, chainIds) => {
    const err = await settle(
      POSClient.init({
        network: 'amoy',
        parent: v6Harness(1).adapter,
        child: v6Harness(1).adapter,
        addresses: ADDRESSES,
        chainIds
      })
    );
    expect(InvalidNumericValueError.has(err)).equals(true);
  });
});
