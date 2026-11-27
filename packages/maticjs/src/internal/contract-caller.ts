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
 * touched contracts to live somewhere in that hierarchy. The rewrite
 * replaces the chain with composition: each token class
 * (`ERC20`, `ERC721`, …) holds a `#caller` field and forwards through
 * it. The caller is an ECMAScript private field, not a TypeScript
 * `private` member or a doc-comment marker on a public one, so it is
 * neither reachable from JavaScript nor printed in the published type
 * declarations.
 *
 * # Typed against the ABI
 *
 * `ContractCaller<TAbi>` is generic over the contract's `as const` ABI.
 * `read`, `write`, `prepareWrite` and `estimateGas` accept only that ABI's
 * function names, each with its own argument list, and `read` returns the
 * type the ABI gives the result. A mistyped name, a missing argument or a
 * result of the wrong shape is therefore a compile error rather than a
 * failure in a consumer's production code. A call descriptor
 * (`{ method, args }`, typed `WriteCall`) lets a call builder choose
 * between two methods at run time without losing that tie. Method names
 * stay string literals at the call so they remain greppable.
 *
 * Every `read` result is validated and normalised by `decode.ts` against
 * the same ABI before any other code sees it; the type mapping in
 * `abi-types.ts` and that decoder are pinned together by a test over every
 * vendored function.
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
 *   override so callers can tune it per network.
 * - `chainId` is cached on the caller for the lifetime of the
 *   instance — re-reading it on every write would add an RPC round-
 *   trip with no benefit (chain IDs do not change at runtime).
 */

import type { Adapter, BlockTag, Hex, PreparedTx, TxResult, WriteRequest } from '../adapter.js';
import type { Logger } from '../logger.js';
import type {
  Abi,
  ReadArgs,
  ReadName,
  ReadResult,
  WriteArgs,
  WriteCall,
  WriteName
} from './abi-types.js';

import { Eip1559NotSupportedError, TxOptionNotObjectError } from '../errors.js';
import { isBuiltInAdapter } from './builtin-adapters.js';
import { decodeAbiResult } from './decode.js';

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

/**
 * Per-call settings only SDK code passes to {@link ContractCaller.write}.
 * They are a separate argument, not fields of `ContractCallerOptions`,
 * because that type is the public `TxOptions`: a field there would let any
 * consumer set it on any write.
 */
export interface InternalWriteSettings {
  /**
   * Fixed gas added on top of the multiplied estimate, for a call whose
   * estimate is known to undershoot. Ignored when `gasLimit` is supplied,
   * which always wins untouched.
   */
  gasHeadroom?: bigint;
}

export interface ContractCallerConfig<TAbi extends Abi> {
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
   * through unchanged. It also drives the validation of every read
   * result: `decode.ts` checks what a read returns against this ABI's
   * `outputs`.
   */
  abi: TAbi;
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
   * Exposed as a constructor option so consumers can
   * tune the headroom if they hit out-of-gas reverts on edge cases.
   */
  gasMultiplier?: number;
  /**
   * The chain this contract lives on, pinned from the network config.
   * Writes default to it instead of the chain id the RPC reports: an RPC
   * is not a trustworthy statement of which chain a signature will be
   * valid on. A per-call `options.chainId` still wins (forks).
   */
  chainId?: number;
}

const DEFAULT_GAS_MULTIPLIER = 1.15;

/** `typeof` the value, or `'null'` / `'array'`, for the options-rejection message. */
const receivedKind = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

/**
 * Plain-JS callers can hand `options` a string, array or `null`, which the
 * property reads below would silently treat as "no overrides" (or crash on
 * with an unrelated TypeError). 3.x rejected these up front; every method
 * calls this first so the rejection names the offending method. Exported for
 * the ERC-20 methods that read `options.spenderAddress` before reaching the
 * caller, where a `null` would otherwise fail as an unrelated TypeError.
 */
export const assertOptionsObject = ({
  method,
  options
}: {
  method: string;
  options: unknown;
}): void => {
  if (options !== null && typeof options === 'object' && !Array.isArray(options)) return;
  throw new TxOptionNotObjectError('Transaction options must be a plain object', {
    info: { method, received: receivedKind(options) }
  });
};

const argsOf = (value: unknown): readonly unknown[] => {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  throw new Error('internal invariant: contract call arguments must be an array');
};

/** What a write-side method acts on, whichever of its two call shapes it was given. */
interface WriteInvocation {
  method: string;
  args: readonly unknown[];
  options: ContractCallerOptions;
  internal: InternalWriteSettings;
}

