/**
 * Unit tests for the vendored contract ABI surface.
 *
 * The ABIs ship `as const` so each one preserves its literal types in
 * downstream `.d.ts` files — viem-typed contract calls infer method
 * names, argument shapes, and return types from the literal. The tests
 * here check both that every required ABI is exported (value level)
 * and that the inferred type carries the literal shape (compile-time
 * level, asserted via a `satisfies` clause that fails to compile if the
 * type is widened to `unknown[]`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getAbiItem, toEventSelector } from 'viem';
import { describe, expect, it } from 'vitest';

import * as abi from '../../src/abi/index.js';
import * as plasmaAbi from '../../src/abi/plasma/index.js';
import { PlasmaEventSignature } from '../../src/plasma/events.ts';

const REQUIRED_ABIS = [
  'RootChainManagerABI',
  'ChildERC20ABI',
  'ChildERC721ABI',
  'ChildERC1155ABI',
  'ERC20PredicateABI',
  'ERC721PredicateABI',
  'ERC1155PredicateABI',
  'EtherPredicateABI',
  'GasSwapperABI',
  'RootChainABI',
  'StakeManagerABI',
  'ValidatorShareABI',
  'PolTokenABI',
  'StateReceiverABI'
] as const;

// The Plasma ABIs are public at `@polygonlabs/maticjs/plasma/abi`, not `./abi`.
const PLASMA_ABIS = [
  'PlasmaDepositManagerABI',
  'PlasmaWithdrawManagerABI',
  'PlasmaExitNFTABI',
  'PlasmaPriorityQueueABI',
  'PlasmaMRC20ABI',
  'PlasmaChildERC20ABI',
  'PlasmaERC20PredicateABI'
] as const;

describe('vendored ABIs', () => {
  it('all required contract ABIs are exported', () => {
    const exported = Object.keys(abi).sort();
    for (const required of REQUIRED_ABIS) {
      expect(exported).contain(required);
    }
    // Spot-check that each export is a non-empty readonly array — i.e.,
    // the literal `as const` array we expect, not a stub.
    for (const required of REQUIRED_ABIS) {
      const value = (abi as Record<string, unknown>)[required];
      expect(Array.isArray(value)).equals(true);
      expect((value as readonly unknown[]).length).greaterThan(0);
    }
  });

  it('./abi exports exactly the 14 shipped names', () => {
    // Deep-equal on the sorted key list, so an addition fails as well as a
    // removal: a new name here is a new public export of `./abi`.
    expect(REQUIRED_ABIS).lengthOf(14);
    expect(Object.keys(abi).sort()).deep.equals([...REQUIRED_ABIS].sort());
  });

  it('the Plasma ABIs are exported from the Plasma barrel, and only those seven', () => {
    expect(Object.keys(plasmaAbi).sort()).deep.equals([...PLASMA_ABIS].sort());
    for (const name of PLASMA_ABIS) {
      const value = (plasmaAbi as Record<string, unknown>)[name];
      expect(Array.isArray(value)).equals(true);
      expect((value as readonly unknown[]).length).greaterThan(0);
    }
  });

  it('the ./abi barrel exports no Plasma ABI', () => {
    // A Plasma ABI re-exported here would put it in every `./abi` consumer's
    // closure; `check-entry-isolation.mjs` guards the built output, this guards
    // the source barrel directly.
    const exported = Object.keys(abi);
    for (const name of PLASMA_ABIS) {
      expect(exported).not.contain(name);
    }
    expect(exported.filter((name) => /plasma/i.test(name))).lengthOf(0);
  });

  it('src/abi holds no orphan or missing module', () => {
    // `codegen-drift-check` runs `git diff --exit-code` over `src/abi`, which
    // cannot see an untracked file or a tracked module the generator no longer
    // writes (it never deletes). Reading the directory here closes that gap.
    const abiDir = fileURLToPath(new URL('../../src/abi/', import.meta.url));
    const modulesOf = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    const exportedModules = (dir: string): string[] =>
      [...readFileSync(`${dir}index.ts`, 'utf8').matchAll(/from '\.\/([^']+)\.js';/g)]
        .map((match) => `${match[1]}.ts`)
        .sort();

    const abiFiles = modulesOf(abiDir).filter(
      (name) => name !== 'index.ts' && name !== 'failed-state-sync.ts'
    );
    expect(abiFiles).deep.equals(exportedModules(abiDir));
    expect(modulesOf(abiDir)).contain('index.ts');
    expect(modulesOf(abiDir)).contain('failed-state-sync.ts');

    const plasmaDir = `${abiDir}plasma/`;
    const plasmaFiles = modulesOf(plasmaDir).filter((name) => name !== 'index.ts');
    expect(plasmaFiles).deep.equals(exportedModules(plasmaDir));
    expect(plasmaFiles).lengthOf(PLASMA_ABIS.length);

    const subfolders = readdirSync(abiDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(subfolders).deep.equals(['plasma']);
    expect(
      readdirSync(plasmaDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    ).lengthOf(0);
  });

  it('viem-typed inference works on RootChainManager.depositFor', () => {
    // Compile-time check: the array element type for the depositFor
    // entry in RootChainManagerABI must be a literal object whose
    // `name` field narrows to the string `'depositFor'` — *not* widen
    // to `string`. If the `as const` is dropped on RootChainManagerABI,
    // this expression fails to compile because the indexed element
    // would type as `unknown` and the `name` field would not be
    // assignable to the string-literal target.
    const depositFor = abi.RootChainManagerABI.find(
      (entry): entry is typeof entry & { readonly name: 'depositFor' } =>
        'name' in entry && entry.name === 'depositFor'
    );
    expect(depositFor).not.equals(undefined);
    expect(depositFor).property('name').equals('depositFor');
    // Inputs must include the expected (user, rootToken, depositData) tuple.
    const inputs = (depositFor as { inputs?: readonly { name: string }[] }).inputs;
    expect(inputs).a('array');
    expect(inputs).lengthOf(3);
    const inputArr = inputs as readonly { name: string }[];
    expect(inputArr[0]).property('name').equals('user');
    expect(inputArr[1]).property('name').equals('rootToken');
    expect(inputArr[2]).property('name').equals('depositData');
  });

  it('viem-typed inference works on StakeManager.stakeFor', () => {
    // `stakeFor` takes five inputs (user, amount, heimdallFee,
    // acceptDelegation, signerPubkey); a four-input shape would mean the
    // ABI was abridged or the wrong overload was picked up.
    const stakeFor = abi.StakeManagerABI.find(
      (entry): entry is typeof entry & { readonly name: 'stakeFor' } =>
        'name' in entry && entry.name === 'stakeFor'
    );
    expect(stakeFor).not.equals(undefined);
    expect(stakeFor).property('name').equals('stakeFor');
    expect(stakeFor).property('inputs').lengthOf(5);
  });

  it('every ABI entry has a `type` discriminator', () => {
    // Sanity check on the literal shape — a missing `type` field would
    // mean the ABI was abridged or copied wrong. viem's typed contract
    // calls require `type: 'function' | 'event' | 'constructor' | ...`
    // on every entry.
    const all: Record<string, readonly { type?: unknown }[]> = { ...abi, ...plasmaAbi };
    for (const name of [...REQUIRED_ABIS, ...PLASMA_ABIS]) {
      const value = all[name];
      expect(value).a('array');
      for (const entry of value ?? []) {
        expect(entry).property('type').a('string');
      }
    }
  });
});

interface AbiEntry {
  readonly type: string;
  readonly name?: string;
  readonly stateMutability?: string;
}

/** Every entry of `abiArray` that has `name`, so an overload cannot hide. */
const entriesNamed = (abiArray: readonly AbiEntry[], name: string): AbiEntry[] =>
  abiArray.filter((entry) => entry.name === name);

