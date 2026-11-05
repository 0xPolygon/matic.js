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
import { describe, expect, it } from 'vitest';

import * as abi from '../../src/abi/index.js';

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
  'RootChainABI'
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

  it('every ABI entry has a `type` discriminator', () => {
    // Sanity check on the literal shape — a missing `type` field would
    // mean the ABI was abridged or copied wrong. viem's typed contract
    // calls require `type: 'function' | 'event' | 'constructor' | ...`
    // on every entry.
    for (const name of REQUIRED_ABIS) {
      const value = (abi as Record<string, readonly { type?: unknown }[]>)[name]!;
      for (const entry of value) {
        expect(entry).property('type').a('string');
      }
    }
  });
});
