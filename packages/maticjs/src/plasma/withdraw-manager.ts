/**
 * `PlasmaWithdrawManager`: the parent-chain `WithdrawManager` calls that
 * finish a Plasma exit, `processExits` and `processExitsBatch`, plus the
 * queue reads they depend on.
 *
 * Each ABI is imported from its own module, never the ABI barrel: the
 * barrel would pull every ABI into any entry that reaches this file, and
 * the entry-isolation gate fails the build if the Plasma ABIs leak into
 * the root entry.
 */
import type { Adapter, Hex, PreparedTx, TxResult } from '../adapter.js';
import type { OperationInfo } from '../errors.js';
import type { WriteCall } from '../internal/abi-types.js';
import type { ContractCallerOptions } from '../internal/contract-caller.js';
import type { Logger } from '../logger.js';

import { PlasmaPriorityQueueABI } from '../abi/plasma/PriorityQueue.js';
import { PlasmaWithdrawManagerABI } from '../abi/plasma/WithdrawManager.js';
import {
  ExitError,
  ExitGasLimitTooLowError,
  ExitQueueEmptyError,
  withOperation
} from '../errors.js';
import { ContractCaller } from '../internal/contract-caller.js';

/**
 * Gas allowed per queued exit when the SDK sizes `processExits` itself.
 *
 * The withdraw manager's loop stops silently, without reverting, once
 * `gasleft()` falls to its `ON_FINALIZE_GAS_LIMIT`, so a transaction that
 * runs short of gas succeeds and leaves exits unprocessed. An estimate taken
 * from a simulation also undercounts: it measures a run that already has
 * enough gas to reach the end. The default limit is therefore the estimate
 * plus this allowance for every exit in the queue, not the estimate alone.
 */
export const PROCESS_EXITS_GAS_PER_EXIT = 350_000n;

/**
 * Upper bound on the default `processExits` gas limit.
 *
 * `estimate + queueSize * PROCESS_EXITS_GAS_PER_EXIT` is unbounded, and a
 * transaction above the per-transaction gas cap is rejected by the node.
 * Ethereum's cap is 2^24 = 16,777,216 gas (EIP-7825); this value sits just
 * below it. A long queue is processed over several calls, since each call
 * handles as many exits as its gas allows.
 */
export const MAX_PROCESS_EXITS_GAS_LIMIT = 16_000_000n;

/**
 * Gas added to the contract's `ON_FINALIZE_GAS_LIMIT` to form the least
 * `gasLimit` a caller may pass to `processExits`.
 *
 * The loop runs only while `gasleft() > ON_FINALIZE_GAS_LIMIT`, and the
 * transaction spends some gas before the first check, so the smallest limit
 * that processes anything is `ON_FINALIZE_GAS_LIMIT` plus that spend. On a
 * devnet (`ON_FINALIZE_GAS_LIMIT` 300,000) the smallest limits that
 * processed the head exit were 338,207 for `processExits`, 338,859 for
 * `processExitsBatch([MATIC])`, 339,233 for `processExitsBatch([MATIC, POL])`
 * and 347,331 for `processExitsBatch([POL, MATIC])`: about 8.3k more for
 * each empty token ahead of the one holding the exit. A call with a limit
 * too low for the loop to start succeeded and used 31,296 gas.
 *
 * 30,000 puts the floor, 330,000 today, below the smallest working
 * minimum, so the SDK never rejects a limit that can work. It is a lower
 * bound, not a sufficient limit: see {@link PlasmaWithdrawManager.processExits}.
 */
export const PRE_LOOP_GAS_ALLOWANCE = 30_000n;

/**
 * Used for `ON_FINALIZE_GAS_LIMIT` only when the withdraw manager answers the
 * read but has no such constant (see `answersWithoutConstant`). This is the value
 * the deployed contract carries.
 */
const FALLBACK_ON_FINALIZE_GAS_LIMIT = 300_000n;

const ZERO_ADDRESS = /^0x0{40}$/i;

