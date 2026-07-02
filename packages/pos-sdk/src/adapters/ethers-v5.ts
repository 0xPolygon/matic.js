import type { BigNumber, ContractInterface, Signer, providers } from 'ethers-v5';

import { keccak256 as keccak256Bytes } from 'ethereum-cryptography/keccak';
import { bytesToHex, hexToBytes } from 'ethereum-cryptography/utils';
import { Contract, utils as ethersUtils } from 'ethers-v5';

import type { Adapter, Hex, PreparedTx, ReadRequest, Receipt, ReceiptLog, TxResult, WriteRequest } from '../adapter.js';

import { POSBridgeError } from '../errors.js';

/**
 * Constructor params for {@link EthersV5Adapter}.
 *
 * The provider is required (used for read calls and chain-id queries);
 * the signer is required only for `write()` / `estimateGas()` paths
 * that need an authenticated origin.
 */
export interface EthersV5AdapterConfig {
  provider: providers.Provider;
  signer?: Signer;
}

/**
 * ethers v5 implementation of {@link Adapter}.
 *
 * # bigint ↔ BigNumber conversion
 *
 * ethers v5 returns `BigNumber` for every numeric value (gas, balances,
 * receipt block numbers via `.toNumber()` semantics, etc.). Our
 * Adapter contract speaks native `bigint`. Conversion happens at this
 * layer:
 *
 * - **Inputs (`bigint` → `BigNumber`):** v5's `BigNumberish` already
 *   accepts `bigint`, so values pass through `BigNumber.from()` only
 *   when the v5 API explicitly requires it. The `Contract` instance
 *   handles BigNumberish coercion for us in the common case; explicit
 *   `BigNumber.from(...)` calls remain for documentation purposes
 *   wherever the boundary is non-obvious.
 * - **Outputs (`BigNumber` → `bigint`):** every numeric return is
 *   piped through `.toBigInt()` before leaving the adapter. v5 has
 *   exposed `toBigInt()` since 5.6.0 so the peer-dep range
 *   `^5.5.1 || ^6.0.0` is updated to `^5.6.0 || ^6.0.0` in stage 8.
 *
 * # Why a static value-import is safe here
 *
 * `ethers` is an OPTIONAL peer dep, but this module lives behind its own
 * package subpath (`@polygonlabs/pos-sdk/ethers-v5`). Only a consumer who
 * has chosen ethers v5 — and therefore installed it — ever imports this
 * file, so a top-level value-import always resolves. The main SDK entry
 * imports NO web3 library, so a viem-only consumer never pulls ethers in.
 *
 * The source imports `Contract` / `utils` from the `ethers-v5` devDep
 * alias (a pinned `npm:ethers@5`) so the compiler sees the genuine v5
 * surface. The tsup build rewrites that specifier to the bare `ethers`
 * the consumer actually installs (see `tsup.config.ts`). This replaces
 * the old dynamic `await import('ethers')` that existed only to keep the
 * combined adapter barrel evaluable when ethers was absent.
 */
export class EthersV5Adapter implements Adapter {
  readonly #provider: providers.Provider;
  readonly #signer: Signer | undefined;
  #chainId: number | undefined;

  constructor(config: EthersV5AdapterConfig) {
    this.#provider = config.provider;
    this.#signer = config.signer;
  }

  async getChainId(): Promise<number> {
    if (this.#chainId === undefined) {
      const network = await this.#provider.getNetwork();
      this.#chainId = network.chainId;
    }
    return this.#chainId;
  }

  async read(req: ReadRequest): Promise<unknown> {
    const contract = this.#contractFor(req.address, req.abi, this.#provider);
    const fn = contract[req.functionName];
    if (typeof fn !== 'function') {
      // Internal invariant: every method the SDK reads is declared in a
      // vendored `as const` ABI, so a miss here means the SDK passed a
      // function name the ABI doesn't carry — our bug, not a consumer
      // condition. Throw a plain Error so it stays out of the typed
      // consumer `POSBridgeErrorCode` union.
      throw new Error(
        `internal invariant: function ${req.functionName} not found on ABI for ${req.address}`
      );
    }
    // ethers v5 view calls accept a trailing call-overrides object; pass
    // `{ blockTag }` to pin the read. A bigint pins an exact height (v5's
    // blockTag accepts a hex-quantity string for that); the string tags
    // pass through unchanged.
    const callArgs = buildReadArgs(req);
    return await (fn as (...args: unknown[]) => Promise<unknown>)(...callArgs);
  }

