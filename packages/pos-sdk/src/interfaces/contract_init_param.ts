export interface IContractInitParam {
  address: string;
  isParent: boolean;
  bridgeAdapterAddress?: string;
  /**
   * used to get the predicate
   *
   * @type {string}
   * @memberof IContractInitParam
   */
  name: string;
  bridgeType?: string;
}
