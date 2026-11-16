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
 * exists and fast-exit methods throw `ProofApiNotSetError`
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
import type { RequestUrl, WhatwgUrl } from './url.js';

import { HttpRequestFailedError } from '../errors.js';
import { httpGet } from '../utils/http_request.js';
import { buildRequestUrl, parseAbsoluteUrl, redactQueryValues } from './url.js';

export interface ProofApiClientConfig {
  /**
   * Base URL of the proof-generation API. It may carry a path prefix and
   * its own query string (e.g. an API key); both survive on every request.
   */
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
 * `proofGenerationApiUrl` may carry credentials in its query string, and
 * errors minted here end up in consumer logs. Request URLs carry their
 * own error-safe form (see `buildRequestUrl`); this redactor covers the
 * text with no URL structure to go by: an unparseable base and response
 * body snippets, where every query value is treated as secret.
 */
const redact = (s: string): string => redactQueryValues(s);

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
  private readonly baseUrl: string;
  private readonly segment: string;

  constructor(config: ProofApiClientConfig) {
    this.baseUrl = config.baseUrl;
    this.segment = networkSegment(config.network);
  }

  /**
   * Resolve a route against the base URL. Appending the route as text put
   * it after any `?` the base carried (`https://host/api?key=abc/api/v1/…`),
   * so a keyed base URL could never work; resolving with `URL` keeps the
   * route in the pathname and the base's own query params on the request.
   */
  private url(route: string, params: Record<string, string | number> = {}): RequestUrl {
    let base: WhatwgUrl;
    try {
      base = parseAbsoluteUrl(this.baseUrl);
    } catch (err) {
      // Same typed failure a bad URL produced when `fetch` rejected it, so
      // callers still fall back to local construction.
      throw new HttpRequestFailedError('proofGenerationApiUrl is not an absolute URL', {
        info: { url: redact(this.baseUrl) },
        cause: err instanceof Error ? err : new Error(String(err))
      });
    }
    return buildRequestUrl(base, `api/v1/${this.segment}/${route}`, params);
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
    const { href, safe: url } = this.url(`exit-payload/${encodeURIComponent(burnTxHash)}`, {
      eventSignature,
      ...(tokenIndex !== undefined ? { tokenIndex } : {})
    });
    const body = await httpGet<RawExitPayload>(href, { safeUrl: url, redact });
    if (typeof body.result !== 'string') {
      throw new HttpRequestFailedError('proof API exit-payload response missing `result`', {
        info: { url }
      });
    }
    return requirePayloadHex(body.result, url);
  }

  /** Fetch every exit payload for a multi-token burn tx. */
  async getAllExitPayloads(burnTxHash: string, eventSignature: string): Promise<string[]> {
    const { href, safe: url } = this.url(`all-exit-payloads/${encodeURIComponent(burnTxHash)}`, {
      eventSignature
    });
    const body = await httpGet<RawAllExitPayloads>(href, { safeUrl: url, redact });
    if (!Array.isArray(body.result)) {
      throw new HttpRequestFailedError(
        'proof API all-exit-payloads response missing `result` array',
        { info: { url } }
      );
    }
    return body.result.map((payload) => requirePayloadHex(payload, url));
  }

