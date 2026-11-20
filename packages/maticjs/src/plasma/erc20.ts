/**
 * `PlasmaERC20`: one ERC-20 token on either side of the Plasma bridge.
 *
 * Method shapes mirror the PoS bridge's `ERC20` (`deposit(amount, userAddress,
 * options)`, `startWithdraw(amount, options)`), so moving a token between the
 * two bridges does not change how its calls look. Every write has a `prepare*`
 * sibling that returns the unsigned `{ to, data, value? }` instead.
 *
 * Which chain a method works on follows the exit's own order: the burn
 * (`startWithdraw`) happens on the child chain; everything else, including
 * reading the exit's status, is a parent-chain call.
 *
 * Each ABI is imported from its own module, never the ABI barrel, so the
 * entry-isolation gate can keep the Plasma ABIs out of the other entries.
 */
import type { Adapter, Hex, PreparedTx, TxResult } from '../adapter.js';
import type { ContractCallerOptions } from '../internal/contract-caller.js';
import type { ExitProofBuilder } from '../internal/exit-proof.js';
import type { Logger } from '../logger.js';
import type { PlasmaWithdrawManager } from './withdraw-manager.js';
import type { PlasmaWithdrawStatus } from './withdraw-status.js';

import { PlasmaChildERC20ABI } from '../abi/plasma/ChildERC20.js';
import { PlasmaMRC20ABI } from '../abi/plasma/MRC20.js';
import { MAX_AMOUNT } from '../constant.js';
import {
  AllowedOnChildError,
  AllowedOnRootError,
  ApproveError,
  BridgeStatusError,
  DepositError,
  ExitError,
  ChildBurnValueNotAllowedError,
  NativeBurnValueMismatchError,
  TokenReadError,
  WithdrawStartError,
  withOperation
} from '../errors.js';
import { assertOptionsObject, ContractCaller } from '../internal/contract-caller.js';
import { PlasmaEventSignature } from './events.js';

/**
 * The child chain's native-token contract. A burn here is `withdraw(amount)`
 * with the same amount attached as value, unlike a child ERC-20, whose burn
 * carries no value.
 */
const NATIVE_TOKEN_CONTRACT = '0x0000000000000000000000000000000000001010';

/** The addresses the token handle reads, resolved fresh on every call. */
export interface PlasmaTokenAddresses {
  DepositManager: Hex;
  MaticToken: Hex;
  PolToken: Hex;
}

/**
 * Parent-chain services every token handle of one client shares. The client
 * builds them once: a token handle is cheap and made per call, and building
 * the proof builder or the callers per handle would repeat that work.
 */
export interface PlasmaBridgeServices {
  /** `DepositManager` caller on the parent chain. */
  depositManager: ContractCaller;
  /** Burn-only ERC-20 predicate caller on the parent chain. */
  predicate: ContractCaller;
  withdrawManager: PlasmaWithdrawManager;
  exitProof: ExitProofBuilder;
  /** Re-read on every call so an address-index refresh reaches the handle. */
  getAddresses: () => Promise<PlasmaTokenAddresses>;
  /** The status read, unwrapped: each public method wraps it in its own operation error. */
  readStatus: (params: PlasmaWithdrawStatusParams) => Promise<PlasmaWithdrawStatus>;
}

export interface PlasmaERC20Config {
  tokenAddress: Hex;
  /** `true` if the token lives on the parent chain (Ethereum). */
  isParent: boolean;
  /** Adapter for the chain the token lives on. */
  adapter: Adapter;
  /** Pinned id of that chain; see `ContractCallerConfig.chainId`. */
  chainId: number;
  logger: Logger;
  bridge: PlasmaBridgeServices;
}

/**
 * Which burn to read the status of, and optionally the transaction that
 * confirmed it. Without `confirmTxHash` a checkpointed burn reads
 * `'not-confirmed'`, because nothing on chain maps a burn to its exit; that
 * answer cannot tell 'never confirmed' from 'confirmed, hash not supplied'.
 */
export interface PlasmaWithdrawStatusParams {
  burnTxHash: string;
  confirmTxHash?: string;
}

/**
 * The methods that work on a parent-chain token handle. The runtime class is
 * one; the views keep a call that would only throw (a burn on the parent
 * chain, a confirm on the child chain) from compiling.
 */
