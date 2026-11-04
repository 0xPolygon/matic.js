/**
 * Internal adapter contract — abstracts every read/write/gas/keccak primitive
 * the SDK needs from a parent-chain RPC client.
 *
 * # Why this layer exists
 *
 * The 1.0 rewrite moves away from a single hard-coded provider class
 * (`Web3SideChainClient`) and toward consumer-supplied parent clients —
 * `viem`, `ethers v5`, or `ethers v6`. The high-level SDK code (bridge
 * flows, proof generation, exit utilities) is written ONCE against this
 * `Adapter` interface; three thin translators in `./adapters/` map each
 * library's native shapes onto it. That keeps the bridge logic provider-
 * agnostic without leaking three sets of types into every call site.
 *
 * # Why these specific shapes
 *
 * - **`bigint` everywhere a number could overflow `Number.MAX_SAFE_INTEGER`.**
 *   ethers v5 returns `BigNumber`; ethers v6 returns native `bigint`; viem
 *   returns native `bigint`. The adapter normalises all of these to
 *   `bigint` so consumers never see a `BigNumber` leak. The v5 adapter is
 *   the only place `BigNumber.from` / `.toBigInt()` lives.
 * - **`TxResult = { hash, confirmed() }`** instead of returning a lazy
 *   transaction-result object that conflates "submitted" and "confirmed".
 *   The legacy SDK exposed an awaitable `Promise` that *sometimes* meant
 *   "submitted, here's a hash" and *sometimes* meant "wait for the
 *   receipt"; that ambiguity was a footgun. The new shape is explicit:
 *   `await write(req)` resolves the moment the transaction is broadcast
 *   (you get a hash); `await result.confirmed()` waits for the receipt.
 *   `confirmed()` is idempotent — calling it twice returns equivalent
 *   receipts; the underlying `wait` is memoised by each adapter so we
 *   never poll the chain twice.
 * - **Minimal `Receipt` shape.** Every adapter must produce the same
 *   subset; viem's, ethers v5's and v6's native receipts each carry
 *   library-specific extras that don't survive normalisation. The fields
 *   here are the union of what the SDK's downstream code actually
 *   reads (status check, log decoding, block number for proof
 *   generation). Add fields here only when a real consumer needs them
 *   and all three adapters can produce them.
 * - **`abi` typed as `readonly unknown[] | unknown`** rather than
 *   `viem.Abi` — the adapter file MUST NOT take a runtime dep on viem;
 *   keeping the type loose at this boundary lets each adapter narrow
 *   internally.
 */

/**
 * 0x-prefixed lowercase hex string of arbitrary length. Re-stated here
 * (rather than imported from viem) so this file has zero runtime imports.
 */
export type Hex = `0x${string}`;

/**
 * Parameters for a contract READ call. Mirrors the 90% case viem's
 * `readContract` covers; ethers adapters translate to `Contract.callStatic`.
 */
/**
 * Block tag a read is pinned to. `'safe'` / `'finalized'` defend against
 * reorg races on the parent chain — a checkpoint read at `'latest'` can
 * observe an un-finalised header that is reorged out before the exit
 * payload reaches L1, producing a proof against a checkpoint that no
 * longer exists. A `bigint` pins to an exact block height.
 */
export type BlockTag = 'safe' | 'finalized' | 'latest' | bigint;

export interface ReadRequest {
  address: Hex;
  /** ABI as supplied by the consumer; each adapter narrows internally. */
  abi: readonly unknown[] | unknown;
  functionName: string;
  args?: readonly unknown[];
  /**
   * Block tag the read is pinned to. Defaults to the underlying client's
   * default (`'latest'`) when omitted. Used by the checkpoint / root-block
   * lookups to read at `'safe'` and avoid reorg races. See {@link BlockTag}.
   */
  blockTag?: BlockTag;
}

/**
 * Parameters for a contract WRITE call. Numeric fields are `bigint`
 * (never `number`/`string`) so callers never have to think about the
 * wei/gwei conversion gotchas the legacy SDK suffered from.
 *
 * `chainId` is optional but recommended — when set, adapters reject if
 * the underlying client is connected to a different chain (defence
 * against accidentally sending a Polygon tx to Ethereum or vice versa).
 */
export interface WriteRequest {
  address: Hex;
  abi: readonly unknown[] | unknown;
  functionName: string;
  args?: readonly unknown[];
  /** Sender; required when the underlying client has no default signer. */
  from?: Hex;
  /** Wei value to attach. */
  value?: bigint;
  /** Per-tx gas limit override. Adapters call `estimateGas` when omitted. */
  gasLimit?: bigint;
  /** EIP-1559 fee cap. Mutually exclusive with legacy `gasPrice` (not modelled). */
  maxFeePerGas?: bigint;
  /** EIP-1559 priority fee. */
  maxPriorityFeePerGas?: bigint;
  /** Nonce override; adapters fetch from the signer when omitted. */
  nonce?: number;
  /** Expected chain ID; rejection guard against cross-chain mis-sends. */
  chainId?: number;
}

/**
 * Decoded receipt log — the subset every adapter can produce verbatim.
 *
 * `topics` and `data` are kept as 0x-hex strings (not pre-decoded) so the
 * SDK's bridge-event decoders own the ABI mapping. `logIndex` is needed
 * for proof generation, where the exit-payload references the specific
 * log within the receipt.
 */
