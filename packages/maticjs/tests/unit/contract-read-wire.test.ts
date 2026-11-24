import type { Abi } from 'viem';

import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Adapter, Hex, Receipt } from '../../src/adapter.ts';
import type {
  LibraryName,
  StateSyncRecord,
  StubNode,
  TaggedValue
} from './contract-call-harness.ts';

import { ChildERC20ABI } from '../../src/abi/ChildERC20.ts';
import { ChildERC721ABI } from '../../src/abi/ChildERC721.ts';
import { ChildERC1155ABI } from '../../src/abi/ChildERC1155.ts';
import { FailedStateSyncHashesABI } from '../../src/abi/failed-state-sync.ts';
import { PlasmaChildERC20ABI } from '../../src/abi/plasma/ChildERC20.ts';
import { PlasmaExitNFTABI } from '../../src/abi/plasma/ExitNFT.ts';
import { PlasmaPriorityQueueABI } from '../../src/abi/plasma/PriorityQueue.ts';
import { PlasmaWithdrawManagerABI } from '../../src/abi/plasma/WithdrawManager.ts';
import { PolTokenABI } from '../../src/abi/PolToken.ts';
import { RootChainABI } from '../../src/abi/RootChain.ts';
import { RootChainManagerABI } from '../../src/abi/RootChainManager.ts';
import { StakeManagerABI } from '../../src/abi/StakeManager.ts';
import { StateReceiverABI } from '../../src/abi/StateReceiver.ts';
import { ValidatorShareABI } from '../../src/abi/ValidatorShare.ts';
import { noopLogger } from '../../src/logger.ts';
import { PlasmaClient } from '../../src/plasma/plasma-client.ts';
import { POSClient } from '../../src/pos-client.ts';
import { RootChain } from '../../src/pos/root_chain.ts';
import { __resetAddressCacheForTesting } from '../../src/services/address-service.ts';
import { StakingClient } from '../../src/staking/staking-client.ts';
import {
  adapterOver,
  ADDRESSES,
  HASH_RECORD,
  hex32,
  LIBRARIES,
  loadFixture,
  OTHER,
  PAYLOAD_RECORD,
  PLASMA_ADDRESSES,
  PLASMA_STATUS,
  quantity,
  receiptOf,
  STAKING_ADDRESSES,
  tagged,
  USER,
  VALIDATOR_SHARE,
  WRITE_FIXTURES_FLAG
} from './contract-call-harness.ts';

/**
 * What goes on the wire for every contract read the SDK makes, and what the
 * public method returns, on each of the three web3 libraries.
 *
 * The REAL adapters (viem, ethers v5, ethers v6) do the encoding and the
 * decoding; only the JSON-RPC transport is a stub. It answers `eth_call` with
 * ABI-encoded data computed here from a canned value, and records the call.
 * The three libraries must send identical bytes to the same address and the
 * public method must return the same value on each, so every row of
 * `tests/fixtures/contract-calls/read-wire.json` is checked three times. The
 * integer widths that differ per library (`uint8`, `uint32`), the
 * multi-output reads, `bytes` (empty and not) and `bytes32` are all here.
 */

const FIXTURE = 'read-wire.json';

type Answers = Readonly<Record<string, unknown>>;

interface WireCall {
  side: 'parent' | 'child';
  functionName: string;
  to: string;
  data: string;
  blockTag: unknown;
}

interface Chains {
  parent: Adapter;
  child: Adapter;
}

interface Scenario {
  name: string;
  /** The ABIs the node decodes the calls against. */
  abis: readonly Abi[];
  answers: Answers;
  /** Extra JSON-RPC the node answers, per chain. */
  parentRpc?: StubNode['rpc'];
  childRpc?: StubNode['rpc'];
  run: (chains: Chains) => Promise<unknown>;
}

interface FixtureRow {
  calls: WireCall[];
  value: TaggedValue;
}

/**
 * The predicate carries letters so the checksum casing a library hands back is
 * part of what the public method returns; an all-digit address would hide it.
 */