export type PlasmaParentERC20 = Pick<
  PlasmaERC20,
  | 'tokenAddress'
  | 'isParent'
  | 'getBalance'
  | 'getAllowance'
  | 'approve'
  | 'prepareApprove'
  | 'approveMax'
  | 'prepareApproveMax'
  | 'deposit'
  | 'prepareDeposit'
  | 'confirmWithdraw'
  | 'prepareConfirmWithdraw'
  | 'confirmWithdrawFast'
  | 'prepareConfirmWithdrawFast'
  | 'completeWithdraw'
  | 'prepareCompleteWithdraw'
  | 'getCompleteWithdrawGasLimit'
  | 'getWithdrawStatus'
>;

/** The methods that work on a child-chain token handle: the balance and the burn. */
export type PlasmaChildERC20 = Pick<
  PlasmaERC20,
  'tokenAddress' | 'isParent' | 'getBalance' | 'startWithdraw' | 'prepareStartWithdraw'
>;

export class PlasmaERC20 {
  readonly tokenAddress: Hex;
  readonly isParent: boolean;
  private readonly caller: ContractCaller;
  /** Only on a child token that is the native-token contract. */
  private readonly nativeCaller: ContractCaller | undefined;
  private readonly bridge: PlasmaBridgeServices;

  constructor(config: PlasmaERC20Config) {
    this.tokenAddress = config.tokenAddress;
    this.isParent = config.isParent;
    this.bridge = config.bridge;
    const shared = {
      adapter: config.adapter,
      getAddress: () => Promise.resolve(config.tokenAddress),
      isParent: config.isParent,
      logger: config.logger,
      chainId: config.chainId
    };
    this.caller = new ContractCaller({ ...shared, abi: PlasmaChildERC20ABI });
    this.nativeCaller = isNativeBurn({
      tokenAddress: config.tokenAddress,
      isParent: config.isParent
    })
      ? new ContractCaller({ ...shared, abi: PlasmaMRC20ABI })
      : undefined;
  }

  /** ERC-20 `balanceOf(userAddress)` on whichever chain this handle is on. */
  async getBalance(userAddress: string, options?: ContractCallerOptions): Promise<bigint> {
    return withOperation({
      error: TokenReadError,
      info: {
        operation: 'getBalance',
        mode: 'read',
        tokenAddress: this.tokenAddress,
        method: 'balanceOf'
      },
      run: async () => {
        const v = await this.caller.read<bigint | string>('balanceOf', [userAddress], options);
        return BigInt(v);
      }
    });
  }

  /**
   * `allowance(userAddress, DepositManager)`: what the deposit can pull.
   * Parent chain only.
   */
  async getAllowance(userAddress: string, options?: ContractCallerOptions): Promise<bigint> {
    return withOperation({
      error: TokenReadError,
      info: {
        operation: 'getAllowance',
        mode: 'read',
        tokenAddress: this.tokenAddress,
        method: 'allowance'
      },
      run: async () => {
        this.requireParent('getAllowance');
        const { DepositManager } = await this.bridge.getAddresses();
        const v = await this.caller.read<bigint | string>(
          'allowance',
          [userAddress, DepositManager],
          options
        );
        return BigInt(v);
      }
    });
  }

  /**
   * Approve the `DepositManager` to pull `amount`. The spender is fixed: a
   * Plasma deposit pulls through the manager, not through a predicate, so
   * there is nothing to choose. Parent chain only.
   */
  async approve(amount: bigint, options: ContractCallerOptions = {}): Promise<TxResult> {
    return withOperation({
      error: ApproveError,
      info: {
        operation: 'approve',
        mode: 'write',
        tokenAddress: this.tokenAddress,
        method: 'approve'
      },
      run: async () => {
        this.requireParent('approve');
        const { DepositManager } = await this.bridge.getAddresses();
        return this.caller.write('approve', [DepositManager, amount], options);
      }
    });
  }

  /** Same as {@link approve} but returns the unsigned `{ to, data, value? }`. */
  async prepareApprove(amount: bigint, options: ContractCallerOptions = {}): Promise<PreparedTx> {
    return withOperation({
      error: ApproveError,
      info: {
        operation: 'prepareApprove',
        mode: 'prepare',
        tokenAddress: this.tokenAddress,
        method: 'approve'
      },
      run: async () => {
        this.requireParent('approve');
        const { DepositManager } = await this.bridge.getAddresses();
        return this.caller.prepareWrite('approve', [DepositManager, amount], options);
      }
    });
  }

