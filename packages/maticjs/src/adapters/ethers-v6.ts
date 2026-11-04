import type {
  ContractRunner,
  FeeData,
  InterfaceAbi,
  Provider,
  Signer,
  TransactionReceipt as V6Receipt,
  TransactionResponse as V6TxResponse
} from 'ethers';

import { keccak_256 as keccak256Bytes } from '@noble/hashes/sha3.js';
import { Contract, Interface, isError, JsonRpcSigner, NonceManager } from 'ethers';

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
 * How many blocks below the pre-broadcast head the replacement scan starts.
 *
 * ethers v6 scans for a replacement from no lower than the block passed to
 * `replaceableTransaction()`. Behind a load-balanced RPC the head we read
 * and the node that took the broadcast can disagree: a replacement can
 * already be mined below the head we read, and a scan that starts above it
 * never finds it, so `confirmed()` waits forever. Starting lower only costs
 * a few extra block fetches, once, and cannot match the wrong transaction
 * (only one transaction per sender and nonce can ever be mined). 16 blocks
 * covers ordinary node lag with room to spare.
 */
const SCAN_MARGIN = 16;

/**
 * Constructor params for {@link EthersV6Adapter}.
 *
 * Identical shape to {@link EthersV5Adapter}'s config — the v6 type
 * names happen to differ but their roles are the same. Consumers pick
 * the v6 adapter by importing `ethersV6Adapter` from the
 * `@polygonlabs/maticjs/ethers-v6` subpath, so there is no runtime
 * discriminator — the import path IS the choice.
 */
export interface EthersV6AdapterConfig {
  provider: Provider;
  signer?: Signer;
}

/**
 * ethers v6 implementation of {@link Adapter}.
 *
 * # No bigint conversion
 *
 * ethers v6 already speaks native `bigint` for every numeric value
 * (gas limits, balances, fee fields, even `transaction.value`) so this
 * adapter is mostly a thin pass-through. Compare with the v5 adapter
 * where every output goes through `.toBigInt()`.
 *
 * # Why a static value-import from `ethers` is safe here
 *
 * `ethers` is an OPTIONAL peer dep, but this module lives behind its own
 * package subpath (`@polygonlabs/maticjs/ethers-v6`). Only a consumer who
 * has chosen ethers v6 — and therefore installed it — ever imports this
 * file, so the top-level `import { Contract, Interface } from 'ethers'`
 * always resolves. The main SDK entry imports NO web3 library, so a
 * viem-only consumer never pulls ethers in. Imports use `'ethers'`
 * directly because the bare `ethers` at this monorepo level is v6 (the
 * `ethers-v5` alias only exists for the v5 adapter). This replaces the
 * old dynamic `await import('ethers')`.
 */
export class EthersV6Adapter implements Adapter {
  /**
   * The exact ethers v6 provider you passed to the factory — exposed read-only so
   * consumers can inspect wiring, compare identity (`adapter.provider ===
   * mine`), or reach the underlying client for unwrapped calls. SDK
   * internals are `private` (typed-API-hidden) rather than hard-`#`:
   * an SDK has no security boundary against its own consumer, and
   * plain properties keep instances debuggable and Proxy-safe.
   */
  readonly provider: Provider;
  readonly signer: Signer | undefined;
  private chainId: number | undefined;

  constructor(config: EthersV6AdapterConfig) {
    this.provider = config.provider;
    this.signer = config.signer;
  }