describe('Plasma ABIs carry what the SDK calls', () => {
  it('DepositManager has depositERC20ForUser, state-changing', () => {
    const [entry] = entriesNamed(plasmaAbi.PlasmaDepositManagerABI, 'depositERC20ForUser');
    expect(entry).property('type').equals('function');
    expect(entry).property('stateMutability').equals('nonpayable');
  });

  it('WithdrawManager has processExits, processExitsBatch, exitsQueues and ExitStarted', () => {
    expect(entriesNamed(plasmaAbi.PlasmaWithdrawManagerABI, 'processExits')).lengthOf(1);
    expect(entriesNamed(plasmaAbi.PlasmaWithdrawManagerABI, 'processExitsBatch')).lengthOf(1);
    const [queues] = entriesNamed(plasmaAbi.PlasmaWithdrawManagerABI, 'exitsQueues');
    expect(queues).property('stateMutability').equals('view');
    const [started] = entriesNamed(plasmaAbi.PlasmaWithdrawManagerABI, 'ExitStarted');
    expect(started).property('type').equals('event');
  });

  it('PlasmaERC20Predicate has startExitWithBurntTokens', () => {
    const [entry] = entriesNamed(plasmaAbi.PlasmaERC20PredicateABI, 'startExitWithBurntTokens');
    expect(entry).property('type').equals('function');
  });

  it('MRC20 withdraw is payable', () => {
    const [entry] = entriesNamed(plasmaAbi.PlasmaMRC20ABI, 'withdraw');
    expect(entry).property('stateMutability').equals('payable');
  });

  it('PlasmaChildERC20 has a single withdraw(uint256), and it is payable', () => {
    const entries = entriesNamed(plasmaAbi.PlasmaChildERC20ABI, 'withdraw');
    expect(entries).lengthOf(1);
    const [entry] = entries;
    expect(entry).property('stateMutability').equals('payable');
  });

  it('ExitNFT has exists and PriorityQueue has currentSize, both reads', () => {
    const [exists] = entriesNamed(plasmaAbi.PlasmaExitNFTABI, 'exists');
    expect(exists).property('stateMutability').equals('view');
    const [currentSize] = entriesNamed(plasmaAbi.PlasmaPriorityQueueABI, 'currentSize');
    expect(currentSize).property('stateMutability').equals('view');
  });
});

describe('PlasmaEventSignature', () => {
  it('Erc20Withdraw is the selector of the Withdraw event in the generated child ERC-20 ABI', () => {
    const event = getAbiItem({ abi: plasmaAbi.PlasmaChildERC20ABI, name: 'Withdraw' });
    expect(event).property('type').equals('event');
    expect(PlasmaEventSignature.Erc20Withdraw).equals(toEventSelector(event));
  });

  it('ExitStarted is the selector of the ExitStarted event in the generated withdraw manager ABI', () => {
    const event = getAbiItem({ abi: plasmaAbi.PlasmaWithdrawManagerABI, name: 'ExitStarted' });
    expect(event).property('type').equals('event');
    expect(PlasmaEventSignature.ExitStarted).equals(toEventSelector(event));
  });
});
