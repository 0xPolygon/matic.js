import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Hex } from '../../src/adapter.ts';
import type { ContractCallerOptions } from '../../src/internal/contract-caller.ts';
import type {
  CoveredPair,
  PlasmaWorld,
  PlasmaWorldOptions,
  RequestRow
} from './contract-call-harness.ts';

import {
  loadFixture,
  OTHER,
  PLASMA_ADDRESSES,
  PLASMA_STATUS,
  plasmaWorld,
  READ,
  rowsOf,
  stubProofApi,
  uncoveredPairs,
  USER,
  WRITE,
  WRITE_FIXTURES_FLAG
} from './contract-call-harness.ts';

/**
 * Request snapshots for the Plasma bridge: what each public method that
 * reaches a contract asks the adapter for, compared with
 * `tests/fixtures/contract-calls/requests-plasma.json`. See the fixtures
 * README for how the file is generated and why.
 */

const FIXTURE = 'requests-plasma.json';

const PARENT_TOKEN: Hex = '0x00000000000000000000000000000000000000c1';
const CHILD_TOKEN: Hex = '0x00000000000000000000000000000000000000d1';
const NATIVE_TOKEN: Hex = '0x0000000000000000000000000000000000001010';

const OPTIONS: ContractCallerOptions = {
  from: USER,
  gasLimit: 900_000n,
  maxFeePerGas: 30n,
  maxPriorityFeePerGas: 2n,
  nonce: 4,
  chainId: 1
};

const burnOf = (file: string): { hash: string } => {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'fixtures', 'exits', file), 'utf8')
  ) as { burnTxHash: string };
  return { hash: fixture.burnTxHash };
};

const BURN_FILE = 'plasma-erc20-burn-1.json';
const BURN = burnOf(BURN_FILE);
const PROOF_API = 'https://proof.invalid';

interface Scenario {
  name: string;
  options?: PlasmaWorldOptions;
  run: (w: PlasmaWorld) => Promise<unknown>;
}

const parentToken = (w: PlasmaWorld, token: Hex = PARENT_TOKEN) => w.plasma.parent.erc20(token);
const childToken = (w: PlasmaWorld, token: Hex = CHILD_TOKEN) => w.plasma.child.erc20(token);

const SCENARIOS: Scenario[] = [
  { name: 'erc20.getBalance (parent)', run: (w) => parentToken(w).getBalance(USER) },
  {
    name: 'erc20.getBalance (parent, pinned block)',
    run: (w) => parentToken(w).getBalance(USER, { blockTag: 'safe' })
  },
  { name: 'erc20.getBalance (child)', run: (w) => childToken(w).getBalance(USER) },
  { name: 'erc20.getAllowance', run: (w) => parentToken(w).getAllowance(USER) },
  { name: 'erc20.approve', run: (w) => parentToken(w).approve(5n) },
  { name: 'erc20.approve (every option)', run: (w) => parentToken(w).approve(5n, OPTIONS) },
  { name: 'erc20.prepareApprove', run: (w) => parentToken(w).prepareApprove(5n) },
  { name: 'erc20.approveMax', run: (w) => parentToken(w).approveMax() },
  { name: 'erc20.prepareApproveMax', run: (w) => parentToken(w).prepareApproveMax() },
  { name: 'erc20.deposit', run: (w) => parentToken(w).deposit(5n, USER) },
  { name: 'erc20.deposit (every option)', run: (w) => parentToken(w).deposit(5n, USER, OPTIONS) },
  { name: 'erc20.prepareDeposit', run: (w) => parentToken(w).prepareDeposit(5n, USER) },
  { name: 'erc20.startWithdraw (child token)', run: (w) => childToken(w).startWithdraw(5n) },
  {
    name: 'erc20.prepareStartWithdraw (child token)',
    run: (w) => childToken(w).prepareStartWithdraw(5n)
  },
  {
    name: 'erc20.startWithdraw (native token)',
    run: (w) => childToken(w, NATIVE_TOKEN).startWithdraw(5n)
  },
  {
    name: 'erc20.prepareStartWithdraw (native token)',
    run: (w) => childToken(w, NATIVE_TOKEN).prepareStartWithdraw(5n)
  },
  {
    name: 'erc20.confirmWithdraw',
    options: { cassette: BURN_FILE },
    run: (w) => parentToken(w, PLASMA_ADDRESSES.MaticToken).confirmWithdraw(BURN.hash)
  },
  {
    name: 'erc20.prepareConfirmWithdraw',
    options: { cassette: BURN_FILE },
    run: (w) => parentToken(w, PLASMA_ADDRESSES.MaticToken).prepareConfirmWithdraw(BURN.hash)
  },
  {
    name: 'erc20.confirmWithdrawFast',
    options: { cassette: BURN_FILE, proofGenerationApiUrl: PROOF_API },
    run: (w) => parentToken(w, PLASMA_ADDRESSES.MaticToken).confirmWithdrawFast(BURN.hash)
  },
  {
    name: 'erc20.prepareConfirmWithdrawFast',
    options: { cassette: BURN_FILE, proofGenerationApiUrl: PROOF_API },
    run: (w) => parentToken(w, PLASMA_ADDRESSES.MaticToken).prepareConfirmWithdrawFast(BURN.hash)
  },
  { name: 'erc20.completeWithdraw', run: (w) => parentToken(w).completeWithdraw() },
  {
    name: 'erc20.completeWithdraw (pol handle processes the matic queue)',
    run: (w) => parentToken(w, PLASMA_ADDRESSES.PolToken).completeWithdraw()
  },
  {
    name: 'erc20.completeWithdraw (explicit gas limit)',
    run: (w) => parentToken(w).completeWithdraw({ gasLimit: 900_000n })
  },
  { name: 'erc20.prepareCompleteWithdraw', run: (w) => parentToken(w).prepareCompleteWithdraw() },
  {
    name: 'erc20.prepareCompleteWithdraw (explicit gas limit)',
    run: (w) => parentToken(w).prepareCompleteWithdraw({ gasLimit: 900_000n })
  },
  {
    name: 'erc20.getCompleteWithdrawGasLimit',
    run: (w) => parentToken(w).getCompleteWithdrawGasLimit()
  },
  {
    name: 'erc20.getWithdrawStatus',
    options: { status: true },
    run: (w) =>
      parentToken(w, PLASMA_ADDRESSES.PolToken).getWithdrawStatus({
        burnTxHash: PLASMA_STATUS.burn,
        confirmTxHash: PLASMA_STATUS.confirm
      })
  },
  {
    name: 'client.getWithdrawStatus',
    options: { status: true },
    run: (w) =>
      w.plasma.getWithdrawStatus({
        burnTxHash: PLASMA_STATUS.burn,
        confirmTxHash: PLASMA_STATUS.confirm
      })
  },
  {
    name: 'client.processExits (one token)',
    run: (w) => w.plasma.processExits({ tokens: [PARENT_TOKEN] })
  },
  {
    name: 'client.processExits (several tokens)',
    run: (w) => w.plasma.processExits({ tokens: [PARENT_TOKEN, OTHER] }, OPTIONS)
  },
  {
    name: 'client.prepareProcessExits (one token)',
    run: (w) => w.plasma.prepareProcessExits({ tokens: [PARENT_TOKEN] })
  },
  {
    name: 'client.prepareProcessExits (several tokens)',
    run: (w) => w.plasma.prepareProcessExits({ tokens: [PARENT_TOKEN, OTHER] })
  },
  {
    name: 'client.getProcessExitsGasLimit',
    run: (w) => w.plasma.getProcessExitsGasLimit({ tokens: [PARENT_TOKEN] })
  },
  {
    name: 'client.getProcessExitsGasLimit (several tokens)',
    run: (w) => w.plasma.getProcessExitsGasLimit({ tokens: [PARENT_TOKEN, OTHER] })
  }
];

