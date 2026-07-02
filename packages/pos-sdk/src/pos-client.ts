/**
 * `POSClient` — top-level orchestrator for the Polygon PoS bridge SDK.
 *
 * # Why a dedicated class instead of a free factory
 *
 * Bridge flows compose: a single deposit needs the parent-chain
 * `RootChainManager`, the child-chain ERC-20, the predicate registry,
 * gas estimation across two chains, and (for the fast-exit path) a
 * proof-API client. Returning each of these from a separate factory
 * function would force every consumer to wire them together, with the
 * matching-network checks duplicated at every call site.
 *
 * `POSClient` owns that wiring: one async `init(config)` builds every
 * dependency once, validates that the address index can be fetched
 * (so configuration errors surface at construction time, not on first
 * use), and exposes the bridge surface through three named handles:
 * `parent.{erc20,erc721,erc1155}(addr)` and `child.{erc20,...}(addr)`
 * for token-specific work, plus `rootChainManager` for raw deposit /
 * exit calls.
 *
 * # Token-namespace lazy construction
 *
 * `parent.erc20(addr)` returns a fresh `ERC20` per call; we don't
 * cache. The `ContractCaller` inside is cheap to build (no I/O) and
 * caching by address would require a `WeakRef`-keyed map plus
 * lifetime semantics most consumers don't expect. Repeated calls with
 * the same address get equivalent behaviour at zero correctness cost.
 *
 * # Construction is async
 *
 * `init` performs one foreground fetch against the address index to
 * validate configuration. After that, the {@link AddressFetcher}'s
 * stale-while-revalidate cache means subsequent contract calls reuse
 * the cached value with no per-call cost; TTL refreshes happen in the
 * background.
 */

import type { Adapter, BlockTag, Hex, PreparedTx, TxResult } from './adapter.js';
import type { ContractCallerOptions } from './internal/contract-caller.js';
import type { Logger } from './logger.js';
import type { Network, NetworkAddresses } from './networks.js';
import type { AddressFetcher } from './services/address-service.js';

import { POSBridgeError } from './errors.js';
import { encodeAbiParameters } from './internal/abi-encode.js';
import { createBridgeChildClient } from './internal/bridge-child-client.js';
import { POSBridgeHelpers } from './internal/pos-bridge-helpers.js';
import { ProofApiClient } from './internal/proof-api-client.js';
import { noopLogger } from './logger.js';
import { ERC20 } from './pos/erc20.js';
import { ERC721 } from './pos/erc721.js';
import { ERC1155 } from './pos/erc1155.js';
import { GasSwapper } from './pos/gas_swapper.js';
import { RootChain } from './pos/root_chain.js';
import { RootChainManager } from './pos/root_chain_manager.js';
import { createAddressFetcher } from './services/address-service.js';

const DEFAULT_PROOF_CONCURRENCY = 4;
/** address(0xEeee...EEeE) — the bridge's sentinel for native ETH. */
const ETHER_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const;

/**
 * Public configuration accepted by {@link POSClient.init}.
 *
 * No `version` field — Stage 3 drops the legacy `version: 'pos' | 'mintable'`
 * concept; mintable variants are addressed via dedicated helpers
 * (e.g. `ERC1155.approveAllForMintable`).
 *
 * No `isParent` field — every public method is unambiguous via the
 * `parent.*` / `child.*` namespaces.
 *
 * No `log: boolean` field — pass a real {@link Logger} to enable
 * logging; omit for the no-op default.
 *
 * No `resolution` field — the legacy SDK accepted an
 * UnstoppableDomains resolver here. Address-resolution is a consumer
 * concern; the SDK takes raw `0x`-addresses.
 */