  async getChainId(): Promise<number> {
    if (this.chainId === undefined) {
      const network = await this.provider.getNetwork();
      // v6's Network.chainId is `bigint`; we narrow to `number` because
      // every supported chain ID fits comfortably under 2^53.
      this.chainId = Number(network.chainId);
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
    // v6 view calls accept a trailing overrides object; pass `{ blockTag }`
    // to pin the read. See {@link buildReadArgs}.
    const callArgs = buildReadArgs(req);
    return await (fn as (...args: unknown[]) => Promise<unknown>)(...callArgs);
  }

  async write(req: WriteRequest): Promise<TxResult> {
    const signer = this.signer;
    if (signer === undefined) {
      throw new POSBridgeError(
        'WEB3_CLIENT_NOT_INITIALIZED',
        'EthersV6Adapter has no signer; pass `signer` to support writes.'
      );
    }

    await this.assertChainId(signer, req.chainId);

    const contract = this.contractFor(req.address, req.abi, signer);
    const fees = signsRemotely(signer) ? {} : await this.resolveFees(req);
    const overrides = buildOverrides({ ...req, ...fees });
    const fn = contract[req.functionName];
    if (typeof fn !== 'function') {
      // See `read` — internal invariant violation, not a consumer condition.
      throw new Error(
        `internal invariant: function ${req.functionName} not found on ABI for ${req.address}`
      );
    }
    // The chain head before broadcast; the replacement scan starts
    // SCAN_MARGIN blocks below it. See the `confirmed` wait below.
    const startBlock = await (signer.provider ?? this.provider).getBlockNumber();
    const tx = (await (fn as (...args: unknown[]) => Promise<unknown>)(
      ...(req.args ?? []),
      overrides
    )) as V6TxResponse;

    const hash = tx.hash as Hex;

    // v6's Contract hands back a ContractTransactionResponse, which drops
    // the block the broadcast started at, so its wait() never scans for a
    // replacement and polls forever for a receipt that will not come.
    // `replaceableTransaction(startBlock)` restores the scan. Its wait()
    // rejects a revert (CALL_EXCEPTION) and a replacement
    // (TRANSACTION_REPLACED), each carrying the receipt that mined; turn
    // both back into an outcome so the shared wrapper decides. Any other
    // rejection (an RPC failure) passes through unchanged.
    const replaceable = tx.replaceableTransaction(Math.max(0, startBlock - SCAN_MARGIN));
    const confirmed = memoiseConfirmation({
      hash,
      wait: () =>
        replaceable.wait().then(
          (r): WaitOutcome => {
            // v6 returns null only for a zero-confirmation wait; treat it
            // as a hard failure rather than a success-shaped receipt.
            if (r === null) {
              throw new POSBridgeError(
                'WEB3_CLIENT_NOT_INITIALIZED',
                `Transaction ${hash} did not produce a receipt (replaced or dropped).`,
                { transactionHash: hash }
              );
            }
            return { receipt: normaliseReceipt(r) };
          },
          (err: unknown): WaitOutcome => {
            if (isError(err, 'TRANSACTION_REPLACED')) {
              return {
                receipt: normaliseReceipt(err.receipt),
                replacement: { reason: err.reason, hash: err.replacement.hash as Hex }
              };
            }
            if (isError(err, 'CALL_EXCEPTION') && err.receipt?.status === 0) {
              return { receipt: normaliseReceipt(err.receipt) };
            }
            throw err;
          }
        )
    });

    return { hash, confirmed };
  }

  async prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    // ethers v6 exposes Interface directly under the package root
    // (versus v5's `utils.Interface`). Imported statically at module top
    // (see class docstring); this file only loads for ethers-v6 consumers.
    const iface = new Interface(req.abi as InterfaceAbi);
    const data = iface.encodeFunctionData(
      req.functionName,
      req.args as readonly unknown[] | undefined
    ) as Hex;
    return req.value !== undefined
      ? { to: req.address, data, value: req.value }
      : { to: req.address, data };
  }

  async estimateGas(req: WriteRequest): Promise<bigint> {
    const runner = this.signer ?? this.provider;
    const contract = this.contractFor(req.address, req.abi, runner);
    const overrides = buildOverrides(req);
    // v6's Contract surface includes a `getFunction(name).estimateGas(...)` accessor.
    const getFunction = contract.getFunction;
    if (typeof getFunction !== 'function') {
      // See `read` — internal invariant violation, not a consumer condition.
      throw new Error(`internal invariant: getFunction missing on contract for ${req.address}`);
    }
    const method = (getFunction as (n: string) => unknown).call(contract, req.functionName) as {
      estimateGas: (...a: unknown[]) => Promise<bigint>;
    };
    return await method.estimateGas(...(req.args ?? []), overrides);
  }

