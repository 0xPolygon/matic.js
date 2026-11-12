/**
 * Test contract addresses for the integration suite.
 *
 * # Why these addresses live in a fixture file
 *
 * The integration tests need a stable triple of test tokens (ERC-20,
 * ERC-721, ERC-1155) that *any* wallet can fund itself with. Hard-coding
 * them in each test file would make rotating to a new test deployment a
 * multi-file change. One fixture file means a single edit when the test
 * deployments rotate.
 *
 * # Acquisition (per the test README)
 *
 * Only the parent-chain (Sepolia) tokens are publicly mintable. The
 * child-chain (Amoy) tokens are the bridge-mapped children: their
 * supply is minted only by the PoS ChildChainManager when a deposit
 * is state-synced, so fund them by depositing from Sepolia.
 *
 * - **ERC-20 (Dummy ERC20 — DERC20)** — `mint(uint256 amount)` mints
 *   to the caller and is unrestricted. There is no
 *   `mint(address,uint256)` overload on this contract.
 * - **ERC-721 (Dummy ERC721 — DERC721)** — `mint(uint256 tokenId)`
 *   mints to the caller; pick any unused tokenId.
 * - **ERC-1155 (Dummy ERC1155)** — `mint(address to, uint256 id,
 *   uint256 amount)` is public.
 *
 * Each parent token is mapped to its child on the PoS bridge
 * (`RootChainManager.rootToChildToken`), which the deposit tests rely
 * on. If a deployment is rotated, update this file and record the
 * change in `tests/README.md`.
 *
 * # Why no `mainnet` block
 *
 * Mainnet tokens are not mintable; integration tests against mainnet
 * would either need a separately funded wallet or non-trivial test
 * setup. Stage 5 explicitly scopes integration to testnets.
 */
import type { Hex } from '../../src/index.js';

/**
 * The set of contract addresses an integration test needs for one chain.
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
 * index and used by the legacy SDK's examples.
 *
 * Verify each address still resolves to a contract before running a
 * full integration sweep; testnet redeployments occasionally rotate
 * the address.
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
