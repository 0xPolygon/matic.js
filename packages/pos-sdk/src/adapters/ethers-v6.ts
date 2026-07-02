import type {
  ContractRunner,
  InterfaceAbi,
  Provider,
  Signer,
  TransactionReceipt as V6Receipt,
  TransactionResponse as V6TxResponse
} from 'ethers';

import { keccak256 as keccak256Bytes } from 'ethereum-cryptography/keccak';
import { bytesToHex, hexToBytes } from 'ethereum-cryptography/utils';
import { Contract, Interface } from 'ethers';

import type { Adapter, Hex, PreparedTx, ReadRequest, Receipt, ReceiptLog, TxResult, WriteRequest } from '../adapter.js';

import { POSBridgeError } from '../errors.js';

/**
 * Constructor params for {@link EthersV6Adapter}.
 *
 * Identical shape to {@link EthersV5Adapter}'s config — the v6 type
 * names happen to differ but their roles are the same. Consumers pick
 * the v6 adapter by importing `ethersV6Adapter` from the
 * `@polygonlabs/pos-sdk/ethers-v6` subpath, so there is no runtime
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
 * package subpath (`@polygonlabs/pos-sdk/ethers-v6`). Only a consumer who
 * has chosen ethers v6 — and therefore installed it — ever imports this
 * file, so the top-level `import { Contract, Interface } from 'ethers'`
 * always resolves. The main SDK entry imports NO web3 library, so a
 * viem-only consumer never pulls ethers in. Imports use `'ethers'`
 * directly because the bare `ethers` at this monorepo level is v6 (the
 * `ethers-v5` alias only exists for the v5 adapter). This replaces the
 * old dynamic `await import('ethers')`.
 */
export class EthersV6Adapter implements Adapter {
  readonly #provider: Provider;
  readonly #signer: Signer | undefined;
  #chainId: number | undefined;

  constructor(config: EthersV6AdapterConfig) {
    this.#provider = config.provider;
    this.#signer = config.signer;
  }

  async getChainId(): Promise<number> {
    if (this.#chainId === undefined) {
      const network = await this.#provider.getNetwork();
      // v6's Network.chainId is `bigint`; we narrow to `number` because
      // every supported chain ID fits comfortably under 2^53.
      this.#chainId = Number(network.chainId);
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
    // v6 view calls accept a trailing overrides object; pass `{ blockTag }`
    // to pin the read. See {@link buildReadArgs}.
    const callArgs = buildReadArgs(req);
    return await (fn as (...args: unknown[]) => Promise<unknown>)(...callArgs);
  }

  async write(req: WriteRequest): Promise<TxResult> {
    const signer = this.#signer;
    if (signer === undefined) {
      throw new POSBridgeError(
        'WEB3_CLIENT_NOT_INITIALIZED',
        'EthersV6Adapter has no signer; pass `signer` to support writes.'
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
    const tx = (await (fn as (...args: unknown[]) => Promise<unknown>)(
      ...(req.args ?? []),
      overrides
    )) as V6TxResponse;

    const hash = tx.hash as Hex;

    let receiptPromise: Promise<Receipt> | undefined;
    const confirmed = (): Promise<Receipt> => {
      if (receiptPromise === undefined) {
        receiptPromise = tx.wait().then((r) => {
          // v6 returns null when the tx is replaced/dropped; treat
          // that as a hard failure rather than collapsing into a
          // success-shaped receipt.
          if (r === null) {
            throw new POSBridgeError(
              'WEB3_CLIENT_NOT_INITIALIZED',
              `Transaction ${hash} did not produce a receipt (replaced or dropped).`,
              { transactionHash: hash }
            );
          }
          return normaliseReceipt(r);
        });
      }
      return receiptPromise;
    };

    return { hash, confirmed };
  }

  async prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    // ethers v6 exposes Interface directly under the package root
    // (versus v5's `utils.Interface`). Imported statically at module top
    // (see class docstring); this file only loads for ethers-v6 consumers.
    const iface = new Interface(req.abi as InterfaceAbi);
    const data = iface.encodeFunctionData(req.functionName, req.args as readonly unknown[] | undefined) as Hex;
    return req.value !== undefined
      ? { to: req.address, data, value: req.value }
      : { to: req.address, data };
  }

  async estimateGas(req: WriteRequest): Promise<bigint> {
    const runner = this.#signer ?? this.#provider;
    const contract = this.#contractFor(req.address, req.abi, runner);
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
    const r = await this.#provider.getTransactionReceipt(hash);
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
    const sendable = this.#provider as unknown as {
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

  #contractFor(
    address: Hex,
    abi: ReadRequest['abi'],
    runner: ContractRunner
  ): Record<string, unknown> & { getFunction?: unknown } {
    // `Contract` is imported statically at module top (see class
    // docstring). Cast the indexable method surface at the boundary so
    // the public Adapter shape stays free of v6-specific contract types.
    const ContractCtor = Contract as unknown as new (a: string, b: InterfaceAbi, r: ContractRunner) => unknown;
    return new ContractCtor(address, abi as InterfaceAbi, runner) as Record<string, unknown> & { getFunction?: unknown };
  }
}

/**
 * Construct an ethers-v6-backed {@link Adapter} for `POSClient.init`.
 *
 * This factory is the public entry point at
 * `@polygonlabs/pos-sdk/ethers-v6`. Consumers pass the constructed
 * `ethersV6Adapter(...)` result as `POSClientConfig.parent` / `.child`.
 *
 * ```ts
 * import { ethersV6Adapter } from '@polygonlabs/pos-sdk/ethers-v6';
 * parent: ethersV6Adapter({ provider, signer })
 * ```
 */
export function ethersV6Adapter(config: EthersV6AdapterConfig): Adapter {
  return new EthersV6Adapter(config);
}

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

const stripHexPrefix = (s: string): string => (s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s);