  async getTransactionReceipt(hash: string): Promise<Receipt | null> {
    const r = await this.provider.getTransactionReceipt(hash);
    if (r === null) return null;
    return normaliseReceipt(r);
  }

  keccak256(data: Uint8Array | string): string {
    const bytes = typeof data === 'string' ? hexToBytes(stripHexPrefix(data)) : data;
    return `0x${bytesToHex(keccak256Bytes(bytes))}`;
  }

  async request<T>(method: string, params: readonly unknown[]): Promise<T> {
    // v6's abstract `Provider` does not declare `send`, but every JSON-
    // RPC descendant exposes it (`AbstractProvider`'s `_send` is internal).
    // Surface a clear error when a custom provider lacks it.
    const sendable = this.provider as unknown as {
      send?: (method: string, params: readonly unknown[]) => Promise<unknown>;
    };
    if (typeof sendable.send !== 'function') {
      throw new POSBridgeError(
        'WEB3_CLIENT_NOT_INITIALIZED',
        'EthersV6Adapter provider has no `send` method; pass a JsonRpcProvider for bridge flows.',
        { method }
      );
    }
    return (await sendable.send(method, params)) as T;
  }

  /**
   * Fill in the EIP-1559 fees when the caller gave no priority fee (tip).
   *
   * On Polygon PoS mainnet ethers v6 takes its fee data from Polygon's gas
   * station, not the node, and `getFeeData()` throws when the station is
   * unreachable. Left to ethers, every write without fee options would then
   * fail. So the adapter also asks the node (`eth_maxPriorityFeePerGas`),
   * takes the higher of the two tips, and prices from the node alone when
   * ethers' fee data fails. A caller-supplied tip always wins.
   *
   * This runs on every chain, not only where ethers attaches a gas station:
   * it keys on nothing chain-specific, so a network that gains or loses a
   * fee-data plugin needs no change here. Everywhere else ethers already
   * takes its tip from `eth_maxPriorityFeePerGas`, so the higher of the two
   * is that same value and the only cost is one more RPC call per write.
   * Runs only for signers that sign locally; see {@link signsRemotely}.
   */
  private async resolveFees(
    req: WriteRequest
  ): Promise<Pick<WriteRequest, 'maxFeePerGas' | 'maxPriorityFeePerGas'>> {
    const passthrough = {
      maxFeePerGas: req.maxFeePerGas,
      maxPriorityFeePerGas: req.maxPriorityFeePerGas
    };
    if (req.maxPriorityFeePerGas !== undefined) return passthrough;

    // Already resolved by the chain guard, so this costs no RPC call.
    const chainId = req.chainId ?? (await this.getChainId());
    let feeData: FeeData;
    try {
      feeData = await this.provider.getFeeData();
    } catch (feeDataError) {
      return await this.resolveFeesFromNode({ req, chainId, feeDataError });
    }
    // No EIP-1559 fee data means the chain has no base fee: leave the
    // request untouched so ethers prices it with gasPrice exactly as before.
    if (feeData.maxFeePerGas === null || feeData.maxPriorityFeePerGas === null) return passthrough;

    let tip = feeData.maxPriorityFeePerGas;
    try {
      const nodeTip = await this.fetchPriorityFee({ chainId });
      if (nodeTip > tip) tip = nodeTip;
    } catch {
      // ethers' fee data already priced the transaction. A node without the
      // method must not break a write that ethers alone could send, so keep
      // ethers' tip; the node is only required when ethers' fee data fails.
    }
    // ethers derives its cap as (base-fee headroom) + (its tip). Keep that
    // headroom and add the resolved tip instead, so the cap always covers the
    // tip (maxFee ≥ tip) and base-fee volatility is absorbed as before. The
    // station's numbers are external, so never let the headroom go negative.
    const headroom = feeData.maxFeePerGas - feeData.maxPriorityFeePerGas;
    return withTip({ req, tip, headroom: headroom > 0n ? headroom : 0n });
  }

