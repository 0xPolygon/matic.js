import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Hex } from '../../src/adapter.ts';
import type { ContractCallerOptions } from '../../src/internal/contract-caller.ts';
import type {
  CoveredPair,
  PosWorld,
  PosWorldOptions,
  RequestRow
} from './contract-call-harness.ts';

import { noopLogger } from '../../src/logger.ts';
import { RootChain } from '../../src/pos/root_chain.ts';
import {
  ADDRESSES,
  failedDelivery,
  HASH_RECORD,
  loadFixture,
  OTHER,
  PAYLOAD_RECORD,
  posWorld,
  READ,
  receiptOf,
  RecordingAdapter,
  RequestLog,
  rowsOf,
  stubProofApi,
  uncoveredPairs,
  USER,
  WRITE,
  WRITE_FIXTURES_FLAG
} from './contract-call-harness.ts';

/**
 * Request snapshots for the PoS bridge: what each public method that reaches a
 * contract asks the adapter for. Each scenario runs against a recording
 * adapter with fixed inputs and its recorded requests are compared with
 * `tests/fixtures/contract-calls/requests-pos.json`. The comparison covers the
 * contract, address, function, block tag, every write field, and each
 * argument's value and JavaScript type, because the type (a `bigint`, a hex
 * `string`, a `number`) is part of what an adapter receives.
 *
 * Regenerate only on a base these suites are meant to describe; see the
 * fixtures README.
 */

const FIXTURE = 'requests-pos.json';

const PARENT_ERC20: Hex = '0x00000000000000000000000000000000000000c1';
const PARENT_ERC721: Hex = '0x00000000000000000000000000000000000000c2';
const PARENT_ERC1155: Hex = '0x00000000000000000000000000000000000000c3';
const CHILD_ERC20: Hex = '0x00000000000000000000000000000000000000d1';
const CHILD_ERC721: Hex = '0x00000000000000000000000000000000000000d2';
const CHILD_ERC1155: Hex = '0x00000000000000000000000000000000000000d3';

/** Every per-call override the callers accept, so each write field is recorded once. */
const FULL_OPTIONS: ContractCallerOptions = {
  from: USER,
  value: 11n,
  gasLimit: 500_000n,
  maxFeePerGas: 30n,
  maxPriorityFeePerGas: 2n,
  nonce: 9,
  chainId: 1
};

const SWAP_CALL_DATA = '0xabcdef';
const READ_OPTIONS: ContractCallerOptions = { blockTag: 'finalized' };

// --- scenarios ----------------------------------------------------------------

interface Scenario {
  name: string;
  options?: PosWorldOptions;
  run: (w: PosWorld) => Promise<unknown>;
}

const erc20 = (w: PosWorld, which: 'parent' | 'child' = 'parent') =>
  which === 'parent' ? w.pos.parent.erc20(PARENT_ERC20) : w.pos.child.erc20(CHILD_ERC20);
const erc721 = (w: PosWorld, which: 'parent' | 'child' = 'parent') =>
  which === 'parent' ? w.pos.parent.erc721(PARENT_ERC721) : w.pos.child.erc721(CHILD_ERC721);
const erc1155 = (w: PosWorld, which: 'parent' | 'child' = 'parent') =>
  which === 'parent' ? w.pos.parent.erc1155(PARENT_ERC1155) : w.pos.child.erc1155(CHILD_ERC1155);

const burn = (file: string): { hash: string; signature: string; options: PosWorldOptions } => {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'fixtures', 'exits', file), 'utf8')
  ) as { burnTxHash: string; eventSignature: string; expectedPayloadHex: string };
  return {
    hash: fixture.burnTxHash,
    signature: fixture.eventSignature,
    options: { cassette: file, parent: { answers: { processedExits: false } } }
  };
};

const ERC20_BURN = burn('erc20-burn-1.json');
const ERC721_BURN = burn('erc721-burn-1.json');
const ERC1155_BURN = burn('erc1155-burn-1.json');
const PROOF_API = 'https://proof.invalid';

