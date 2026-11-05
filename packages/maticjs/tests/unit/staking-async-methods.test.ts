import { describe, expect, it } from 'vitest';

import { StakeManager } from '../../src/staking/stake-manager.ts';
import { StakingClient } from '../../src/staking/staking-client.ts';
import { StakingToken } from '../../src/staking/staking-token.ts';
import { ValidatorShare } from '../../src/staking/validator-share.ts';

/**
 * Guard failures on a Promise-returning public method must arrive as a
 * rejected promise, never as a synchronous throw: a consumer writing
 * `share.delegate(x).catch(handle)` only sees failures that go through the
 * promise. Declaring every such method `async` guarantees that for any
 * guard added later, so this pins the declaration itself rather than the
 * guards that exist today.
 */

// Synchronous by design: `validatorShare` binds an address and returns an
// object; `assertPermit` is a private void check called inside async methods.
const SYNC_METHODS = new Set(['constructor', 'validatorShare', 'assertPermit']);

const methodsOf = (proto: object): [string, unknown][] =>
  Object.getOwnPropertyNames(proto)
    .filter((name) => !SYNC_METHODS.has(name))
    .map((name) => [name, Reflect.get(proto, name)]);

describe('staking public methods are async', () => {
  it.each([
    ['StakeManager', StakeManager.prototype],
    ['ValidatorShare', ValidatorShare.prototype],
    ['StakingToken', StakingToken.prototype],
    ['StakingClient', StakingClient.prototype]
  ])('%s', (_name, proto) => {
    const methods = methodsOf(proto);
    expect(methods.length).greaterThan(0);
    for (const [name, fn] of methods) {
      expect(fn, name).instanceOf(Function);
      expect(fn, name).property('constructor').property('name').equals('AsyncFunction');
    }
  });
});
