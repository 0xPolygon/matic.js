/**
 * Idempotent funding of every (suite × adapter) key on the devnet.
 *
 * Each step checks a balance first and only sends when it is short, so a
 * second run against the same devnet sends nothing. It uses plain viem
 * calls and never the SDK, so a defect in the SDK cannot break the setup
 * that the SDK's own tests depend on.
 *
 * Three phases, in order:
 *
 * 1. The admin account tops up L1 ETH, L2 native gas and (for staking keys)
 *    POL. All admin sends share one nonce stream, so they are signed with
 *    consecutive nonces and awaited together.
 * 2. Each key mints its own Dummy ERC-20 / ERC-721 / ERC-1155 on L1 (the
 *    pos-portal Dummy tokens let any account mint). Keys run in parallel,
 *    each on its own nonce stream.
 * 3. The adapter-parity keys bridge a small ERC-20 amount to L2 with a real
 *    `depositFor`, because their tests start from an L2 balance.
 */
import type { Address, Chain, Hash, PrivateKeyAccount, PublicClient, WalletClient } from 'viem';

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  parseEther
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { VError } from '@polygonlabs/verror';

import type { AdapterName, Suite } from './keys.ts';

import {
  dummyErc1155Abi,
  dummyErc20Abi,
  dummyErc721Abi,
  erc20Abi,
  rootChainManagerAbi
} from './devnet-abis.ts';
import { ADAPTERS, allKeySlots, keyFor } from './keys.ts';
import { getTestEnv } from './test-env.ts';
import { pollUntil } from './wait.ts';

const MIN_GAS = parseEther('5');
const GAS_TOP_UP = parseEther('10');
const MIN_POL = parseEther('200');
const POL_TOP_UP = parseEther('500');
const MIN_ERC20 = parseEther('1');
// Mint double the minimum, so the adapter-parity keys' small L2 deposit
// does not drop them back under it and make the next seed mint again.
const ERC20_MINT = parseEther('2');
const ERC1155_TOKEN_ID = 1n;
const MIN_ERC1155 = 10n;
const MIN_CHILD_ERC20 = 1_000_000n;
const POLLING_INTERVAL_MS = 250;

interface Chains {
  l1: { chain: Chain; public: PublicClient };
  l2: { chain: Chain; public: PublicClient };
}

export interface SeedResult {
  adminSends: number;
  keySends: number;
}

function chainFor({ id, name, url }: { id: number; name: string; url: string }) {
  const chain = defineChain({
    id,
    name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } }
  });
  return {
    chain,
    public: createPublicClient({ chain, transport: http(), pollingInterval: POLLING_INTERVAL_MS })
  };
}

function walletFor(
  account: PrivateKeyAccount,
  chain: Chain
): WalletClient<ReturnType<typeof http>, Chain, PrivateKeyAccount> {
  return createWalletClient({ account, chain, transport: http() });
}

async function waitAll({
  client,
  hashes,
  label
}: {
  client: PublicClient;
  hashes: Hash[];
  label: string;
}): Promise<void> {
  const receipts = await Promise.all(
    hashes.map((hash) => client.waitForTransactionReceipt({ hash, timeout: 120_000 }))
  );
  const failed = receipts.filter((r) => r.status !== 'success').map((r) => r.transactionHash);
  if (failed.length > 0) throw new VError(`${label}: transactions reverted`, { info: { failed } });
}

