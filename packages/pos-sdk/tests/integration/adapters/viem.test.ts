/**
 * Adapter parity test — viem, against Amoy.
 *
 * No mocks. With creds present, this test signs and reads against the
 * real chain. Without creds, the entire `describe` is skipped.
 *
 * The three adapter parity files (`viem.test.ts`, `ethers-v5.test.ts`,
 * `ethers-v6.test.ts`) carry **the same `it()` names with the same
 * expectations** so a future regression in any one library lights up
 * exactly one of the three files. Names are mirrored verbatim — do not
 * rename without updating all three.
 */
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygonAmoy, sepolia } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import type { Hex } from '../../../src/index.js';

import { RootChainManagerABI } from '../../../src/abi/index.js';
import { viemAdapter } from '../../../src/adapters/viem.js';
import { TEST_NETWORKS } from '../../fixtures/networks.js';
import { HAS_CREDS, readChainEnvOrPlaceholder } from '../helpers.js';

describe.skipIf(!HAS_CREDS)('Adapter: viem', { timeout: 60_000 }, () => {
  const env = readChainEnvOrPlaceholder();

  it('getChainId returns 80002 on Amoy', async () => {
    const account = privateKeyToAccount(env.privateKey);
    const publicClient = createPublicClient({
      chain: polygonAmoy,
      transport: http(env.childRpc)
    });
    const adapter = viemAdapter({
      public: publicClient,
      account: account.address
    });
    const chainId = await adapter.getChainId();
    expect(chainId).equals(TEST_NETWORKS.child.chainId);
  });

  it('read RootChainManager.tokenToType matches expected value', async () => {
    // RootChainManager lives on the parent chain. tokenToType is a
    // mapping read; for an unregistered token (e.g. address(0)) it
    // returns the zero `bytes32`.
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(env.parentRpc)
    });
    const adapter = viemAdapter({ public: publicClient });
    // Bridge-registered address index — we read the live address from
    // the SDK's address fetcher rather than hard-coding it here.
    const { createAddressFetcher } = await import('../../../src/services/address-service.js');
    const fetcher = createAddressFetcher({ network: 'amoy' });
    const addresses = await fetcher.get();
    const result = await adapter.read({
      address: addresses.RootChainManager,
      abi: RootChainManagerABI,
      functionName: 'tokenToType',
      args: ['0x0000000000000000000000000000000000000000']
    });
    // Unregistered token ⇒ zero bytes32. The viem read decodes a
    // `bytes32` into a 0x-prefixed 66-character hex string.
    expect(result).a('string');
    expect((result as string).toLowerCase()).equals(
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    );
  });

  it('write transfers 1 wei of test ERC20 and resolves with hash', async () => {
    // The sender pays gas in Amoy POL; this test moves 1 wei of the test
    // ERC-20 to itself, which is a no-op asset move that exercises the
    // write path end-to-end. A successful write requires gas — failure
    // here typically means the wallet ran out of testnet POL.
    const account = privateKeyToAccount(env.privateKey);
    const publicClient = createPublicClient({
      chain: polygonAmoy,
      transport: http(env.childRpc)
    });
    const walletClient = createWalletClient({
      account,
      chain: polygonAmoy,
      transport: http(env.childRpc)
    });
    const adapter = viemAdapter({
      public: publicClient,
      wallet: walletClient,
      account: account.address
    });
    const erc20Abi = [
      {
        type: 'function',
        name: 'transfer',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' }
        ],
        outputs: [{ type: 'bool' }]
      }
    ] as const;
    const tx = await adapter.write({
      address: TEST_NETWORKS.child.contracts.erc20,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [account.address, 1n]
    });
    expect(tx.hash).match(/^0x[0-9a-f]{64}$/i);
    const receipt = await tx.confirmed();
    expect(receipt.status).equals('success');
  });

  it('keccak256 produces expected hash for known input', () => {
    const publicClient = createPublicClient({
      chain: polygonAmoy,
      transport: http(env.childRpc)
    });
    const adapter = viemAdapter({ public: publicClient });
    // keccak256("") = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
    const hash = adapter.keccak256(new Uint8Array());
    expect(hash).equals(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
    );
  });

  it('getTransactionReceipt returns null for nonexistent hash', async () => {
    const publicClient = createPublicClient({
      chain: polygonAmoy,
      transport: http(env.childRpc)
    });
    const adapter = viemAdapter({ public: publicClient });
    const r = await adapter.getTransactionReceipt(
      // 32 bytes of zeros — a hash that cannot exist on-chain.
      ('0x' + '00'.repeat(32)) as Hex
    );
    expect(r).equals(null);
  });
});
