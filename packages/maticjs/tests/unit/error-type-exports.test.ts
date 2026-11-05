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

describe('error type exports', () => {
  it('every info and option type is importable from the root entry', () => {
    const root: Root['length'] = 36;
    expect(root).equals(36);
  });
});
