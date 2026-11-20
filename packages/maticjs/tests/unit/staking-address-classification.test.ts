import { describe, expect, it } from 'vitest';

import type { NetworkAddresses } from '../../src/networks.ts';
import type { StakingAddresses } from '../../src/staking/addresses.ts';

import {
  classifyStakingAddresses,
  REQUIRED_BRIDGE_ADDRESS_KEYS
} from '../../src/staking/addresses.ts';

const BRIDGE: NetworkAddresses = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666'
};
const STAKING_ONLY: StakingAddresses = {
  StakeManager: '0x7777777777777777777777777777777777777777',
  MaticToken: '0x8888888888888888888888888888888888888888',
  PolToken: '0x9999999999999999999999999999999999999999'
};
const FULL: NetworkAddresses = { ...BRIDGE, ...STAKING_ONLY };
const GAS_SWAPPER = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';

const inherited: Record<string, unknown> = Object.create({
  RootChainManager: BRIDGE.RootChainManager
});
Object.assign(inherited, STAKING_ONLY);

describe('classifyStakingAddresses', () => {
  it.each([
    ['FULL', FULL, 'full-index'],
    ['STAKING_ONLY', STAKING_ONLY, 'staking-only'],
    ['{}', {}, 'staking-only'],
    [
      'staking keys plus an optional PoS key',
      { ...STAKING_ONLY, GasSwapper: GAS_SWAPPER },
      'staking-only'
    ],
    ['staking keys plus RootChain', { ...STAKING_ONLY, RootChain: BRIDGE.RootChain }, 'full-index'],
    [
      'staking keys plus RootChainManager: undefined',
      { ...STAKING_ONLY, RootChainManager: undefined },
      'full-index'
    ],
    ['only a Main key', { Main: {} }, 'staking-only'],
    ['a bridge key inherited through the prototype', inherited, 'full-index'],
    ['bridge keys only', BRIDGE, 'full-index']
  ])('%s is %s', (_label, override, expected) => {
    expect(classifyStakingAddresses(override)).equals(expected);
  });

  it('recognises each required bridge key on its own', () => {
    for (const key of REQUIRED_BRIDGE_ADDRESS_KEYS) {
      expect(classifyStakingAddresses({ ...STAKING_ONLY, [key]: undefined }), key).equals(
        'full-index'
      );
    }
  });

  it('names the first probed key in the native error for a non-object', () => {
    expect(() => classifyStakingAddresses(null as never))
      .throws(TypeError)
      .with.property('message')
      .match(/Cannot use 'in' operator to search for 'RootChainManager' in null/);
  });
});
