/**
 * Consumers annotate what they read off `err.info` with the SDK's own
 * types, so every `info` type and the constructor option types must be
 * importable from the public entries. This file fails to typecheck when
 * one is missing; the runtime assertions only keep vitest from reporting
 * an empty file.
 */
import { describe, expect, it } from 'vitest';

import type {
  AdapterResultMismatchInfo,
  BatchSizeLimitExceededInfo,
  BridgeEventDecodeFailedInfo,
  BufferTypeRequiredInfo,
  BurnTxNotCheckpointedInfo,
  ChainSideInfo,
  ContractNotAvailableOnNetworkInfo,
  DepositNotReplayableInfo,
  Eip1559NotSupportedInfo,
  EmptyInfo,
  ErrorInfo,
  ErrorOptions,
  FeeEstimationFailedInfo,
  HttpRequestFailedInfo,
  IndexOutOfBoundsInfo,
  InvalidHexStringInfo,
  InvalidNumericValueInfo,
  InvalidTokenTypeInfo,
  LogNotFoundInReceiptInfo,
  MerkleTreeDepthExceededInfo,
  NegativeBigNumberInfo,
  NegativeIndexInfo,
  NullSpenderAddressInfo,
  OnlyAllowedOnMainnetInfo,
  OperationErrorOptions,
  PermitNotSupportedInfo,
  ProofNodeKeyMismatchInfo,
  ReceiptsRootMismatchInfo,
  RequiredInfoErrorOptions,
  TransactionHashInfo,
  TransactionHashRequiredInfo,
  TransactionReplacedInfo,
  TransactionRevertedInfo,
  TxOptionNotObjectInfo,
  TypeOfResult,
  UnsupportedKeccakBitWidthInfo,
  UnsupportedNetworkInfo,
  Web3ClientNotInitializedInfo
} from '../../src/index.ts';
import type {
  AdapterResultMismatchInfo as PlasmaAdapterResultMismatchInfo,
  BridgeEventDecodeFailedInfo as PlasmaBridgeEventDecodeFailedInfo,
  BurnTxNotCheckpointedInfo as PlasmaBurnTxNotCheckpointedInfo,
  CheckpointRangeInvalidInfo as PlasmaCheckpointRangeInvalidInfo,
  ContractNotAvailableOnNetworkInfo as PlasmaContractNotAvailableOnNetworkInfo,
  Eip1559NotSupportedInfo as PlasmaEip1559NotSupportedInfo,
  ErrorInfo as PlasmaErrorInfo,
  ErrorOptions as PlasmaErrorOptions,
  ExitGasLimitTooLowInfo as PlasmaExitGasLimitTooLowInfo,
  ExitNotStartedInfo as PlasmaExitNotStartedInfo,
  ExitQueueEmptyInfo as PlasmaExitQueueEmptyInfo,
  FeeEstimationFailedInfo as PlasmaFeeEstimationFailedInfo,
  HttpRequestFailedInfo as PlasmaHttpRequestFailedInfo,
  IndexOutOfBoundsInfo as PlasmaIndexOutOfBoundsInfo,
  InvalidHexStringInfo as PlasmaInvalidHexStringInfo,
  InvalidNumericValueInfo as PlasmaInvalidNumericValueInfo,
  LegacyErrorType as PlasmaLegacyErrorType,
  LogNotFoundInReceiptInfo as PlasmaLogNotFoundInReceiptInfo,
  NativeBurnValueMismatchInfo as PlasmaNativeBurnValueMismatchInfo,
  ChildBurnValueNotAllowedInfo as PlasmaChildBurnValueNotAllowedInfo,
  OperationErrorOptions as PlasmaOperationErrorOptions,
  RequiredInfoErrorOptions as PlasmaRequiredInfoErrorOptions,
  TransactionHashInfo as PlasmaTransactionHashInfo,
  TransactionHashRequiredInfo as PlasmaTransactionHashRequiredInfo,
  TransactionReplacedInfo as PlasmaTransactionReplacedInfo,
  TransactionRevertedInfo as PlasmaTransactionRevertedInfo,
  TxOptionNotObjectInfo as PlasmaTxOptionNotObjectInfo,
  TypeOfResult as PlasmaTypeOfResult,
  UnsupportedNetworkInfo as PlasmaUnsupportedNetworkInfo
} from '../../src/plasma/index.ts';
import type {
  AdapterResultMismatchInfo as StakingAdapterResultMismatchInfo,
  BridgeEventDecodeFailedInfo as StakingBridgeEventDecodeFailedInfo,
  ContractNotAvailableOnNetworkInfo as StakingContractNotAvailableOnNetworkInfo,
  ErrorInfo as StakingErrorInfo,
  ErrorOptions as StakingErrorOptions,
  FeeEstimationFailedInfo as StakingFeeEstimationFailedInfo,
  HttpRequestFailedInfo as StakingHttpRequestFailedInfo,
  InvalidHexStringInfo as StakingInvalidHexStringInfo,
  LegacyErrorType as StakingLegacyErrorType,
  OperationErrorOptions as StakingOperationErrorOptions,
  PermitNotSupportedInfo as StakingPermitNotSupportedInfo,
  RequiredInfoErrorOptions as StakingRequiredInfoErrorOptions,
  TransactionHashInfo as StakingTransactionHashInfo,
  TransactionReplacedInfo as StakingTransactionReplacedInfo,
  TransactionRevertedInfo as StakingTransactionRevertedInfo,
  TxOptionNotObjectInfo as StakingTxOptionNotObjectInfo,
  TypeOfResult as StakingTypeOfResult,
  UnsupportedNetworkInfo as StakingUnsupportedNetworkInfo,
  Web3ClientNotInitializedInfo as StakingWeb3ClientNotInitializedInfo
} from '../../src/staking/index.ts';