  /** Convenience wrapper: `approve(2^256 - 1, …)`. */
  async approveMax(options: ContractCallerOptions = {}): Promise<TxResult> {
    return withOperation({
      error: ApproveError,
      info: {
        operation: 'approveMax',
        mode: 'write',
        tokenAddress: this.tokenAddress,
        method: 'approve'
      },
      run: () => this.approve(MAX_AMOUNT, options)
    });
  }

  /** Same as {@link approveMax} but returns the unsigned `{ to, data, value? }`. */
  async prepareApproveMax(options: ContractCallerOptions = {}): Promise<PreparedTx> {
    return withOperation({
      error: ApproveError,
      info: {
        operation: 'prepareApproveMax',
        mode: 'prepare',
        tokenAddress: this.tokenAddress,
        method: 'approve'
      },
      run: () => this.prepareApprove(MAX_AMOUNT, options)
    });
  }

  /**
   * Deposit `amount` of the token to `userAddress` on the child chain, through
   * `DepositManager.depositERC20ForUser`. The manager must be approved first.
   * Parent chain only.
   */
  async deposit(
    amount: bigint,
    userAddress: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    return withOperation({
      error: DepositError,
      info: {
        operation: 'deposit',
        mode: 'write',
        tokenAddress: this.tokenAddress,
        method: 'depositERC20ForUser'
      },
      run: () => {
        this.requireParent('deposit');
        return this.bridge.depositManager.write(
          'depositERC20ForUser',
          [this.tokenAddress, userAddress, amount],
          options
        );
      }
    });
  }

  /** Same as {@link deposit} but returns the unsigned `{ to, data, value? }`. */
  async prepareDeposit(
    amount: bigint,
    userAddress: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return withOperation({
      error: DepositError,
      info: {
        operation: 'prepareDeposit',
        mode: 'prepare',
        tokenAddress: this.tokenAddress,
        method: 'depositERC20ForUser'
      },
      run: () => {
        this.requireParent('deposit');
        return this.bridge.depositManager.prepareWrite(
          'depositERC20ForUser',
          [this.tokenAddress, userAddress, amount],
          options
        );
      }
    });
  }

  /**
   * Burn `amount` on the child chain to start a withdrawal. Child chain only.
   *
   * On the native-token contract the burn is `withdraw(amount)` with `amount`
   * attached as value, and the contract reverts on any other value. An absent
   * `options.value` is therefore set to `amount`, an equal one is sent as is,
   * and a different one throws `NativeBurnValueMismatchError` before anything
   * is estimated or sent. Any other child token's `withdraw` is payable and
   * keeps whatever value is sent with it, so a non-zero `options.value` throws
   * `ChildBurnValueNotAllowedError` before anything is estimated or sent; an
   * absent or zero value burns with `options` passed through untouched.
   *
   * The account that burns is the only one that can confirm the exit, from
   * the same address on the parent chain, and the bridge accepts one exit per
   * burn transaction. See {@link prepareStartWithdraw} before batching burns.
   */
  async startWithdraw(amount: bigint, options: ContractCallerOptions = {}): Promise<TxResult> {
    return withOperation({
      error: WithdrawStartError,
      info: {
        operation: 'startWithdraw',
        mode: 'write',
        tokenAddress: this.tokenAddress,
        method: 'withdraw'
      },
      run: () => {
        this.requireChild('startWithdraw');
        assertOptionsObject({ method: 'startWithdraw', options });
        return this.nativeCaller === undefined
          ? this.caller.write('withdraw', [amount], childBurnOptions({ options }))
          : this.nativeCaller.write('withdraw', [amount], nativeBurnOptions({ amount, options }));
      }
    });
  }

