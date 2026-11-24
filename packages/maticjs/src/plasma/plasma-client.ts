/**
 * `PlasmaClient`: entry point for the Polygon Plasma bridge, served from
 * `@polygonlabs/maticjs/plasma`.
 *
 * Plasma is the bridge's older ERC-20 exit path. A withdrawal is a burn on
 * the child chain, a confirm on the parent chain once the burn is
 * checkpointed (which queues the exit), and a `processExits` call once the
 * exit's waiting period has ended. The client wires the two adapters, the
 * address index and the exit-proof builder together, and hands out token
 * handles that run that flow.
 *
 * It is a separate entry from the PoS bridge so that PoS consumers carry no
 * Plasma ABI, and Plasma consumers carry none of the PoS bridge's ABIs except
 * `RootChain`, which checkpoint reads need.
 */
import type { Adapter, BlockTag, Hex, PreparedTx, TxResult } from '../adapter.js';
import type { Abi } from '../internal/abi-types.js';
import type { ContractCallerOptions } from '../internal/contract-caller.js';
import type { Logger } from '../logger.js';
import type { Network } from '../networks.js';
import type { PlasmaAddresses, PlasmaAddressKey } from './addresses.js';
import type {
  PlasmaBridgeServices,
  PlasmaChildERC20,
  PlasmaParentERC20,
  PlasmaWithdrawStatusParams
} from './erc20.js';
import type { PlasmaBurnReader, PlasmaWithdrawStatus } from './withdraw-status.js';

import { PlasmaDepositManagerABI } from '../abi/plasma/DepositManager.js';
import { PlasmaERC20PredicateABI } from '../abi/plasma/ERC20Predicate.js';
import { RootChainABI } from '../abi/RootChain.js';
import {
  AddressLookupError,
  BridgeStatusError,
  ExitError,
  InitError,
  InvalidNumericValueError,
  LogNotFoundInReceiptError,
  TransactionNotFoundError,
  withOperation
} from '../errors.js';
import { createBridgeChildClient } from '../internal/bridge-child-client.js';
import { ContractCaller } from '../internal/contract-caller.js';
import { ExitProofBuilder, getLogIndex } from '../internal/exit-proof.js';
import { ProofApiClient } from '../internal/proof-api-client.js';
import { noopLogger } from '../logger.js';
import { L1_CHAIN_ID, L2_CHAIN_ID } from '../networks.js';
import { createPlasmaAddressSource } from './addresses.js';
import { PlasmaERC20 } from './erc20.js';
import { PlasmaEventSignature } from './events.js';
import { addressOfTopic } from './exit-id.js';
import { PlasmaWithdrawManager } from './withdraw-manager.js';
import { readPlasmaWithdrawStatus } from './withdraw-status.js';

const DEFAULT_PROOF_CONCURRENCY = 4;

interface PlasmaClientBaseConfig {
  /** Polygon network: `'mainnet'` or `'amoy'`. */
  network: Network;
  /**
   * Parent-chain (Ethereum) adapter, built with the factory for the library
   * you use (`viemAdapter`, `ethersV5Adapter`, `ethersV6Adapter`). The SDK
   * never imports viem or ethers itself.
   */
  parent: Adapter;
  /** Child-chain (Polygon) adapter; built the same way as `parent`. */
  child: Adapter;
  /** Optional structural logger; defaults to a no-op. */
  logger?: Logger;
  /**
   * Maximum concurrent receipt-fetch RPCs while building an exit proof.
   * Polygon mainnet blocks routinely hold 280+ transactions; fetching them
   * all at once trips RPC rate limits. Default: 4.
   */
  proofConcurrency?: number;
  /**
   * Base URL of a Polygon proof-generation API. Optional: when omitted,
   * `confirmWithdrawFast` throws `ProofApiNotSetError` and every exit payload
   * is built locally from RPC.
   */
  proofGenerationApiUrl?: string;
  /**
   * Parent-chain block tag the checkpoint reads pin to. Defaults to `'safe'`:
   * reading at `'latest'` can observe a checkpoint that is reorged out before
   * the exit payload reaches the parent chain.
   */
  rootChainDefaultBlock?: BlockTag;
  /**
   * Chain ids for forks and devnets whose ids differ from the `network`
   * preset. When given they replace the network pin: writes on `parent` are
   * checked against `chainIds.parent` and writes on `child` against
   * `chainIds.child`, and a signer or RPC on any other chain is refused with
   * `UnsupportedNetworkError` before anything is signed. Declared by your
   * own code, never read from the RPC. Each must be a positive safe integer.
   */
  chainIds?: { parent: number; child: number };
}

