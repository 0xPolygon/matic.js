import type { Abi, Account, Chain, Hex as ViemHex, PublicClient, TransactionReceipt as ViemReceipt, WalletClient, WriteContractParameters } from 'viem';

import { keccak256 as keccak256Bytes } from 'ethereum-cryptography/keccak';
import { bytesToHex, hexToBytes } from 'ethereum-cryptography/utils';
import { encodeFunctionData } from 'viem';

import type { Adapter, Hex, PreparedTx, ReadRequest, Receipt, ReceiptLog, TxResult, WriteRequest } from '../adapter.js';

import { POSBridgeError } from '../errors.js';

/**
 * Constructor params for {@link ViemAdapter}.
 *
 * Naming note: `public` is a reserved word, but JavaScript permits it as
 * an object key — viem itself uses this in tutorials and we keep parity
 * with that idiom. Consumers write `{ public: publicClient, wallet:
 * walletClient }`.
 */
export interface ViemAdapterConfig {
  public: PublicClient;
  wallet?: WalletClient;
  /**
   * Sender address used when `WriteRequest.from` is omitted. Falls back
   * to the wallet client's bound account when both are absent.
   */
  account?: Hex;
}

/**
 * viem implementation of {@link Adapter}.
 *
 * Translation strategy:
 * - `read` → `publicClient.readContract`
 * - `write` → `walletClient.writeContract`, hash returned immediately
 * - `confirmed()` → `publicClient.waitForTransactionReceipt` (memoised)
 * - `estimateGas` → `publicClient.estimateContractGas`
 * - `getChainId` → `publicClient.getChainId` (cached after first call)
 * - `getTransactionReceipt` → `publicClient.getTransactionReceipt`
 * - `keccak256` → `ethereum-cryptography/keccak` (sync, no client round-trip)
 *
 * # Why a static value-import from `viem` is safe here
 *
 * `viem` is an OPTIONAL peer dep, but this module lives behind its own
 * package subpath (`@polygonlabs/pos-sdk/viem`). Only a consumer who has
 * chosen viem — and therefore installed it — ever imports this file, so
 * the top-level `import { encodeFunctionData } from 'viem'` always
 * resolves. The main SDK entry (`@polygonlabs/pos-sdk`) imports NO web3
 * library, so an ethers-only consumer never pulls viem in. This replaces
 * the old dynamic `await import('viem')` that existed solely to keep the
 * single combined adapter barrel evaluable when viem was absent.
 */
export class ViemAdapter implements Adapter {
  readonly #public: PublicClient;
  readonly #wallet: WalletClient | undefined;
  readonly #account: Hex | undefined;
  #chainId: number | undefined;

  constructor(config: ViemAdapterConfig) {
    this.#public = config.public;
    this.#wallet = config.wallet;
    this.#account = config.account;
  }

  async getChainId(): Promise<number> {
    if (this.#chainId === undefined) {
      this.#chainId = await this.#public.getChainId();
    }
    return this.#chainId;
  }

