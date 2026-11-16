import type { ITransactionOption } from './transaction_option.js';

export interface IApproveTransactionOption extends ITransactionOption {
  /**
   * address of spender
   *
   * **spender** - third-party user or a smart contract which can transfer your token on your behalf.
   *
   * @type {string}
   * @memberof IAllowanceTransactionOption
   */
  spenderAddress?: string;
  forceUpdateGlobalExitRoot?: boolean;
}