const SCENARIOS: Scenario[] = [
  // ERC-20, parent chain
  { name: 'erc20.getBalance', run: (w) => erc20(w).getBalance(USER) },
  { name: 'erc20.getBalance (pinned block)', run: (w) => erc20(w).getBalance(USER, READ_OPTIONS) },
  { name: 'erc20.getAllowance (default spender)', run: (w) => erc20(w).getAllowance(USER) },
  {
    name: 'erc20.getAllowance (explicit spender)',
    run: (w) => erc20(w).getAllowance(USER, { spenderAddress: OTHER, blockTag: 12n })
  },
  { name: 'erc20.approve', run: (w) => erc20(w).approve(5n) },
  { name: 'erc20.approve (every option)', run: (w) => erc20(w).approve(5n, FULL_OPTIONS) },
  { name: 'erc20.prepareApprove', run: (w) => erc20(w).prepareApprove(5n) },
  { name: 'erc20.approveMax', run: (w) => erc20(w).approveMax() },
  { name: 'erc20.prepareApproveMax', run: (w) => erc20(w).prepareApproveMax() },
  { name: 'erc20.deposit', run: (w) => erc20(w).deposit(5n, USER) },
  { name: 'erc20.deposit (every option)', run: (w) => erc20(w).deposit(5n, USER, FULL_OPTIONS) },
  { name: 'erc20.prepareDeposit', run: (w) => erc20(w).prepareDeposit(5n, USER) },
  {
    name: 'erc20.depositWithGas',
    run: (w) => erc20(w).depositWithGas(5n, USER, 3n, SWAP_CALL_DATA)
  },
  {
    name: 'erc20.prepareDepositWithGas',
    run: (w) => erc20(w).prepareDepositWithGas(5n, USER, 3n, SWAP_CALL_DATA)
  },
  { name: 'erc20.transfer (parent)', run: (w) => erc20(w).transfer(5n, OTHER) },
  { name: 'erc20.prepareTransfer (parent)', run: (w) => erc20(w).prepareTransfer(5n, OTHER) },
  // ERC-20, child chain
  { name: 'erc20.child.getBalance', run: (w) => erc20(w, 'child').getBalance(USER) },
  {
    name: 'erc20.child.approve',
    run: (w) => erc20(w, 'child').approve(5n, { spenderAddress: OTHER })
  },
  { name: 'erc20.child.startWithdraw', run: (w) => erc20(w, 'child').startWithdraw(5n) },
  {
    name: 'erc20.child.startWithdraw (every option)',
    run: (w) => erc20(w, 'child').startWithdraw(5n, { ...FULL_OPTIONS, value: undefined })
  },
  {
    name: 'erc20.child.prepareStartWithdraw',
    run: (w) => erc20(w, 'child').prepareStartWithdraw(5n)
  },
  { name: 'erc20.child.transfer', run: (w) => erc20(w, 'child').transfer(5n, OTHER) },
  {
    name: 'erc20.child.prepareTransfer',
    run: (w) => erc20(w, 'child').prepareTransfer(5n, OTHER)
  },
  // ERC-20 exits, replayed from a recorded burn
  {
    name: 'erc20.completeWithdraw',
    options: ERC20_BURN.options,
    run: (w) => erc20(w).completeWithdraw(ERC20_BURN.hash)
  },
  {
    name: 'erc20.prepareCompleteWithdraw',
    options: ERC20_BURN.options,
    run: (w) => erc20(w).prepareCompleteWithdraw(ERC20_BURN.hash)
  },
  {
    name: 'erc20.completeWithdrawFast',
    options: { ...ERC20_BURN.options, proofGenerationApiUrl: PROOF_API },
    run: (w) => erc20(w).completeWithdrawFast(ERC20_BURN.hash)
  },
  {
    name: 'erc20.prepareCompleteWithdrawFast',
    options: { ...ERC20_BURN.options, proofGenerationApiUrl: PROOF_API },
    run: (w) => erc20(w).prepareCompleteWithdrawFast(ERC20_BURN.hash)
  },
  {
    name: 'erc20.getWithdrawExitStatus',
    options: ERC20_BURN.options,
    run: (w) => erc20(w).getWithdrawExitStatus(ERC20_BURN.hash)
  },
  // ERC-721
  { name: 'erc721.getTokensCount', run: (w) => erc721(w).getTokensCount(USER) },
  {
    name: 'erc721.getTokenIdAtIndexForUser',
    run: (w) => erc721(w).getTokenIdAtIndexForUser(3, USER)
  },
  {
    name: 'erc721.getAllTokens',
    options: { parent: { answers: { balanceOf: 2n } } },
    run: (w) => erc721(w).getAllTokens(USER)
  },
  { name: 'erc721.isApproved', run: (w) => erc721(w).isApproved(8n) },
  { name: 'erc721.isApprovedAll', run: (w) => erc721(w).isApprovedAll(USER) },
  { name: 'erc721.approve', run: (w) => erc721(w).approve(8n) },
  { name: 'erc721.prepareApprove', run: (w) => erc721(w).prepareApprove(8n) },
  { name: 'erc721.approveAll', run: (w) => erc721(w).approveAll() },
  { name: 'erc721.prepareApproveAll', run: (w) => erc721(w).prepareApproveAll() },
  { name: 'erc721.deposit', run: (w) => erc721(w).deposit(8n, USER) },
  { name: 'erc721.prepareDeposit', run: (w) => erc721(w).prepareDeposit(8n, USER) },
  { name: 'erc721.depositMany', run: (w) => erc721(w).depositMany([8n, 9n], USER) },
  { name: 'erc721.prepareDepositMany', run: (w) => erc721(w).prepareDepositMany([8n, 9n], USER) },
  { name: 'erc721.child.startWithdraw', run: (w) => erc721(w, 'child').startWithdraw(8n) },
  {
    name: 'erc721.child.prepareStartWithdraw',
    run: (w) => erc721(w, 'child').prepareStartWithdraw(8n)
  },
  {
    name: 'erc721.child.startWithdrawWithMetaData',
    run: (w) => erc721(w, 'child').startWithdrawWithMetaData(8n)
  },
  {
    name: 'erc721.child.prepareStartWithdrawWithMetaData',
    run: (w) => erc721(w, 'child').prepareStartWithdrawWithMetaData(8n)
  },
  {
    name: 'erc721.child.startWithdrawMany',
    run: (w) => erc721(w, 'child').startWithdrawMany([8n, 9n])
  },
  {
    name: 'erc721.child.prepareStartWithdrawMany',
    run: (w) => erc721(w, 'child').prepareStartWithdrawMany([8n, 9n])
  },
  { name: 'erc721.transfer', run: (w) => erc721(w).transfer(8n, USER, OTHER) },
  { name: 'erc721.prepareTransfer', run: (w) => erc721(w).prepareTransfer(8n, USER, OTHER) },
  {
    name: 'erc721.completeWithdraw',
    options: ERC721_BURN.options,
    run: (w) => erc721(w).completeWithdraw(ERC721_BURN.hash)
  },
  {
    name: 'erc721.prepareCompleteWithdraw',
    options: ERC721_BURN.options,
    run: (w) => erc721(w).prepareCompleteWithdraw(ERC721_BURN.hash)
  },
  {
    name: 'erc721.completeWithdrawOnIndex',
    options: ERC721_BURN.options,
    run: (w) => erc721(w).completeWithdrawOnIndex(ERC721_BURN.hash, 0)
  },
  {
    name: 'erc721.prepareCompleteWithdrawOnIndex',
    options: ERC721_BURN.options,
    run: (w) => erc721(w).prepareCompleteWithdrawOnIndex(ERC721_BURN.hash, 0)
  },
  {
    name: 'erc721.completeWithdrawFast',
    options: { ...ERC721_BURN.options, proofGenerationApiUrl: PROOF_API },
    run: (w) => erc721(w).completeWithdrawFast(ERC721_BURN.hash)
  },
  {
    name: 'erc721.prepareCompleteWithdrawFast',
    options: { ...ERC721_BURN.options, proofGenerationApiUrl: PROOF_API },
    run: (w) => erc721(w).prepareCompleteWithdrawFast(ERC721_BURN.hash)
  },
  {
    name: 'erc721.getWithdrawExitStatusOnIndex',
    options: ERC721_BURN.options,
    run: (w) => erc721(w).getWithdrawExitStatusOnIndex(ERC721_BURN.hash, 0)
  },
  {
    name: 'erc721.getWithdrawExitStatusOnIndices',
    options: ERC721_BURN.options,
    run: (w) => erc721(w).getWithdrawExitStatusOnIndices(ERC721_BURN.hash, [0])
  },
  {
    name: 'erc721.getWithdrawExitStatus',
    options: ERC721_BURN.options,
    run: (w) => erc721(w).getWithdrawExitStatus(ERC721_BURN.hash)
  },
  // ERC-1155
  { name: 'erc1155.getBalance', run: (w) => erc1155(w).getBalance(USER, 4n) },
  { name: 'erc1155.isApprovedAll', run: (w) => erc1155(w).isApprovedAll(USER) },
  { name: 'erc1155.approveAll', run: (w) => erc1155(w).approveAll() },
  { name: 'erc1155.prepareApproveAll', run: (w) => erc1155(w).prepareApproveAll() },
  { name: 'erc1155.approveAllForMintable', run: (w) => erc1155(w).approveAllForMintable() },
  {
    name: 'erc1155.prepareApproveAllForMintable',
    run: (w) => erc1155(w).prepareApproveAllForMintable()
  },
  {
    name: 'erc1155.deposit',
    run: (w) => erc1155(w).deposit({ tokenId: 4n, amount: 6n, userAddress: USER })
  },
  {
    name: 'erc1155.prepareDeposit',
    run: (w) => erc1155(w).prepareDeposit({ tokenId: 4n, amount: 6n, userAddress: USER })
  },
  {
    name: 'erc1155.depositMany',
    run: (w) => erc1155(w).depositMany({ tokenIds: [4n, 5n], amounts: [6n, 7n], userAddress: USER })
  },
  {
    name: 'erc1155.prepareDepositMany',
    run: (w) =>
      erc1155(w).prepareDepositMany({ tokenIds: [4n, 5n], amounts: [6n, 7n], userAddress: USER })
  },
  { name: 'erc1155.child.startWithdraw', run: (w) => erc1155(w, 'child').startWithdraw(4n, 6n) },
  {
    name: 'erc1155.child.prepareStartWithdraw',
    run: (w) => erc1155(w, 'child').prepareStartWithdraw(4n, 6n)
  },
  {
    name: 'erc1155.child.startWithdrawMany',
    run: (w) => erc1155(w, 'child').startWithdrawMany([4n, 5n], [6n, 7n])
  },
  {
    name: 'erc1155.child.prepareStartWithdrawMany',
    run: (w) => erc1155(w, 'child').prepareStartWithdrawMany([4n, 5n], [6n, 7n])
  },
  {
    name: 'erc1155.transfer',
    run: (w) => erc1155(w).transfer({ tokenId: 4n, amount: 6n, from: USER, to: OTHER })
  },
  {
    name: 'erc1155.transfer (with data)',
    run: (w) =>
      erc1155(w).transfer({ tokenId: 4n, amount: 6n, from: USER, to: OTHER, data: '0x1234' })
  },
  {
    name: 'erc1155.prepareTransfer',
    run: (w) => erc1155(w).prepareTransfer({ tokenId: 4n, amount: 6n, from: USER, to: OTHER })
  },
  {
    name: 'erc1155.completeWithdraw',
    options: ERC1155_BURN.options,
    run: (w) => erc1155(w).completeWithdraw(ERC1155_BURN.hash)
  },
  {
    name: 'erc1155.prepareCompleteWithdraw',
    options: ERC1155_BURN.options,
    run: (w) => erc1155(w).prepareCompleteWithdraw(ERC1155_BURN.hash)
  },
  {
    name: 'erc1155.completeWithdrawFast',
    options: { ...ERC1155_BURN.options, proofGenerationApiUrl: PROOF_API },
    run: (w) => erc1155(w).completeWithdrawFast(ERC1155_BURN.hash)
  },
  {
    name: 'erc1155.prepareCompleteWithdrawFast',
    options: { ...ERC1155_BURN.options, proofGenerationApiUrl: PROOF_API },
    run: (w) => erc1155(w).prepareCompleteWithdrawFast(ERC1155_BURN.hash)
  },
  {
    name: 'erc1155.getWithdrawExitStatus',
    options: ERC1155_BURN.options,
    run: (w) => erc1155(w).getWithdrawExitStatus(ERC1155_BURN.hash)
  },
  // The client's own methods
  { name: 'pos.getPredicateAddress', run: (w) => w.pos.getPredicateAddress(PARENT_ERC20) },
  { name: 'pos.depositEther', run: (w) => w.pos.depositEther(9n, USER) },
  {
    name: 'pos.depositEther (every option)',
    run: (w) => w.pos.depositEther(9n, USER, FULL_OPTIONS)
  },
  { name: 'pos.prepareDepositEther', run: (w) => w.pos.prepareDepositEther(9n, USER) },
  {
    name: 'pos.depositEtherWithGas',
    run: (w) => w.pos.depositEtherWithGas(9n, USER, 3n, SWAP_CALL_DATA)
  },
  {
    name: 'pos.prepareDepositEtherWithGas',
    run: (w) => w.pos.prepareDepositEtherWithGas(9n, USER, 3n, SWAP_CALL_DATA)
  },
  {
    name: 'pos.getWithdrawStatus',
    options: ERC20_BURN.options,
    run: (w) => w.pos.getWithdrawStatus(ERC20_BURN.hash, ERC20_BURN.signature)
  },
  {
    name: 'pos.getWithdrawStatusOnIndex',
    options: ERC20_BURN.options,
    run: (w) => w.pos.getWithdrawStatusOnIndex(ERC20_BURN.hash, ERC20_BURN.signature, 0)
  },
  {
    name: 'pos.getCheckpointStatus',
    options: ERC20_BURN.options,
    run: (w) => w.pos.getCheckpointStatus(ERC20_BURN.hash)
  },
  {
    name: 'pos.buildExitPayload',
    options: ERC20_BURN.options,
    run: (w) => w.pos.buildExitPayload(ERC20_BURN.hash, ERC20_BURN.signature)
  },
  {
    name: 'pos.buildExitPayloadOnIndex',
    options: ERC20_BURN.options,
    run: (w) => w.pos.buildExitPayloadOnIndex(ERC20_BURN.hash, ERC20_BURN.signature, 0)
  },
  {
    name: 'pos.buildExitPayloads',
    options: ERC20_BURN.options,
    run: (w) => w.pos.buildExitPayloads(ERC20_BURN.hash, ERC20_BURN.signature)
  },
  {
    name: 'pos.getDepositStatus (delivered)',
    options: {
      parent: { receipts: { [HASH_RECORD.transactionHash]: receiptOf(HASH_RECORD) } },
      child: { answers: { lastStateId: 99_999_999n } }
    },
    run: (w) => w.pos.getDepositStatus(HASH_RECORD.transactionHash)
  },
  {
    name: 'pos.getDepositStatus (failed, hash record)',
    options: {
      parent: { receipts: { [HASH_RECORD.transactionHash]: receiptOf(HASH_RECORD) } },
      child: failedDelivery(HASH_RECORD)
    },
    run: (w) => w.pos.getDepositStatus(HASH_RECORD.transactionHash)
  },
  {
    name: 'pos.getDepositStatus (failed, payload record)',
    options: {
      parent: { receipts: { [PAYLOAD_RECORD.transactionHash]: receiptOf(PAYLOAD_RECORD) } },
      child: failedDelivery(PAYLOAD_RECORD)
    },
    run: (w) => w.pos.getDepositStatus(PAYLOAD_RECORD.transactionHash)
  },
  {
    name: 'pos.replayDeposit (hash record)',
    options: {
      parent: { receipts: { [HASH_RECORD.transactionHash]: receiptOf(HASH_RECORD) } },
      child: failedDelivery(HASH_RECORD)
    },
    run: (w) => w.pos.replayDeposit(HASH_RECORD.transactionHash)
  },
  {
    name: 'pos.prepareReplayDeposit (hash record)',
    options: {
      parent: { receipts: { [HASH_RECORD.transactionHash]: receiptOf(HASH_RECORD) } },
      child: failedDelivery(HASH_RECORD)
    },
    run: (w) => w.pos.prepareReplayDeposit(HASH_RECORD.transactionHash)
  },
  {
    name: 'pos.replayDeposit (payload record)',
    options: {
      parent: { receipts: { [PAYLOAD_RECORD.transactionHash]: receiptOf(PAYLOAD_RECORD) } },
      child: failedDelivery(PAYLOAD_RECORD)
    },
    run: (w) => w.pos.replayDeposit(PAYLOAD_RECORD.transactionHash)
  },
  {
    name: 'pos.prepareReplayDeposit (payload record)',
    options: {
      parent: { receipts: { [PAYLOAD_RECORD.transactionHash]: receiptOf(PAYLOAD_RECORD) } },
      child: failedDelivery(PAYLOAD_RECORD)
    },
    run: (w) => w.pos.prepareReplayDeposit(PAYLOAD_RECORD.transactionHash)
  },
  // The handles the client builds
  {
    name: 'rootChainManager.deposit',
    run: (w) => w.pos.rootChainManager.deposit(USER, PARENT_ERC20, '0x01')
  },
  {
    name: 'rootChainManager.prepareDeposit',
    run: (w) => w.pos.rootChainManager.prepareDeposit(USER, PARENT_ERC20, '0x01')
  },
  { name: 'rootChainManager.exit', run: (w) => w.pos.rootChainManager.exit('0x0102') },
  {
    name: 'rootChainManager.prepareExit',
    run: (w) => w.pos.rootChainManager.prepareExit('0x0102')
  },
  {
    name: 'rootChainManager.isExitProcessed',
    run: (w) => w.pos.rootChainManager.isExitProcessed(`0x${'cd'.repeat(32)}`)
  }
];