/** Fixed addresses: the address index is never read, so its options are not accepted. */
interface PlasmaClientFixedAddressesConfig extends PlasmaClientBaseConfig {
  /**
   * Pre-resolved addresses; the SDK then never reaches the address index.
   * The seven Plasma addresses ({@link PlasmaAddresses}); an absent or
   * malformed one fails `init` with `ContractNotAvailableOnNetworkError`.
   * Keys outside the seven are ignored, so a PoS bridge index passed here
   * fails naming the Plasma keys it lacks.
   */
  addresses: PlasmaAddresses;
  addressIndexUrl?: never;
  addressTTLMs?: never;
  onAddressRefreshError?: never;
}

/** Addresses from the address index, which these options tune. */
interface PlasmaClientIndexedAddressesConfig extends PlasmaClientBaseConfig {
  addresses?: undefined;
  /** Override the address-index base URL (staging mirrors, air-gapped deployments). */
  addressIndexUrl?: string;
  /** Address cache TTL in milliseconds. Default 1 hour. */
  addressTTLMs?: number;
  /** Invoked when a background address refresh fails; defaults to `logger.warn`. */
  onAddressRefreshError?: (err: Error) => void;
}

/**
 * Either pre-resolved `addresses`, or the address index with its options. The
 * index options cannot be combined with `addresses`, which skips the index.
 */
export type PlasmaClientConfig =
  | PlasmaClientFixedAddressesConfig
  | PlasmaClientIndexedAddressesConfig;

/** The `processExits` argument: the tokens whose exit queues to process. */
export interface ProcessExitsParams {
  tokens: readonly Hex[];
}

/** Token handles for one chain; each call returns a fresh, cheap handle. */
export interface PlasmaTokenNamespace<Token> {
  /** ERC-20 handle for the token at `addr` on this chain. */
  erc20(addr: Hex): Token;
}

/**
 * The burn's checkpoint answer and position, read through the exit-proof
 * builder the exit payloads are built with, so the status and the confirm see
 * the burn the same way.
 */
function burnReaderOver(exitProof: ExitProofBuilder): PlasmaBurnReader {
  return {
    getCheckpointStatus: (burnTxHash) => exitProof.getCheckpointStatus(burnTxHash),
    getBurn: async (burnTxHash) => {
      const { receipt } = await exitProof.readBurn(burnTxHash);
      // The status read asks only for a burn already reported checkpointed,
      // which has a receipt; a node that now has none is a missing dependency.
      if (receipt === undefined) {
        throw new TransactionNotFoundError(`Transaction ${burnTxHash} is not yet mined`, {
          info: { transactionHash: burnTxHash }
        });
      }
      // The exit payload points at the first Withdraw log, and the predicate
      // starts the exit only for the account that log names as `from`, so
      // that account, not the transaction's sender, is who the exit is for.
      const withdraw = (receipt.logs ?? [])[
        getLogIndex(PlasmaEventSignature.Erc20Withdraw, receipt)
      ];
      const from = withdraw?.topics[2];
      if (from === undefined) {
        throw new LogNotFoundInReceiptError('Log not found in receipt', {
          info: {
            eventSignature: PlasmaEventSignature.Erc20Withdraw,
            transactionHash: burnTxHash
          }
        });
      }
      return {
        blockNumber: BigInt(receipt.blockNumber),
        transactionIndex: receipt.transactionIndex,
        exitor: addressOfTopic(from)
      };
    }
  };
}

export class PlasmaClient {
  /** Parent-chain (Ethereum) token handles. */
  readonly parent: PlasmaTokenNamespace<PlasmaParentERC20>;
  /** Child-chain (Polygon) token handles. */
  readonly child: PlasmaTokenNamespace<PlasmaChildERC20>;