const PREDICATE: Hex = '0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf';
const INDEX = { ...ADDRESSES, ERC20Predicate: PREDICATE };

const BIG = 123_456_789_012_345_678_901n;
const PREDICATE_TYPE: Hex = hex32(1n);
const PARENT_ERC20: Hex = '0x00000000000000000000000000000000000000c1';
const PARENT_ERC721: Hex = '0x00000000000000000000000000000000000000c2';
const PARENT_ERC1155: Hex = '0x00000000000000000000000000000000000000c3';
const QUEUE: Hex = '0x00000000000000000000000000000000000000e1';

/** A receipt in the shape a node returns it, from the fields the SDK reads. */
const rpcReceipt = (receipt: Receipt): unknown => ({
  transactionHash: receipt.transactionHash,
  transactionIndex: '0x0',
  blockHash: hex32(0xb10cn),
  blockNumber: quantity(receipt.blockNumber),
  from: ADDRESSES.RootChain,
  to: ADDRESSES.RootChain,
  contractAddress: null,
  cumulativeGasUsed: '0x5208',
  gasUsed: '0x5208',
  effectiveGasPrice: '0x1',
  type: '0x2',
  status: receipt.status === 'success' ? '0x1' : '0x0',
  logsBloom: `0x${'00'.repeat(256)}`,
  logs: receipt.logs.map((log) => ({
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: quantity(receipt.blockNumber),
    transactionHash: receipt.transactionHash,
    transactionIndex: '0x0',
    blockHash: hex32(0xb10cn),
    logIndex: quantity(log.logIndex),
    removed: false
  }))
});

const depositRpc = (record: StateSyncRecord): StubNode['rpc'] => {
  const receipt = rpcReceipt(receiptOf(record));
  return (method, params) => {
    if (method === 'eth_getTransactionReceipt' && params[0] === record.transactionHash) {
      return receipt;
    }
    throw new Error(`parent chain: unscripted ${method}`);
  };
};

const posOn = async ({ parent, child }: Chains): Promise<POSClient> => {
  __resetAddressCacheForTesting();
  return POSClient.init({
    network: 'mainnet',
    parent,
    child,
    addresses: INDEX,
    logger: noopLogger
  });
};

const stakingOn = ({ parent }: Chains): Promise<StakingClient> => {
  __resetAddressCacheForTesting();
  return StakingClient.init({
    network: 'mainnet',
    parent,
    addresses: STAKING_ADDRESSES,
    logger: noopLogger
  });
};

const plasmaOn = ({ parent, child }: Chains): Promise<PlasmaClient> =>
  PlasmaClient.init({
    network: 'mainnet',
    parent,
    child,
    addresses: PLASMA_ADDRESSES,
    logger: noopLogger
  });

const TOKEN_TYPE_ANSWERS: Answers = {
  tokenToType: PREDICATE_TYPE,
  typeToPredicate: PREDICATE
};

/** A scalar staking read: one public method, one `uint256` answer. */
const scalar = ({
  name,
  abi,
  functionName,
  run
}: {
  name: string;
  abi: Abi;
  functionName: string;
  run: (c: Chains) => Promise<unknown>;
}): Scenario => ({ name, abis: [abi], answers: { [functionName]: BIG }, run });

