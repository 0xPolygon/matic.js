/**
 * `@polygonlabs/maticjs/plasma`: the Polygon Plasma bridge for ERC-20 tokens.
 *
 * A separate entry so PoS bridge consumers carry no Plasma ABI, and Plasma
 * consumers carry none of the PoS bridge's ABIs except `RootChain`, which
 * checkpoint reads need. Plasma modules import each ABI from its own module,
 * never a barrel, so the Plasma ABIs land in chunks the other entries do not
 * load. The ABIs are public at `@polygonlabs/maticjs/plasma/abi`, not
 * re-exported here, so this entry's surface stays the client.
 * Token handles are exported as a type only: instances come from
 * `PlasmaClient.init`, which wires the address index and the two adapters.
 */

export { PlasmaClient } from './plasma-client.js';
export { PlasmaEventSignature } from './events.js';
export {
  MAX_PROCESS_EXITS_GAS_LIMIT,
  PRE_LOOP_GAS_ALLOWANCE,
  PROCESS_EXITS_GAS_PER_EXIT
} from './withdraw-manager.js';

// The same RPC-token redactor as the root entry's (one module, so identity
// holds across both imports), for Plasma-only consumers' error logging.
export { sanitiseError } from '../adapters/index.js';

// The error classes a Plasma call can surface, so a Plasma-only consumer
// imports them from the entry it already uses. Same classes as the root
// entry's (one module), so `find` / `has` work across both imports.
export {
  AdapterResultMismatchError,
  AddressLookupError,
  AllowedOnChildError,
  AllowedOnRootError,
  ApproveError,
  BridgeEventDecodeFailedError,
  BridgeStatusError,
  BurnTxNotCheckpointedError,
  CheckpointRangeInvalidError,
  ConfirmationError,
  ContractNotAvailableOnNetworkError,
  DepositError,
  Eip1559NotSupportedError,
  ExitError,
  ExitGasLimitTooLowError,
  ExitNotStartedError,
  ExitQueueEmptyError,
  FeeEstimationFailedError,
  HttpRequestFailedError,
  IndexOutOfBoundsError,
  InitError,
  InvalidHexStringError,
  InvalidNumericValueError,
  LogNotFoundInReceiptError,
  NativeBurnValueMismatchError,
  ChildBurnValueNotAllowedError,
  ProofApiNotSetError,
  TokenReadError,
  TransactionHashRequiredError,
  TransactionNotFoundError,
  TransactionReplacedError,
  TransactionRevertedError,
  TxOptionNotObjectError,
  UnsupportedNetworkError,
  WithdrawStartError,
  isMaticjsError,
  MATICJS_ERROR_NAMES,
  rootCause
} from '../errors.js';
export type {
  AdapterResultMismatchInfo,
  BridgeEventDecodeFailedInfo,
  BurnTxNotCheckpointedInfo,
  CheckpointRangeInvalidInfo,
  ContractNotAvailableOnNetworkInfo,
  Eip1559NotSupportedInfo,
  ErrorInfo,
  ErrorOptions,
  ExitGasLimitTooLowInfo,
  ExitNotStartedInfo,
  ExitQueueEmptyInfo,
  FeeEstimationFailedInfo,
  FoundError,
  HttpRequestFailedInfo,
  IndexOutOfBoundsInfo,
  InvalidHexStringInfo,
  InvalidNumericValueInfo,
  LegacyErrorType,
  LogNotFoundInReceiptInfo,
  NativeBurnValueMismatchInfo,
  ChildBurnValueNotAllowedInfo,
  OperationErrorOptions,
  OperationInfo,
  OperationMode,
  RequiredInfoErrorOptions,
  TransactionHashInfo,
  TransactionHashRequiredInfo,
  TransactionReplacedInfo,
  TransactionRevertedInfo,
  TxOptionNotObjectInfo,
  TypeOfResult,
  UnsupportedNetworkInfo
} from '../errors.js';

export type {
  CheckpointNotReachedReason,
  CheckpointStatus
} from '../internal/checkpoint-status.js';
export type { ReplacementReason } from '../internal/confirmation.js';
export type { CheckpointRangeInvalidReason, ExitNotStartedReason } from '../errors.js';
export type { PlasmaAddresses } from './addresses.js';
export type {
  PlasmaClientConfig,
  PlasmaTokenNamespace,
  ProcessExitsParams
} from './plasma-client.js';
export type {
  PlasmaChildERC20,
  PlasmaERC20,
  PlasmaParentERC20,
  PlasmaWithdrawStatusParams
} from './erc20.js';
export type { PlasmaWithdrawNotExitedReason, PlasmaWithdrawStatus } from './withdraw-status.js';