const ROOT_CHAIN_SCENARIOS: Array<{
  name: string;
  defaultBlock?: 'safe' | 'finalized' | 'latest';
}> = [
  { name: 'rootChain.getLastChildBlock' },
  { name: 'rootChain.getLastChildBlock (pinned block)', defaultBlock: 'finalized' },
  { name: 'rootChain.findRootBlockFromChild' }
];

/** Every contract method the PoS client calls, and how. */
const PAIRS: readonly CoveredPair[] = [
  ['ChildERC20ABI', 'balanceOf', READ],
  ['ChildERC20ABI', 'allowance', READ],
  ['ChildERC20ABI', 'approve', WRITE],
  ['ChildERC20ABI', 'withdraw', WRITE],
  ['ChildERC20ABI', 'transfer', WRITE],
  ['ChildERC721ABI', 'balanceOf', READ],
  ['ChildERC721ABI', 'tokenOfOwnerByIndex', READ],
  ['ChildERC721ABI', 'getApproved', READ],
  ['ChildERC721ABI', 'isApprovedForAll', READ],
  ['ChildERC721ABI', 'approve', WRITE],
  ['ChildERC721ABI', 'setApprovalForAll', WRITE],
  ['ChildERC721ABI', 'withdraw', WRITE],
  ['ChildERC721ABI', 'withdrawWithMetadata', WRITE],
  ['ChildERC721ABI', 'withdrawBatch', WRITE],
  ['ChildERC721ABI', 'transferFrom', WRITE],
  ['ChildERC1155ABI', 'balanceOf', READ],
  ['ChildERC1155ABI', 'isApprovedForAll', READ],
  ['ChildERC1155ABI', 'setApprovalForAll', WRITE],
  ['ChildERC1155ABI', 'withdrawSingle', WRITE],
  ['ChildERC1155ABI', 'withdrawBatch', WRITE],
  ['ChildERC1155ABI', 'safeTransferFrom', WRITE],
  ['GasSwapperABI', 'swapAndBridge', WRITE],
  ['RootChainABI', 'getLastChildBlock', READ],
  ['RootChainABI', 'currentHeaderBlock', READ],
  ['RootChainABI', 'headerBlocks', READ],
  ['RootChainManagerABI', 'depositFor', WRITE],
  ['RootChainManagerABI', 'exit', WRITE],
  ['RootChainManagerABI', 'depositEtherFor', WRITE],
  ['RootChainManagerABI', 'processedExits', READ],
  ['RootChainManagerABI', 'tokenToType', READ],
  ['RootChainManagerABI', 'typeToPredicate', READ],
  ['StateReceiverABI+FailedStateSyncHashesABI+ReplayFailedStateSyncABI', 'lastStateId', READ],
  [
    'StateReceiverABI+FailedStateSyncHashesABI+ReplayFailedStateSyncABI',
    'failedStateSyncHashes',
    READ
  ],
  ['StateReceiverABI+FailedStateSyncHashesABI+ReplayFailedStateSyncABI', 'failedStateSyncs', READ],
  [
    'StateReceiverABI+FailedStateSyncHashesABI+ReplayFailedStateSyncABI',
    'replayFailedStateSync',
    WRITE
  ],
  [
    'StateReceiverABI+FailedStateSyncHashesABI+ReplayFailedStateSyncABI',
    'replayFailedStateSyncWithData',
    WRITE
  ]
];