  /**
   * Same as {@link startWithdraw} but returns the unsigned `{ to, data, value? }`.
   *
   * **Send each burn in its own transaction.** The bridge identifies an exit
   * by the burn's block and its transaction's position in that block, so it
   * accepts one exit per burn transaction: a second burn batched into the
   * same transaction can never be confirmed on the parent chain. The sender
   * must also be able to send from the same address on the parent chain,
   * because the confirm is accepted only from the account that burned.
   */
  async prepareStartWithdraw(
    amount: bigint,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return withOperation({
      error: WithdrawStartError,
      info: {
        operation: 'prepareStartWithdraw',
        mode: 'prepare',
        tokenAddress: this.tokenAddress,
        method: 'withdraw'
      },
      run: () => {
        this.requireChild('startWithdraw');
        assertOptionsObject({ method: 'prepareStartWithdraw', options });
        return this.nativeCaller === undefined
          ? this.caller.prepareWrite('withdraw', [amount], childBurnOptions({ options }))
          : this.nativeCaller.prepareWrite(
              'withdraw',
              [amount],
              nativeBurnOptions({ amount, options })
            );
      }
    });
  }

  /**
   * Confirm a burn: build its exit payload locally from RPC and queue the exit
   * through the burn-only predicate. Returns the transaction to pass as
   * `confirmTxHash` to `getWithdrawStatus`. The burn's block must already be
   * checkpointed. Parent chain only.
   */
  async confirmWithdraw(
    burnTxHash: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    return withOperation({
      error: ExitError,
      info: {
        operation: 'confirmWithdraw',
        mode: 'write',
        tokenAddress: this.tokenAddress,
        burnTxHash,
        method: 'startExitWithBurntTokens',
        isFast: false
      },
      run: async () => {
        this.requireParent('confirmWithdraw');
        const payload = await this.exitPayload({ burnTxHash, isFast: false });
        return this.bridge.predicate.write('startExitWithBurntTokens', [payload], options);
      }
    });
  }

  /** Same as {@link confirmWithdraw} but returns the unsigned `{ to, data, value? }`. */
  async prepareConfirmWithdraw(
    burnTxHash: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return withOperation({
      error: ExitError,
      info: {
        operation: 'prepareConfirmWithdraw',
        mode: 'prepare',
        tokenAddress: this.tokenAddress,
        burnTxHash,
        method: 'startExitWithBurntTokens',
        isFast: false
      },
      run: async () => {
        this.requireParent('confirmWithdraw');
        const payload = await this.exitPayload({ burnTxHash, isFast: false });
        return this.bridge.predicate.prepareWrite('startExitWithBurntTokens', [payload], options);
      }
    });
  }

  /**
   * Same as {@link confirmWithdraw} but takes the exit payload from the proof
   * API. Throws `ProofApiNotSetError` when the client was built without a
   * `proofGenerationApiUrl`; if the API is configured and then fails, the
   * payload is built locally instead.
   */
  async confirmWithdrawFast(
    burnTxHash: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    return withOperation({
      error: ExitError,
      info: {
        operation: 'confirmWithdrawFast',
        mode: 'write',
        tokenAddress: this.tokenAddress,
        burnTxHash,
        method: 'startExitWithBurntTokens',
        isFast: true
      },
      run: async () => {
        this.requireParent('confirmWithdrawFast');
        const payload = await this.exitPayload({ burnTxHash, isFast: true });
        return this.bridge.predicate.write('startExitWithBurntTokens', [payload], options);
      }
    });
  }

  /** Same as {@link confirmWithdrawFast} but returns the unsigned `{ to, data, value? }`. */
  async prepareConfirmWithdrawFast(
    burnTxHash: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return withOperation({
      error: ExitError,
      info: {
        operation: 'prepareConfirmWithdrawFast',
        mode: 'prepare',
        tokenAddress: this.tokenAddress,
        burnTxHash,
        method: 'startExitWithBurntTokens',
        isFast: true
      },
      run: async () => {
        this.requireParent('confirmWithdrawFast');
        const payload = await this.exitPayload({ burnTxHash, isFast: true });
        return this.bridge.predicate.prepareWrite('startExitWithBurntTokens', [payload], options);
      }
    });
  }

