/**
 * Adapter parity test — ethers v6, against Amoy.
 *
 * Mirrors `viem.test.ts` `it()`-for-`it()` so a future regression in v6
 * lights up here and only here. Names and expectations are kept
 * verbatim — see the docstring on `viem.test.ts`.
 */
import { JsonRpcProvider, Network, Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';

import type { Hex } from '../../../src/index.js';

import { RootChainManagerABI } from '../../../src/abi/index.js';
import { ethersV6Adapter } from '../../../src/adapters/ethers-v6.js';
import { TEST_NETWORKS } from '../../fixtures/networks.js';
import { HAS_CREDS, readChainEnvOrPlaceholder } from '../helpers.js';

const childNetwork = (): Network => Network.from(TEST_NETWORKS.child.chainId);
const parentNetwork = (): Network => Network.from(TEST_NETWORKS.parent.chainId);

describe.skipIf(!HAS_CREDS)('Adapter: ethers v6', { timeout: 60_000 }, () => {
  const env = readChainEnvOrPlaceholder();

  it('getChainId returns 80002 on Amoy', async () => {
    // staticNetwork: true matches the team backend.md guidance: avoid
    // re-detecting the chain on every call when the SDK will only ever
    // talk to one RPC endpoint per adapter.
    const provider = new JsonRpcProvider(env.childRpc, childNetwork(), {
      staticNetwork: true
    });
    const adapter = ethersV6Adapter({ provider });
    const chainId = await adapter.getChainId();
    expect(chainId).equals(TEST_NETWORKS.child.chainId);
  });

  it('read RootChainManager.tokenToType matches expected value', async () => {
    const provider = new JsonRpcProvider(env.parentRpc, parentNetwork(), {
      staticNetwork: true
    });
    const adapter = ethersV6Adapter({ provider });
    const { createAddressFetcher } = await import('../../../src/services/address-service.js');
    const fetcher = createAddressFetcher({ network: 'amoy' });
    const addresses = await fetcher.get();
    const result = await adapter.read({
      address: addresses.RootChainManager,
      abi: RootChainManagerABI,
      functionName: 'tokenToType',
      args: ['0x0000000000000000000000000000000000000000']
    });
    expect(result).a('string');
    expect((result as string).toLowerCase()).equals(
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    );
  });

  it('write transfers 1 wei of test ERC20 and resolves with hash', async () => {
    const provider = new JsonRpcProvider(env.childRpc, childNetwork(), {
      staticNetwork: true
    });
    const signer = new Wallet(env.privateKey, provider);
    const adapter = ethersV6Adapter({
      provider,
      signer
    });
    const erc20Abi = [
      'function transfer(address to, uint256 amount) returns (bool)'
    ];
    const tx = await adapter.write({
      address: TEST_NETWORKS.child.contracts.erc20,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [await signer.getAddress(), 1n]
    });
    expect(tx.hash).match(/^0x[0-9a-f]{64}$/i);
    const receipt = await tx.confirmed();
    expect(receipt.status).equals('success');
  });

  it('keccak256 produces expected hash for known input', () => {
    const provider = new JsonRpcProvider(env.childRpc, childNetwork(), {
      staticNetwork: true
    });
    const adapter = ethersV6Adapter({ provider });
    const hash = adapter.keccak256(new Uint8Array());
    expect(hash).equals(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
    );
  });

  it('getTransactionReceipt returns null for nonexistent hash', async () => {
    const provider = new JsonRpcProvider(env.childRpc, childNetwork(), {
      staticNetwork: true
    });
    const adapter = ethersV6Adapter({ provider });
    const r = await adapter.getTransactionReceipt(
      ('0x' + '00'.repeat(32)) as Hex
    );
    expect(r).equals(null);
  });
});