const SCENARIOS: Scenario[] = [
  // PoS
  {
    name: 'erc20.getBalance',
    abis: [ChildERC20ABI],
    answers: { balanceOf: BIG },
    run: async (c) => (await posOn(c)).parent.erc20(PARENT_ERC20).getBalance(USER)
  },
  {
    name: 'erc20.getAllowance',
    abis: [ChildERC20ABI],
    answers: { allowance: BIG },
    run: async (c) =>
      (await posOn(c)).parent.erc20(PARENT_ERC20).getAllowance(USER, { spenderAddress: OTHER })
  },
  {
    name: 'erc20.getAllowance (default spender)',
    abis: [ChildERC20ABI, RootChainManagerABI],
    answers: { allowance: 5n, ...TOKEN_TYPE_ANSWERS },
    run: async (c) => (await posOn(c)).parent.erc20(PARENT_ERC20).getAllowance(USER)
  },
  {
    name: 'pos.getPredicateAddress',
    abis: [RootChainManagerABI],
    answers: TOKEN_TYPE_ANSWERS,
    run: async (c) => (await posOn(c)).getPredicateAddress(PARENT_ERC20)
  },
  {
    name: 'erc721.getTokensCount',
    abis: [ChildERC721ABI],
    answers: { balanceOf: 3n },
    run: async (c) => (await posOn(c)).parent.erc721(PARENT_ERC721).getTokensCount(USER)
  },
  {
    name: 'erc721.getTokenIdAtIndexForUser',
    abis: [ChildERC721ABI],
    answers: { tokenOfOwnerByIndex: BIG },
    run: async (c) =>
      (await posOn(c)).parent.erc721(PARENT_ERC721).getTokenIdAtIndexForUser(2, USER)
  },
  {
    name: 'erc721.isApproved',
    abis: [ChildERC721ABI, RootChainManagerABI],
    answers: { getApproved: PREDICATE, ...TOKEN_TYPE_ANSWERS },
    run: async (c) => (await posOn(c)).parent.erc721(PARENT_ERC721).isApproved(8n)
  },
  {
    name: 'erc721.isApprovedAll',
    abis: [ChildERC721ABI, RootChainManagerABI],
    answers: { isApprovedForAll: true, ...TOKEN_TYPE_ANSWERS },
    run: async (c) => (await posOn(c)).parent.erc721(PARENT_ERC721).isApprovedAll(USER)
  },
  {
    name: 'erc1155.getBalance',
    abis: [ChildERC1155ABI],
    answers: { balanceOf: BIG },
    run: async (c) => (await posOn(c)).parent.erc1155(PARENT_ERC1155).getBalance(USER, 4n)
  },
  {
    name: 'erc1155.isApprovedAll',
    abis: [ChildERC1155ABI, RootChainManagerABI],
    answers: { isApprovedForAll: false, ...TOKEN_TYPE_ANSWERS },
    run: async (c) => (await posOn(c)).parent.erc1155(PARENT_ERC1155).isApprovedAll(USER)
  },
  {
    name: 'rootChainManager.isExitProcessed',
    abis: [RootChainManagerABI],
    answers: { processedExits: true },
    run: async (c) => (await posOn(c)).rootChainManager.isExitProcessed(hex32(0xcdn))
  },
  {
    name: 'rootChain.getLastChildBlock',
    abis: [RootChainABI],
    answers: { getLastChildBlock: BIG },
    run: (c) =>
      new RootChain({
        adapter: c.parent,
        chainId: 1,
        getAddress: () => Promise.resolve(ADDRESSES.RootChain),
        logger: noopLogger
      }).getLastChildBlock()
  },
  {
    name: 'rootChain.findRootBlockFromChild',
    abis: [RootChainABI],
    answers: {
      currentHeaderBlock: 20_000n,
      headerBlocks: [hex32(0x11n), 1n, 1_000_000n, 1_700_000_000n, OTHER]
    },
    run: (c) =>
      new RootChain({
        adapter: c.parent,
        chainId: 1,
        getAddress: () => Promise.resolve(ADDRESSES.RootChain),
        logger: noopLogger
      }).findRootBlockFromChild(500_000n)
  },
  {
    name: 'pos.getDepositStatus (delivered)',
    abis: [StateReceiverABI, FailedStateSyncHashesABI],
    answers: { lastStateId: BIG, failedStateSyncHashes: hex32(0n), failedStateSyncs: '0x' },
    parentRpc: depositRpc(HASH_RECORD),
    run: async (c) => (await posOn(c)).getDepositStatus(HASH_RECORD.transactionHash)
  },
  {
    name: 'pos.getDepositStatus (failed, hash record)',
    abis: [StateReceiverABI, FailedStateSyncHashesABI],
    answers: {
      lastStateId: BIG,
      failedStateSyncHashes: HASH_RECORD.childFailedStateSyncHash,
      failedStateSyncs: '0x'
    },
    parentRpc: depositRpc(HASH_RECORD),
    run: async (c) => (await posOn(c)).getDepositStatus(HASH_RECORD.transactionHash)
  },
  {
    name: 'pos.getDepositStatus (failed, payload record)',
    abis: [StateReceiverABI, FailedStateSyncHashesABI],
    answers: {
      lastStateId: BIG,
      failedStateSyncHashes: hex32(0n),
      failedStateSyncs: PAYLOAD_RECORD.childFailedStateSyncPayload
    },
    parentRpc: depositRpc(PAYLOAD_RECORD),
    run: async (c) => (await posOn(c)).getDepositStatus(PAYLOAD_RECORD.transactionHash)
  },
  // Staking
  scalar({
    name: 'stakeManager.getValidatorId',
    abi: StakeManagerABI,
    functionName: 'getValidatorId',
    run: async (c) => (await stakingOn(c)).stakeManager.getValidatorId({ user: USER })
  }),
  scalar({
    name: 'stakeManager.getDelegatedAmount',
    abi: StakeManagerABI,
    functionName: 'delegatedAmount',
    run: async (c) => (await stakingOn(c)).stakeManager.getDelegatedAmount({ validatorId: 1n })
  }),
  scalar({
    name: 'stakeManager.getValidatorStake',
    abi: StakeManagerABI,
    functionName: 'validatorStake',
    run: async (c) => (await stakingOn(c)).stakeManager.getValidatorStake({ validatorId: 1n })
  }),
  scalar({
    name: 'stakeManager.getMinDeposit',
    abi: StakeManagerABI,
    functionName: 'minDeposit',
    run: async (c) => (await stakingOn(c)).stakeManager.getMinDeposit()
  }),
  scalar({
    name: 'stakeManager.getMinHeimdallFee',
    abi: StakeManagerABI,
    functionName: 'minHeimdallFee',
    run: async (c) => (await stakingOn(c)).stakeManager.getMinHeimdallFee()
  }),
  scalar({
    name: 'stakeManager.getWithdrawalDelay',
    abi: StakeManagerABI,
    functionName: 'WITHDRAWAL_DELAY',
    run: async (c) => (await stakingOn(c)).stakeManager.getWithdrawalDelay()
  }),
  scalar({
    name: 'stakeManager.getCheckpointReward',
    abi: StakeManagerABI,
    functionName: 'CHECKPOINT_REWARD',
    run: async (c) => (await stakingOn(c)).stakeManager.getCheckpointReward()
  }),
  scalar({
    name: 'stakeManager.getCurrentEpoch',
    abi: StakeManagerABI,
    functionName: 'currentEpoch',
    run: async (c) => (await stakingOn(c)).stakeManager.getCurrentEpoch()
  }),
  scalar({
    name: 'stakeManager.getTotalStaked',
    abi: StakeManagerABI,
    functionName: 'currentValidatorSetTotalStake',
    run: async (c) => (await stakingOn(c)).stakeManager.getTotalStaked()
  }),
  {
    name: 'stakeManager.isLocked',
    abis: [StakeManagerABI],
    answers: { locked: true },
    run: async (c) => (await stakingOn(c)).stakeManager.isLocked()
  },
  {
    name: 'stakeManager.getValidatorContract',
    abis: [StakeManagerABI],
    answers: { getValidatorContract: VALIDATOR_SHARE },
    run: async (c) => (await stakingOn(c)).stakeManager.getValidatorContract({ validatorId: 1n })
  },
  {
    // `status` is a uint8: viem and ethers v5 return a number, ethers v6 a bigint.
    name: 'stakeManager.getValidator',
    abis: [StakeManagerABI],
    answers: {
      validators: [BIG, 2n, 3n, 4n, 5n, USER, VALIDATOR_SHARE, 1, 8n, 9n, 10n, 11n, 12n]
    },
    run: async (c) => (await stakingOn(c)).stakeManager.getValidator({ validatorId: 1n })
  },
  scalar({
    name: 'validatorShare.getExchangeRate',
    abi: ValidatorShareABI,
    functionName: 'exchangeRate',
    run: async (c) => (await stakingOn(c)).validatorShare(VALIDATOR_SHARE).getExchangeRate()
  }),
  scalar({
    name: 'validatorShare.getLiquidRewards',
    abi: ValidatorShareABI,
    functionName: 'getLiquidRewards',
    run: async (c) =>
      (await stakingOn(c)).validatorShare(VALIDATOR_SHARE).getLiquidRewards({ user: USER })
  }),
  scalar({
    name: 'validatorShare.getMinAmount',
    abi: ValidatorShareABI,
    functionName: 'minAmount',
    run: async (c) => (await stakingOn(c)).validatorShare(VALIDATOR_SHARE).getMinAmount()
  }),
  scalar({
    name: 'validatorShare.getBalance',
    abi: ValidatorShareABI,
    functionName: 'balanceOf',
    run: async (c) =>
      (await stakingOn(c)).validatorShare(VALIDATOR_SHARE).getBalance({ user: USER })
  }),
  scalar({
    name: 'validatorShare.getUnbondNonce',
    abi: ValidatorShareABI,
    functionName: 'unbondNonces',
    run: async (c) =>
      (await stakingOn(c)).validatorShare(VALIDATOR_SHARE).getUnbondNonce({ user: USER })
  }),
  scalar({
    name: 'validatorShare.getValidatorId',
    abi: ValidatorShareABI,
    functionName: 'validatorId',
    run: async (c) => (await stakingOn(c)).validatorShare(VALIDATOR_SHARE).getValidatorId()
  }),
  {
    name: 'validatorShare.getTotalStake',
    abis: [ValidatorShareABI],
    answers: { getTotalStake: [BIG, 10n ** 18n] },
    run: async (c) =>
      (await stakingOn(c)).validatorShare(VALIDATOR_SHARE).getTotalStake({ user: USER })
  },
  {
    name: 'validatorShare.getUnbond',
    abis: [ValidatorShareABI],
    answers: { unbonds: [BIG, 7n] },
    run: async (c) => (await stakingOn(c)).validatorShare(VALIDATOR_SHARE).getUnbond({ user: USER })
  },
  {
    name: 'validatorShare.getUnbondNew',
    abis: [ValidatorShareABI],
    answers: { unbonds_new: [BIG, 7n] },
    run: async (c) =>
      (await stakingOn(c)).validatorShare(VALIDATOR_SHARE).getUnbondNew({ user: USER, nonce: 2n })
  },
  scalar({
    name: 'pol.getBalance',
    abi: PolTokenABI,
    functionName: 'balanceOf',
    run: async (c) => (await stakingOn(c)).pol.getBalance({ user: USER })
  }),
  scalar({
    name: 'pol.getAllowanceForStakeManager',
    abi: PolTokenABI,
    functionName: 'allowance',
    run: async (c) => (await stakingOn(c)).pol.getAllowanceForStakeManager({ owner: USER })
  }),
  scalar({
    name: 'pol.getNonce',
    abi: PolTokenABI,
    functionName: 'nonces',
    run: async (c) => (await stakingOn(c)).pol.getNonce({ owner: USER })
  }),
  {
    // `eip712Domain` mixes `bytes1`, two strings, a `uint256`, an address, a
    // `bytes32` and a `uint256[]` in one answer.
    name: 'pol.preparePermit',
    abis: [PolTokenABI],
    answers: {
      nonces: 4n,
      eip712Domain: [
        '0x0f',
        'Polygon Ecosystem Token',
        '1',
        1n,
        STAKING_ADDRESSES.PolToken,
        hex32(0n),
        []
      ]
    },
    run: async (c) =>
      (await stakingOn(c)).pol.preparePermit({ owner: USER, value: 5n, deadline: 1_900_000_000n })
  },
  // Plasma
  {
    name: 'plasma.erc20.getBalance',
    abis: [PlasmaChildERC20ABI],
    answers: { balanceOf: BIG },
    run: async (c) => (await plasmaOn(c)).parent.erc20(PARENT_ERC20).getBalance(USER)
  },
  {
    name: 'plasma.erc20.getAllowance',
    abis: [PlasmaChildERC20ABI],
    answers: { allowance: BIG },
    run: async (c) => (await plasmaOn(c)).parent.erc20(PARENT_ERC20).getAllowance(USER)
  },
  {
    // exitsQueues (address), currentSize (uint256) and ON_FINALIZE_GAS_LIMIT
    // (uint32: a number on viem and ethers v5, a bigint on ethers v6).
    name: 'plasma.erc20.prepareCompleteWithdraw (explicit gas limit)',
    abis: [PlasmaWithdrawManagerABI, PlasmaPriorityQueueABI],
    answers: { exitsQueues: QUEUE, currentSize: BIG, ON_FINALIZE_GAS_LIMIT: 300_000 },
    run: async (c) =>
      (await plasmaOn(c)).parent.erc20(PARENT_ERC20).prepareCompleteWithdraw({ gasLimit: 900_000n })
  },
  {
    name: 'plasma.erc20.getWithdrawStatus',
    abis: [RootChainABI, PlasmaExitNFTABI],
    answers: { getLastChildBlock: 100n, exists: true },
    parentRpc: (method, params) => {
      if (method === 'eth_getTransactionReceipt' && params[0] === PLASMA_STATUS.confirm) {
        return rpcReceipt(PLASMA_STATUS.confirmReceipt);
      }
      return PLASMA_STATUS.parentRpc(method, params);
    },
    childRpc: PLASMA_STATUS.childRpc,
    run: async (c) =>
      (await plasmaOn(c)).parent.erc20(PLASMA_ADDRESSES.PolToken).getWithdrawStatus({
        burnTxHash: PLASMA_STATUS.burn,
        confirmTxHash: PLASMA_STATUS.confirm
      })
  }
];

