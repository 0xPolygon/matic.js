import type { BigNumber, ContractInterface, Signer } from 'ethers-v5';

import { keccak_256 as keccak256Bytes } from '@noble/hashes/sha3.js';
import { Contract, utils as ethersUtils, providers } from 'ethers-v5';

import type {
  Adapter,
  Hex,
  PreparedTx,
  ReadRequest,
  Receipt,
  ReceiptLog,
  TxResult,
  WriteRequest
} from '../adapter.js';
import type { WaitOutcome } from '../internal/confirmation.js';

import { POSBridgeError } from '../errors.js';
import { memoiseConfirmation } from '../internal/confirmation.js';
import { bytesToHex, hexToBytes } from '../utils/bytes.js';

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
 *   exposed `toBigInt()` since 5.6.0, which is why the peer-dep range
 *   is `^5.6.0 || ^6.0.0`.
 *
 * # Why a static value-import is safe here
 *
 * `ethers` is an OPTIONAL peer dep, but this module lives behind its own
 * package subpath (`@polygonlabs/maticjs/ethers-v5`). Only a consumer who
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
  /**
   * The exact ethers v5 provider you passed to the factory — exposed read-only so
   * consumers can inspect wiring, compare identity (`adapter.provider ===
   * mine`), or reach the underlying client for unwrapped calls. SDK
   * internals are `private` (typed-API-hidden) rather than hard-`#`:
   * an SDK has no security boundary against its own consumer, and
   * plain properties keep instances debuggable and Proxy-safe.
   */
  readonly provider: providers.Provider;
  readonly signer: Signer | undefined;
  private chainId: number | undefined;

  constructor(config: EthersV5AdapterConfig) {
    this.provider = config.provider;
    this.signer = config.signer;
  }

  async getChainId(): Promise<number> {
    if (this.chainId === undefined) {
      const network = await this.provider.getNetwork();
      this.chainId = network.chainId;
    }
    return this.chainId;
  }

  async read(req: ReadRequest): Promise<unknown> {
    const contract = this.contractFor(req.address, req.abi, this.provider);
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
    const signer = this.signer;
    if (signer === undefined) {
      throw new POSBridgeError(
        'WEB3_CLIENT_NOT_INITIALIZED',
        'EthersV5Adapter has no signer; pass `signer` to support writes.'
      );
    }

    await this.assertChainId(signer, req.chainId);

    const contract = this.contractFor(req.address, req.abi, signer);
    const fees = signsRemotely(signer) ? {} : await this.resolveFees({ req, signer });
    const overrides = buildOverrides({ ...req, ...fees });
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

    // v5's wait() rejects both a revert (CALL_EXCEPTION) and a replacement
    // (TRANSACTION_REPLACED), each carrying the receipt that mined. Turn
    // both back into an outcome so the shared wrapper decides: a revert
    // raises TRANSACTION_REVERTED, a fee bump counts as the original, and a
    // cancel or replacement raises TRANSACTION_REPLACED. Any other
    // rejection (an RPC failure) passes through unchanged.
    const confirmed = memoiseConfirmation({
      hash,
      wait: () =>
        tx.wait().then(
          (r): WaitOutcome => ({ receipt: normaliseReceipt(r) }),
          async (err: unknown): Promise<WaitOutcome> => {
            const replaced = replacedOutcome(err);
            if (replaced !== undefined) return replaced;
            if (isCallException(err)) {
              // Prefer the receipt the error carries: the signer's node has
              // already seen it, while the read provider may lag behind.
              const carried = callExceptionReceipt(err);
              if (carried !== undefined) return { receipt: normaliseReceipt(carried) };
              const r = await this.provider.getTransactionReceipt(hash);
              if (r !== null && r !== undefined && r.status === 0) {
                return { receipt: normaliseReceipt(r) };
              }
            }
            throw err;
          }
        )
    });

    return { hash, confirmed };
  }

  async prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    // v5 exposes `Interface` under `utils`. Imported statically at module
    // top (see class docstring); this file only loads for ethers-v5
    // consumers, so the import always resolves. v5's `Interface`
    // constructor types its parameter more narrowly than the broad
    // `ContractInterface` the consumer ABI is shaped as (which also
    // admits a pre-built Interface) — cast the ctor at the boundary, the
    // same pattern `contractFor` uses for `Contract`.
    const InterfaceCtor = ethersUtils.Interface as unknown as new (abi: ContractInterface) => {
      encodeFunctionData(name: string, args?: readonly unknown[]): string;
    };
    const iface = new InterfaceCtor(req.abi as ContractInterface);
    const data = iface.encodeFunctionData(req.functionName, req.args ?? undefined) as Hex;
    return req.value !== undefined
      ? { to: req.address, data, value: req.value }
      : { to: req.address, data };
  }

  async estimateGas(req: WriteRequest): Promise<bigint> {
    const runner = this.signer ?? this.provider;
    const contract = this.contractFor(req.address, req.abi, runner);
    const overrides = buildOverrides(req);
    const estimateBag = (contract.estimateGas ?? {}) as Record<
      string,
      (...a: unknown[]) => Promise<BigNumber>
    >;
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
    const r = await this.provider.getTransactionReceipt(hash);
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
    const sendable = this.provider as unknown as {
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

  /**
   * Fill in the EIP-1559 priority fee (tip) when the caller gave none.
   *
   * ethers v5's own fee data uses a fixed tip that is below the minimum
   * some chains (Polygon PoS among them) enforce, so leaving the tip to
   * ethers underprices the transaction. Ask the node instead, as ethers v6
   * and viem do. A caller-supplied tip always wins and is passed through.
   * Runs only for signers that sign locally; see {@link signsRemotely}.
   */
  private async resolveFees({
    req,
    signer
  }: {
    req: WriteRequest;
    signer: Signer;
  }): Promise<Pick<WriteRequest, 'maxFeePerGas' | 'maxPriorityFeePerGas'>> {
    const passthrough = {
      maxFeePerGas: req.maxFeePerGas,
      maxPriorityFeePerGas: req.maxPriorityFeePerGas
    };
    if (req.maxPriorityFeePerGas !== undefined) return passthrough;

    const feeData = await this.provider.getFeeData();
    // No EIP-1559 fee data means the chain has no base fee: leave the
    // request untouched so ethers prices it with gasPrice exactly as before.
    if (feeData.maxFeePerGas === null || feeData.maxPriorityFeePerGas === null) return passthrough;

    // Already resolved by the chain guard, so this costs no RPC call.
    const chainId = req.chainId ?? (await this.getChainId());
    const tip = await this.fetchPriorityFee({ signer, chainId });
    if (req.maxFeePerGas !== undefined) {
      // The caller's fee cap is a hard ceiling, and nodes reject a tip above
      // the cap. The protocol never pays more than (maxFee − baseFee) as tip
      // anyway, so capping the tip at maxFee prices the transaction exactly
      // as the caller's ceiling allows rather than failing it.
      return {
        maxFeePerGas: req.maxFeePerGas,
        maxPriorityFeePerGas: tip < req.maxFeePerGas ? tip : req.maxFeePerGas
      };
    }
    // ethers derives its cap as (base-fee headroom) + (its fixed tip). Keep
    // ethers' base-fee headroom and add the node's tip instead, so the cap
    // always covers the tip (maxFee ≥ tip) however high the node's tip is,
    // and base-fee volatility is absorbed exactly as it was before.
    const baseFeeHeadroom = feeData.maxFeePerGas.sub(feeData.maxPriorityFeePerGas).toBigInt();
    return { maxFeePerGas: baseFeeHeadroom + tip, maxPriorityFeePerGas: tip };
  }

  /**
   * Query `eth_maxPriorityFeePerGas`. Fails loudly rather than falling
   * back: like every other RPC failure in this adapter the error reaches
   * the caller, and the only fallback available here is ethers' fixed tip,
   * i.e. silently sending the underpriced transaction this exists to
   * prevent. Callers whose node lacks the method can pass
   * `maxPriorityFeePerGas` explicitly, which skips the query.
   *
   * The query needs a JSON-RPC provider. A read provider without `send`
   * (a `FallbackProvider`, as `getDefaultProvider` returns) cannot make it,
   * so the signer's own provider is asked instead; the transaction is
   * broadcast through that provider anyway.
   */
  private async fetchPriorityFee({
    signer,
    chainId
  }: {
    signer: Signer;
    chainId: number;
  }): Promise<bigint> {
    const method = 'eth_maxPriorityFeePerGas';
    const send = jsonRpcSendOf(this.provider) ?? jsonRpcSendOf(signer.provider);
    if (send === undefined) {
      throw new POSBridgeError(
        'FEE_ESTIMATION_FAILED',
        `EthersV5Adapter cannot query ${method}: neither the adapter's provider nor the signer's provider is a JSON-RPC provider; pass maxPriorityFeePerGas explicitly`,
        { method, chainId }
      );
    }
    let raw: unknown;
    try {
      raw = await send(method, []);
    } catch (err) {
      throw new POSBridgeError(
        'FEE_ESTIMATION_FAILED',
        `EthersV5Adapter could not fetch the priority fee via ${method}; pass maxPriorityFeePerGas explicitly if the node does not support it`,
        { method, chainId },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) {
      throw new POSBridgeError(
        'FEE_ESTIMATION_FAILED',
        `EthersV5Adapter received a malformed ${method} response; pass maxPriorityFeePerGas explicitly`,
        { method, chainId, response: String(raw) }
      );
    }
    return BigInt(raw);
  }

  /**
   * The cross-chain mis-send guard: reject before broadcasting when the
   * SIGNER is not on the expected chain. The expected chain is
   * `WriteRequest.chainId` when the caller pins one, else the chain the
   * adapter's provider reads from — a write signed on one chain and
   * confirmed through a provider on another can never succeed.
   *
   * The signer's chain is checked, not the provider's: a browser wallet
   * whose user switched networks keeps the dapp's read provider on the
   * old chain.
   */
  private async assertChainId(signer: Signer, requested?: number): Promise<void> {
    const expected = requested ?? (await this.getChainId());
    // Never cached: the user can switch networks between two writes, so
    // the signer's chain is re-read immediately before every broadcast.
    const actual = await signer.getChainId();
    if (actual !== expected) {
      throw new POSBridgeError(
        'UNSUPPORTED_NETWORK',
        `signing wallet reports chain ${actual}, but the write expected chain ${expected} — refusing to broadcast cross-chain`,
        { expected, actual }
      );
    }
  }

  private contractFor(
    address: Hex,
    abi: ReadRequest['abi'],
    runner: providers.Provider | Signer
  ): Record<string, unknown> & { estimateGas?: Record<string, unknown> } {
    // `Contract` is imported statically at module top (see class
    // docstring). Cast the indexable method surface at the boundary so
    // the public Adapter shape stays free of v5-specific contract types.
    const ContractCtor = Contract as unknown as new (
      a: string,
      b: ContractInterface,
      r: unknown
    ) => unknown;
    return new ContractCtor(address, abi as ContractInterface, runner) as Record<
      string,
      unknown
    > & { estimateGas?: Record<string, unknown> };
  }
}

/**
 * Construct an ethers-v5-backed {@link Adapter} for `POSClient.init`.
 *
 * This factory is the public entry point at
 * `@polygonlabs/maticjs/ethers-v5`. Consumers pass the constructed
 * `ethersV5Adapter(...)` result as `POSClientConfig.parent` / `.child`.
 *
 * ```ts
 * import { ethersV5Adapter } from '@polygonlabs/maticjs/ethers-v5';
 * parent: ethersV5Adapter({ provider, signer })
 * ```
 */
export function ethersV5Adapter(config: EthersV5AdapterConfig): Adapter {
  return new EthersV5Adapter(config);
}

/**
 * Whether the signer hands the transaction to a remote wallet that prices
 * it, so the SDK must leave fee pricing to that wallet.
 *
 * Only ethers' JSON-RPC signer qualifies (`provider.getSigner()`,
 * `Web3Provider`'s signer for an injected wallet, and its unchecked
 * subclass). Its send path forwards the request as `eth_sendTransaction`
 * without ever reading ethers' fee data, so the wallet prices the
 * transaction and its fee UX stays intact. Every other signer is treated
 * as signing locally: the default signer send path fills fees from
 * ethers' local fee data, whose fixed tip is the underpricing this adapter
 * resolves fees to prevent. That includes signers this check cannot see
 * through, such as a nonce-managing wrapper (which lives in a separate
 * ethers package), so an unrecognised signer gets SDK-resolved fees
 * rather than risking an underpriced send.
 */
const signsRemotely = (signer: Signer): boolean => signer instanceof providers.JsonRpcSigner;

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
  // `chainId` is deliberately NOT passed: v5's Contract rejects any override
  // it does not know with `cannot override "chainId"`, which would fail every
  // SDK write. `assertChainId` checks the signer's chain before broadcast, and
  // the v5 signer stamps its own chain id on the transaction it signs.
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

/** v5 tags errors with a string `code`; `CALL_EXCEPTION` from wait() means the tx reverted. */
const isCallException = (err: unknown): boolean =>
  err instanceof Error && 'code' in err && err.code === 'CALL_EXCEPTION';

/**
 * The receipt on a wait() CALL_EXCEPTION. ethers v5 attaches it whenever
 * the mined receipt has status 0; the error itself is untyped.
 */
const callExceptionReceipt = (err: unknown): providers.TransactionReceipt | undefined => {
  if (typeof err !== 'object' || err === null || !('receipt' in err)) return undefined;
  const receipt = err.receipt;
  return isV5Receipt(receipt) && receipt.status === 0 ? receipt : undefined;
};

/**
 * A wait() TRANSACTION_REPLACED as an outcome. ethers v5 rejects with this
 * when another transaction mined at our nonce, carrying why (`reason`), the
 * replacement and its receipt.
 */
const replacedOutcome = (err: unknown): WaitOutcome | undefined => {
  if (!(err instanceof Error) || !('code' in err) || err.code !== 'TRANSACTION_REPLACED') {
    return undefined;
  }
  if (!('reason' in err) || !('replacement' in err) || !('receipt' in err)) return undefined;
  const { reason, replacement, receipt } = err;
  if (reason !== 'repriced' && reason !== 'cancelled' && reason !== 'replaced') return undefined;
  if (typeof replacement !== 'object' || replacement === null || !('hash' in replacement)) {
    return undefined;
  }
  const replacementHash = replacement.hash;
  if (typeof replacementHash !== 'string' || !isV5Receipt(receipt)) return undefined;
  return {
    receipt: normaliseReceipt(receipt),
    replacement: { reason, hash: replacementHash as Hex }
  };
};

const isV5Receipt = (value: unknown): value is providers.TransactionReceipt =>
  typeof value === 'object' &&
  value !== null &&
  'transactionHash' in value &&
  typeof value.transactionHash === 'string' &&
  'blockNumber' in value &&
  typeof value.blockNumber === 'number' &&
  'status' in value &&
  typeof value.status === 'number' &&
  'logs' in value &&
  Array.isArray(value.logs);

type JsonRpcSend = (method: string, params: readonly unknown[]) => Promise<unknown>;

/** `provider.send`, when the provider speaks JSON-RPC. */
const jsonRpcSendOf = (provider: unknown): JsonRpcSend | undefined => {
  if (typeof provider !== 'object' || provider === null || !('send' in provider)) return undefined;
  const send: unknown = provider.send;
  if (typeof send !== 'function') return undefined;
  return async (method, params) => (await send.call(provider, method, params)) as unknown;
};

const stripHexPrefix = (s: string): string =>
  s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