  private readonly resolveAddresses: () => Promise<PlasmaAddresses>;
  private readonly withdrawManager: PlasmaWithdrawManager;
  private readonly readStatus: (
    params: PlasmaWithdrawStatusParams
  ) => Promise<PlasmaWithdrawStatus>;

  private constructor(args: {
    parent: PlasmaTokenNamespace<PlasmaParentERC20>;
    child: PlasmaTokenNamespace<PlasmaChildERC20>;
    resolveAddresses: () => Promise<PlasmaAddresses>;
    withdrawManager: PlasmaWithdrawManager;
    readStatus: (params: PlasmaWithdrawStatusParams) => Promise<PlasmaWithdrawStatus>;
  }) {
    this.parent = args.parent;
    this.child = args.child;
    this.resolveAddresses = args.resolveAddresses;
    this.withdrawManager = args.withdrawManager;
    this.readStatus = args.readStatus;
  }

  /**
   * Build a `PlasmaClient`. Performs one foreground address-index fetch so a
   * misconfigured network, URL or override fails here rather than on the
   * first transaction.
   */
  static async init(config: PlasmaClientConfig): Promise<PlasmaClient> {
    return withOperation({
      error: InitError,
      info: { operation: 'init', mode: 'init' },
      run: () => PlasmaClient.build(config)
    });
  }

  private static async build(config: PlasmaClientConfig): Promise<PlasmaClient> {
    const { network, parent: parentAdapter, child: childAdapter } = config;
    const logger = config.logger ?? noopLogger;
    const proofConcurrency = config.proofConcurrency ?? DEFAULT_PROOF_CONCURRENCY;
    if (!Number.isInteger(proofConcurrency) || proofConcurrency < 1) {
      // Rejected here, typed, rather than as a bare TypeError from the
      // concurrency limiter inside the first proof build.
      throw new InvalidNumericValueError(
        `proofConcurrency must be a positive integer; got ${String(config.proofConcurrency)}`,
        { info: { proofConcurrency: config.proofConcurrency } }
      );
    }
    const declared = config.chainIds;
    if (declared !== undefined) {
      for (const side of ['parent', 'child'] as const) {
        const id = declared[side];
        if (!Number.isSafeInteger(id) || id < 1) {
          throw new InvalidNumericValueError(
            `chainIds.${side} must be a positive safe integer; got ${String(id)}`,
            { info: { value: id } }
          );
        }
      }
    }

    const source = createPlasmaAddressSource({
      network,
      addresses: config.addresses,
      baseUrl: config.addressIndexUrl,
      ttlMs: config.addressTTLMs,
      // The same default as the other clients: a silently failing refresh
      // loop looks exactly like a healthy one.
      onRefreshError:
        config.onAddressRefreshError ??
        ((err): void => {
          logger.warn({ err }, 'background address-index refresh failed; serving cached addresses');
        })
    });

    // One foreground read so a misconfigured network, URL or override fails
    // here rather than on the first transaction. The source validates every
    // Plasma key before it caches or returns anything, so `resolve` needs no
    // re-check: a refresh that would drop a key is rejected inside the source
    // and the last good addresses keep being served.
    await source.get();
    const resolve = (): Promise<PlasmaAddresses> => source.get();
    const addressOf = (key: PlasmaAddressKey) => async (): Promise<Hex> => (await resolve())[key];

    // Pinned from the network or declared in `chainIds`, never read back from
    // an RPC: every write is checked against these before it is signed.
    const l1ChainId = declared?.parent ?? L1_CHAIN_ID[network];
    const l2ChainId = declared?.child ?? L2_CHAIN_ID[network];

    const rootChainCaller = new ContractCaller({
      adapter: parentAdapter,
      getAddress: addressOf('RootChain'),
      abi: RootChainABI,
      isParent: true,
      logger,
      chainId: l1ChainId
    });
    const proofApiClient =
      config.proofGenerationApiUrl !== undefined
        ? new ProofApiClient({ baseUrl: config.proofGenerationApiUrl, network })
        : undefined;
    const exitProof = new ExitProofBuilder({
      rootChainCaller,
      childClient: createBridgeChildClient(childAdapter),
      ...(proofApiClient !== undefined ? { proofApiClient } : {}),
      ...(config.rootChainDefaultBlock !== undefined
        ? { rootChainDefaultBlock: config.rootChainDefaultBlock }
        : {}),
      logger,
      proofConcurrency
    });
    const burnReader = burnReaderOver(exitProof);

    const parentCaller = <TAbi extends Abi>({
      getAddress,
      abi
    }: {
      getAddress: () => Promise<Hex>;
      abi: TAbi;
    }): ContractCaller<TAbi> =>
      new ContractCaller({
        adapter: parentAdapter,
        getAddress,
        abi,
        isParent: true,
        logger,
        chainId: l1ChainId
      });
    const withdrawManager = new PlasmaWithdrawManager({
      adapter: parentAdapter,
      getWithdrawManagerAddress: addressOf('WithdrawManager'),
      logger,
      chainId: l1ChainId
    });

    const readStatus = async ({
      burnTxHash,
      confirmTxHash
    }: PlasmaWithdrawStatusParams): Promise<PlasmaWithdrawStatus> =>
      readPlasmaWithdrawStatus({
        burnTxHash,
        ...(confirmTxHash !== undefined ? { confirmTxHash } : {}),
        proof: burnReader,
        parentAdapter,
        addresses: await resolve(),
        logger
      });

    const bridge: PlasmaBridgeServices = {
      depositManager: parentCaller({
        getAddress: addressOf('DepositManager'),
        abi: PlasmaDepositManagerABI
      }),
      predicate: parentCaller({
        getAddress: addressOf('PlasmaERC20Predicate'),
        abi: PlasmaERC20PredicateABI
      }),
      withdrawManager,
      exitProof,
      getAddresses: resolve,
      readStatus
    };

    const handle = ({ addr, isParent }: { addr: Hex; isParent: boolean }): PlasmaERC20 =>
      new PlasmaERC20({
        tokenAddress: addr,
        isParent,
        adapter: isParent ? parentAdapter : childAdapter,
        chainId: isParent ? l1ChainId : l2ChainId,
        logger,
        bridge
      });

    return new PlasmaClient({
      parent: { erc20: (addr) => handle({ addr, isParent: true }) },
      child: { erc20: (addr) => handle({ addr, isParent: false }) },
      resolveAddresses: resolve,
      withdrawManager,
      readStatus
    });
  }