export interface PlasmaWithdrawManagerConfig {
  /** Adapter for the parent chain, where the withdraw manager lives. */
  adapter: Adapter;
  /** Resolves the withdraw manager's current address (so index refreshes are honoured). */
  getWithdrawManagerAddress: () => Promise<Hex>;
  logger: Logger;
  defaultFrom?: Hex;
  /** Parent chain id every write is pinned to; see `ContractCallerConfig.chainId`. */
  chainId?: number;
}

export class PlasmaWithdrawManager {
  private readonly adapter: Adapter;
  private readonly logger: Logger;
  readonly #caller: ContractCaller<typeof PlasmaWithdrawManagerABI>;
  private onFinalizeGasLimit: Promise<bigint> | undefined;

  constructor(config: PlasmaWithdrawManagerConfig) {
    this.adapter = config.adapter;
    this.logger = config.logger;
    this.#caller = new ContractCaller({
      adapter: config.adapter,
      getAddress: config.getWithdrawManagerAddress,
      abi: PlasmaWithdrawManagerABI,
      isParent: true,
      logger: config.logger,
      ...(config.defaultFrom !== undefined ? { defaultFrom: config.defaultFrom } : {}),
      ...(config.chainId !== undefined ? { chainId: config.chainId } : {}),
      // The default limit below adds a per-exit allowance to the node's own
      // estimate. Scaling the estimate as well would change a formula that
      // was checked on a devnet with the unscaled figure.
      gasMultiplier: 1
    });
  }

  /**
   * Number of exits queued for `token`, summed over the exit queue the
   * withdraw manager keeps for it. A token with no queue contract has none.
   */
  async getExitQueueSize(token: Hex): Promise<bigint> {
    const queue = await this.#caller.read('exitsQueues', [token]);
    if (ZERO_ADDRESS.test(queue)) return 0n;
    const queueCaller = new ContractCaller({
      adapter: this.adapter,
      getAddress: () => Promise.resolve(queue),
      abi: PlasmaPriorityQueueABI,
      isParent: true,
      logger: this.logger
    });
    return queueCaller.read('currentSize', []);
  }

  /**
   * Process the queued exits of `tokens`: one token calls `processExits`,
   * several call `processExitsBatch`.
   *
   * Throws `ExitQueueEmptyError` before anything is sent when no token has
   * a queued exit (an empty `tokens` list included), because such a
   * transaction would spend gas and change nothing.
   *
   * **Default gas.** When `options.gasLimit` is omitted the limit is
   * `min(estimateGas + queueSize * 350_000n, 16_000_000n)`, where
   * `queueSize` counts the queued exits of all `tokens`. The per-exit
   * allowance is there because the contract's loop stops silently when gas
   * runs low (see {@link PROCESS_EXITS_GAS_PER_EXIT}); the cap keeps the
   * transaction under Ethereum's per-transaction limit (see
   * {@link MAX_PROCESS_EXITS_GAS_LIMIT}).
   *
   * **Gas floor.** A `gasLimit` you pass is used exactly as given, except
   * that one below `ON_FINALIZE_GAS_LIMIT + 30_000n` (330,000 on the
   * deployed contract) throws `ExitGasLimitTooLowError` before anything is
   * sent. The contract's loop runs only while
   * `gasleft() > ON_FINALIZE_GAS_LIMIT`, so a limit that cannot get the loop
   * started completes successfully and processes nothing: on a devnet a call
   * with 318,670 gas, for an exit that needs 159,335, did exactly that.
   *
   * The floor sits below the smallest working minimum so it never rejects a
   * limit that can work. Measured on a devnet, the smallest limits that
   * processed the head exit were 338,207 (`processExits`), 338,859
   * (`processExitsBatch([MATIC])`), 339,233 (`processExitsBatch([MATIC,
   * POL])`) and 347,331 (`processExitsBatch([POL, MATIC])`), about 8.3k more
   * for each empty token ahead of the queue holding the exit; a call that
   * could not start the loop used 31,296 gas. A limit between the floor and
   * the real minimum is accepted and can still complete as a silent no-op,
   * more so with several tokens. The SDK's default limit is the safe value.
   * A caller who passes the raw `eth_estimateGas` value (214,204 for one
   * exit) gets a no-op: the estimate is the gas the run used, not the
   * `gasleft()` the loop needs at its start. `getWithdrawStatus` is the proof
   * that an exit completed; a successful receipt is not.
   *
   * `ON_FINALIZE_GAS_LIMIT` is read from the contract once per instance, with
   * 300,000 used only when the contract answers but has no such constant. A
   * transport or RPC failure on that read reaches you unchanged.
   *
   * To size a transaction you send yourself, read the same default from
   * {@link PlasmaWithdrawManager.getProcessExitsGasLimit}.
   */
  async processExits(
    { tokens }: { tokens: readonly Hex[] },
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    return withOperation({
      error: ExitError,
      info: operationInfo({ operation: 'processExits', mode: 'write', tokens }),
      run: async () => {
        const call = callFor(tokens);
        const queueSize = await this.requireQueuedExits(tokens);
        await this.requireGasFloor(options.gasLimit);
        const gasLimit =
          options.gasLimit ?? (await this.defaultGasLimit({ call, options, queueSize }));
        return this.#caller.write(call, { ...options, gasLimit });
      }
    });
  }

  /**
   * Same as {@link processExits} but returns the unsigned `{ to, data }`.
   * The queue check and the gas floor apply to a `gasLimit` in `options`
   * too, although a prepared transaction carries no gas: the same call then
   * fails the same way whether it is sent or prepared.
   *
   * **The sender MUST set the transaction's gas limit to at least
   * {@link PlasmaWithdrawManager.getProcessExitsGasLimit}.** The result
   * carries no gas, and a wallet, batcher or bundler that sizes the
   * transaction itself uses the node's estimate, which is the gas the run
   * used. The contract's loop needs more than that at its start (it stops
   * silently once `gasleft()` falls to `ON_FINALIZE_GAS_LIMIT`), so a
   * transaction sized by the estimate alone succeeds and processes nothing.
   * On a devnet the estimate was 214,204 for a call that needs about 338,000
   * to start the loop.
   */
  async prepareProcessExits(
    { tokens }: { tokens: readonly Hex[] },
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return withOperation({
      error: ExitError,
      info: operationInfo({ operation: 'prepareProcessExits', mode: 'prepare', tokens }),
      run: async () => {
        const call = callFor(tokens);
        await this.requireQueuedExits(tokens);
        await this.requireGasFloor(options.gasLimit);
        return this.#caller.prepareWrite(call, options);
      }
    });
  }

  /**
   * The gas limit {@link processExits} sends when `options.gasLimit` is
   * omitted: `min(estimateGas + queueSize * 350_000n, 16_000_000n)`, where
   * `queueSize` counts the queued exits of all `tokens`. Use it as the gas
   * limit of a transaction you send yourself from {@link prepareProcessExits}.
   *
   * **The sender MUST set at least this value.** The contract's loop stops
   * silently, without reverting, once `gasleft()` falls to its
   * `ON_FINALIZE_GAS_LIMIT`. A wallet's own estimate is the gas the run used,
   * not the `gasleft()` the loop needs when it starts, so a transaction sized
   * by that estimate alone succeeds and processes nothing.
   *
   * It runs the write's own computation, not a copy of it, so the two cannot
   * drift. Like the write it estimates as `options.from` (or the adapter's
   * signer); pass `from` when the adapter has neither. Throws
   * `ExitQueueEmptyError`, as the write does, when no token has a queued
   * exit. A node, transport or library failure reaches you unchanged.
   */
  async getProcessExitsGasLimit(
    { tokens }: { tokens: readonly Hex[] },
    options: ContractCallerOptions = {}
  ): Promise<bigint> {
    return withOperation({
      error: ExitError,
      info: operationInfo({ operation: 'getProcessExitsGasLimit', mode: 'read', tokens }),
      run: async () => {
        const call = callFor(tokens);
        const queueSize = await this.requireQueuedExits(tokens);
        return this.defaultGasLimit({ call, options, queueSize });
      }
    });
  }

  /** Total queued exits across `tokens`; throws `ExitQueueEmptyError` when there are none. */
  private async requireQueuedExits(tokens: readonly Hex[]): Promise<bigint> {
    const sizes = await Promise.all(tokens.map((token) => this.getExitQueueSize(token)));
    const total = sizes.reduce((sum, size) => sum + size, 0n);
    if (total === 0n) {
      throw new ExitQueueEmptyError(
        tokens.length === 0
          ? 'No tokens were given, so there is nothing to process. Pass the token whose exit you started.'
          : 'No exit is queued for the given tokens. It may already be processed: read getWithdrawStatus before retrying.',
        { info: { tokens } }
      );
    }
    return total;
  }

  private async requireGasFloor(gasLimit: bigint | undefined): Promise<void> {
    if (gasLimit === undefined) return;
    const minimum = (await this.readOnFinalizeGasLimit()) + PRE_LOOP_GAS_ALLOWANCE;
    if (gasLimit < minimum) {
      throw new ExitGasLimitTooLowError(
        `gasLimit ${gasLimit.toString()} is below the minimum of ${minimum.toString()}. A limit that low completes successfully and processes nothing.`,
        { info: { gasLimit, minimum } }
      );
    }
  }

  private async defaultGasLimit({
    call,
    options,
    queueSize
  }: {
    call: Call;
    options: ContractCallerOptions;
    queueSize: bigint;
  }): Promise<bigint> {
    const estimate = await this.#caller.estimateGas(call, options);
    const sized = estimate + queueSize * PROCESS_EXITS_GAS_PER_EXIT;
    return sized < MAX_PROCESS_EXITS_GAS_LIMIT ? sized : MAX_PROCESS_EXITS_GAS_LIMIT;
  }

  /**
   * The contract's `ON_FINALIZE_GAS_LIMIT`, read once per instance. The
   * in-flight read is what is cached, so concurrent callers share it. The
   * fallback is cached too, since the contract's answer will not change. A
   * failure that is not that answer is not cached, so the next call tries
   * the contract again.
   */
  private readOnFinalizeGasLimit(): Promise<bigint> {
    this.onFinalizeGasLimit ??= this.fetchOnFinalizeGasLimit().catch((err: unknown) => {
      this.onFinalizeGasLimit = undefined;
      throw err;
    });
    return this.onFinalizeGasLimit;
  }

  /**
   * Falls back to 300,000 only when the contract answered and the constant is
   * absent. Every other failure is a library, wallet or transport error and
   * is rethrown as the same object: substituting a number for a network
   * failure would hide the failure behind a guess.
   */
  private async fetchOnFinalizeGasLimit(): Promise<bigint> {
    try {
      return await this.#caller.read('ON_FINALIZE_GAS_LIMIT', []);
    } catch (err) {
      if (!answersWithoutConstant(err)) throw err;
      this.logger.warn(
        { err },
        'the withdraw manager answered without an ON_FINALIZE_GAS_LIMIT; using the fallback'
      );
      return FALLBACK_ON_FINALIZE_GAS_LIMIT;
    }
  }
}