export interface POSClientConfig {
  /** Polygon network — `'mainnet'` or `'amoy'`. */
  network: Network;
  /**
   * Parent-chain (Ethereum) adapter. Construct it with the factory for
   * the web3 library you use — `viemAdapter(...)` from
   * `@polygonlabs/pos-sdk/viem`, `ethersV5Adapter(...)` from
   * `.../ethers-v5`, or `ethersV6Adapter(...)` from `.../ethers-v6`. The
   * SDK never imports viem or ethers itself; the adapter you pass in is
   * the only place the chosen library is loaded.
   */
  parent: Adapter;
  /** Child-chain (Polygon) adapter; built the same way as `parent`. */
  child: Adapter;
  /**
   * Optional structural logger. Defaults to {@link noopLogger}; pass a
   * pino-shaped logger to surface SDK debug / warn / error events.
   */
  logger?: Logger;
  /**
   * Maximum concurrent receipt-fetch RPCs during proof construction.
   * Polygon mainnet blocks routinely contain 280+ transactions; firing
   * all of them at once trips RPC rate limits. Default: 4.
   */
  proofConcurrency?: number;
  /**
   * Base URL of a Polygon proof-generation API (e.g.
   * 'https://proof-generator.polygon.technology'). Optional — when
   * omitted, fast-exit methods throw POSBridgeError('PROOF_API_NOT_SET')
   * and all exit payloads are built locally from RPC. No default: the
   * fast path is opt-in, matching the 0.x setProofApi() behaviour.
   */
  proofGenerationApiUrl?: string;
  /**
   * L1 block tag the root-chain checkpoint reads pin to. Defaults to
   * `'safe'` to avoid reorg races: reading the checkpoint at `'latest'`
   * can observe an un-finalised header that is reorged out before the
   * exit payload reaches L1. Set to `'latest'` to trade safety for
   * lower latency, or `'finalized'` for maximum safety. Matches the 0.x
   * `rootChainDefaultBlock` knob.
   */
  rootChainDefaultBlock?: BlockTag;
  /**
   * Pre-resolved address index. When provided, the SDK never reaches
   * the CDN; the consumer is fully responsible for keeping these
   * addresses fresh across protocol redeployments.
   */
  addresses?: NetworkAddresses;
  /**
   * Override the CDN base URL. Defaults to the value baked into the
   * SDK (`networks.ts`'s `ADDRESS_INDEX_URL`). Use for staging
   * mirrors or air-gapped deployments where the URL is reachable but
   * different.
   */
  addressIndexUrl?: string;
  /**
   * TTL for cached addresses, in milliseconds. Default 1 hour. Inside
   * the TTL window the cache is served synchronously; outside the
   * window the cache is still served immediately while a single
   * background refresh repopulates it. Ignored when {@link addresses}
   * is provided.
   */
  addressTTLMs?: number;
  /**
   * Hook invoked when a *background* address-cache refresh fails. The
   * cached value continues to be served and never propagates the
   * error to the caller (a stale value is better than a 500). Use
   * this to forward the error to your own logger / alerting.
   */
  onAddressRefreshError?: (err: Error) => void;
}

/**
 * Lazy factories for parent / child token wrappers. Constructing a
 * fresh wrapper per call is cheap; the wrapper holds a `ContractCaller`
 * pinned to the address you pass in.
 */
export interface TokenNamespace {
  /** ERC-20 wrapper for the supplied token address on this chain. */
  erc20(addr: Hex): ERC20;
  /** ERC-721 wrapper for the supplied token address on this chain. */
  erc721(addr: Hex): ERC721;
  /** ERC-1155 wrapper for the supplied token address on this chain. */
  erc1155(addr: Hex): ERC1155;
}

/**
 * Top-level orchestrator. Construct via {@link POSClient.init}; the
 * constructor is private so misuse (skipping the address-index
 * validation, forgetting to inject the bridge helpers) cannot
 * happen.
 */
export class POSClient {
  /** Parent-chain (Ethereum) `RootChainManager` handle. */
  readonly rootChainManager: RootChainManager;
  /** Parent-chain (Ethereum) `RootChain` handle. */
  readonly rootChain: RootChain;
  /** Parent-chain (Ethereum) token factories. */
  readonly parent: TokenNamespace;
  /** Child-chain (Polygon) token factories. */
  readonly child: TokenNamespace;