  /**
   * Process this token's exit queue, which pays out every exit whose waiting
   * period has ended, yours included. Parent chain only.
   *
   * The queue to process is the one the exit was queued under. A native-token
   * burn queues under the legacy MATIC token even though it pays POL, so a
   * handle for the POL token processes the MATIC queue; any other token
   * processes its own. Gas, and what happens when nothing is queued, are those
   * of `PlasmaClient.processExits`.
   */
  async completeWithdraw(options: ContractCallerOptions = {}): Promise<TxResult> {
    return withOperation({
      error: ExitError,
      info: {
        operation: 'completeWithdraw',
        mode: 'write',
        tokenAddress: this.tokenAddress
      },
      run: async () => {
        this.requireParent('completeWithdraw');
        assertOptionsObject({ method: 'completeWithdraw', options });
        return this.bridge.withdrawManager.processExits(
          { tokens: [await this.queueToken()] },
          options
        );
      }
    });
  }

  /**
   * Same as {@link completeWithdraw} but returns the unsigned `{ to, data, value? }`.
   *
   * **The sender MUST set the transaction's gas limit to at least
   * {@link getCompleteWithdrawGasLimit}.** The result carries no gas, and a
   * smart wallet, batcher or bundler that sizes the transaction itself uses
   * the node's estimate, which is the gas the run used. The contract's exit
   * loop needs more than that at its start and stops silently, without
   * reverting, when it has less, so a transaction sized by the estimate alone
   * succeeds and processes nothing.
   */
  async prepareCompleteWithdraw(options: ContractCallerOptions = {}): Promise<PreparedTx> {
    return withOperation({
      error: ExitError,
      info: {
        operation: 'prepareCompleteWithdraw',
        mode: 'prepare',
        tokenAddress: this.tokenAddress
      },
      run: async () => {
        this.requireParent('completeWithdraw');
        assertOptionsObject({ method: 'prepareCompleteWithdraw', options });
        return this.bridge.withdrawManager.prepareProcessExits(
          { tokens: [await this.queueToken()] },
          options
        );
      }
    });
  }

  /**
   * The gas limit {@link completeWithdraw} sends when you pass no `gasLimit`:
   * the node's estimate plus `PROCESS_EXITS_GAS_PER_EXIT` for every exit in
   * this token's queue, capped at `MAX_PROCESS_EXITS_GAS_LIMIT`. Use it as the
   * gas limit of a transaction you send from {@link prepareCompleteWithdraw}.
   * Parent chain only. A POL handle reads the MATIC queue, as
   * `completeWithdraw` does.
   *
   * **The sender MUST set at least this value.** The contract's exit loop
   * stops silently, without reverting, once the gas left falls to its
   * `ON_FINALIZE_GAS_LIMIT`. A wallet's own estimate is the gas the run used,
   * not the gas left the loop needs when it starts, so a transaction sized by
   * that estimate alone succeeds and processes nothing.
   *
   * The value is computed by the same code the write runs, so the two agree.
   * It estimates as `options.from`, or as the adapter's signer; pass `from`
   * when the adapter has neither. Throws `ExitQueueEmptyError`, as
   * `completeWithdraw` does, when nothing is queued. A failure from your
   * library, wallet or RPC reaches you unchanged.
   */
  async getCompleteWithdrawGasLimit(options: ContractCallerOptions = {}): Promise<bigint> {
    return withOperation({
      error: ExitError,
      info: {
        operation: 'getCompleteWithdrawGasLimit',
        mode: 'read',
        tokenAddress: this.tokenAddress
      },
      run: async () => {
        this.requireParent('getCompleteWithdrawGasLimit');
        assertOptionsObject({ method: 'getCompleteWithdrawGasLimit', options });
        return this.bridge.withdrawManager.getProcessExitsGasLimit(
          { tokens: [await this.queueToken()] },
          options
        );
      }
    });
  }

