import type { ITransactionRequestConfig } from './transaction_config.js';

export interface ITransactionResult {
  estimateGas(tx?: ITransactionRequestConfig): Promise<number>;
  encodeABI(): string;
}
