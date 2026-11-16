import type { ITransactionOption } from './transaction_option.js';

export interface IBridgeTransactionOption extends ITransactionOption {
  /**
   * address of spender
   *
   * **spender** - third-party user or a smart contract which can transfer your token on your behalf.
   *
   * @type {string}
   * @memberof IBridgeTransactionOption
   */
  permitData?: string;
  forceUpdateGlobalExitRoot?: boolean;
  v?: number;
  r?: string;
  s?: string;
}
