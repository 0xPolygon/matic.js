/**
 * `ProofApiClient` — internal HTTP client for a Polygon
 * proof-generation API (e.g. `https://proof-generator.polygon.technology`).
 *
 * # Why this exists
 *
 * Reconstructing an exit proof client-side walks the L2 chain: it fetches
 * one receipt per transaction in the burn block (280+ on a busy Polygon
 * block), builds the receipts trie, locates the checkpoint header, and
 * Merkle-proves block inclusion — far too many sequential RPC calls to do
 * reliably from a browser or a thin service. The proof-generation API does
 * that work server-side so a consumer makes a single HTTP request. This
 * client is the SDK's typed front-door to that API.
 *
 * # Opt-in, no default URL
 *
 * The fast path is opt-in: the client is built only when the consumer sets
 * `proofGenerationApiUrl` on `POSClientConfig`. When unset, no client
 * exists and fast-exit methods throw `POSBridgeError('PROOF_API_NOT_SET')`
 * — matching the 0.x `setProofApi()` semantics. We deliberately do NOT
 * default the URL: the legacy SDK auto-derived it from the network, which
 * masked mis-configuration in air-gapped deployments.
 *
 * # Network segment
 *
 * The API namespaces routes by a network segment that is NOT the same as
 * the SDK `network`: mainnet maps to `matic`, amoy stays `amoy`. The 0.x
 * `NetworkService` hardcoded `matic` (`version === 'v1' ? 'matic' : …`),
 * a latent mainnet-only bug; we derive the segment from `network` instead.
 *
 * # Why not `import()` — and why this is internal
 *
 * Static imports only (a hard SDK requirement). The class is never exported
 * from `index.ts`; it is an internal collaborator that `POSClient.init`
 * constructs and hands to `POSBridgeHelpers`.
 */

import type { Network } from '../networks.js';

import { POSBridgeError } from '../errors.js';
import { httpGet } from '../utils/http_request.js';

export interface ProofApiClientConfig {
  /** Base URL of the proof-generation API. A trailing slash is stripped. */
  baseUrl: string;
  /** SDK network — maps to the API's network segment (mainnet → matic). */
  network: Network;
}

/**
 * Root-block inclusion info as returned by `block-included`. Values on
 * the wire may be hex (`0x…`) or decimal strings; this client normalises
 * everything to `bigint`.
 */
export interface BlockIncludedResult {
  headerBlockNumber: bigint;
  start: bigint;
  end: bigint;
}

/** Raw `block-included` 200 body — superset of fields we consume. */
interface RawBlockIncluded {
  headerBlockNumber: string | number;
  start: string | number;
  end: string | number;
}

/** Raw `exit-payload` / `all-exit-payloads` 200 body. */
interface RawExitPayload {
  message: string;
  result: string;
}

interface RawAllExitPayloads {
  message: string;
  result: string[];
}

/** Raw `fast-merkle-proof` 200 body. */
interface RawFastMerkleProof {
  proof: string;
}

/**
 * Map an SDK network to the proof-API network segment.
 *
 * Mainnet's segment is the historical `matic`; amoy is itself. Centralised
 * here so the mapping is in one place if a future network is added.
 */
function networkSegment(network: Network): string {
  return network === 'mainnet' ? 'matic' : network;
}

/**
 * Normalise a hex-or-decimal string/number to `bigint`. The 0.x
 * `NetworkService` branched on a `0x` prefix to pick `parseInt(x, 16)`
 * vs decimal; native `BigInt(...)` already parses both a `0x`-prefixed
 * hex string and a decimal string (and a number) correctly, so no
 * prefix branch is needed.
 */
function toBigInt(value: string | number): bigint {
  return BigInt(value);
}

export class ProofApiClient {
  readonly #base: string;
  readonly #segment: string;

  constructor(config: ProofApiClientConfig) {
    // Strip a single trailing slash so route composition never produces a
    // double slash (`https://host//api/...`).
    this.#base = config.baseUrl.replace(/\/+$/, '');
    this.#segment = networkSegment(config.network);
  }

  #url(path: string): string {
    return `${this.#base}/api/v1/${this.#segment}${path}`;
  }

  /**
   * Fetch a single pre-built exit payload. `tokenIndex` selects the n-th
   * matching log when the burn tx emitted several.
   */
  async getExitPayload(
    burnTxHash: string,
    eventSignature: string,
    tokenIndex?: number
  ): Promise<string> {
    const tokenIndexQuery = tokenIndex !== undefined ? `&tokenIndex=${tokenIndex}` : '';
    const url = this.#url(
      `/exit-payload/${burnTxHash}?eventSignature=${eventSignature}${tokenIndexQuery}`
    );
    const body = await httpGet<RawExitPayload>(url);
    if (typeof body.result !== 'string') {
      throw new POSBridgeError(
        'ROOT_HASH_RPC_FAILED',
        'proof API exit-payload response missing `result`',
        { url }
      );
    }
    return body.result;
  }

  /** Fetch every exit payload for a multi-token burn tx. */
  async getAllExitPayloads(burnTxHash: string, eventSignature: string): Promise<string[]> {
    const url = this.#url(`/all-exit-payloads/${burnTxHash}?eventSignature=${eventSignature}`);
    const body = await httpGet<RawAllExitPayloads>(url);
    if (!Array.isArray(body.result)) {
      throw new POSBridgeError(
        'ROOT_HASH_RPC_FAILED',
        'proof API all-exit-payloads response missing `result` array',
        { url }
      );
    }
    return body.result;
  }

  /**
   * Resolve the checkpoint header that contains `blockNumber`, or `null`
   * when the block is not yet checkpointed.
   *
   * A 404 from this endpoint is the API's "not checkpointed yet" signal
   * (`BlockNotIncludedError`), the API analogue of the local-path
   * `BURN_TX_NOT_CHECKPOINTED` gate. We surface that as `null` so the
   * caller falls back to local construction / its own not-checkpointed
   * handling — exactly how the slow path treats an un-checkpointed block.
   * Any other non-2xx propagates as the `POSBridgeError` `httpGet` throws.
   */
  async getBlockIncluded(blockNumber: number): Promise<BlockIncludedResult | null> {
    const url = this.#url(`/block-included/${blockNumber}`);
    let body: RawBlockIncluded;
    try {
      body = await httpGet<RawBlockIncluded>(url);
    } catch (err) {
      if (err instanceof POSBridgeError && err.info?.['status'] === 404) {
        return null;
      }
      throw err;
    }
    if (
      body.headerBlockNumber === undefined ||
      body.start === undefined ||
      body.end === undefined
    ) {
      throw new POSBridgeError(
        'ROOT_HASH_RPC_FAILED',
        'proof API block-included response missing fields',
        { url }
      );
    }
    return {
      headerBlockNumber: toBigInt(body.headerBlockNumber),
      start: toBigInt(body.start),
      end: toBigInt(body.end)
    };
  }

  /** Fetch the block-inclusion Merkle proof hex for a header range. */
  async getFastMerkleProof(start: number, end: number, blockNumber: number): Promise<string> {
    const url = this.#url(`/fast-merkle-proof?start=${start}&end=${end}&number=${blockNumber}`);
    const body = await httpGet<RawFastMerkleProof>(url);
    if (typeof body.proof !== 'string') {
      throw new POSBridgeError(
        'ROOT_HASH_RPC_FAILED',
        'proof API fast-merkle-proof response missing `proof`',
        { url }
      );
    }
    return body.proof;
  }
}