  async write(req: WriteRequest): Promise<TxResult> {
    const signer = this.#signer;
    if (signer === undefined) {
      throw new POSBridgeError(
        'WEB3_CLIENT_NOT_INITIALIZED',
        'EthersV5Adapter has no signer; pass `signer` to support writes.'
      );
    }

    const contract = this.#contractFor(req.address, req.abi, signer);
    const overrides = buildOverrides(req);
    const fn = contract[req.functionName];
    if (typeof fn !== 'function') {
      // See `read` — internal invariant violation, not a consumer condition.
      throw new Error(
        `internal invariant: function ${req.functionName} not found on ABI for ${req.address}`
      );
    }
    // ethers v5's Contract method signature accepts a trailing overrides
    // object. Cast at the boundary to keep the public Adapter shape
    // free of v5-specific types.
    const tx = (await (fn as (...args: unknown[]) => Promise<unknown>)(
      ...(req.args ?? []),
      overrides
    )) as providers.TransactionResponse;

    const hash = tx.hash as Hex;

    let receiptPromise: Promise<Receipt> | undefined;
    const confirmed = (): Promise<Receipt> => {
      // Memoised: tx.wait() is only safe to call once on the response
      // object before the inner promise resolves; subsequent callers
      // share the same resolved value.
      if (receiptPromise === undefined) {
        receiptPromise = tx.wait().then((r) => normaliseReceipt(r));
      }
      return receiptPromise;
    };

    return { hash, confirmed };
  }

  async prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    // v5 exposes `Interface` under `utils`. Imported statically at module
    // top (see class docstring); this file only loads for ethers-v5
    // consumers, so the import always resolves. v5's `Interface`
    // constructor types its parameter more narrowly than the broad
    // `ContractInterface` the consumer ABI is shaped as (which also
    // admits a pre-built Interface) — cast the ctor at the boundary, the
    // same pattern `#contractFor` uses for `Contract`.
    const InterfaceCtor = ethersUtils.Interface as unknown as new (
      abi: ContractInterface
    ) => { encodeFunctionData(name: string, args?: readonly unknown[]): string };
    const iface = new InterfaceCtor(req.abi as ContractInterface);
    const data = iface.encodeFunctionData(req.functionName, req.args ?? undefined) as Hex;
    return req.value !== undefined
      ? { to: req.address, data, value: req.value }
      : { to: req.address, data };
  }

  async estimateGas(req: WriteRequest): Promise<bigint> {
    const runner = this.#signer ?? this.#provider;
    const contract = this.#contractFor(req.address, req.abi, runner);
    const overrides = buildOverrides(req);
    const estimateBag = (contract.estimateGas ?? {}) as Record<string, (...a: unknown[]) => Promise<BigNumber>>;
    const estimateFn = estimateBag[req.functionName];
    if (typeof estimateFn !== 'function') {
      // See `read` — internal invariant violation, not a consumer condition.
      throw new Error(
        `internal invariant: estimateGas missing for ${req.functionName} on ${req.address}`
      );
    }
    const gas: BigNumber = await estimateFn(...(req.args ?? []), overrides);
    return gas.toBigInt();
  }

  async getTransactionReceipt(hash: string): Promise<Receipt | null> {
    const r = await this.#provider.getTransactionReceipt(hash);
    // v5 returns `null` (not undefined) when the tx isn't mined yet,
    // but the type lies about this — runtime null check is required.
    if (r === null || r === undefined) return null;
    return normaliseReceipt(r);
  }

  keccak256(data: Uint8Array | string): string {
    const bytes = typeof data === 'string' ? hexToBytes(stripHexPrefix(data)) : data;
    return `0x${bytesToHex(keccak256Bytes(bytes))}`;
  }

  async request<T>(method: string, params: readonly unknown[]): Promise<T> {
    // v5's abstract `Provider` doesn't expose `send`; only JSON-RPC
    // descendants do. The bridge fundamentally needs RPC access, so
    // consumers passing a non-JSON-RPC provider here get a clear
    // runtime error rather than a confusing "no such method".
    const sendable = this.#provider as unknown as {
      send?: (method: string, params: readonly unknown[]) => Promise<unknown>;
    };
    if (typeof sendable.send !== 'function') {
      throw new POSBridgeError(
        'WEB3_CLIENT_NOT_INITIALIZED',
        'EthersV5Adapter provider has no `send` method; pass a JsonRpcProvider for bridge flows.',
        { method }
      );
    }
    return (await sendable.send(method, params)) as T;
  }

  #contractFor(
    address: Hex,
    abi: ReadRequest['abi'],
    runner: providers.Provider | Signer
  ): Record<string, unknown> & { estimateGas?: Record<string, unknown> } {
    // `Contract` is imported statically at module top (see class
    // docstring). Cast the indexable method surface at the boundary so
    // the public Adapter shape stays free of v5-specific contract types.
    const ContractCtor = Contract as unknown as new (a: string, b: ContractInterface, r: unknown) => unknown;
    return new ContractCtor(address, abi as ContractInterface, runner) as Record<string, unknown> & { estimateGas?: Record<string, unknown> };
  }
}

