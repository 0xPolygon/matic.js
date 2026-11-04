/**
 * Legacy request shape kept for backwards-compatibility on the
 * existing transaction-option interfaces. The internal SDK uses
 * `WriteRequest` from `../adapter.ts`; this remains as a structural
 * superset so consumers passing through legacy hand-rolled tx config
 * still type-check.
 *
 * Numeric fields use `bigint` (Stage 2) instead of the legacy
 * `BaseBigNumber` placeholder.
 */
export interface ITransactionRequestConfig {
  from?: string;
  to?: string;
  value?: number | string | bigint;
  gasLimit?: number | string | bigint;
  gasPrice?: number | string | bigint;
  data?: string;
  nonce?: number;
  chainId?: number;
  chain?: string;
  hardfork?: string;
  maxFeePerGas?: number | string | bigint;
  maxPriorityFeePerGas?: number | string | bigint;
  type?: number;
}
