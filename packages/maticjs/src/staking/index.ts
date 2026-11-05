/**
 * `@polygonlabs/maticjs/staking` — Polygon PoS validator and delegator
 * staking.
 *
 * A separate entry so bridge consumers carry no staking ABI and staking
 * consumers no bridge proof machinery. Staking modules import each ABI
 * from its own module, never the `../abi/index.js` barrel, so the staking
 * ABIs land in a chunk the bridge entry does not load (checked by
 * `scripts/check-entry-isolation.mjs`). Contract wrappers are exported
 * as types only: instances come from `StakingClient.init`, which wires
 * the address index and the parent-chain adapter.
 */

export { StakingClient } from './staking-client.js';
export { splitSignature } from './permit.js';

// The error classes a staking call can surface, so a staking-only consumer
// imports them from the entry it already uses. Same classes as the root
// entry's (one module), so `find` / `has` work across both imports.
export {
  AddressLookupError,
  BridgeEventDecodeFailedError,
  ConfirmationError,
  ContractNotAvailableOnNetworkError,
  FeeEstimationFailedError,
  HttpRequestFailedError,
  InitError,
  InvalidHexStringError,
  PermitError,
  PermitNotSupportedError,
  StakingReadError,
  StakingWriteError,
  TransactionNotFoundError,
  TransactionReplacedError,
  TransactionRevertedError,
  TxOptionNotObjectError,
  UnsupportedNetworkError,
  Web3ClientNotInitializedError,
  isMaticjsError,
  MATICJS_ERROR_NAMES,
  rootCause
} from '../errors.js';
export type {
  BridgeEventDecodeFailedInfo,
  ContractNotAvailableOnNetworkInfo,
  ErrorInfo,
  ErrorOptions,
  FeeEstimationFailedInfo,
  FoundError,
  HttpRequestFailedInfo,
  InvalidHexStringInfo,
  LegacyErrorType,
  OperationErrorOptions,
  OperationInfo,
  OperationMode,
  PermitNotSupportedInfo,
  RequiredInfoErrorOptions,
  TransactionHashInfo,
  TransactionReplacedInfo,
  TransactionRevertedInfo,
  TxOptionNotObjectInfo,
  TypeOfResult,
  UnsupportedNetworkInfo,
  Web3ClientNotInitializedInfo
} from '../errors.js';

export type {
  ResolvedStakingAddresses,
  StakingAddresses,
  StakingClientConfig
} from './staking-client.js';
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
