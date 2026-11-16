import type { IBaseBlock } from './block.js';
import type { ITransactionData } from './transaction_data.js';

export interface IBlockWithTransaction extends IBaseBlock {
  transactions: ITransactionData[];
}
