/**
 * `@polygonlabs/maticjs/staking` — Polygon PoS validator and delegator
 * staking.
 *
 * A separate entry so bridge consumers carry no staking ABI and staking
 * consumers no bridge proof machinery. Contract wrappers are exported
 * as types only: instances come from `StakingClient.init`, which wires
 * the address index and the parent-chain adapter.
 */

export { StakingClient } from './staking-client.js';
export { splitSignature } from './permit.js';

export type { StakingClientConfig } from './staking-client.js';
export type {
  MigrateDelegationParams,
  RestakeParams,
  StakeForParams,
  StakeManager,
  TopUpHeimdallFeeParams,
  UpdateCommissionRateParams,
  UpdateSignerParams,
  ValidatorIdParams,
  ValidatorInfo
} from './stake-manager.js';
export type {
  ClaimUndelegatedParams,
  DelegateParams,
  DelegateWithPermitParams,
  DelegatorStake,
  UndelegateParams,
  Unbond,
  ValidatorShare
} from './validator-share.js';
export type { PreparePermitParams, StakingToken } from './staking-token.js';
export type { PermitDomain, PermitMessage, PermitSignature, PermitTypedData } from './permit.js';
