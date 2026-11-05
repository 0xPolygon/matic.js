/**
 * Test contract addresses for the live-read tier.
 *
 * Live-read reads only; write paths run on the kurtosis devnet, see
 * `packages/e2e/README.md`.
 *
 * # Why these addresses live in a fixture file
 *
 * The live reads need a stable triple of test tokens (ERC-20, ERC-721,
 * ERC-1155) on each chain. One fixture file means a single edit when the
 * test deployments rotate, instead of one per test file.
 *
 * Each parent token is mapped to its child on the PoS bridge
 * (`RootChainManager.rootToChildToken`). If a deployment is rotated,
 * update this file.
 */
import type { Hex } from '../../src/index.js';

/**
 * The set of contract addresses a live-read test needs for one chain.
 */
export interface TestContractSet {
  /** Address of the test ERC-20 on this chain. */
  erc20: Hex;
  /** Address of the test ERC-721 on this chain. */
  erc721: Hex;
  /** Address of the test ERC-1155 on this chain. */
  erc1155: Hex;
}

export interface TestNetworkFixture {
  /** Parent-chain (Sepolia) configuration. */
  parent: {
    /** Public chain ID — Sepolia. */
    chainId: 11155111;
    contracts: TestContractSet;
  };
  /** Child-chain (Amoy) configuration. */
  child: {
    /** Public chain ID — Amoy. */
    chainId: 80002;
    contracts: TestContractSet;
  };
}

/**
 * Test deployments on Sepolia ↔ Amoy: the PoS bridge's Dummy* test
 * tokens, as published under `POSContracts.Tokens` in the Amoy address
 * index and used by the legacy SDK's examples. Testnet redeployments
 * occasionally rotate an address.
 */
export const TEST_NETWORKS: TestNetworkFixture = {
  parent: {
    chainId: 11155111,
    contracts: {
      erc20: '0xb480378044d92C96D16589Eb95986df6a97F2cFB',
      erc721: '0x421DbB7B5dFCb112D7a13944DeFB80b28eC5D22C',
      erc1155: '0x095DD31b6473c4a32548d2A5B09e0f2F3F30d8F1'
    }
  },
  child: {
    chainId: 80002,
    contracts: {
      erc20: '0xf3202E7270a10E599394d8A7dA2F4Fbd475e96bA',
      erc721: '0x02f83d4110D3595872481f677Ae323D50Aa09209',
      erc1155: '0x488AfDFef019f511E343becb98B7c24ee02fA639'
    }
  }
} as const;