  readonly #parentAdapter: Adapter;
  readonly #fetcher: AddressFetcher;
  readonly #logger: Logger;
  readonly #bridge: POSBridgeHelpers;
  readonly #proofGenerationApiUrl: string | undefined;

  private constructor(args: {
    rootChainManager: RootChainManager;
    rootChain: RootChain;
    parent: TokenNamespace;
    child: TokenNamespace;
    parentAdapter: Adapter;
    fetcher: AddressFetcher;
    logger: Logger;
    bridge: POSBridgeHelpers;
    proofGenerationApiUrl: string | undefined;
  }) {
    this.rootChainManager = args.rootChainManager;
    this.rootChain = args.rootChain;
    this.parent = args.parent;
    this.child = args.child;
    this.#parentAdapter = args.parentAdapter;
    this.#fetcher = args.fetcher;
    this.#logger = args.logger;
    this.#bridge = args.bridge;
    this.#proofGenerationApiUrl = args.proofGenerationApiUrl;
  }

  /**
   * The configured proof-generation API base URL, or `undefined` when the
   * fast-exit path is disabled. Mirrors the 0.x `getProofApi()` accessor.
   */
  getProofApi(): string | undefined {
    return this.#proofGenerationApiUrl;
  }

  /**
   * The resolved bridge contract addresses for the configured network.
   *
   * Surfaced so consumers can call contract methods the SDK doesn't wrap
   * directly — the escape hatch that replaces the 0.x `.method(...)`
   * accessor. Pair these addresses with the vendored ABIs exported from
   * `@polygonlabs/pos-sdk/abi` and your own viem / ethers client:
   *
   * ```ts
   * import { RootChainManagerABI } from '@polygonlabs/pos-sdk/abi';
   * const { RootChainManager } = await pos.getAddresses();
   * const value = await parentPublicClient.readContract({
   *   address: RootChainManager,
   *   abi: RootChainManagerABI,
   *   functionName: 'someUnwrappedMethod',
   *   args: [...]
   * });
   * ```
   *
   * Reads through the same {@link AddressFetcher} the bridge flows use,
   * so the value is served from the stale-while-revalidate cache (no
   * extra network round-trip in the common case) and reflects index
   * redeployments within the TTL window. When the client was constructed
   * with a `config.addresses` override, this returns that override
   * verbatim.
   */
  getAddresses(): Promise<NetworkAddresses> {
    return this.#fetcher.get();
  }

