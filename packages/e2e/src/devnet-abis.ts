/**
 * Minimal ABI fragments for the devnet's pos-portal Dummy tokens and the
 * RootChainManager. The harness uses these to seed balances with plain
 * viem calls, so seeding never depends on the SDK under test.
 */
import { parseAbi } from 'viem';

export const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
]);

/** Root DummyERC20: anyone can mint to themselves. */
export const dummyErc20Abi = parseAbi(['function mint(uint256 amount)']);

/** Root DummyERC721: anyone can mint a free token id to themselves. */
export const dummyErc721Abi = parseAbi([
  'function mint(uint256 tokenId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)'
]);

/** Root DummyERC1155: anyone can mint. */
export const dummyErc1155Abi = parseAbi([
  'function mint(address account, uint256 id, uint256 amount)',
  'function balanceOf(address account, uint256 id) view returns (uint256)'
]);

/**
 * ERC-721 and ERC-1155 operator approval. The tests use it to revoke an
 * approval the SDK set in an earlier run, and to read it back independently.
 */
export const approvalForAllAbi = parseAbi([
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)'
]);

export const rootChainManagerAbi = parseAbi([
  'function depositFor(address user, address rootToken, bytes depositData)'
]);

/**
 * StakeManager reads the staking tests use to check the SDK's writes
 * without going through the SDK's own reads.
 */
export const stakeManagerAbi = parseAbi([
  'function NFTContract() view returns (address)',
  'function logger() view returns (address)',
  'function totalHeimdallFee() view returns (uint256)',
  'function validators(uint256 validatorId) view returns (uint256 amount, uint256 reward, uint256 activationEpoch, uint256 deactivationEpoch, uint256 jailTime, address signer, address contractAddress, uint8 status, uint256 commissionRate, uint256 lastCommissionUpdate, uint256 delegatorsReward, uint256 delegatedAmount, uint256 initialRewardPerStake)'
]);

/** Events StakeManager emits through its StakingInfo logger. */
export const stakingInfoAbi = parseAbi([
  'event TopUpFee(address indexed user, uint256 indexed fee)',
  'event ClaimRewards(uint256 indexed validatorId, uint256 indexed amount, uint256 indexed totalAmount)',
  'event Restaked(uint256 indexed validatorId, uint256 amount, uint256 total)'
]);
