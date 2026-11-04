import type { ITransactionOption } from './transaction_option.js';

export interface IExitTransactionOption extends ITransactionOption {
  /**
   * event signature for burn transaction
   *
   * @type {string}
   * @memberof IExitTransactionOption
   */
  burnEventSignature?: string;
}