/**
 * A write of the withdraw manager that ends an exit. The descriptor ties each
 * method to its own arguments, which an object with a method-name union and a
 * separate argument list would not.
 */
type Call = WriteCall<typeof PlasmaWithdrawManagerABI>;

/** One token takes the single-token entry point, any other count the batch one. */
const callFor = (tokens: readonly Hex[]): Call => {
  const [only] = tokens;
  return tokens.length === 1 && only !== undefined
    ? { method: 'processExits', args: [only] }
    : { method: 'processExitsBatch', args: [tokens] };
};

type OperationMode = 'write' | 'prepare' | 'read';

const operationInfo = ({
  operation,
  mode,
  tokens
}: {
  operation: string;
  mode: OperationMode;
  tokens: readonly Hex[];
}): OperationInfo => {
  const [only] = tokens;
  return {
    operation,
    mode,
    method: callFor(tokens).method,
    ...(tokens.length === 1 && only !== undefined ? { tokenAddress: only } : {})
  };
};

// --- classifying a failed `ON_FINALIZE_GAS_LIMIT` read -------------------------

/** viem errors raised while decoding returned data that is empty or too short. */
const VIEM_UNDECODABLE_RETURN = new Set([
  'ContractFunctionZeroDataError',
  'AbiDecodingZeroDataError',
  'AbiDecodingDataSizeTooSmallError',
  'AbiDecodingDataSizeInvalidError'
]);

