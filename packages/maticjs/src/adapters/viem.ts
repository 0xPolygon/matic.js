import type {
  Abi,
  Account,
  Chain,
  Hex as ViemHex,
  PublicClient,
  TransactionReceipt as ViemReceipt,
  WalletClient,
  WriteContractParameters
} from 'viem';

import { keccak_256 as keccak256Bytes } from '@noble/hashes/sha3.js';
import { encodeFunctionData } from 'viem';

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
import type { Replacement, WaitOutcome } from '../internal/confirmation.js';

import { UnsupportedNetworkError, Web3ClientNotInitializedError } from '../errors.js';
import { memoiseConfirmation } from '../internal/confirmation.js';
import { bytesToHex, hexToBytes } from '../utils/bytes.js';

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
 * - `keccak256` → `@noble/hashes` keccak-256 (sync, no client round-trip)
 *
 * # Why a static value-import from `viem` is safe here
 *
 * `viem` is an OPTIONAL peer dep, but this module lives behind its own
 * package subpath (`@polygonlabs/maticjs/viem`). Only a consumer who has
 * chosen viem — and therefore installed it — ever imports this file, so
 * the top-level `import { encodeFunctionData } from 'viem'` always
 * resolves. The main SDK entry (`@polygonlabs/maticjs`) imports NO web3
 * library, so an ethers-only consumer never pulls viem in. This replaces
 * the old dynamic `await import('viem')` that existed solely to keep the
 * single combined adapter barrel evaluable when viem was absent.
 */
export class ViemAdapter implements Adapter {
  /**
   * The exact viem `PublicClient` you passed to the factory — exposed read-only so
   * consumers can inspect wiring, compare identity (`adapter.publicClient ===
   * mine`), or reach the underlying client for unwrapped calls. SDK
   * internals are `private` (typed-API-hidden) rather than hard-`#`:
   * an SDK has no security boundary against its own consumer, and
   * plain properties keep instances debuggable and Proxy-safe.
   */
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient | undefined;
  readonly account: Hex | undefined;
  private chainId: number | undefined;

  constructor(config: ViemAdapterConfig) {
    this.publicClient = config.public;
    this.walletClient = config.wallet;
    this.account = config.account;
  }

  async getChainId(): Promise<number> {
    if (this.chainId === undefined) {
      this.chainId = await this.publicClient.getChainId();
    }
    return this.chainId;
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
    return await this.publicClient.readContract({
      address: req.address,
      abi: req.abi as Abi,
      functionName: req.functionName,
      args: req.args as readonly unknown[] | undefined,
      ...pin
    });
  }

  async write(req: WriteRequest): Promise<TxResult> {
    const wallet = this.walletClient;
    if (wallet === undefined) {
      throw new Web3ClientNotInitializedError(
        'ViemAdapter has no wallet client; pass `wallet` to support writes.'
      );
    }

    await this.assertChainId(wallet, req.chainId);

    const account = this.resolveAccount(req.from);
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

    // viem resolves a reverted receipt (status 'reverted'), and on a
    // replacement it resolves with the REPLACEMENT's receipt, reporting why
    // only through `onReplaced`. Capture that so the shared wrapper can
    // tell a fee bump from a cancel; it also raises TransactionRevertedError.
    // viem raises no error of its own for a mined revert or a replacement,
    // so these are conditions the SDK detects from the receipt.
    const confirmed = memoiseConfirmation({
      hash,
      wait: async (): Promise<WaitOutcome> => {
        let replacement: Replacement | undefined;
        const r = await this.publicClient.waitForTransactionReceipt({
          hash,
          onReplaced: ({ reason, transaction }) => {
            replacement = { reason, hash: transaction.hash };
          }
        });
        return { receipt: normaliseReceipt(r), replacement };
      }
    });

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
    const account = this.resolveAccount(req.from);
    return await this.publicClient.estimateContractGas({
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
      const r = await this.publicClient.getTransactionReceipt({ hash: hash as ViemHex });
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
    return (await (
      this.publicClient as unknown as {
        request: (args: { method: string; params: readonly unknown[] }) => Promise<unknown>;
      }
    ).request({ method, params })) as T;
  }

  /**
   * The cross-chain mis-send guard: reject before broadcasting when the
   * WALLET that will sign is not on the expected chain. The expected chain
   * is `WriteRequest.chainId` when the caller pins one, else the chain the
   * public client reads from — a write signed on one chain and confirmed
   * through an RPC on another can never succeed.
   *
   * The wallet's chain is checked, not the public client's: a browser
   * wallet whose user switched networks keeps the dapp's RPC on the old
   * chain, and a wallet client built without `chain` gives viem's
   * `writeContract` nothing to assert against.
   */
  private async assertChainId(wallet: WalletClient, requested?: number): Promise<void> {
    const expected = requested ?? (await this.getChainId());
    // Never cached: the user can switch networks between two writes, so
    // the wallet's chain is re-read immediately before every broadcast.
    const actual = await wallet.getChainId();
    if (actual !== expected) {
      throw new UnsupportedNetworkError(
        `signing wallet reports chain ${actual}, but the write expected chain ${expected} — refusing to broadcast cross-chain`,
        { info: { expected, actual } }
      );
    }
  }

  private resolveAccount(from?: Hex): Account | Hex {
    const requested = from ?? this.account;
    const bound = this.walletClient?.account;
    if (requested === undefined) {
      if (bound !== undefined) return bound;
      throw new Web3ClientNotInitializedError(
        'no signer available — pass `account` to ViemAdapter or `from` on the WriteRequest.'
      );
    }
    // viem treats a bare address as a JSON-RPC account and sends it with
    // `eth_sendTransaction`, skipping a local account's own signing — so a
    // private-key wallet would hand the write to the RPC node, which holds
    // no key and rejects it. Keep the wallet's Account when it is the same
    // sender.
    if (bound !== undefined && bound.address.toLowerCase() === requested.toLowerCase()) {
      return bound;
    }
    return requested;
  }
}

/**
 * Construct a viem-backed {@link Adapter} for `POSClient.init`.
 *
 * This factory is the public entry point at `@polygonlabs/maticjs/viem`.
 * Consumers pass the already-constructed `viemAdapter(...)` result as
 * `POSClientConfig.parent` / `.child`, so the SDK never imports viem
 * itself — only this subpath does, and only viem consumers import it.
 *
 * ```ts
 * import { POSClient } from '@polygonlabs/maticjs';
 * import { viemAdapter } from '@polygonlabs/maticjs/viem';
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

const stripHexPrefix = (s: string): string =>
  s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;

// Marker so unused-type imports stick around when generic narrowing
// resolves to `never` — keeps the published .d.ts honest about the
// accepted Chain shape.
export type _ChainGeneric = Chain;
