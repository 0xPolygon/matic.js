/**
 * The staking address override: its shape and the one function that
 * decides whether a caller handed over a full bridge index or only the
 * staking addresses.
 */

import type { Hex } from '../adapter.js';
import type { NetworkAddresses } from '../networks.js';

/**
 * The three contracts the staking client calls. This is all a
 * staking-only `addresses` override has to carry: the bridge keys of
 * {@link NetworkAddresses} are never read by staking, so a consumer that
 * does not use the bridge need not invent placeholders for them.
 */
export interface StakingAddresses {
  /** Live StakeManager proxy (never the implementation). */
  StakeManager: Hex;
  /** Legacy MATIC staking token. */
  MaticToken: Hex;
  /** POL staking token. */
  PolToken: Hex;
}

/** The staking keys, in the order error messages list them. */
export const STAKING_ADDRESS_KEYS = [
  'StakeManager',
  'MaticToken',
  'PolToken'
] as const satisfies readonly (keyof StakingAddresses)[];

/**
 * The bridge keys the bridge address parser requires. Any one of them
 * present marks an override as a full index.
 */
export const REQUIRED_BRIDGE_ADDRESS_KEYS = [
  'RootChainManager',
  'ERC20Predicate',
  'ERC721Predicate',
  'ERC1155Predicate',
  'EtherPredicate',
  'RootChain'
] as const satisfies readonly (keyof NetworkAddresses)[];

export type StakingAddressesKind = 'full-index' | 'staking-only';

/**
 * Decide whether `override` is a full bridge index or a staking-only
 * override. This is the only place in the staking client that looks at
 * which keys an override carries.
 *
 * A full index is recognised by any required bridge key being present
 * (own or inherited, even with an `undefined` value), so a full index with
 * a typo'd or missing bridge key still fails the bridge parser loudly
 * instead of being quietly treated as staking-only. The parameter is
 * `object` because plain-JS callers get no help from the types and can
 * pass anything. A non-object makes the `in` test throw a native
 * `TypeError`, which is how it has always surfaced, so the probe must
 * reach `in` with `RootChainManager` first (its message names the key
 * searched) and must not be wrapped.
 */
export function classifyStakingAddresses(override: object): StakingAddressesKind {
  return REQUIRED_BRIDGE_ADDRESS_KEYS.some((key) => key in override)
    ? 'full-index'
    : 'staking-only';
}
