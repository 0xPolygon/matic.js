/**
 * Consumers annotate what they read off `err.info` with the SDK's own
 * types, so every `info` type and the constructor option types must be
 * importable from the public entries. This file fails to typecheck when
 * one is missing; the runtime assertions only keep vitest from reporting
 * an empty file.
 */
import { describe, expect, it } from 'vitest';

import type {
  BatchSizeLimitExceededInfo,
  BridgeEventDecodeFailedInfo,
  BufferTypeRequiredInfo,
  BurnTxNotCheckpointedInfo,
  ChainSideInfo,
  ContractNotAvailableOnNetworkInfo,
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
  FeeEstimationFailedError,
  MATICJS_ERROR_NAMES,
  TransactionNotFoundError,
  UnsupportedNetworkError,
  Web3ClientNotInitializedError
} from '../../src/index.ts';
import {
  FeeEstimationFailedError as StakingFeeEstimationFailedError,
  MATICJS_ERROR_NAMES as STAKING_MATICJS_ERROR_NAMES,
  TransactionNotFoundError as StakingTransactionNotFoundError,
  UnsupportedNetworkError as StakingUnsupportedNetworkError,
  Web3ClientNotInitializedError as StakingWeb3ClientNotInitializedError
} from '../../src/staking/index.ts';

type Root = [
  BatchSizeLimitExceededInfo,
  BridgeEventDecodeFailedInfo,
  BufferTypeRequiredInfo,
  BurnTxNotCheckpointedInfo,
  ChainSideInfo,
  ContractNotAvailableOnNetworkInfo,
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

describe('error type exports', () => {
  it('every info and option type is importable from the root and staking entries', () => {
    const root: Root['length'] = 36;
    const staking: Staking['length'] = 18;
    expect(root).equals(36);
    expect(staking).equals(18);
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