// The two predicates name what `assertOptionsObject` and the shape check have
// already established, so the value can be used without a cast.
const isOptions = (value: unknown): value is ContractCallerOptions =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isInternalSettings = (value: unknown): value is InternalWriteSettings =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isCallDescriptor = (
  value: unknown
): value is { readonly method: string; readonly args: readonly unknown[] } =>
  value !== null &&
  typeof value === 'object' &&
  'method' in value &&
  typeof value.method === 'string' &&
  'args' in value &&
  Array.isArray(value.args);

/**
 * Sort the arguments of a write-side method into one record. The methods
 * take either `(method, args, options, internal)` or a `{ method, args }`
 * descriptor followed by `(options, internal)`: the descriptor lets a call
 * builder that picks between two methods at run time keep each method's
 * arguments tied to it in the type.
 */
const writeInvocationOf = ({
  operation,
  params
}: {
  operation: string;
  params: readonly unknown[];
}): WriteInvocation => {
  const [first, second, third, fourth] = params;
  let method: string;
  let args: readonly unknown[];
  let options: unknown;
  let internal: unknown;
  if (typeof first === 'string') {
    method = first;
    args = argsOf(second);
    options = third;
    internal = fourth;
  } else if (isCallDescriptor(first)) {
    method = first.method;
    args = first.args;
    options = second;
    internal = third;
  } else {
    throw new Error(
      `internal invariant: ${operation} needs a method name or a { method, args } call`
    );
  }
  const given = options === undefined ? {} : options;
  assertOptionsObject({ method: operation, options: given });
  return {
    method,
    args,
    options: isOptions(given) ? given : {},
    internal: isInternalSettings(internal) ? internal : {}
  };
};

export class ContractCaller<TAbi extends Abi> {
  private readonly adapter: Adapter;
  private readonly getAddress: () => Promise<Hex>;
  private readonly abi: TAbi;
  private readonly isParent: boolean;
  private readonly logger: Logger;
  private readonly defaultFrom: Hex | undefined;
  private readonly gasMultiplier: number;
  private readonly pinnedChainId: number | undefined;
  private cachedChainId: number | undefined;

  constructor(config: ContractCallerConfig<TAbi>) {
    this.adapter = config.adapter;
    this.getAddress = config.getAddress;
    this.abi = config.abi;
    this.isParent = config.isParent;
    this.logger = config.logger;
    this.defaultFrom = config.defaultFrom;
    this.gasMultiplier = config.gasMultiplier ?? DEFAULT_GAS_MULTIPLIER;
    this.pinnedChainId = config.chainId;
  }

  /** Resolve the current contract address (delegates to `getAddress`). */
  getContractAddress(): Promise<Hex> {
    return this.getAddress();
  }

  /**
   * Eth-call style read. The value the adapter returns is checked against
   * the ABI's `outputs` and normalised to one SDK value, so the same read
   * gives the same result on viem, ethers v5 and ethers v6. A value that
   * does not match the ABI rejects with `AdapterResultMismatchError`.
   */
  read<N extends ReadName<TAbi>>(
    method: N,
    args: ReadArgs<TAbi, N>,
    options?: ContractCallerOptions
  ): Promise<ReadResult<TAbi, N>>;
  // The implementation returns `unknown` and each overload names what the
  // ABI says that value is: `decodeAbiResult` walks the same ABI the types
  // are derived from, and a test over every vendored function pins the two
  // together. That is the one place the type is taken on trust.
  async read(
    method: string,
    args: readonly unknown[] = [],
    options: ContractCallerOptions = {}
  ): Promise<unknown> {
    assertOptionsObject({ method: 'read', options });
    const address = await this.getAddress();
    this.logger.debug(
      { contract: address, method, args, blockTag: options.blockTag },
      'contract read'
    );
    const raw = await this.adapter.read({
      address,
      abi: this.abi,
      functionName: method,
      args,
      ...(options.blockTag !== undefined ? { blockTag: options.blockTag } : {})
    });
    return decodeAbiResult({
      abi: this.abi,
      method,
      raw,
      builtIn: isBuiltInAdapter(this.adapter)
    });
  }

  /**
   * Estimate gas for the same shape as `write`. The result has the
   * gas multiplier applied so callers that pre-estimate (and pass the
   * value into `options.gasLimit`) get the same headroom that `write`
   * would compute internally.
   */
  estimateGas<N extends WriteName<TAbi>>(
    method: N,
    args: WriteArgs<TAbi, N>,
    options?: ContractCallerOptions
  ): Promise<bigint>;
  estimateGas(call: WriteCall<TAbi>, options?: ContractCallerOptions): Promise<bigint>;
  async estimateGas(...params: readonly unknown[]): Promise<bigint> {
    const { method, args, options } = writeInvocationOf({ operation: 'estimateGas', params });
    const address = await this.getAddress();
    return this.estimateFor({ address, method, args, options });
  }