  /**
   * Where a burn stands on the exit path, as `{ exited: true }` or
   * `{ exited: false, reason }`. Pass the transaction `confirmWithdraw`
   * returned as `confirmTxHash`: without it a checkpointed burn reads
   * `'not-confirmed'`, because nothing on chain maps a burn to its exit, even
   * when the exit was already processed; that answer cannot tell 'never
   * confirmed' from 'confirmed, hash not supplied'. If you lost the hash, do
   * not call `confirmWithdraw` again (a new confirm for an exit that already
   * exists reverts): find the confirm transaction and pass its hash.
   * `{ exited: true }` means the exit was processed (its exit token is gone),
   * not that the payout succeeded in full.
   *
   * Known limit: a chain reorganisation on the parent chain in the short
   * window between the exit's processing and this read can make the answer
   * briefly stale.
   * A node that is behind the block of the confirm transaction answers
   * `'in-exit-window'` from its own view, even when the exit is already
   * processed or its waiting period has ended; a later read from a node that
   * has caught up answers correctly.
   *
   * A `confirmTxHash` that did not start an exit for this burn rejects with
   * `ExitNotStartedError`, and so does a burn whose receipt has no Plasma
   * `Withdraw` log (a PoS burn passed by mistake) with
   * `LogNotFoundInReceiptError`. Both arrive as the `cause` of the
   * `BridgeStatusError` this method rejects with; find them with
   * `ExitNotStartedError.find(err)` and `LogNotFoundInReceiptError.find(err)`.
   * Parent chain only.
   */
  async getWithdrawStatus(params: PlasmaWithdrawStatusParams): Promise<PlasmaWithdrawStatus> {
    return withOperation({
      error: BridgeStatusError,
      info: {
        operation: 'getWithdrawStatus',
        mode: 'read',
        tokenAddress: this.tokenAddress,
        burnTxHash: params.burnTxHash
      },
      run: () => {
        this.requireParent('getWithdrawStatus');
        return this.bridge.readStatus(params);
      }
    });
  }

  // --- internals ---------------------------------------------------------

  private exitPayload({
    burnTxHash,
    isFast
  }: {
    burnTxHash: string;
    isFast: boolean;
  }): Promise<string> {
    return this.bridge.exitProof.buildExitPayload(
      burnTxHash,
      PlasmaEventSignature.Erc20Withdraw,
      isFast
    );
  }

  /** The token whose exit queue holds this token's exits. */
  private async queueToken(): Promise<Hex> {
    const { MaticToken, PolToken } = await this.bridge.getAddresses();
    return this.tokenAddress.toLowerCase() === PolToken.toLowerCase()
      ? MaticToken
      : this.tokenAddress;
  }

  private requireParent(action: string): void {
    if (!this.isParent) {
      throw new AllowedOnRootError(`${action} is allowed only on the parent (root) chain`, {
        info: { action, isParent: this.isParent, tokenAddress: this.tokenAddress }
      });
    }
  }

  private requireChild(action: string): void {
    if (this.isParent) {
      throw new AllowedOnChildError(`${action} is allowed only on the child chain`, {
        info: { action, isParent: this.isParent, tokenAddress: this.tokenAddress }
      });
    }
  }
}

const isNativeBurn = ({
  tokenAddress,
  isParent
}: {
  tokenAddress: Hex;
  isParent: boolean;
}): boolean => !isParent && tokenAddress.toLowerCase() === NATIVE_TOKEN_CONTRACT;

/**
 * Options for a native-token burn: `value` defaults to `amount`, because the
 * contract's `withdraw` requires exactly that value attached. A value that
 * differs would revert on chain, so it is refused here, before any call.
 */
const nativeBurnOptions = ({
  amount,
  options
}: {
  amount: bigint;
  options: ContractCallerOptions;
}): ContractCallerOptions => {
  const { value } = options;
  if (value === undefined) return { ...options, value: amount };
  if (value !== amount) {
    throw new NativeBurnValueMismatchError(
      `options.value ${value.toString()} differs from the burn amount ${amount.toString()}: a native-token burn must attach exactly its amount. Omit value and the SDK attaches it.`,
      { info: { amount, value } }
    );
  }
  return options;
};

/**
 * Options for a non-native child-token burn. The token's `withdraw` is payable
 * and keeps any value sent with it, so a non-zero value would be lost to the
 * token contract; it is refused here, before any call.
 */
const childBurnOptions = ({
  options
}: {
  options: ContractCallerOptions;
}): ContractCallerOptions => {
  const { value } = options;
  // A plain-JavaScript caller can pass the number 0; it attaches nothing, so it
  // is as harmless as 0n. Other numbers are not converted: BigInt throws on a
  // fraction, and a non-zero value is refused either way.
  const isNonZero = typeof value === 'number' ? value !== 0 : value !== 0n;
  if (value !== undefined && isNonZero) {
    throw new ChildBurnValueNotAllowedError(
      `options.value ${value.toString()} was passed with a burn of a non-native child token: its withdraw keeps any value sent with it, so the value would be lost. Omit value.`,
      { info: { value } }
    );
  }
  return options;
};