  async read(req: ReadRequest): Promise<unknown> {
    // viem's readContract takes `blockNumber` (bigint) OR `blockTag`
    // ('latest' | 'safe' | 'finalized' | …) — never both. Split our
    // single `blockTag` field onto the right viem field.
    const pin =
      req.blockTag === undefined
        ? {}
        : typeof req.blockTag === 'bigint'
          ? { blockNumber: req.blockTag }
          : { blockTag: req.blockTag };
    return await this.#public.readContract({
      address: req.address,
      abi: req.abi as Abi,
      functionName: req.functionName,
      args: req.args as readonly unknown[] | undefined,
      ...pin
    });
  }

  async write(req: WriteRequest): Promise<TxResult> {
    const wallet = this.#wallet;
    if (wallet === undefined) {
      throw new POSBridgeError(
        'WEB3_CLIENT_NOT_INITIALIZED',
        'ViemAdapter has no wallet client; pass `wallet` to support writes.'
      );
    }

    const account = this.#resolveAccount(req.from);
    // viem's writeContract requires `account` and `chain` to be present
    // in the args type even when the wallet client already has them.
    // Cast at the boundary to keep our own WriteRequest free of viem
    // generics.
    const params = {
      address: req.address,
      abi: req.abi as Abi,
      functionName: req.functionName,
      args: req.args as readonly unknown[] | undefined,
      account,
      chain: wallet.chain ?? null,
      value: req.value,
      gas: req.gasLimit,
      maxFeePerGas: req.maxFeePerGas,
      maxPriorityFeePerGas: req.maxPriorityFeePerGas,
      nonce: req.nonce
    } as unknown as WriteContractParameters;

    const hash = (await wallet.writeContract(params)) as Hex;

    let receiptPromise: Promise<Receipt> | undefined;
    const confirmed = (): Promise<Receipt> => {
      // Memoised so repeated `confirmed()` calls share one underlying poll.
      if (receiptPromise === undefined) {
        receiptPromise = this.#public
          .waitForTransactionReceipt({ hash })
          .then((r) => normaliseReceipt(r));
      }
      return receiptPromise;
    };

    return { hash, confirmed };
  }

  async prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    // viem's `encodeFunctionData` is a top-level utility, not a method on
    // PublicClient/WalletClient. Imported statically at module top — this
    // file only loads for viem consumers (see class docstring).
    const data = encodeFunctionData({
      abi: req.abi as Abi,
      functionName: req.functionName,
      args: req.args as readonly unknown[] | undefined
    });
    return req.value !== undefined
      ? { to: req.address, data: data as Hex, value: req.value }
      : { to: req.address, data: data as Hex };
  }

  async estimateGas(req: WriteRequest): Promise<bigint> {
    const account = this.#resolveAccount(req.from);
    return await this.#public.estimateContractGas({
      address: req.address,
      abi: req.abi as Abi,
      functionName: req.functionName,
      args: req.args as readonly unknown[] | undefined,
      account,
      value: req.value
    });
  }

  async getTransactionReceipt(hash: string): Promise<Receipt | null> {
    try {
      const r = await this.#public.getTransactionReceipt({ hash: hash as ViemHex });
      return normaliseReceipt(r);
    } catch (err) {
      // viem throws TransactionReceiptNotFoundError when the tx isn't
      // mined yet. We deliberately swallow only that error class — but
      // detecting it without a value-import means we structurally check
      // the name. Other errors (network, RPC) propagate unchanged.
      if (err instanceof Error && err.name === 'TransactionReceiptNotFoundError') {
        return null;
      }
      throw err;
    }
  }

  keccak256(data: Uint8Array | string): string {
    const bytes = typeof data === 'string' ? hexToBytes(stripHexPrefix(data)) : data;
    return `0x${bytesToHex(keccak256Bytes(bytes))}`;
  }

  async request<T>(method: string, params: readonly unknown[]): Promise<T> {
    // viem's `request` types each (method, params) pair against its
    // EIP-1474 union; bor methods aren't in that union, so we cast at
    // the boundary. The wallet/public client both forward to the
    // underlying transport, so PublicClient is sufficient here.
    return (await (this.#public as unknown as {
      request: (args: { method: string; params: readonly unknown[] }) => Promise<unknown>;
    }).request({ method, params })) as T;
  }

  #resolveAccount(from?: Hex): Account | Hex {
    if (from !== undefined) return from;
    if (this.#account !== undefined) return this.#account;
    const bound = this.#wallet?.account;
    if (bound !== undefined) return bound;
    throw new POSBridgeError(
      'WEB3_CLIENT_NOT_INITIALIZED',
      'no signer available — pass `account` to ViemAdapter or `from` on the WriteRequest.'
    );
  }
}

/**
 * Construct a viem-backed {@link Adapter} for `POSClient.init`.
 *
 * This factory is the public entry point at `@polygonlabs/pos-sdk/viem`.
 * Consumers pass the already-constructed `viemAdapter(...)` result as
 * `POSClientConfig.parent` / `.child`, so the SDK never imports viem
 * itself — only this subpath does, and only viem consumers import it.
 *
 * ```ts
 * import { POSClient } from '@polygonlabs/pos-sdk';
 * import { viemAdapter } from '@polygonlabs/pos-sdk/viem';
 * const pos = await POSClient.init({
 *   network: 'amoy',
 *   parent: viemAdapter({ public: parentPublic, wallet: parentWallet }),
 *   child:  viemAdapter({ public: childPublic,  wallet: childWallet })
 * });
 * ```
 */
export function viemAdapter(config: ViemAdapterConfig): Adapter {
  return new ViemAdapter(config);
}

/**
 * Normalise viem's receipt to our minimal shape. Discards fields the
 * SDK doesn't read (effectiveGasPrice, gasUsed, contractAddress, etc.);
 * if a downstream stage needs them, widen `Receipt` in `adapter.ts` and
 * teach all three adapters to populate them.
 */
const normaliseReceipt = (r: ViemReceipt): Receipt => ({
  transactionHash: r.transactionHash,
  status: r.status === 'success' ? 'success' : 'reverted',
  blockNumber: r.blockNumber,
  logs: r.logs.map<ReceiptLog>((log) => ({
    address: log.address as Hex,
    topics: log.topics as readonly Hex[],
    data: log.data as Hex,
    // viem types `logIndex` as `number` for mined logs; pending logs
    // are filtered out by the receipt path.
    logIndex: log.logIndex ?? 0
  }))
});

const stripHexPrefix = (s: string): string => (s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s);

// Marker so unused-type imports stick around when generic narrowing
// resolves to `never` — keeps the published .d.ts honest about the
// accepted Chain shape.
export type _ChainGeneric = Chain;