/**
 * Construct an ethers-v5-backed {@link Adapter} for `POSClient.init`.
 *
 * This factory is the public entry point at
 * `@polygonlabs/pos-sdk/ethers-v5`. Consumers pass the constructed
 * `ethersV5Adapter(...)` result as `POSClientConfig.parent` / `.child`.
 *
 * ```ts
 * import { ethersV5Adapter } from '@polygonlabs/pos-sdk/ethers-v5';
 * parent: ethersV5Adapter({ provider, signer })
 * ```
 */
export function ethersV5Adapter(config: EthersV5AdapterConfig): Adapter {
  return new EthersV5Adapter(config);
}

/**
 * Build v5 transaction overrides from our provider-agnostic shape.
 *
 * v5's `Overrides` accepts `BigNumberish`, which includes `bigint`
 * since 5.6.0 — so the `bigint` values pass through unchanged. The
 * conversion happens implicitly via `BigNumber.from()` inside ethers.
 */
/**
 * Build the positional args for a view call, appending a `{ blockTag }`
 * call-overrides object only when the read pins to a non-default tag.
 * ethers' `blockTag` accepts string tags ('safe'/'finalized'/'latest')
 * and a hex-quantity for an exact height.
 */
const buildReadArgs = (req: ReadRequest): unknown[] => {
  const args = [...(req.args ?? [])];
  if (req.blockTag === undefined) return args;
  const blockTag =
    typeof req.blockTag === 'bigint' ? `0x${req.blockTag.toString(16)}` : req.blockTag;
  args.push({ blockTag });
  return args;
};

const buildOverrides = (req: WriteRequest): Record<string, unknown> => {
  const o: Record<string, unknown> = {};
  if (req.from !== undefined) o.from = req.from;
  if (req.value !== undefined) o.value = req.value;
  if (req.gasLimit !== undefined) o.gasLimit = req.gasLimit;
  if (req.maxFeePerGas !== undefined) o.maxFeePerGas = req.maxFeePerGas;
  if (req.maxPriorityFeePerGas !== undefined) o.maxPriorityFeePerGas = req.maxPriorityFeePerGas;
  if (req.nonce !== undefined) o.nonce = req.nonce;
  if (req.chainId !== undefined) o.chainId = req.chainId;
  return o;
};

/**
 * Normalise v5's receipt to our minimal shape. Everything numeric is
 * piped through `.toBigInt()` (or `BigInt(...)` for `number` fields
 * v5 already returns as JS numbers, like `blockNumber`).
 */
const normaliseReceipt = (r: providers.TransactionReceipt): Receipt => ({
  transactionHash: r.transactionHash as Hex,
  status: r.status === 1 ? 'success' : 'reverted',
  // v5's receipt has `blockNumber: number` — coerce to bigint for
  // contract-shape parity with viem and v6 receipts.
  blockNumber: BigInt(r.blockNumber),
  logs: r.logs.map<ReceiptLog>((log) => ({
    address: log.address as Hex,
    topics: log.topics as readonly Hex[],
    data: log.data as Hex,
    logIndex: log.logIndex
  }))
});

const stripHexPrefix = (s: string): string => (s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s);
