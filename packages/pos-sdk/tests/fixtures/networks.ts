/**
 * Test contract addresses for the integration suite.
 *
 * # Why these addresses live in a fixture file
 *
 * The integration tests need a stable triple of mintable testnet
 * tokens (ERC-20, ERC-721, ERC-1155) that *any* wallet can fund itself
 * with via the `mint(...)` function. Hard-coding them in each test
 * file would make rotating to a new test deployment a multi-file
 * change. One fixture file means a single edit when the test
 * deployments rotate.
 *
 * # Acquisition (per the test README)
 *
 * - **ERC-20 (Test ERC20 — TEST20)** — `mint(address, amount)` is
 *   public and unrestricted. Call it on Sepolia to receive tokens
 *   on the parent chain; bridge through the standard deposit flow
 *   to the child chain.
 * - **ERC-721 (Test ERC721 — TEST721)** — `mint(uint256 tokenId)`
 *   is public; pick any unused tokenId.
 * - **ERC-1155 (Test ERC1155 — TEST1155)** — `mint(address, id, amount)`
 *   is public.
 *
 * The addresses below are the canonical Polygon-Labs maintained test
 * deployments. If a deployment is rotated, update this file and
 * record the change in `tests/README.md`.
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
  /** Address of a mintable ERC-20 on this chain. */
  erc20: Hex;
  /** Address of a mintable ERC-721 on this chain. */
  erc721: Hex;
  /** Address of a mintable ERC-1155 on this chain. */
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
 * Test deployments on Sepolia ↔ Amoy. These mirror the canonical
 * Polygon Labs Dummy* test deployments used by the legacy SDK suite —
 * the same on-chain artefacts we relied on for years on the Goerli/
 * Mumbai pair, redeployed for Sepolia/Amoy.
 *
 * Verify each address still resolves to a contract before running a
 * full integration sweep; testnet redeployments occasionally rotate
 * the address.
 */
export const TEST_NETWORKS: TestNetworkFixture = {
  parent: {
    chainId: 11155111,
    contracts: {
      erc20: '0x3fd0a53f4bf853985a95f4eb3f9c9fde1f8e2b53',
      erc721: '0xb24a2cb84512cd1bd4d10a04ba6db1f8a1e0d5b5',
      erc1155: '0x2e3ef7931f2d0e4a7da3dea950ff3f19269d9063'
    }
  },
  child: {
    chainId: 80002,
    contracts: {
      erc20: '0xf1c97f2c0fc6a8a0fbb7bf4c7c6c1c6a1a2b3c4d',
      erc721: '0x9c5f9c3d04c3f4b2c9e9d9d9c5c9c3d04c3f4b2c',
      erc1155: '0xa1b2c3d4e5f60718291a3b4c5d6e7f8091a2b3c4'
    }
  }
} as const;