import {
  AdapterResultMismatchError,
  FeeEstimationFailedError,
  MATICJS_ERROR_NAMES,
  TransactionNotFoundError,
  UnsupportedNetworkError,
  Web3ClientNotInitializedError
} from '../../src/index.ts';
import { AdapterResultMismatchError as PlasmaAdapterResultMismatchError } from '../../src/plasma/index.ts';
import {
  AdapterResultMismatchError as StakingAdapterResultMismatchError,
  FeeEstimationFailedError as StakingFeeEstimationFailedError,
  MATICJS_ERROR_NAMES as STAKING_MATICJS_ERROR_NAMES,
  TransactionNotFoundError as StakingTransactionNotFoundError,
  UnsupportedNetworkError as StakingUnsupportedNetworkError,
  Web3ClientNotInitializedError as StakingWeb3ClientNotInitializedError
} from '../../src/staking/index.ts';

type Root = [
  AdapterResultMismatchInfo,
  BatchSizeLimitExceededInfo,
  BridgeEventDecodeFailedInfo,
  BufferTypeRequiredInfo,
  BurnTxNotCheckpointedInfo,
  ChainSideInfo,
  ContractNotAvailableOnNetworkInfo,
  DepositNotReplayableInfo,
  Eip1559NotSupportedInfo,
  EmptyInfo,
  ErrorInfo,
  ErrorOptions<ErrorInfo>,
  FeeEstimationFailedInfo,
  HttpRequestFailedInfo,
  IndexOutOfBoundsInfo,
  InvalidHexStringInfo,
  InvalidNumericValueInfo,
  InvalidTokenTypeInfo,
  LogNotFoundInReceiptInfo,
  MerkleTreeDepthExceededInfo,
  NegativeBigNumberInfo,
  NegativeIndexInfo,
  NullSpenderAddressInfo,
  OnlyAllowedOnMainnetInfo,
  OperationErrorOptions,
  PermitNotSupportedInfo,
  ProofNodeKeyMismatchInfo,
  ReceiptsRootMismatchInfo,
  RequiredInfoErrorOptions<ErrorInfo>,
  TransactionHashInfo,
  TransactionHashRequiredInfo,
  TransactionReplacedInfo,
  TransactionRevertedInfo,
  TxOptionNotObjectInfo,
  TypeOfResult,
  UnsupportedKeccakBitWidthInfo,
  UnsupportedNetworkInfo,
  Web3ClientNotInitializedInfo
];

