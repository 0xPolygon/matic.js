/**
 * `ContractCaller` is the read/write/estimate front-door for every
 * contract the SDK touches.
 *
 * # Why this service exists
 *
 * The legacy SDK extended a four-deep inheritance chain
 * (`BaseToken → POSToken → ERC20 / ERC721 / ERC1155`) where the base
 * class owned all the transaction plumbing — fee-cap validation, gas
 * estimation, chain-id lookups, payload assembly. Every concrete
 * token class inherited that surface, which forced *all* code that
 * touched contracts to live somewhere in that hierarchy. Stage 2
 * dismantles the chain in favour of composition: each token class
 * (`ERC20`, `ERC721`, …) holds a `private caller: ContractCaller`
 * and forwards through it.
 *
 * # Design notes
 *
 * - `getAddress` is a callback rather than a static field so
 *   infrastructure contracts route through `AddressFetcher.get()` and
 *   pick up TTL refreshes when the published address index changes.
 *   For user-supplied token addresses the consumer passes
 *   `() => Promise.resolve(addr)` and pays no per-call cost.
 * - Every public method awaits `getAddress()` first. The address is
 *   not cached on the caller instance — caching belongs in the
 *   underlying `AddressFetcher`, which already implements
 *   stale-while-revalidate.
 * - The gas multiplier (`1.15` by default) preserves the legacy
 *   behaviour from `base_token.ts:190`. It accepts an optional
 *   override so future stages can tune per-network.
 * - `chainId` is cached on the caller for the lifetime of the
 *   instance — re-reading it on every write would add an RPC round-
 *   trip with no benefit (chain IDs do not change at runtime).
 */

import type { Adapter, BlockTag, Hex, PreparedTx, TxResult, WriteRequest } from '../adapter.js';
import type { Logger } from '../logger.js';

import { POSBridgeError } from '../errors.js';

/**
 * Per-call overrides for read / write / estimateGas.
 *
 * Mirrors the subset of `WriteRequest` that callers might want to
 * change on a per-call basis (sender, value, gas limit, nonce, fee
 * caps). The contract address, ABI, and function name are owned by
 * the `ContractCaller` instance — overriding them per-call would
 * defeat the encapsulation.
 */
export interface ContractCallerOptions {
  /** Sender override; falls back to `defaultFrom` on the caller. */
  from?: Hex;
  /** Wei value to attach. Required for `payable` writes. */
  value?: bigint;
  /** Gas limit override; when omitted, the caller estimates and applies the multiplier. */
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
  /** Expected chain ID; rejection guard against cross-chain mis-sends. */
  chainId?: number;
  /**
   * Block tag a READ is pinned to (ignored by write / estimateGas).
   * Checkpoint and root-block lookups pass `'safe'` to avoid reorg
   * races; omit for the client's default (`'latest'`).
   */
  blockTag?: BlockTag;
}

export interface ContractCallerConfig {
  adapter: Adapter;
  /**
   * Resolves the contract's current address. Consumers of an
   * infrastructure contract pass a callback that delegates to
   * `AddressFetcher.get()` so TTL refreshes are picked up; consumers
   * of a user-supplied token address pass `() => Promise.resolve(addr)`.
   */
  getAddress: () => Promise<Hex>;
  /**
   * ABI fragment for this contract. The adapter narrows internally —
   * each library has its own ABI shape. The runtime value flows
   * through unchanged.
   */
  abi: readonly unknown[];
  /**
   * `true` for parent-chain (Ethereum mainnet / Sepolia) contracts;
   * `false` for child-chain (Polygon) contracts. Used by the EIP-1559
   * support guard so the error message identifies the offending chain.
   */
  isParent: boolean;
  logger: Logger;
  /** Default sender used when no per-call `from` override is supplied. */
  defaultFrom?: Hex;
  /**
   * Multiplier applied to gas estimates. Defaults to `1.15` to match
   * the hard-coded multiplier in the legacy `base_token.ts` (line 190).
   * Stage 2 surfaces this as a constructor option so consumers can
   * tune the headroom if they hit out-of-gas reverts on edge cases.
   */
  gasMultiplier?: number;
}

const DEFAULT_GAS_MULTIPLIER = 1.15;

export class ContractCaller {
  readonly #adapter: Adapter;
  readonly #getAddress: () => Promise<Hex>;
  readonly #abi: readonly unknown[];
  readonly #isParent: boolean;
  readonly #logger: Logger;
  readonly #defaultFrom: Hex | undefined;
  readonly #gasMultiplier: number;
  #cachedChainId: number | undefined;

  constructor(config: ContractCallerConfig) {
    this.#adapter = config.adapter;
    this.#getAddress = config.getAddress;
    this.#abi = config.abi;
    this.#isParent = config.isParent;
    this.#logger = config.logger;
    this.#defaultFrom = config.defaultFrom;
    this.#gasMultiplier = config.gasMultiplier ?? DEFAULT_GAS_MULTIPLIER;
  }

  /** Resolve the current contract address (delegates to `getAddress`). */
  getContractAddress(): Promise<Hex> {
    return this.#getAddress();
  }