  /**
   * The seven Plasma addresses the client uses, and no others: the PoS
   * bridge addresses are not part of this client's index. All seven are
   * always present. A background refresh of the address index that drops one
   * is rejected whole, so this keeps returning the last good addresses and
   * `onAddressRefreshError` is called.
   *
   * Pair them with the vendored ABIs at `@polygonlabs/maticjs/plasma/abi`
   * (and `RootChain` from `@polygonlabs/maticjs/abi`) and your own client to
   * call a contract method the SDK does not wrap.
   */
  async getAddresses(): Promise<PlasmaAddresses> {
    return withOperation({
      error: AddressLookupError,
      info: { operation: 'getAddresses', mode: 'read' },
      run: () => this.resolveAddresses()
    });
  }

  /**
   * Process the exit queues of `tokens`, paying out every exit whose waiting
   * period has ended. One token calls `processExits`, several call
   * `processExitsBatch`. Name the token the exit was queued under: for a
   * native-token burn that is the legacy MATIC token, even though it pays POL
   * (a POL handle's `completeWithdraw` does that mapping for you).
   *
   * Throws `ExitQueueEmptyError`, sending nothing, when no token has a queued
   * exit; someone else may already have processed yours, so read
   * `getWithdrawStatus` before retrying. Without `options.gasLimit` the limit
   * is the node's estimate plus `PROCESS_EXITS_GAS_PER_EXIT` per queued
   * exit, capped at `MAX_PROCESS_EXITS_GAS_LIMIT`. A `gasLimit` below the
   * floor (`ON_FINALIZE_GAS_LIMIT + PRE_LOOP_GAS_ALLOWANCE`) cannot start the
   * contract's exit loop and is refused with `ExitGasLimitTooLowError`; one at
   * or above it is used exactly as given and can still process nothing.
   */
  async processExits(
    params: ProcessExitsParams,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    return withOperation({
      error: ExitError,
      info: { operation: 'processExits', mode: 'write' },
      run: () => this.withdrawManager.processExits(params, options)
    });
  }