export interface ReceiptLog {
  address: Hex;
  topics: readonly Hex[];
  data: Hex;
  logIndex: number;
}

/**
 * Normalised transaction receipt. See module docstring for why this
 * shape is intentionally smaller than each library's native receipt.
 */
export interface Receipt {
  transactionHash: Hex;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  logs: readonly ReceiptLog[];
}

/**
 * Result of `Adapter.write`. See module docstring for the rationale.
 *
 * `hash` is available immediately (the moment the parent-chain RPC
 * accepts the broadcast). `confirmed()` waits for the receipt and is
 * idempotent — adapters MUST memoise the underlying confirmation so
 * repeated calls don't double-poll the chain.
 */
export interface TxResult {
  hash: Hex;
  confirmed(): Promise<Receipt>;
}

/**
 * Unsigned transaction — the encoded calldata for a write, ready to be
 * forwarded to a smart-contract wallet, batched with other operations,
 * inspected before signing, or sent through any other path that does
 * not go through the SDK's broadcast.
 *
 * # Why this shape exists
 *
 * Every public write on the SDK has a sibling `prepareXxx` that returns
 * this shape instead of broadcasting. Common consumer paths:
 *
 * - **Smart-contract wallets** (Safe, Sequence, biconomy, account
 *   abstraction bundlers) — the SDK encodes the bridge call; the wallet
 *   handles signing, ordering, and submission.
 * - **Batched user flows** — combine a `prepareApprove` and a
 *   `prepareDeposit` into a single multicall the user signs once.
 * - **Pre-flight inspection** — show the user "what's about to happen"
 *   before opening the wallet popup.
 * - **Off-chain signing** — sign on a hardware wallet, hand the signed
 *   tx to a relay service.
 *
 * # Why `{ to, data, value? }` and not the full `WriteRequest`
 *
 * Gas, fee caps, nonce, and chain ID are routinely set by the wallet at
 * signing time — letting them through here would invite consumers to
 * pin values that the wallet then overrides. The minimal shape forces
 * those decisions to live where they belong (the wallet client).
 * Consumers that genuinely need pre-computed gas estimate it via their
 * own client's `estimateGas` against the prepared `to`/`data`/`value`.
 */
export interface PreparedTx {
  to: Hex;
  data: Hex;
  /** Wei to attach. Omit when zero. */
  value?: bigint;
}

/**
 * The provider-agnostic surface every bridge primitive is written against.
 *
 * Implementations MUST:
 * - return `bigint` for every numeric value (not `BigNumber`, not
 *   `number`, not decimal strings);
 * - resolve `write()` as soon as the transaction is broadcast — never
 *   wait for confirmation in `write()` itself;
 * - memoise the confirmation inside the returned `TxResult` so
 *   `confirmed()` is idempotent;
 * - throw a `POSBridgeError` (Stage 2) for protocol violations rather
 *   than leaking native client errors directly. Until 1B/2 land, the
 *   adapters throw `Error` with a TODO comment.
 */
export interface Adapter {
  /** Connected chain ID; cached internally is fine. */
  getChainId(): Promise<number>;

  /** Eth-call style read; returns raw return value (decoded by each adapter). */
  read(req: ReadRequest): Promise<unknown>;

  /** Broadcast a write; resolves once the chain accepts the tx. */
  write(req: WriteRequest): Promise<TxResult>;

  /**
   * Encode a write for off-broadcast use. Returns the prepared
   * `{ to, data, value? }` without touching the network. Used by the
   * `prepareXxx` accessors on the public surface — see {@link PreparedTx}.
   */
  prepareWrite(req: WriteRequest): Promise<PreparedTx>;

  /** Gas estimate for the same shape as `write`. */
  estimateGas(req: WriteRequest): Promise<bigint>;

  /** Receipt fetch by hash; `null` if not yet mined. */
  getTransactionReceipt(hash: string): Promise<Receipt | null>;

  /** Sync keccak-256 hash; returns `0x`-prefixed hex digest. */
  keccak256(data: Uint8Array | string): string;

  /**
   * Low-level JSON-RPC escape hatch.
   *
   * The adapter abstracts over read/write/estimate, but the bridge's
   * proof builders need primitives the high-level surface doesn't model:
   * the bor-specific `bor_getRootHash` method, the legacy
   * `eth_getTransactionReceipt` shape with `cumulativeGasUsed`/
   * `transactionIndex`/`logsBloom` fields the slim {@link Receipt} drops,
   * and `eth_getBlockByNumber` with the full transaction list. Rather
   * than adding one Adapter method per RPC call (and forcing every
   * adapter to know about bor) we expose a single `request` primitive
   * and let the bridge wrapper build the higher-level shapes on top.
   *
   * Implementations forward to the underlying client's raw-RPC method
   * (viem's `request`, ethers v5/v6's `send`). Consumers passing a
   * non-JSON-RPC provider (custom in-memory mock, etc.) will get a
   * runtime error here — that's by design; the bridge fundamentally
   * needs RPC access.
   */
  request<T>(method: string, params: readonly unknown[]): Promise<T>;
}