/** EIP-1474's code for a call the EVM reverted; a rate limit or a crash has another. */
const EXECUTION_REVERTED_RPC_CODE = 3;

const MAX_CHAIN_LENGTH = 10;

const indexable = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const propertyOf = (value: unknown, key: string): unknown =>
  indexable(value) ? value[key] : undefined;

/** `0x` alone is valid hex and is what an empty return looks like. */
const carriesHex = (value: unknown): boolean =>
  typeof value === 'string' && /^0x[0-9a-f]*$/i.test(value);

/**
 * The error and what it wraps, outermost first: viem keeps the inner error
 * at `cause`, ethers v5 at `error`, ethers v6 at `info.error`.
 */
const errorChain = (err: unknown): unknown[] => {
  const chain: unknown[] = [];
  let link: unknown = err;
  while (indexable(link) && !chain.includes(link) && chain.length < MAX_CHAIN_LENGTH) {
    chain.push(link);
    link = link['cause'] ?? link['error'] ?? propertyOf(link['info'], 'error');
  }
  return chain;
};

/**
 * Whether a failed read of `ON_FINALIZE_GAS_LIMIT` is the contract's own
 * answer that the constant is not there: it returned nothing, or nothing
 * decodable, or it reverted.
 *
 * It judges by the shape each library gives that answer, never by message
 * text, because a network failure can carry any words (a rate-limit body can
 * say "execution reverted"). All three libraries also report failures that
 * never reached the contract as a call revert, so a revert counts only when
 * the node itself reported one (RPC code 3) or the library saw the call
 * return empty or undecodable data. A failure that fits none of these is not
 * an answer, and the caller rethrows it unchanged. A revert a node reports
 * under another code is rethrown too: failing loudly is the safe side of that
 * doubt.
 *
 * - viem: a zero-data or too-short-data decoding error, or a
 *   `ContractFunctionRevertedError` over code 3. viem builds that error from a
 *   -32603 internal error as well and keeps its data, so the data alone does
 *   not show the contract answered.
 * - ethers v5: `CALL_EXCEPTION` wrapping no error (the call returned empty or
 *   revert data), or wrapping one with code 3.
 * - ethers v6: `BAD_DATA` from decoding the return value (it carries the
 *   `value` and the `info.method` of the decode), or `CALL_EXCEPTION` as for
 *   v5 with the wrapped error at `info.error`.
 */
const answersWithoutConstant = (err: unknown): boolean => {
  const chain = errorChain(err);
  const [top, wrapped] = chain;
  const nodeReportedRevert = chain.some(
    (link) => propertyOf(link, 'code') === EXECUTION_REVERTED_RPC_CODE
  );

  if (chain.some((link) => VIEM_UNDECODABLE_RETURN.has(String(propertyOf(link, 'name'))))) {
    return true;
  }
  const viemRevert = chain.find(
    (link) => propertyOf(link, 'name') === 'ContractFunctionRevertedError'
  );
  if (viemRevert !== undefined) {
    return nodeReportedRevert;
  }

  const code = propertyOf(top, 'code');
  if (code === 'CALL_EXCEPTION') return wrapped === undefined || nodeReportedRevert;
  if (code === 'BAD_DATA') {
    return (
      carriesHex(propertyOf(top, 'value')) &&
      typeof propertyOf(propertyOf(top, 'info'), 'method') === 'string'
    );
  }
  return false;
};