  /**
   * Same as {@link processExits} but returns the unsigned `{ to, data, value? }`.
   *
   * **The sender MUST set the transaction's gas limit to at least
   * {@link getProcessExitsGasLimit}.** The result carries no gas, and a smart
   * wallet, batcher or bundler that sizes the transaction itself uses the
   * node's estimate, which is the gas the run used. The contract's exit loop
   * needs more than that at its start and stops silently, without reverting,
   * when it has less, so a transaction sized by the estimate alone succeeds
   * and processes nothing.
   */
  async prepareProcessExits(
    params: ProcessExitsParams,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return withOperation({
      error: ExitError,
      info: { operation: 'prepareProcessExits', mode: 'prepare' },
      run: () => this.withdrawManager.prepareProcessExits(params, options)
    });
  }

  /**
   * The gas limit {@link processExits} sends when you pass no `gasLimit`: the
   * node's estimate plus `PROCESS_EXITS_GAS_PER_EXIT` for every queued exit of
   * `tokens`, capped at `MAX_PROCESS_EXITS_GAS_LIMIT`. Use it as the gas limit
   * of a transaction you send from {@link prepareProcessExits}.
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
   * `processExits` does, when no token has a queued exit. A failure from
   * your library, wallet or RPC reaches you unchanged.
   */
  async getProcessExitsGasLimit(
    params: ProcessExitsParams,
    options: ContractCallerOptions = {}
  ): Promise<bigint> {
    return withOperation({
      error: ExitError,
      info: { operation: 'getProcessExitsGasLimit', mode: 'read' },
      run: () => this.withdrawManager.getProcessExitsGasLimit(params, options)
    });
  }

  /**
   * Where a burn stands on the exit path: `{ exited: true }`, or
   * `{ exited: false, reason }`, with the reason naming what the withdrawal
   * is waiting for (`'pending'`, `'not-checkpointed'`, `'not-confirmed'`,
   * `'in-exit-window'`, `'ready-to-process'`).
   *
   * Pass the transaction `confirmWithdraw` returned as `confirmTxHash`. The
   * contracts keep no lookup from a burn to its exit, so without it a
   * checkpointed burn reads `'not-confirmed'`, even when the exit was already
   * processed; that answer cannot tell 'never confirmed' from 'confirmed, hash
   * not supplied'. If you lost the hash, do not call `confirmWithdraw` again
   * (a new confirm for an exit that already exists reverts): find the confirm
   * transaction and pass its hash. `{ exited: true }` means the exit was
   * processed (its exit token is gone), not that the payout succeeded in full.
   *
   * Known limit: a chain reorganisation on the parent chain in the short
   * window between the exit's processing and this read can make the answer
   * briefly stale.
   * A node that is behind the block of the confirm transaction answers
   * `'in-exit-window'` from its own view, even when the exit is already
   * processed or its waiting period has ended; a later read from a node that
   * has caught up answers correctly.
   *
   * A `confirmTxHash` that did not
   * start an exit for this burn rejects with `ExitNotStartedError`, and so
   * does a burn whose receipt has no Plasma `Withdraw` log (a PoS burn passed
   * by mistake) with `LogNotFoundInReceiptError`. Both arrive as the `cause`
   * of the `BridgeStatusError` this method rejects with; find them with
   * `ExitNotStartedError.find(err)` and `LogNotFoundInReceiptError.find(err)`.
   * Without `confirmTxHash` the burn's log is never read.
   */
  async getWithdrawStatus(params: PlasmaWithdrawStatusParams): Promise<PlasmaWithdrawStatus> {
    return withOperation({
      error: BridgeStatusError,
      info: { operation: 'getWithdrawStatus', mode: 'read', burnTxHash: params.burnTxHash },
      run: () => this.readStatus(params)
    });
  }
}