/** Every contract read the SDK makes, by ABI and function (the call-site inventory). */
const PAIRS: ReadonlyArray<readonly [abi: Abi, method: string]> = [
  [ChildERC20ABI, 'balanceOf'],
  [ChildERC20ABI, 'allowance'],
  [ChildERC721ABI, 'balanceOf'],
  [ChildERC721ABI, 'tokenOfOwnerByIndex'],
  [ChildERC721ABI, 'getApproved'],
  [ChildERC721ABI, 'isApprovedForAll'],
  [ChildERC1155ABI, 'balanceOf'],
  [ChildERC1155ABI, 'isApprovedForAll'],
  [RootChainManagerABI, 'tokenToType'],
  [RootChainManagerABI, 'typeToPredicate'],
  [RootChainManagerABI, 'processedExits'],
  [RootChainABI, 'getLastChildBlock'],
  [RootChainABI, 'currentHeaderBlock'],
  [RootChainABI, 'headerBlocks'],
  [StateReceiverABI, 'lastStateId'],
  [FailedStateSyncHashesABI, 'failedStateSyncHashes'],
  [FailedStateSyncHashesABI, 'failedStateSyncs'],
  ...[
    'validators',
    'getValidatorContract',
    'locked',
    'CHECKPOINT_REWARD',
    'currentEpoch',
    'currentValidatorSetTotalStake',
    'delegatedAmount',
    'getValidatorId',
    'minDeposit',
    'minHeimdallFee',
    'validatorStake',
    'WITHDRAWAL_DELAY'
  ].map((m): [Abi, string] => [StakeManagerABI, m]),
  ...[
    'getTotalStake',
    'balanceOf',
    'exchangeRate',
    'getLiquidRewards',
    'minAmount',
    'unbondNonces',
    'unbonds',
    'unbonds_new',
    'validatorId'
  ].map((m): [Abi, string] => [ValidatorShareABI, m]),
  [PolTokenABI, 'eip712Domain'],
  [PolTokenABI, 'allowance'],
  [PolTokenABI, 'balanceOf'],
  [PolTokenABI, 'nonces'],
  [PlasmaChildERC20ABI, 'balanceOf'],
  [PlasmaChildERC20ABI, 'allowance'],
  [PlasmaWithdrawManagerABI, 'exitsQueues'],
  [PlasmaWithdrawManagerABI, 'ON_FINALIZE_GAS_LIMIT'],
  [PlasmaPriorityQueueABI, 'currentSize'],
  [PlasmaExitNFTABI, 'exists']
];

