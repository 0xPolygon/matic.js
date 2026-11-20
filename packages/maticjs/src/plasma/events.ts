/**
 * The event topics the Plasma bridge reads, kept out of the root entry's
 * `LogEventSignature` because only the `./plasma` entry's consumers use them.
 * Hardcoded, and a unit test derives each from the matching event of the
 * generated Plasma ABI, so this module needs no hashing library at load time.
 */
export const PlasmaEventSignature = {
  /**
   * `Withdraw(address,address,uint256,uint256,uint256)`: emitted on the
   * CHILD chain by a Plasma child ERC-20 (and by the native-token contract
   * at `0x…1010`) when a burn starts a withdrawal. The Plasma ERC-20
   * predicate selects the burn's log by this topic, not by `Transfer`,
   * so the exit proof must point at this log.
   */
  Erc20Withdraw: '0xebff2602b3f468259e1e99f613fed6691f3a6526effe6ef3e768ba7ae7a36c4f',
  /**
   * `ExitStarted(address,uint256,address,uint256,bool)`: the log the
   * withdraw manager emits on the parent chain when an exit is queued.
   */
  ExitStarted: '0xaa5303fdad123ab5ecaefaf69137bf8632257839546d43a3b3dd148cc2879d6f'
} as const;

export type PlasmaEventSignature = (typeof PlasmaEventSignature)[keyof typeof PlasmaEventSignature];