  /**
   * Build a fully-wired `POSClient`. Performs one foreground fetch
   * against the address index to surface configuration errors at
   * construction time; subsequent contract calls reuse the cached
   * fetcher.
   */
  static async init(config: POSClientConfig): Promise<POSClient> {
    const logger = config.logger ?? noopLogger;
    const proofConcurrency = config.proofConcurrency ?? DEFAULT_PROOF_CONCURRENCY;

    // Adapters arrive already constructed via their per-library
    // factories (viemAdapter / ethersV5Adapter / ethersV6Adapter) — no
    // selection step. This is what lets the SDK avoid a static import of
    // any web3 library: the factory the consumer imported is the only
    // place viem or ethers loads.
    const parentAdapter = config.parent;
    const childAdapter = config.child;

    const fetcher = createAddressFetcher({
      network: config.network,
      baseUrl: config.addressIndexUrl,
      ttlMs: config.addressTTLMs,
      initial: config.addresses,
      onRefreshError: config.onAddressRefreshError
    });

    // Foreground validation — surfaces network / parsing failures at
    // init time rather than on the first contract call. Subsequent
    // resolutions inside contract callers go through the same fetcher
    // and reuse the cache.
    const addresses = await fetcher.get();

    const rootChainManager = new RootChainManager({
      adapter: parentAdapter,
      getAddress: () => fetcher.get().then((a) => a.RootChainManager),
      logger
    });

    const rootChain = new RootChain({
      adapter: parentAdapter,
      getAddress: () => fetcher.get().then((a) => a.RootChain),
      logger,
      ...(config.rootChainDefaultBlock !== undefined
        ? { defaultBlock: config.rootChainDefaultBlock }
        : {})
    });

    // Build the proof-API client only when a URL is configured. Absence
    // means the fast path is disabled (opt-in), matching 0.x setProofApi.
    const proofApiClient =
      config.proofGenerationApiUrl !== undefined
        ? new ProofApiClient({ baseUrl: config.proofGenerationApiUrl, network: config.network })
        : undefined;

    // GasSwapper is only deployed on some networks. Construct only
    // when the address index actually carries one; absence is normal
    // on Amoy and any network where the swap helper isn't deployed.
    const gasSwapper =
      addresses.GasSwapper !== undefined
        ? new GasSwapper({
            adapter: parentAdapter,
            // The fetcher's `get()` returns a fresh object every
            // refresh; re-read so a redeployment is picked up.
            getAddress: () =>
              fetcher.get().then((a) => {
                if (a.GasSwapper === undefined) {
                  throw new Error('GasSwapper address disappeared from index after init');
                }
                return a.GasSwapper;
              }),
            logger
          })
        : undefined;

    const childBridgeClient = createBridgeChildClient(childAdapter);

    const bridge = new POSBridgeHelpers({
      rootChainManagerCaller: rootChainManager.caller,
      rootChainCaller: rootChain.caller,
      childClient: childBridgeClient,
      childAdapter,
      parentAdapter,
      ...(proofApiClient !== undefined ? { proofApiClient } : {}),
      ...(config.rootChainDefaultBlock !== undefined
        ? { rootChainDefaultBlock: config.rootChainDefaultBlock }
        : {}),
      logger,
      proofConcurrency
    });

    const parent: TokenNamespace = {
      erc20: (addr) =>
        new ERC20({
          tokenAddress: addr,
          isParent: true,
          adapter: parentAdapter,
          bridge,
          rootChainManager,
          gasSwapper,
          parentAdapter,
          encodeParameters: encodeAbiParameters,
          logger
        }),
      erc721: (addr) =>
        new ERC721({
          tokenAddress: addr,
          isParent: true,
          adapter: parentAdapter,
          bridge,
          rootChainManager,
          parentAdapter,
          encodeParameters: encodeAbiParameters,
          logger
        }),
      erc1155: (addr) =>
        new ERC1155({
          tokenAddress: addr,
          isParent: true,
          adapter: parentAdapter,
          bridge,
          rootChainManager,
          parentAdapter,
          encodeParameters: encodeAbiParameters,
          mintablePredicateAddress: addresses.MintableERC1155Predicate,
          logger
        })
    };

    const child: TokenNamespace = {
      erc20: (addr) =>
        new ERC20({
          tokenAddress: addr,
          isParent: false,
          adapter: childAdapter,
          bridge,
          rootChainManager,
          gasSwapper,
          parentAdapter,
          encodeParameters: encodeAbiParameters,
          logger
        }),
      erc721: (addr) =>
        new ERC721({
          tokenAddress: addr,
          isParent: false,
          adapter: childAdapter,
          bridge,
          rootChainManager,
          parentAdapter,
          encodeParameters: encodeAbiParameters,
          logger
        }),
      erc1155: (addr) =>
        new ERC1155({
          tokenAddress: addr,
          isParent: false,
          adapter: childAdapter,
          bridge,
          rootChainManager,
          parentAdapter,
          encodeParameters: encodeAbiParameters,
          mintablePredicateAddress: addresses.MintableERC1155Predicate,
          logger
        })
    };

    return new POSClient({
      rootChainManager,
      rootChain,
      parent,
      child,
      parentAdapter,
      fetcher,
      logger,
      bridge,
      proofGenerationApiUrl: config.proofGenerationApiUrl
    });
  }