// --- the stub node ----------------------------------------------------------------

const nodeFor = ({
  side,
  chainId,
  scenario,
  calls
}: {
  side: WireCall['side'];
  chainId: number;
  scenario: Scenario;
  calls: WireCall[];
}): StubNode => {
  const abi: Abi = scenario.abis.flatMap((a) => [...a]);
  const extra = side === 'parent' ? scenario.parentRpc : scenario.childRpc;
  return {
    chainId,
    rpc: (method, params) => {
      if (method === 'eth_chainId') return quantity(chainId);
      // ethers v5 asks for the head to count a receipt's confirmations.
      if (method === 'eth_blockNumber') return quantity(1_000_000n);
      if (method === 'eth_call') {
        const call = params[0] as { to: string; data?: string; input?: string };
        const data = (call.data ?? call.input ?? '0x') as Hex;
        const { functionName } = decodeFunctionData({ abi, data });
        if (!(functionName in scenario.answers)) {
          throw new Error(`stub node: no answer for ${functionName}`);
        }
        calls.push({
          side,
          functionName,
          to: call.to.toLowerCase(),
          data: data.toLowerCase(),
          blockTag: params[1]
        });
        return encodeFunctionResult({
          abi,
          functionName,
          result: scenario.answers[functionName]
        });
      }
      if (extra !== undefined) return extra(method, params);
      throw new Error(`stub node: unscripted ${method}`);
    }
  };
};