  /**
   * Price the transaction from the node alone after ethers' fee data failed
   * (on Polygon PoS mainnet: the gas station is down). The tip comes from
   * `eth_maxPriorityFeePerGas`; the cap uses ethers' own heuristic,
   * 2 × the latest block's base fee + tip, so a fallback write is priced the
   * same way a station-free chain's write is.
   */
  private async resolveFeesFromNode({
    req,
    chainId,
    feeDataError
  }: {
    req: WriteRequest;
    chainId: number;
    feeDataError: unknown;
  }): Promise<Pick<WriteRequest, 'maxFeePerGas' | 'maxPriorityFeePerGas'>> {
    const method = 'eth_maxPriorityFeePerGas';
    const feeDataMessage = toError(feeDataError).message;
    let tip: bigint;
    try {
      tip = await this.fetchPriorityFee({ chainId });
    } catch (err) {
      // Already typed (provider without `send`, malformed response): keep
      // its code at the top.
      if (err instanceof POSBridgeError) throw err;
      // Both sources failed. There is nothing left to price the transaction
      // with, and guessing a tip risks an underpriced send, so fail loudly.
      throw new POSBridgeError(
        'FEE_ESTIMATION_FAILED',
        `EthersV6Adapter could not fetch the priority fee via ${method} after ethers' fee data failed; pass maxPriorityFeePerGas explicitly to skip both`,
        { method, chainId, feeDataError: feeDataMessage },
        { cause: toError(err) }
      );
    }
    // A caller cap needs no base fee: the tip is simply held beneath it.
    if (req.maxFeePerGas !== undefined) return withTip({ req, tip, headroom: 0n });

    const block = await this.provider.getBlock('latest');
    const baseFee = block?.baseFeePerGas ?? null;
    if (baseFee === null) {
      // No base fee means a legacy chain, which ethers prices with gasPrice
      // — and that path needs the fee data that just failed.
      throw new POSBridgeError(
        'FEE_ESTIMATION_FAILED',
        'EthersV6Adapter could not resolve fee data, and the latest block has no base fee to fall back on; pass maxPriorityFeePerGas explicitly',
        { method: 'eth_getBlockByNumber', chainId },
        { cause: toError(feeDataError) }
      );
    }
    return withTip({ req, tip, headroom: 2n * baseFee });
  }