  // -------------------------------------------------------------------
  // Bridge helpers — exposed flat on POSClient for symmetry with the
  // legacy `pos.client.exitUtil.<method>` access shape consumers like
  // proof-generation-api relied on. The internal `POSBridgeHelpers`
  // class stays internal; only its public methods surface here.
  // -------------------------------------------------------------------

  /** Predicate contract for `tokenAddress`, looked up via RootChainManager. */
  getPredicateAddress(tokenAddress: string): Promise<string> {
    return this.#bridge.getPredicateAddress(tokenAddress);
  }

  /**
   * True iff a burn-tx with the given event signature has already been
   * processed on the parent chain. Equivalent to the legacy
   * `pos.isWithdrawn(burnTxHash, eventSig)` query.
   */
  isWithdrawn(burnTxHash: string, eventSignature: string): Promise<boolean> {
    return this.#bridge.isWithdrawn(burnTxHash, eventSignature);
  }

  /** Same as {@link isWithdrawn} but for the n-th matching log. */
  isWithdrawnOnIndex(
    burnTxHash: string,
    eventSignature: string,
    index: number
  ): Promise<boolean> {
    return this.#bridge.isWithdrawnOnIndex(burnTxHash, index, eventSignature);
  }

  /**
   * True iff the block containing `burnTxHash` has been checkpointed on
   * the parent chain. Consumers building exit payloads outside the
   * standard token flows (sync block transactions, custom bridge
   * events) poll this first to avoid the `BURN_TX_NOT_CHECKPOINTED`
   * failure inside `buildExitPayload`.
   */
  isCheckpointed(burnTxHash: string): Promise<boolean> {
    return this.#bridge.isCheckpointed(burnTxHash);
  }

  /**
   * Build the bytes that go to `RootChainManager.exit(payload)`.
   * Exposed for consumers (e.g. the proof-generation-api service)
   * that need exit payloads for arbitrary event signatures, not just
   * the ERC-20/721/1155 transfer events the token classes hard-wire.
   *
   * Pass `isFast: true` to use the proof-API path (requires
   * `proofGenerationApiUrl` in the client config).
   */
  buildExitPayload(
    burnTxHash: string,
    eventSignature: string,
    isFast = false
  ): Promise<string> {
    return this.#bridge.buildExitPayload(burnTxHash, eventSignature, isFast);
  }

  /**
   * Same as {@link buildExitPayload} but builds the payload for the
   * n-th matching log under the burn tx — used by NFT transfers that
   * emit multiple `Transfer` events under a single tx hash.
   */
  buildExitPayloadOnIndex(
    burnTxHash: string,
    eventSignature: string,
    index: number,
    isFast = false
  ): Promise<string> {
    return this.#bridge.buildExitPayloadOnIndex(burnTxHash, eventSignature, index, isFast);
  }

  /**
   * Build an exit payload for EVERY matching log under the burn tx —
   * used when a single burn transaction transferred multiple tokens
   * (the legacy `buildMultiplePayloadsForExit`). Each returned hex goes
   * to its own `RootChainManager.exit(payload)` call.
   *
   * Pass `isFast: true` to fetch the pre-built array from the proof API
   * (requires `proofGenerationApiUrl` in the client config).
   */
  buildExitPayloads(
    burnTxHash: string,
    eventSignature: string,
    isFast = false
  ): Promise<string[]> {
    return this.#bridge.buildExitPayloads(burnTxHash, eventSignature, isFast);
  }

  /**
   * True iff a deposit's state-sync has been applied on the child chain.
   * Equivalent to the legacy `pos.isDeposited(depositTxHash)`: reads the
   * deposit's `StateSynced` event from the parent-chain receipt and
   * compares its state id against the child `StateReceiver.lastStateId()`.
   */
  isDeposited(depositTxHash: string): Promise<boolean> {
    return this.#bridge.isDeposited(depositTxHash);
  }