const runOn = async ({
  scenario,
  library
}: {
  scenario: Scenario;
  library: LibraryName;
}): Promise<FixtureRow> => {
  const calls: WireCall[] = [];
  const parent = adapterOver({
    library,
    node: nodeFor({ side: 'parent', chainId: 1, scenario, calls })
  });
  const child = adapterOver({
    library,
    node: nodeFor({ side: 'child', chainId: 137, scenario, calls })
  });
  const value = await scenario.run({ parent, child });
  return { calls, value: tagged(value) };
};

const actual: Record<string, Record<LibraryName, FixtureRow>> = {};
let fixture: Record<string, FixtureRow> = {};

describe('contract reads on the wire, on three libraries', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    // viem is the reference a fixture is generated from; each test then holds
    // the other two libraries to the same row.
    const reference: Record<string, FixtureRow> = {};
    for (const scenario of SCENARIOS) {
      const byLibrary: Record<LibraryName, FixtureRow> = {
        viem: await runOn({ scenario, library: 'viem' }),
        'ethers v5': await runOn({ scenario, library: 'ethers v5' }),
        'ethers v6': await runOn({ scenario, library: 'ethers v6' })
      };
      actual[scenario.name] = byLibrary;
      reference[scenario.name] = byLibrary.viem;
    }
    fixture = loadFixture({ name: FIXTURE, actual: reference });
  });

  it('has a fixture row for every scenario and a scenario for every fixture row', () => {
    expect(Object.keys(fixture).sort()).deep.equals(SCENARIOS.map((s) => s.name).sort());
  });

  it('covers every contract read the SDK makes', () => {
    const missing = PAIRS.filter(
      ([abi, method]) =>
        !SCENARIOS.some(
          (s) =>
            s.abis.includes(abi) &&
            fixture[s.name]?.calls.some((call) => call.functionName === method) === true
        )
    ).map(([, method]) => method);
    expect(missing).deep.equals([]);
  });

  describe.each(SCENARIOS.map((s) => s.name))('%s', (name) => {
    it.each(LIBRARIES)(
      `${name} on %s sends the recorded bytes and returns the recorded value`,
      (library) => {
        const row = actual[name]?.[library];
        expect(row, `${name} on ${library} (regenerate with ${WRITE_FIXTURES_FLAG}=1)`).deep.equals(
          fixture[name]
        );
      }
    );
  });
});