/** Phase 1: admin top-ups, one nonce stream per chain. */
async function fundFromAdmin(chains: Chains, log: (line: string) => void): Promise<number> {
  const env = getTestEnv();
  const { admin, addresses } = env.E2E_ADDRESSES_JSON;
  const adminAccount = privateKeyToAccount(admin.privateKey);
  const l1Wallet = walletFor(adminAccount, chains.l1.chain);
  const l2Wallet = walletFor(adminAccount, chains.l2.chain);

  let l1Nonce = await chains.l1.public.getTransactionCount({
    address: adminAccount.address,
    blockTag: 'pending'
  });
  let l2Nonce = await chains.l2.public.getTransactionCount({
    address: adminAccount.address,
    blockTag: 'pending'
  });
  const l1Hashes: Hash[] = [];
  const l2Hashes: Hash[] = [];

  for (const { suite, adapter } of allKeySlots()) {
    const { address } = keyFor({ suite, adapter });
    const [l1Balance, l2Balance] = await Promise.all([
      chains.l1.public.getBalance({ address }),
      chains.l2.public.getBalance({ address })
    ]);
    if (l1Balance < MIN_GAS) {
      l1Hashes.push(
        await l1Wallet.sendTransaction({ to: address, value: GAS_TOP_UP, nonce: l1Nonce++ })
      );
      log(`${suite}/${adapter}: admin sends 10 ETH on L1`);
    }
    if (l2Balance < MIN_GAS) {
      l2Hashes.push(
        await l2Wallet.sendTransaction({ to: address, value: GAS_TOP_UP, nonce: l2Nonce++ })
      );
      log(`${suite}/${adapter}: admin sends 10 native on L2`);
    }
    if (suite.startsWith('staking')) {
      const pol = await chains.l1.public.readContract({
        address: addresses.PolToken,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address]
      });
      if (pol < MIN_POL) {
        l1Hashes.push(
          await l1Wallet.writeContract({
            address: addresses.PolToken,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [address, POL_TOP_UP],
            nonce: l1Nonce++
          })
        );
        log(`${suite}/${adapter}: admin sends 500 POL on L1`);
      }
    }
  }

  await waitAll({ client: chains.l1.public, hashes: l1Hashes, label: 'admin L1 top-ups' });
  await waitAll({ client: chains.l2.public, hashes: l2Hashes, label: 'admin L2 top-ups' });
  return l1Hashes.length + l2Hashes.length;
}

/** First token id at or above `from` that nobody owns (`ownerOf` reverts for unminted ids). */
async function firstFreeTokenId({
  client,
  token,
  from
}: {
  client: PublicClient;
  token: Address;
  from: bigint;
}): Promise<bigint> {
  for (let id = from; ; id++) {
    try {
      await client.readContract({
        address: token,
        abi: dummyErc721Abi,
        functionName: 'ownerOf',
        args: [id]
      });
    } catch {
      return id;
    }
  }
}

/** Phase 2: one key mints its own L1 test tokens. Returns the number of sends. */
async function mintTokens({
  chains,
  suite,
  adapter,
  index,
  log
}: {
  chains: Chains;
  suite: Suite;
  adapter: AdapterName;
  index: number;
  log: (line: string) => void;
}): Promise<number> {
  const { tokens } = getTestEnv().E2E_ADDRESSES_JSON;
  const account = keyFor({ suite, adapter });
  const wallet = walletFor(account, chains.l1.chain);
  const client = chains.l1.public;
  const hashes: Hash[] = [];

  const [erc20, erc721, erc1155] = await Promise.all([
    client.readContract({
      address: tokens.root.erc20,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address]
    }),
    client.readContract({
      address: tokens.root.erc721,
      abi: dummyErc721Abi,
      functionName: 'balanceOf',
      args: [account.address]
    }),
    client.readContract({
      address: tokens.root.erc1155,
      abi: dummyErc1155Abi,
      functionName: 'balanceOf',
      args: [account.address, ERC1155_TOKEN_ID]
    })
  ]);

  // One nonce stream per key: each send is accepted by the node before the
  // next is signed, then all receipts are awaited together.
  if (erc20 < MIN_ERC20) {
    hashes.push(
      await wallet.writeContract({
        address: tokens.root.erc20,
        abi: dummyErc20Abi,
        functionName: 'mint',
        args: [ERC20_MINT]
      })
    );
    log(`${suite}/${adapter}: mints 2e18 DummyERC20`);
  }
  if (erc721 < 1n) {
    // Each key scans its own id range, so concurrent keys never race for the same id.
    const tokenId = await firstFreeTokenId({
      client,
      token: tokens.root.erc721,
      from: 1000n + 100n * BigInt(index)
    });
    hashes.push(
      await wallet.writeContract({
        address: tokens.root.erc721,
        abi: dummyErc721Abi,
        functionName: 'mint',
        args: [tokenId]
      })
    );
    log(`${suite}/${adapter}: mints DummyERC721 #${tokenId.toString()}`);
  }
  if (erc1155 < MIN_ERC1155) {
    hashes.push(
      await wallet.writeContract({
        address: tokens.root.erc1155,
        abi: dummyErc1155Abi,
        functionName: 'mint',
        args: [account.address, ERC1155_TOKEN_ID, MIN_ERC1155]
      })
    );
    log(`${suite}/${adapter}: mints 10 DummyERC1155 #1`);
  }

  await waitAll({ client, hashes, label: `${suite}/${adapter} mints` });
  log(`${suite}/${adapter} ${account.address}: ${String(hashes.length)} mint sends`);
  return hashes.length;
}