  /**
   * Build a Merkle inclusion proof for `blockNumber` against the header
   * range `[start, end]`. Generic block-proof builder for non-token
   * use cases — sync block transactions, custom bridge events, plasma
   * exit proofs, anything that needs the same proof shape outside the
   * standard token-class flows.
   */
  getBlockProof(
    blockNumber: number,
    range: { start: number; end: number }
  ): Promise<string> {
    return this.#bridge.getBlockProof(blockNumber, range);
  }

  /**
   * Bridge-deposit native ETH for `userAddress`. Hoisted to the
   * top-level client because ETH has no token contract, so this
   * doesn't fit naturally on `parent.erc20(...)`.
   */
  depositEther(
    amount: bigint,
    userAddress: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    return this.rootChainManager.caller.write(
      'depositEtherFor',
      [userAddress],
      { ...options, value: amount }
    );
  }

  /** Same as {@link depositEther} but returns the unsigned `{ to, data, value? }`. */
  prepareDepositEther(
    amount: bigint,
    userAddress: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    return this.rootChainManager.caller.prepareWrite(
      'depositEtherFor',
      [userAddress],
      { ...options, value: amount }
    );
  }

  /**
   * Bridge-deposit ETH plus an ETH→token swap via the GasSwapper
   * helper. Mainnet-only; the GasSwapper contract is not deployed on
   * Amoy or any future testnet.
   */
  async depositEtherWithGas(
    amount: bigint,
    userAddress: string,
    swapEthAmount: bigint,
    swapCallData: string,
    options: ContractCallerOptions = {}
  ): Promise<TxResult> {
    const swapper = await this.#requireGasSwapper();
    const chainId = await this.#parentAdapter.getChainId();
    if (chainId !== 1) {
      throw new POSBridgeError(
        'ONLY_ALLOWED_ON_MAINNET',
        'depositEtherWithGas is only allowed on Ethereum mainnet',
        { chainId }
      );
    }
    const amountInABI = encodeAbiParameters([amount], ['uint256']);
    return swapper.depositWithGas(
      ETHER_ADDRESS,
      amountInABI,
      userAddress,
      swapCallData,
      { ...options, value: amount + swapEthAmount }
    );
  }

  /** Same as {@link depositEtherWithGas} but returns the unsigned `{ to, data, value? }`. */
  async prepareDepositEtherWithGas(
    amount: bigint,
    userAddress: string,
    swapEthAmount: bigint,
    swapCallData: string,
    options: ContractCallerOptions = {}
  ): Promise<PreparedTx> {
    const swapper = await this.#requireGasSwapper();
    const chainId = await this.#parentAdapter.getChainId();
    if (chainId !== 1) {
      throw new POSBridgeError(
        'ONLY_ALLOWED_ON_MAINNET',
        'depositEtherWithGas is only allowed on Ethereum mainnet',
        { chainId }
      );
    }
    const amountInABI = encodeAbiParameters([amount], ['uint256']);
    return swapper.prepareDepositWithGas(
      ETHER_ADDRESS,
      amountInABI,
      userAddress,
      swapCallData,
      { ...options, value: amount + swapEthAmount }
    );
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Build a fresh `GasSwapper` handle on demand. We don't pre-build
   * one in `init()` because the swapper is mainnet-only — most
   * consumers never call into it, and synthesising the handle here
   * keeps the success-path I/O during `init()` minimal.
   */
  async #requireGasSwapper(): Promise<GasSwapper> {
    const addresses = await this.#fetcher.get();
    if (addresses.GasSwapper === undefined) {
      throw new POSBridgeError(
        'CONTRACT_NOT_AVAILABLE_ON_NETWORK',
        'GasSwapper is not deployed/configured on this network'
      );
    }
    return new GasSwapper({
      adapter: this.#parentAdapter,
      getAddress: () =>
        this.#fetcher.get().then((a) => {
          if (a.GasSwapper === undefined) {
            throw new Error('GasSwapper address disappeared from index');
          }
          return a.GasSwapper;
        }),
      logger: this.#logger
    });
  }
}