  /**
   * Resolve the checkpoint header that contains `blockNumber`, or `null`
   * when the block is not yet checkpointed.
   *
   * A 404 from this endpoint is the API's "not checkpointed yet" signal
   * (`BlockNotIncludedError`), the API analogue of the local-path
   * `BurnTxNotCheckpointedError` gate. We surface that as `null` so the
   * caller falls back to local construction / its own not-checkpointed
   * handling — exactly how the slow path treats an un-checkpointed block.
   * Any other non-2xx propagates as the `HttpRequestFailedError` `httpGet` throws.
   */
  async getBlockIncluded(blockNumber: number): Promise<BlockIncludedResult | null> {
    const { href, safe: url } = this.url(`block-included/${blockNumber}`);
    let body: RawBlockIncluded;
    try {
      body = await httpGet<RawBlockIncluded>(href, { safeUrl: url, redact });
    } catch (err) {
      if (HttpRequestFailedError.find(err)?.info.status === 404) {
        return null;
      }
      throw err;
    }
    if (
      body.headerBlockNumber === undefined ||
      body.start === undefined ||
      body.end === undefined
    ) {
      throw new HttpRequestFailedError('proof API block-included response missing fields', {
        info: { url }
      });
    }
    const headerBlockNumber = parseQuantity(body.headerBlockNumber, 'headerBlockNumber', url);
    const start = parseQuantity(body.start, 'start', url);
    const end = parseQuantity(body.end, 'end', url);
    if (end < start) {
      throw new HttpRequestFailedError('proof API block-included response has end < start', {
        info: { url, start: start.toString(), end: end.toString() }
      });
    }
    return { headerBlockNumber, start, end };
  }

  /** Fetch the block-inclusion Merkle proof hex for a header range. */
  async getFastMerkleProof(start: number, end: number, blockNumber: number): Promise<string> {
    const { href, safe: url } = this.url('fast-merkle-proof', { start, end, number: blockNumber });
    const body = await httpGet<RawFastMerkleProof>(href, { safeUrl: url, redact });
    if (typeof body.proof !== 'string') {
      throw new HttpRequestFailedError('proof API fast-merkle-proof response missing `proof`', {
        info: { url }
      });
    }
    // The proof is RLP-encoded straight into the exit payload, and
    // `@ethereumjs/rlp` encodes ANY string (UTF-8 for non-hex, zero-padded
    // for odd-length hex) — so a malformed body would become an exit
    // payload that can never verify. Reject it here instead; the caller
    // then falls back to local construction. The on-chain verifier walks
    // one 32-byte sibling per level of the checkpoint's Merkle tree, so
    // the proof's length is fixed by the range: `ceil(log2(end − start + 1))`
    // words, exactly what the local builder emits.
    const expectedWords = Math.ceil(Math.log2(end - start + 1));
    if (
      !/^0x(?:[0-9a-fA-F]{64})*$/.test(body.proof) ||
      (body.proof.length - 2) / 64 !== expectedWords
    ) {
      throw new HttpRequestFailedError(
        `proof API fast-merkle-proof response is not ${expectedWords} 32-byte hex words`,
        { info: { url, expectedWords, proof: body.proof.slice(0, 80) } }
      );
    }
    return body.proof;
  }
}

/**
 * An exit payload is submitted verbatim as the `bytes` argument of
 * `RootChainManager.exit`, so anything but non-empty even-length hex can
 * never be a payload. Rejecting here keeps a malformed API body from
 * reaching the consumer's contract call as an opaque library error.
 */
function requirePayloadHex(payload: string, url: string): string {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(payload)) {
    throw new HttpRequestFailedError(
      'proof API exit payload is not a non-empty 0x-prefixed hex string',
      { info: { url, payload: payload.slice(0, 80) } }
    );
  }
  return payload;
}

/**
 * `BigInt(...)` throws a bare `SyntaxError` on a non-numeric string and
 * accepts negatives, neither of which is a checkpoint quantity; both
 * become the typed HTTP failure the caller already handles.
 */
function parseQuantity(value: string | number, field: string, url: string): bigint {
  let parsed: bigint;
  try {
    parsed = toBigInt(value);
  } catch (err) {
    throw new HttpRequestFailedError(
      `proof API block-included field \`${field}\` is not a number`,
      {
        info: { url, field, value: String(value).slice(0, 80) },
        cause: err instanceof Error ? err : new Error(String(err))
      }
    );
  }
  if (parsed < 0n) {
    throw new HttpRequestFailedError(`proof API block-included field \`${field}\` is negative`, {
      info: { url, field, value: parsed.toString() }
    });
  }
  return parsed;
}