/** Phase 3: bridge a small ERC-20 balance to L2 for one adapter-parity key. */
async function bridgeErc20ToChild({
  chains,
  adapter,
  log
}: {
  chains: Chains;
  adapter: AdapterName;
  log: (line: string) => void;
}): Promise<number> {
  const { addresses, tokens } = getTestEnv().E2E_ADDRESSES_JSON;
  const account = keyFor({ suite: 'adapter-parity', adapter });
  const readChild = () =>
    chains.l2.public.readContract({
      address: tokens.child.erc20,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address]
    });

  if ((await readChild()) >= MIN_CHILD_ERC20) return 0;

  const wallet = walletFor(account, chains.l1.chain);
  const approve = await wallet.writeContract({
    address: tokens.root.erc20,
    abi: erc20Abi,
    functionName: 'approve',
    args: [addresses.ERC20Predicate, MIN_CHILD_ERC20]
  });
  await waitAll({
    client: chains.l1.public,
    hashes: [approve],
    label: `adapter-parity/${adapter} approve`
  });
  const deposit = await wallet.writeContract({
    address: addresses.RootChainManager,
    abi: rootChainManagerAbi,
    functionName: 'depositFor',
    args: [
      account.address,
      tokens.root.erc20,
      encodeAbiParameters([{ type: 'uint256' }], [MIN_CHILD_ERC20])
    ]
  });
  await waitAll({
    client: chains.l1.public,
    hashes: [deposit],
    label: `adapter-parity/${adapter} deposit`
  });
  log(
    `adapter-parity/${adapter}: deposited ${MIN_CHILD_ERC20.toString()} DummyERC20, waiting for state sync`
  );

  await pollUntil({
    fn: async () => ((await readChild()) >= MIN_CHILD_ERC20 ? true : undefined),
    pollMs: 2_000,
    timeoutMs: 180_000,
    label: `adapter-parity/${adapter} child DummyERC20 balance after state sync`
  });
  return 2;
}

export async function seed({ log }: { log: (line: string) => void }): Promise<SeedResult> {
  const env = getTestEnv();
  const chains: Chains = {
    l1: chainFor({ id: env.E2E_L1_CHAIN_ID, name: 'devnet-l1', url: env.E2E_L1_RPC_URL }),
    l2: chainFor({ id: env.E2E_L2_CHAIN_ID, name: 'devnet-l2', url: env.E2E_L2_RPC_URL })
  };

  const adminSends = await fundFromAdmin(chains, log);

  const mintSends = await Promise.all(
    allKeySlots().map(({ suite, adapter, index }) =>
      mintTokens({ chains, suite, adapter, index, log })
    )
  );

  const bridgeSends = await Promise.all(
    ADAPTERS.map((adapter) => bridgeErc20ToChild({ chains, adapter, log }))
  );

  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  return { adminSends, keySends: sum(mintSends) + sum(bridgeSends) };
}
