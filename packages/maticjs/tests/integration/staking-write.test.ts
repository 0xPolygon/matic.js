/**
 * Staking write tier — real Sepolia broadcasts, parameterised over all
 * three adapters, gated on the same `POS_SDK_TEST_*` credentials as the
 * bridge write tests.
 *
 * Covers what calldata ground truth cannot: that a staking write reaches
 * the chain and lands (`approveStakeManager` of 1 wei POL, read back via
 * `getAllowanceForStakeManager`), and that the parent-chain pin refuses a
 * write when the adapter is connected to the wrong chain, before
 * anything is broadcast. Approving 1 wei needs no POL balance, only
 * Sepolia ETH for gas.
 *
 * Delegation writes are not exercised here: they need funded POL and a
 * live validator share on Sepolia.
 */
import { Interface, JsonRpcProvider, Network as V6Network, Wallet as V6Wallet } from 'ethers';
import { providers as v5Providers, utils as v5Utils, Wallet as V5Wallet } from 'ethers-v5';
import { createPublicClient, createWalletClient, encodeFunctionData, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import type { Adapter, Hex } from '../../src/index.js';

import { PolTokenABI } from '../../src/abi/index.js';
import { ethersV5Adapter } from '../../src/adapters/ethers-v5.js';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.js';
import { viemAdapter } from '../../src/adapters/viem.js';
import { POSBridgeError } from '../../src/errors.js';
import { StakingClient } from '../../src/staking/index.js';
import { TEST_NETWORKS } from '../fixtures/networks.js';
import { HAS_CREDS, noteSkippedIfNoCreds, readChainEnvOrPlaceholder } from './helpers.js';

const env = readChainEnvOrPlaceholder();
const MAINNET_RPC = process.env['POS_SDK_TEST_MAINNET_PARENT_RPC'] ?? 'https://eth.drpc.org';

interface AdapterRow {
  name: string;
  /** Sepolia adapter with the test signer. */
  parent: Adapter;
  /** Ethereum-mainnet adapter holding the SAME Sepolia signer: the wrong chain. */
  wrongChain: Adapter;
  testWallet: Hex;
  /** The adapter library's own encoder, independent of the SDK's prepare path. */
  encodeApprove: (args: { spender: Hex; amount: bigint }) => string;
}

function rows(): readonly AdapterRow[] {
  if (!HAS_CREDS) return [];
  const viemAccount = privateKeyToAccount(env.privateKey);
  const v5Sepolia = new v5Providers.StaticJsonRpcProvider(env.parentRpc);
  const v5Mainnet = new v5Providers.StaticJsonRpcProvider(MAINNET_RPC);
  const v6Sepolia = new JsonRpcProvider(
    env.parentRpc,
    V6Network.from(TEST_NETWORKS.parent.chainId),
    { staticNetwork: true }
  );
  const v6Mainnet = new JsonRpcProvider(MAINNET_RPC, V6Network.from(1), { staticNetwork: true });
  const v5Signer = new V5Wallet(env.privateKey, v5Sepolia);
  const v6Signer = new V6Wallet(env.privateKey, v6Sepolia);
  const v5Iface = new v5Utils.Interface(PolTokenABI);
  const v6Iface = new Interface(PolTokenABI);
  return [
    {
      name: 'viem',
      parent: viemAdapter({
        public: createPublicClient({ chain: sepolia, transport: http(env.parentRpc) }),
        wallet: createWalletClient({
          account: viemAccount,
          chain: sepolia,
          transport: http(env.parentRpc)
        }),
        account: viemAccount.address
      }),
      wrongChain: viemAdapter({
        public: createPublicClient({ chain: mainnet, transport: http(MAINNET_RPC) }),
        wallet: createWalletClient({
          account: viemAccount,
          chain: mainnet,
          transport: http(MAINNET_RPC)
        }),
        account: viemAccount.address
      }),
      testWallet: viemAccount.address,
      encodeApprove: ({ spender, amount }) =>
        encodeFunctionData({ abi: PolTokenABI, functionName: 'approve', args: [spender, amount] })
    },
    {
      name: 'ethers-v5',
      parent: ethersV5Adapter({ provider: v5Sepolia, signer: v5Signer }),
      wrongChain: ethersV5Adapter({
        provider: v5Mainnet,
        signer: new V5Wallet(env.privateKey, v5Mainnet)
      }),
      testWallet: viemAccount.address,
      encodeApprove: ({ spender, amount }) =>
        v5Iface.encodeFunctionData('approve', [spender, amount])
    },
    {
      name: 'ethers-v6',
      parent: ethersV6Adapter({ provider: v6Sepolia, signer: v6Signer }),
      wrongChain: ethersV6Adapter({
        provider: v6Mainnet,
        signer: new V6Wallet(env.privateKey, v6Mainnet)
      }),
      testWallet: viemAccount.address,
      encodeApprove: ({ spender, amount }) =>
        v6Iface.encodeFunctionData('approve', [spender, amount])
    }
  ];
}

const TABLE = rows().map((r) => [r.name, r] as const);
noteSkippedIfNoCreds('staking writes');

describe.skipIf(!HAS_CREDS)('staking writes (Sepolia)', { timeout: 180_000 }, () => {
  describe.each(TABLE)('via %s', (_name, row) => {
    it('pol.approveStakeManager(1 wei) lands and the allowance reads back', async () => {
      const staking = await StakingClient.init({ network: 'amoy', parent: row.parent });
      const tx = await staking.pol.approveStakeManager({ amount: 1n });
      expect(tx)
        .property('hash')
        .match(/^0x[0-9a-f]{64}$/i);

      const receipt = await tx.confirmed();
      expect(receipt).property('status').equals('success');

      const allowance = await staking.pol.getAllowanceForStakeManager({ owner: row.testWallet });
      expect(allowance).equals(1n);
    });

    it('pol.prepareApproveStakeManager encodes what the adapter library encodes', async () => {
      const staking = await StakingClient.init({ network: 'amoy', parent: row.parent });
      const spender = await staking.stakeManager.getAddress();
      const prepared = await staking.pol.prepareApproveStakeManager({ amount: 1n });

      expect(prepared)
        .property('to')
        .equals(await staking.pol.getAddress());
      expect(prepared)
        .property('data')
        .equals(row.encodeApprove({ spender, amount: 1n }));
    });

    it('refuses a write from an adapter on the wrong chain before broadcasting', async () => {
      // Sepolia addresses, mainnet connection: the write is pinned to
      // Sepolia's chain id, so the adapter must reject it pre-flight. A
      // fixed gas limit keeps the check independent of gas estimation.
      const staking = await StakingClient.init({ network: 'amoy', parent: row.wrongChain });
      const err = await staking.pol
        .approveStakeManager({ amount: 1n }, { gasLimit: 100_000n })
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(err).instanceOf(POSBridgeError);
      expect(err).property('code').equals('UNSUPPORTED_NETWORK');
    });
  });
});