  /**
   * Query `eth_maxPriorityFeePerGas` and parse the quantity. Errors are
   * left to the caller: {@link resolveFees} tolerates them while ethers'
   * fee data stands, and {@link resolveFeesFromNode} fails loudly on them.
   */
  private async fetchPriorityFee({ chainId }: { chainId: number }): Promise<bigint> {
    const method = 'eth_maxPriorityFeePerGas';
    const raw = await this.request<unknown>(method, []);
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) {
      throw new POSBridgeError(
        'FEE_ESTIMATION_FAILED',
        `EthersV6Adapter received a malformed ${method} response; pass maxPriorityFeePerGas explicitly`,
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
   *
   * ethers' own signer also checks a `chainId` override when it populates
   * the tx; this pre-flight runs first so every adapter rejects with the
   * same `POSBridgeError` shape.
   */
  private async assertChainId(signer: Signer, requested?: number): Promise<void> {
    const expected = requested ?? (await this.getChainId());
    // Never cached: the user can switch networks between two writes, so
    // the signer's chain is re-read immediately before every broadcast.
    const signerProvider = signer.provider;
    if (signerProvider === null) {
      throw new POSBridgeError(
        'WEB3_CLIENT_NOT_INITIALIZED',
        'EthersV6Adapter signer has no provider, so its chain cannot be verified; connect the signer to a provider.'
      );
    }
    // v6's Network.chainId is `bigint`: compare in bigint space so no
    // value is rounded, and narrow to `number` only for the error info.
    const signerChainId = (await signerProvider.getNetwork()).chainId;
    if (signerChainId !== BigInt(expected)) {
      const actual = Number(signerChainId);
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
    runner: ContractRunner
  ): Record<string, unknown> & { getFunction?: unknown } {
    // `Contract` is imported statically at module top (see class
    // docstring). Cast the indexable method surface at the boundary so
    // the public Adapter shape stays free of v6-specific contract types.
    const ContractCtor = Contract as unknown as new (
      a: string,
      b: InterfaceAbi,
      r: ContractRunner
    ) => unknown;
    return new ContractCtor(address, abi as InterfaceAbi, runner) as Record<string, unknown> & {
      getFunction?: unknown;
    };
  }
}

/**
 * Construct an ethers-v6-backed {@link Adapter} for `POSClient.init`.
 *
 * This factory is the public entry point at
 * `@polygonlabs/maticjs/ethers-v6`. Consumers pass the constructed
 * `ethersV6Adapter(...)` result as `POSClientConfig.parent` / `.child`.
 *
 * ```ts
 * import { ethersV6Adapter } from '@polygonlabs/maticjs/ethers-v6';
 * parent: ethersV6Adapter({ provider, signer })
 * ```
 */
export function ethersV6Adapter(config: EthersV6AdapterConfig): Adapter {
  return new EthersV6Adapter(config);
}

/**
 * Whether the signer hands the transaction to a remote wallet that prices
 * it, so the SDK must leave fee pricing to that wallet.
 *
 * Only ethers' JSON-RPC signer qualifies (`provider.getSigner()`, and
 * `BrowserProvider`'s signer for an injected wallet). It populates without
 * fee data and forwards the request as `eth_sendTransaction`, so the wallet
 * prices the transaction and its fee UX stays intact. A `NonceManager` is
 * classified by the signer it wraps: it populates through that signer and
 * then sends through it, so it is remote exactly when its inner signer is.
 * Every other signer is treated as signing locally: the default signer
 * populate path fills fees from ethers' local fee data, which is what fails
 * when the gas station is down. An unrecognised signer therefore gets
 * SDK-resolved fees rather than risking a failed or underpriced send.
 */
const signsRemotely = (signer: Signer): boolean => {
  let inner = signer;
  while (inner instanceof NonceManager) inner = inner.signer;
  return inner instanceof JsonRpcSigner;
};

/**
 * Build v6 transaction overrides from our provider-agnostic shape. v6
 * already accepts `bigint` natively so values pass through unchanged.
 */
/**
 * Build the positional args for a view call, appending a `{ blockTag }`
 * call-overrides object only when the read pins to a non-default tag.
 * v6's `blockTag` accepts string tags and a hex-quantity for an exact
 * height.
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
 * Apply a resolved tip. With a caller-supplied cap the cap is a hard
 * ceiling and nodes reject a tip above it; the protocol never pays more
 * than (maxFee − baseFee) as tip anyway, so the tip is held at the cap
 * rather than failing the write. Without one, the cap is the base-fee
 * headroom plus the tip, so it always covers the tip.
 */
const withTip = ({
  req,
  tip,
  headroom
}: {
  req: WriteRequest;
  tip: bigint;
  headroom: bigint;
}): Pick<WriteRequest, 'maxFeePerGas' | 'maxPriorityFeePerGas'> => {
  if (req.maxFeePerGas !== undefined) {
    return {
      maxFeePerGas: req.maxFeePerGas,
      maxPriorityFeePerGas: tip < req.maxFeePerGas ? tip : req.maxFeePerGas
    };
  }
  return { maxFeePerGas: headroom + tip, maxPriorityFeePerGas: tip };
};

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/**
 * Normalise v6's receipt to our minimal shape. v6's Log uses `index`
 * (not v5's `logIndex`); the receipt's `status` is `null | number`
 * where `null` only appears for pre-Byzantium transactions, which the
 * Polygon PoS bridge never sees in production. Treat `null` as
 * `'reverted'` defensively rather than crashing.
 */
const normaliseReceipt = (r: V6Receipt): Receipt => ({
  transactionHash: r.hash as Hex,
  status: r.status === 1 ? 'success' : 'reverted',
  blockNumber: BigInt(r.blockNumber),
  logs: Array.from(r.logs).map<ReceiptLog>((log) => ({
    address: log.address as Hex,
    topics: log.topics as readonly Hex[],
    data: log.data as Hex,
    logIndex: log.index
  }))
});

const stripHexPrefix = (s: string): string =>
  s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
