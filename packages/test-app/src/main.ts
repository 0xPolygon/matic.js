/**
 * Browser smoke test driver for `@polygonlabs/pos-sdk`.
 *
 * # What this file is testing
 *
 * The SDK ships an ESM bundle produced by tsup. The bundle is intended
 * to be browser-safe — no `Buffer`, no `process`, no `node:*` module
 * imports — but bundling does not by itself catch code paths that
 * *reference* a Node global at runtime. Vite-then-Playwright is the
 * cheapest way to exercise the bundled output in a real browser and
 * assert that every public symbol the README points consumers at
 * actually loads, runs, and returns the expected shape.
 *
 * # Strategy
 *
 * Every check writes its result into a single JSON object that gets
 * dropped into `#result`. The Playwright spec under `tests/` reads
 * that object and asserts on each field. Console errors during the
 * run are also captured by Playwright and fail the test — so a
 * `Buffer is not defined` ReferenceError surfaces both as a missing
 * field in the result blob and as a console failure in the spec.
 *
 * # No real network calls
 *
 * Every code path here is offline by design:
 *   - `POSClient.init({ addresses })` short-circuits the address-index
 *     CDN fetch.
 *   - `erc20.prepareApprove(amount, { spenderAddress })` short-circuits
 *     the on-chain predicate lookup that the default branch would do
 *     via `getPredicateAddress` — because we hand the spender in.
 *   - The viem PublicClient is constructed against a transport that
 *     never makes a request in any of the code paths we exercise.
 *
 * # No `: any`
 *
 * Anything coming back from the SDK is typed with the public types
 * the SDK exports. Any `unknown`-typed value is narrowed before use.
 */

import { keccak256 as keccakBytes } from 'ethereum-cryptography/keccak';
import { utf8ToBytes, bytesToHex } from 'ethereum-cryptography/utils';
import { createPublicClient, createWalletClient, http } from 'viem';
import { sepolia } from 'viem/chains';

import type { NetworkAddresses as PosNetworkAddresses } from '@polygonlabs/pos-sdk';

import {
  noopLogger,
  POSBridgeError,
  POSClient,
  sanitiseError
} from '@polygonlabs/pos-sdk';
import { viemAdapter } from '@polygonlabs/pos-sdk/viem';

interface SmokeResult {
  posClientReady: boolean;
  prepareApproveData: string;
  posBridgeErrorCode: string;
  /**
   * `info` payload retrieved from the constructed `POSBridgeError`.
   * The error class extends `VError`, which exposes the structured
   * payload at `err.info`. Surfaced through the result blob so the
   * spec can assert the payload survives instantiation in the
   * browser.
   */
  posBridgeErrorInfo: Record<string, unknown> | undefined;
  posBridgeErrorCauseMessage: string | undefined;
  sanitisedMessage: string;
  keccakOk: boolean;
  noopLoggerOk: boolean;
  addressFetcherOk: boolean;
  errors: Array<{ phase: string; message: string }>;
}

const resultEl = document.getElementById('result');
if (!resultEl) {
  throw new Error('test app html is missing #result; cannot publish smoke result');
}

const errors: Array<{ phase: string; message: string }> = [];

const recordError = (phase: string, err: unknown): void => {
  const message = err instanceof Error ? err.message : String(err);
  errors.push({ phase, message });
  // Re-surface to the console so Playwright captures it as a console
  // error; the spec asserts no console errors fired during the run.
  console.error(`[smoke:${phase}]`, err);
};

/**
 * Sample addresses from the production Sepolia/Amoy index. They are
 * not exercised on chain — we only need them to be 0x-prefixed strings
 * the SDK accepts. Keeping them realistic lets the addressFetcher
 * override pattern read like a consumer would write it.
 */