type Staking = [
  StakingAdapterResultMismatchInfo,
  StakingBridgeEventDecodeFailedInfo,
  StakingContractNotAvailableOnNetworkInfo,
  StakingErrorInfo,
  StakingErrorOptions<StakingErrorInfo>,
  StakingFeeEstimationFailedInfo,
  StakingHttpRequestFailedInfo,
  StakingInvalidHexStringInfo,
  StakingLegacyErrorType,
  StakingOperationErrorOptions,
  StakingPermitNotSupportedInfo,
  StakingRequiredInfoErrorOptions<StakingErrorInfo>,
  StakingTransactionHashInfo,
  StakingTransactionReplacedInfo,
  StakingTransactionRevertedInfo,
  StakingTxOptionNotObjectInfo,
  StakingTypeOfResult,
  StakingUnsupportedNetworkInfo,
  StakingWeb3ClientNotInitializedInfo
];

type Plasma = [
  PlasmaAdapterResultMismatchInfo,
  PlasmaBridgeEventDecodeFailedInfo,
  PlasmaBurnTxNotCheckpointedInfo,
  PlasmaCheckpointRangeInvalidInfo,
  PlasmaContractNotAvailableOnNetworkInfo,
  PlasmaEip1559NotSupportedInfo,
  PlasmaErrorInfo,
  PlasmaErrorOptions<PlasmaErrorInfo>,
  PlasmaExitGasLimitTooLowInfo,
  PlasmaExitNotStartedInfo,
  PlasmaExitQueueEmptyInfo,
  PlasmaFeeEstimationFailedInfo,
  PlasmaHttpRequestFailedInfo,
  PlasmaIndexOutOfBoundsInfo,
  PlasmaInvalidHexStringInfo,
  PlasmaInvalidNumericValueInfo,
  PlasmaLegacyErrorType,
  PlasmaLogNotFoundInReceiptInfo,
  PlasmaNativeBurnValueMismatchInfo,
  PlasmaChildBurnValueNotAllowedInfo,
  PlasmaOperationErrorOptions,
  PlasmaRequiredInfoErrorOptions<PlasmaErrorInfo>,
  PlasmaTransactionHashInfo,
  PlasmaTransactionHashRequiredInfo,
  PlasmaTransactionReplacedInfo,
  PlasmaTransactionRevertedInfo,
  PlasmaTxOptionNotObjectInfo,
  PlasmaTypeOfResult,
  PlasmaUnsupportedNetworkInfo
];

describe('error type exports', () => {
  it('every info and option type is importable from the root, staking and plasma entries', () => {
    const root: Root['length'] = 38;
    const staking: Staking['length'] = 19;
    const plasma: Plasma['length'] = 29;
    expect(root).equals(38);
    expect(staking).equals(19);
    expect(plasma).equals(29);
  });

  // A staking or Plasma read can reject with this class, so its own entry
  // exports it; it must be the root's class, or `has` / `find` would disagree.
  it('AdapterResultMismatchError is the same class from the root, staking and plasma entries', () => {
    expect(StakingAdapterResultMismatchError).equals(AdapterResultMismatchError);
    expect(PlasmaAdapterResultMismatchError).equals(AdapterResultMismatchError);
  });

  // A staking write can raise these (chain guard, signer/provider checks,
  // fee lookup, receipt wait), so a staking-only consumer must be able to
  // match them without importing the bridge entry.
  it.each([
    ['UnsupportedNetworkError', StakingUnsupportedNetworkError, UnsupportedNetworkError],
    [
      'Web3ClientNotInitializedError',
      StakingWeb3ClientNotInitializedError,
      Web3ClientNotInitializedError
    ],
    ['FeeEstimationFailedError', StakingFeeEstimationFailedError, FeeEstimationFailedError],
    ['TransactionNotFoundError', StakingTransactionNotFoundError, TransactionNotFoundError],
    ['MATICJS_ERROR_NAMES', STAKING_MATICJS_ERROR_NAMES, MATICJS_ERROR_NAMES]
  ])(
    'the staking entry re-exports %s, the same value as the root entry',
    (_name, staking, root) => {
      expect(staking).not.equals(undefined);
      expect(staking).equals(root);
    }
  );
});