  /**
   * Eth-call style read. Returns `T` cast from the adapter's `unknown`
   * — callers must pass the expected return type at the call site.
   */
  async read<T>(
    method: string,
    args: readonly unknown[] = [],
    options: ContractCallerOptions = {}
  ): Promise<T> {
    const address = await this.#getAddress();
    this.#logger.debug({ contract: address, method, args, blockTag: options.blockTag }, 'contract read');
    const result = await this.#adapter.read({
      address,
      abi: this.#abi,
      functionName: method,
      args,
      ...(options.blockTag !== undefined ? { blockTag: options.blockTag } : {})
    });
    return result as T;
  }

  /**
   * Estimate gas for the same shape as `write`. The result has the
   * gas multiplier applied so callers that pre-estimate (and pass the
   * value into `options.gasLimit`) get the same headroom that `write`
   * would compute internally.
   */
  async estimateGas(
    method: string,
    args: readonly unknown[] = [],
    options: ContractCallerOptions = {}
  ): Promise<bigint> {
    const address = await this.#getAddress();
    const req = this.#minimalWriteRequest(address, method, args, options);
    const raw = await this.#adapter.estimateGas(req);
    return BigInt(Math.trunc(Number(raw) * this.#gasMultiplier));
  }

  /**
   * Broadcast a write. Resolves the moment the chain accepts the tx;
   * call `result.confirmed()` to wait for the receipt.
   *
   * If `options.gasLimit` is omitted, the caller estimates internally
   * and applies the gas multiplier — preserving legacy behaviour.
   */
  async write(
    method: string,
    args: readonly unknown[] = [],
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    const address = await this.#getAddress();
    const chainId = await this.#getChainId();
    const isMaxFeeProvided =
      options.maxFeePerGas !== undefined || options.maxPriorityFeePerGas !== undefined;
    if (isMaxFeeProvided && !isEIP1559Supported(chainId)) {
      throw new POSBridgeError(
        'EIP1559_NOT_SUPPORTED',
        `${this.#isParent ? 'Root' : 'Child'} chain (${chainId}) does not support EIP-1559`,
        { chainId, isParent: this.#isParent }
      );
    }

    const gasLimit =
      options.gasLimit ?? (await this.estimateGas(method, args, options));

    const req: WriteRequest = {
      address,
      abi: this.#abi,
      functionName: method,
      args,
      from: options.from ?? this.#defaultFrom,
      value: options.value,
      gasLimit,
      maxFeePerGas: options.maxFeePerGas,
      maxPriorityFeePerGas: options.maxPriorityFeePerGas,
      nonce: options.nonce,
      chainId: options.chainId ?? chainId
    };

    this.#logger.debug({ contract: address, method, args, chainId }, 'contract write');
    return this.#adapter.write(req);
  }

  /**
   * Encode a write without broadcasting it. The result is the
   * `{ to, data, value? }` shape consumers forward to a smart-contract
   * wallet, batch with other ops, or sign through an external path.
   *
   * Unlike `write()`, this never touches the network — no chain-id
   * lookup, no gas estimation, no fee-cap guard. The wallet that
   * eventually signs the prepared tx fills those in.
   */
  async prepareWrite(
    method: string,
    args: readonly unknown[] = [],
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    const address = await this.#getAddress();
    const req: WriteRequest = {
      address,
      abi: this.#abi,
      functionName: method,
      args,
      from: options.from ?? this.#defaultFrom,
      value: options.value
    };
    this.#logger.debug({ contract: address, method, args }, 'contract prepareWrite');
    return this.#adapter.prepareWrite(req);
  }

  /**
   * Build the minimal request shape the adapter's `estimateGas` needs.
   * Intentionally omits `gasLimit` (we're computing it) and the fee
   * caps (estimateGas does not need them — the underlying RPC
   * `eth_estimateGas` ignores fee fields).
   */
  #minimalWriteRequest(
    address: Hex,
    method: string,
    args: readonly unknown[],
    options: ContractCallerOptions
  ): WriteRequest {
    return {
      address,
      abi: this.#abi,
      functionName: method,
      args,
      from: options.from ?? this.#defaultFrom,
      value: options.value
    };
  }

  async #getChainId(): Promise<number> {
    if (this.#cachedChainId === undefined) {
      this.#cachedChainId = await this.#adapter.getChainId();
    }
    return this.#cachedChainId;
  }
}

/**
 * EIP-1559 support oracle.
 *
 * Stage 2 ships this as a permissive default (`true`) — every chain
 * the SDK currently touches (Ethereum mainnet/Sepolia, Polygon
 * mainnet/Amoy) supports EIP-1559. The legacy SDK pluggably checked a
 * runtime list; the rewrite folds that into a single function so a
 * future stage can introduce a per-chain override map without
 * redistributing the check across every call site.
 *
 * Returning `false` here flips writes that supply `maxFeePerGas` or
 * `maxPriorityFeePerGas` to throw `POSBridgeError('EIP1559_NOT_SUPPORTED')`,
 * preserving the legacy guard's signal.
 */
function isEIP1559Supported(_chainId: number): boolean {
  return true;
}