  /**
   * Broadcast a write. Resolves the moment the chain accepts the tx;
   * call `result.confirmed()` to wait for the receipt.
   *
   * If `options.gasLimit` is omitted, the caller estimates internally
   * and applies the gas multiplier — preserving legacy behaviour.
   */
  write<N extends WriteName<TAbi>>(
    method: N,
    args: WriteArgs<TAbi, N>,
    options?: ContractCallerOptions,
    internal?: InternalWriteSettings
  ): Promise<TxResult>;
  write(
    call: WriteCall<TAbi>,
    options?: ContractCallerOptions,
    internal?: InternalWriteSettings
  ): Promise<TxResult>;
  async write(...params: readonly unknown[]): Promise<TxResult> {
    const { method, args, options, internal } = writeInvocationOf({ operation: 'write', params });
    const address = await this.getAddress();
    // The pinned id is the expectation every adapter checks the signer
    // against; the RPC's own answer is only a fallback for callers that
    // built this without a network config.
    const chainId = options.chainId ?? this.pinnedChainId ?? (await this.getChainId());
    const isMaxFeeProvided =
      options.maxFeePerGas !== undefined || options.maxPriorityFeePerGas !== undefined;
    if (isMaxFeeProvided && !isEIP1559Supported(chainId)) {
      throw new Eip1559NotSupportedError(
        `${this.isParent ? 'Root' : 'Child'} chain (${chainId}) does not support EIP-1559`,
        { info: { chainId, isParent: this.isParent } }
      );
    }

    const gasLimit =
      options.gasLimit ??
      (await this.estimateFor({ address, method, args, options })) + (internal.gasHeadroom ?? 0n);

    const req: WriteRequest = {
      address,
      abi: this.abi,
      functionName: method,
      args,
      from: options.from ?? this.defaultFrom,
      value: options.value,
      gasLimit,
      maxFeePerGas: options.maxFeePerGas,
      maxPriorityFeePerGas: options.maxPriorityFeePerGas,
      nonce: options.nonce,
      chainId
    };

    this.logger.debug({ contract: address, method, args, chainId }, 'contract write');
    return this.adapter.write(req);
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
  prepareWrite<N extends WriteName<TAbi>>(
    method: N,
    args: WriteArgs<TAbi, N>,
    options?: ContractCallerOptions
  ): Promise<PreparedTx>;
  prepareWrite(call: WriteCall<TAbi>, options?: ContractCallerOptions): Promise<PreparedTx>;
  async prepareWrite(...params: readonly unknown[]): Promise<PreparedTx> {
    const { method, args, options } = writeInvocationOf({ operation: 'prepareWrite', params });
    const address = await this.getAddress();
    const req: WriteRequest = {
      address,
      abi: this.abi,
      functionName: method,
      args,
      from: options.from ?? this.defaultFrom,
      value: options.value
    };
    this.logger.debug({ contract: address, method, args }, 'contract prepareWrite');
    return this.adapter.prepareWrite(req);
  }

  /** The gas estimate with the multiplier applied, for an address already resolved. */
  private async estimateFor({
    address,
    method,
    args,
    options
  }: {
    address: Hex;
    method: string;
    args: readonly unknown[];
    options: ContractCallerOptions;
  }): Promise<bigint> {
    const req = this.minimalWriteRequest(address, method, args, options);
    const raw = await this.adapter.estimateGas(req);
    return BigInt(Math.trunc(Number(raw) * this.gasMultiplier));
  }

  /**
   * Build the minimal request shape the adapter's `estimateGas` needs.
   * Intentionally omits `gasLimit` (we're computing it) and the fee
   * caps (estimateGas does not need them — the underlying RPC
   * `eth_estimateGas` ignores fee fields).
   */
  private minimalWriteRequest(
    address: Hex,
    method: string,
    args: readonly unknown[],
    options: ContractCallerOptions
  ): WriteRequest {
    return {
      address,
      abi: this.abi,
      functionName: method,
      args,
      from: options.from ?? this.defaultFrom,
      value: options.value
    };
  }

  private async getChainId(): Promise<number> {
    if (this.cachedChainId === undefined) {
      this.cachedChainId = await this.adapter.getChainId();
    }
    return this.cachedChainId;
  }
}

/**
 * EIP-1559 support oracle.
 *
 * This is a permissive default (`true`) — every chain
 * the SDK currently touches (Ethereum mainnet/Sepolia, Polygon
 * mainnet/Amoy) supports EIP-1559. The legacy SDK pluggably checked a
 * runtime list; the rewrite folds that into a single function so a
 * future change can introduce a per-chain override map without
 * redistributing the check across every call site.
 *
 * Returning `false` here flips writes that supply `maxFeePerGas` or
 * `maxPriorityFeePerGas` to throw `Eip1559NotSupportedError`,
 * preserving the legacy guard's signal.
 */
function isEIP1559Supported(_chainId: number): boolean {
  return true;
}