let actual: Record<string, RequestRow[]> = {};
let fixture: Record<string, RequestRow[]> = {};

describe('PoS contract requests', { timeout: 120_000 }, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeAll(async () => {
    const collected: Record<string, RequestRow[]> = {};
    for (const scenario of SCENARIOS) {
      if (scenario.name.includes('Fast')) stubProofApi();
      try {
        const w = await posWorld(scenario.options);
        await scenario.run(w);
        collected[scenario.name] = rowsOf(w.log, {
          collapseReads: scenario.options?.cassette !== undefined
        });
      } finally {
        vi.unstubAllGlobals();
      }
    }
    for (const scenario of ROOT_CHAIN_SCENARIOS) {
      const log = new RequestLog();
      const adapter = new RecordingAdapter({ side: 'parent', log, chainId: 1 });
      const chain = new RootChain({
        adapter,
        chainId: 1,
        getAddress: () => Promise.resolve(ADDRESSES.RootChain),
        logger: noopLogger,
        ...(scenario.defaultBlock === undefined ? {} : { defaultBlock: scenario.defaultBlock })
      });
      if (scenario.name === 'rootChain.findRootBlockFromChild') {
        await chain.findRootBlockFromChild(500_000n);
      } else {
        await chain.getLastChildBlock();
      }
      collected[scenario.name] = rowsOf(log);
    }
    actual = collected;
    fixture = loadFixture({ name: FIXTURE, actual });
  });

  it('has a scenario for every fixture entry and a fixture entry for every scenario', () => {
    expect(Object.keys(actual).sort()).deep.equals(Object.keys(fixture).sort());
  });

  it('records every scenario with at least one request', () => {
    for (const [name, rows] of Object.entries(actual)) {
      expect(rows.length, name).greaterThan(0);
    }
  });

  it('covers every contract method the PoS client calls', () => {
    expect(uncoveredPairs({ pairs: PAIRS, fixture })).deep.equals([]);
  });

  it.each([...SCENARIOS.map((s) => s.name), ...ROOT_CHAIN_SCENARIOS.map((s) => s.name)])(
    '%s sends the recorded requests',
    (name) => {
      expect(
        actual[name],
        `${name} (regenerate with ${WRITE_FIXTURES_FLAG}=1 on a clean base)`
      ).deep.equals(fixture[name]);
    }
  );
});