/** Every contract method the Plasma client calls, and how. */
const PAIRS: readonly CoveredPair[] = [
  ['PlasmaChildERC20ABI', 'balanceOf', READ],
  ['PlasmaChildERC20ABI', 'allowance', READ],
  ['PlasmaChildERC20ABI', 'approve', WRITE],
  ['PlasmaChildERC20ABI', 'withdraw', WRITE],
  ['PlasmaMRC20ABI', 'withdraw', WRITE],
  ['PlasmaDepositManagerABI', 'depositERC20ForUser', WRITE],
  ['PlasmaERC20PredicateABI', 'startExitWithBurntTokens', WRITE],
  ['PlasmaWithdrawManagerABI', 'exitsQueues', READ],
  ['PlasmaWithdrawManagerABI', 'ON_FINALIZE_GAS_LIMIT', READ],
  ['PlasmaWithdrawManagerABI', 'processExits', WRITE],
  ['PlasmaWithdrawManagerABI', 'processExitsBatch', WRITE],
  ['PlasmaPriorityQueueABI', 'currentSize', READ],
  ['PlasmaExitNFTABI', 'exists', READ],
  ['RootChainABI', 'getLastChildBlock', READ],
  ['RootChainABI', 'currentHeaderBlock', READ],
  ['RootChainABI', 'headerBlocks', READ]
];

let actual: Record<string, RequestRow[]> = {};
let fixture: Record<string, RequestRow[]> = {};

describe('Plasma contract requests', { timeout: 120_000 }, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeAll(async () => {
    const collected: Record<string, RequestRow[]> = {};
    for (const scenario of SCENARIOS) {
      if (scenario.name.includes('Fast')) stubProofApi();
      try {
        const w = await plasmaWorld(scenario.options);
        await scenario.run(w);
        collected[scenario.name] = rowsOf(w.log, {
          collapseReads: scenario.options?.cassette !== undefined
        });
      } finally {
        vi.unstubAllGlobals();
      }
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

  it('covers every contract method the Plasma client calls', () => {
    expect(uncoveredPairs({ pairs: PAIRS, fixture })).deep.equals([]);
  });

  it.each(SCENARIOS.map((s) => s.name))('%s sends the recorded requests', (name) => {
    expect(
      actual[name],
      `${name} (regenerate with ${WRITE_FIXTURES_FLAG}=1 on a clean base)`
    ).deep.equals(fixture[name]);
  });
});