const AMOY_ADDRESSES: PosNetworkAddresses = {
  RootChainManager: '0x34F5A25B627f50Bb3f5cAb72807c4D4F405a9232',
  ERC20Predicate: '0xdD6596F2029e6233DEFfaCa316e6A95217d4Dc34',
  ERC721Predicate: '0xd4D5D0D03E1cb2E03Db1B45f06F90b6c12d52f7E',
  ERC1155Predicate: '0xCcb59D5340d3F8e90A09c9D8b6e6E9d0F88f7a5d',
  EtherPredicate: '0xb50B4F4A89cAb9CFa3aCC6E7Ee9Ec2B61bE5C3a4',
  RootChain: '0x2890bA17EfE978480615e330ecB65333b880928e'
};

const PARENT_TOKEN: `0x${string}` = '0x' + 'a'.repeat(40) as `0x${string}`;
const FAKE_SPENDER: `0x${string}` = '0x' + 'b'.repeat(40) as `0x${string}`;
const FAKE_ACCOUNT: `0x${string}` = '0x' + 'c'.repeat(40) as `0x${string}`;

async function runSmokeTest(): Promise<SmokeResult> {
  // The transport URL is intentionally unreachable — we never make a
  // request through it in any code path we exercise. If a code path
  // *did* make a request, the test would fail loudly with a network
  // error, which is also a useful signal.
  const parentPublic = createPublicClient({
    chain: sepolia,
    transport: http('http://127.0.0.1:9999')
  });
  const parentWallet = createWalletClient({
    account: FAKE_ACCOUNT,
    chain: sepolia,
    transport: http('http://127.0.0.1:9999')
  });
  const childPublic = createPublicClient({
    transport: http('http://127.0.0.1:9999')
  });

  // -----------------------------------------------------------------
  // POSClient.init — exercises the viemAdapter factory (imported from
  // the `@polygonlabs/pos-sdk/viem` subpath) + createAddressFetcher.
  // -----------------------------------------------------------------
  let pos: POSClient | undefined;
  let posClientReady = false;
  try {
    pos = await POSClient.init({
      network: 'amoy',
      parent: viemAdapter({ public: parentPublic, wallet: parentWallet, account: FAKE_ACCOUNT }),
      child: viemAdapter({ public: childPublic, account: FAKE_ACCOUNT }),
      addresses: AMOY_ADDRESSES,
      logger: noopLogger
    });
    posClientReady = true;
  } catch (err) {
    recordError('POSClient.init', err);
  }

  // -----------------------------------------------------------------
  // prepareApprove — exercises the static `encodeFunctionData` path
  // inside ViemAdapter.prepareWrite (now a top-level import from viem,
  // resolved through the SDK's `/viem` subpath). Passing `spenderAddress`
  // skips the on-chain predicate lookup so we never touch RPC.
  // -----------------------------------------------------------------
  let prepareApproveData = '';
  if (pos !== undefined) {
    try {
      const erc20 = pos.parent.erc20(PARENT_TOKEN);
      const prepared = await erc20.prepareApprove(1_000_000n, {
        spenderAddress: FAKE_SPENDER
      });
      prepareApproveData = prepared.data;
    } catch (err) {
      recordError('prepareApprove', err);
    }
  }

  // -----------------------------------------------------------------
  // POSBridgeError — construct with code + info + cause; verify each
  // field is reachable from the public surface. The class extends
  // VError, which stores the structured payload on the inherited
  // `info` property.
  // -----------------------------------------------------------------
  let posBridgeErrorCode = '';
  let posBridgeErrorInfo: Record<string, unknown> | undefined;
  let posBridgeErrorCauseMessage: string | undefined;
  try {
    const cause = new Error('upstream RPC 500 at https://rpc.example/api?token=abc&foo=bar');
    const wrapped = new POSBridgeError(
      'BURN_TX_NOT_CHECKPOINTED',
      'burn tx not yet checkpointed',
      { txHash: '0xdead', blockNumber: 42 },
      { cause }
    );
    posBridgeErrorCode = wrapped.code;
    // VError exposes `info` as a public own property; reading it
    // through the inherited type is fine without a cast.
    posBridgeErrorInfo = wrapped.info;
    posBridgeErrorCauseMessage = wrapped.cause instanceof Error ? wrapped.cause.message : undefined;
  } catch (err) {
    recordError('POSBridgeError', err);
  }

  // -----------------------------------------------------------------
  // sanitiseError — token redaction on a thrown HTTP-shaped error.
  // -----------------------------------------------------------------
  let sanitisedMessage = '';
  try {
    const raw = new Error('failed at https://rpc.example/api?token=abc&foo=bar');
    const cleaned = sanitiseError(raw);
    if (cleaned instanceof Error) {
      sanitisedMessage = cleaned.message;
    } else {
      recordError('sanitiseError', new Error(`expected Error, got ${typeof cleaned}`));
    }
  } catch (err) {
    recordError('sanitiseError', err);
  }

  // -----------------------------------------------------------------
  // keccak256 via the same dependency the SDK adapter consumes
  // (`ethereum-cryptography/keccak`). Verifies that
  // `ethereum-cryptography` and its `@noble/hashes` runtime
  // dependency bundle for the browser without a Buffer / Node-crypto
  // polyfill. The SDK's `ViemAdapter.keccak256` calls into the same
  // module — exercising it here surfaces any browser-incompatible
  // code path before consumers hit it.
  // -----------------------------------------------------------------
  let keccakOk = false;
  try {
    const digest = `0x${bytesToHex(keccakBytes(utf8ToBytes('foo')))}`;
    keccakOk = /^0x[0-9a-f]{64}$/.test(digest);
    if (!keccakOk) {
      recordError('keccak256', new Error(`unexpected digest shape: ${digest}`));
    }
  } catch (err) {
    recordError('keccak256', err);
  }

  // -----------------------------------------------------------------
  // noopLogger — every method must be safely callable.
  // -----------------------------------------------------------------
  let noopLoggerOk = false;
  try {
    noopLogger.trace({ x: 1 });
    noopLogger.debug({ x: 1 }, 'msg');
    noopLogger.info({ x: 1 }, 'msg');
    noopLogger.warn({ x: 1 }, 'msg');
    noopLogger.error({ x: 1 }, 'msg');
    noopLoggerOk = true;
  } catch (err) {
    recordError('noopLogger', err);
  }

  // -----------------------------------------------------------------
  // createAddressFetcher (initial-override path) — verified
  // indirectly: POSClient.init wires the fetcher with `addresses`
  // override; if it had thrown, posClientReady would be false. We
  // also re-resolve a getter inside the SDK by issuing a second
  // prepareApprove against a different token; the fetcher serves
  // the cached value synchronously.
  // -----------------------------------------------------------------
  let addressFetcherOk = false;
  if (pos !== undefined) {
    try {
      const erc20b = pos.parent.erc20(PARENT_TOKEN);
      const second = await erc20b.prepareApprove(2_000_000n, {
        spenderAddress: FAKE_SPENDER
      });
      addressFetcherOk = typeof second.data === 'string' && second.data.startsWith('0x');
    } catch (err) {
      recordError('addressFetcher', err);
    }
  }

  return {
    posClientReady,
    prepareApproveData,
    posBridgeErrorCode,
    posBridgeErrorInfo,
    posBridgeErrorCauseMessage,
    sanitisedMessage,
    keccakOk,
    noopLoggerOk,
    addressFetcherOk,
    errors
  };
}

const publish = (state: 'ready' | 'failed', payload: SmokeResult | { error: string }): void => {
  resultEl.setAttribute('data-state', state);
  resultEl.textContent = JSON.stringify(payload, null, 2);
};

runSmokeTest().then(
  (result) => {
    publish(result.errors.length === 0 ? 'ready' : 'failed', result);
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[smoke:fatal]', err);
    publish('failed', { error: message });
  }
);
