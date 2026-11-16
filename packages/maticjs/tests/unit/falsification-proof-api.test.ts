import { createPublicClient, custom } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../src/logger.ts';
import type { NetworkAddresses } from '../../src/types.ts';

import { viemAdapter } from '../../src/adapters/viem.ts';
import { LogEventSignature } from '../../src/constant.ts';
import {
  HttpRequestFailedError,
  isMaticjsError,
  rootCause,
  TransactionNotFoundError
} from '../../src/errors.ts';
import { POSClient } from '../../src/pos-client.ts';
import { expectNoLibraryCause } from './library-errors.ts';

/**
 * Falsification matrix, proof-API row: `proofGenerationApiUrl` is set and
 * the API fails. The SDK's contract is that an API failure degrades to
 * local construction, so the API's HttpRequestFailedError must NOT be the
 * thrown cause: it is logged as a warning (`{ err }`) and the error the
 * consumer sees is whatever stopped the local path: an SDK condition, or
 * the node's error itself when the node is what failed.
 *
 * Driven through `POSClient.buildExitPayload` over the REAL viem adapter;
 * only `fetch` and the JSON-RPC transport are stubbed.
 */

const PROOF_API = 'https://proof.example/';
const BURN_TX = `0x${'ab'.repeat(32)}`;
const TX_BLOCK = 100;
const BLOCK_HASH = `0x${'aa'.repeat(32)}`;

const ADDRESSES: NetworkAddresses = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666'
};

const toQuantity = (v: number): string => `0x${v.toString(16)}`;
const word = (v: number): string => `0x${v.toString(16).padStart(64, '0')}`;

const rpcError = (code: number, message: string): Error =>
  Object.assign(new Error(message), { code });

// --- the child + parent chain (one node serves both) ------------------------

/**
 * `burnMined: false` — the burn transaction is unknown to the node, so the
 * local path stops at once with TransactionNotFoundError.
 * `burnMined: true` — the burn is mined and checkpointed, the receipt and
 * block read back, and the local path stops later, at the node's
 * `bor_getRootHash`, whose error is rethrown as viem raised it.
 */
class ProofChain {
  readonly methods: string[] = [];
  private readonly burnMined: boolean;

  constructor({ burnMined }: { burnMined: boolean }) {
    this.burnMined = burnMined;
  }

  answer(method: string): unknown {
    this.methods.push(method);
    switch (method) {
      case 'eth_chainId':
        return toQuantity(80002);
      case 'eth_call':
        // RootChain.getLastChildBlock: far past the burn, so it is checkpointed.
        return word(1_000);
      case 'eth_getTransactionByHash':
        return this.burnMined ? { hash: BURN_TX, blockNumber: toQuantity(TX_BLOCK) } : null;
      case 'eth_getTransactionReceipt':
        return {
          transactionHash: BURN_TX,
          transactionIndex: '0x0',
          blockHash: BLOCK_HASH,
          blockNumber: toQuantity(TX_BLOCK),
          from: '0x7777777777777777777777777777777777777777',
          to: '0x8888888888888888888888888888888888888888',
          contractAddress: null,
          cumulativeGasUsed: '0xc350',
          gasUsed: '0xc350',
          logs: [],
          status: '0x1',
          logsBloom: `0x${'00'.repeat(256)}`,
          type: '0x2'
        };
      case 'eth_getBlockByNumber':
        return {
          hash: BLOCK_HASH,
          parentHash: `0x${'bb'.repeat(32)}`,
          sha3Uncles: `0x${'cc'.repeat(32)}`,
          stateRoot: `0x${'dd'.repeat(32)}`,
          transactionsRoot: `0x${'ee'.repeat(32)}`,
          receiptsRoot: `0x${'ff'.repeat(32)}`,
          logsBloom: `0x${'00'.repeat(256)}`,
          number: toQuantity(TX_BLOCK),
          timestamp: '0x1',
          nonce: '0x0000000000000000',
          difficulty: '0x0',
          size: '0x1',
          gasLimit: '0x1c9c380',
          gasUsed: '0x0',
          miner: '0x0000000000000000000000000000000000000000',
          extraData: '0x',
          uncles: [],
          transactions: []
        };
      case 'bor_getRootHash':
        throw rpcError(-32000, 'bor_getRootHash: range not available');
      default:
        throw rpcError(-32601, `stub chain: unexpected RPC ${method}`);
    }
  }
}

// --- the proof API (global fetch) --------------------------------------------

type ApiAnswer = () => Promise<Response>;

const fetchedUrls: string[] = [];

const stubProofApi = (answers: { [route: string]: ApiAnswer }): void => {
  vi.stubGlobal('fetch', (input: string | URL) => {
    const url = String(input);
    fetchedUrls.push(url);
    for (const [route, answer] of Object.entries(answers)) {
      if (url.includes(`/api/v1/amoy/${route}`)) return answer();
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
};

const networkDown: ApiAnswer = () => Promise.reject(new TypeError('fetch failed'));
const htmlPage: ApiAnswer = () =>
  Promise.resolve(
    new Response('<html>challenge</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    })
  );
const json =
  (body: unknown): ApiAnswer =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

// --- a logger that records warnings ------------------------------------------

type Entry = { obj: object; msg: string | undefined };

const recordingLogger = (): Logger & { warnings: Entry[] } => {
  const warnings: Entry[] = [];
  return {
    warnings,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (obj, msg) => {
      warnings.push({ obj, msg });
    },
    error: () => {}
  };
};

const loggedErr = (entry: Entry | undefined): unknown =>
  entry === undefined ? undefined : Reflect.get(entry.obj, 'err');

const posClient = async (chain: ProofChain, logger: Logger): Promise<POSClient> => {
  const adapter = viemAdapter({
    public: createPublicClient({
      transport: custom({ request: async ({ method }: { method: string }) => chain.answer(method) })
    })
  });
  return POSClient.init({
    network: 'amoy',
    parent: adapter,
    child: adapter,
    addresses: ADDRESSES,
    proofGenerationApiUrl: PROOF_API,
    logger
  });
};

/**
 * The rejection, checked on the way out: whatever the row, no ethers or
 * viem error is ever hung under an SDK error as its cause.
 */
const rejectionOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => {
      expectNoLibraryCause(e);
      return e;
    }
  );

beforeEach(() => {
  fetchedUrls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fast exit: the exit-payload API fails and the local fallback fails too', () => {
  it('network failure (TypeError: fetch failed): ProofBuildError caused by the local TransactionNotFoundError; the API error is only logged', async () => {
    stubProofApi({ 'exit-payload': networkDown });
    const logger = recordingLogger();
    const pos = await posClient(new ProofChain({ burnMined: false }), logger);

    const err = await rejectionOf(
      pos.buildExitPayload(BURN_TX, LogEventSignature.Erc20Transfer, true)
    );

    expect(fetchedUrls.some((u) => u.includes('/exit-payload/'))).equals(true);
    expect(err).property('name').equals('ProofBuildError');
    expect(err).nested.property('info.operation').equals('buildExitPayload');
    expect(err).nested.property('info.isFast').equals(true);
    expect(HttpRequestFailedError.find(err)).equals(null);
    expect(TransactionNotFoundError.find(err))
      .nested.property('info.transactionHash')
      .equals(BURN_TX);
    expect(rootCause(err)).property('name').equals('TransactionNotFoundError');

    expect(logger.warnings).lengthOf(1);
    const logged = loggedErr(logger.warnings[0]);
    expect(HttpRequestFailedError.find(logged)).not.equals(null);
    const loggedRoot = rootCause(logged);
    expect(loggedRoot).instanceOf(TypeError);
    expect(loggedRoot).property('message').equals('fetch failed');
  });

  it('non-JSON 200 body: the logged API error has the SyntaxError as its root cause', async () => {
    stubProofApi({ 'exit-payload': htmlPage });
    const logger = recordingLogger();
    const pos = await posClient(new ProofChain({ burnMined: false }), logger);

    const err = await rejectionOf(
      pos.buildExitPayload(BURN_TX, LogEventSignature.Erc20Transfer, true)
    );

    expect(err).property('name').equals('ProofBuildError');
    expect(HttpRequestFailedError.find(err)).equals(null);
    expect(TransactionNotFoundError.has(err)).equals(true);

    expect(logger.warnings).lengthOf(1);
    const logged = loggedErr(logger.warnings[0]);
    expect(HttpRequestFailedError.find(logged))
      .nested.property('info.contentType')
      .equals('text/html');
    expect(rootCause(logged)).instanceOf(SyntaxError);
  });
});

describe('slow exit (isFast: false) with the proof API configured', () => {
  it('a burn the node does not know stops before any API call', async () => {
    stubProofApi({});
    const logger = recordingLogger();
    const pos = await posClient(new ProofChain({ burnMined: false }), logger);

    const err = await rejectionOf(
      pos.buildExitPayload(BURN_TX, LogEventSignature.Erc20Transfer, false)
    );

    expect(err).property('name').equals('ProofBuildError');
    expect(err).nested.property('info.isFast').equals(false);
    expect(TransactionNotFoundError.has(err)).equals(true);
    expect(fetchedUrls).lengthOf(0);
    expect(logger.warnings).lengthOf(0);
  });
});

describe('slow exit: the API block proof is unusable and the local block proof fails', () => {
  const included = json({ headerBlockNumber: 10_000, start: TX_BLOCK, end: TX_BLOCK + 1 });

  it('malformed fast-merkle-proof: the logged error carries expectedWords; the node error from the local build is thrown as-is', async () => {
    stubProofApi({ 'block-included': included, 'fast-merkle-proof': json({ proof: '0xzz' }) });
    const logger = recordingLogger();
    const pos = await posClient(new ProofChain({ burnMined: true }), logger);

    const err = await rejectionOf(
      pos.buildExitPayload(BURN_TX, LogEventSignature.Erc20Transfer, false)
    );

    expect(fetchedUrls.some((u) => u.includes('/fast-merkle-proof'))).equals(true);
    // The node's error reaches the caller as viem raised it: no
    // ProofBuildError around it and no SDK condition in between.
    expect(isMaticjsError(err)).equals(false);
    expect(err).property('message').contains('bor_getRootHash: range not available');
    expect(err).property('code').equals(-32000);

    expect(logger.warnings).lengthOf(1);
    const logged = loggedErr(logger.warnings[0]);
    // [start, end] = [100, 101]: a one-level tree, so one 32-byte word.
    expect(HttpRequestFailedError.find(logged)).nested.property('info.expectedWords').equals(1);
  });

  it('non-JSON fast-merkle-proof body: the logged error has the SyntaxError as its root cause', async () => {
    stubProofApi({ 'block-included': included, 'fast-merkle-proof': htmlPage });
    const logger = recordingLogger();
    const pos = await posClient(new ProofChain({ burnMined: true }), logger);

    const err = await rejectionOf(
      pos.buildExitPayload(BURN_TX, LogEventSignature.Erc20Transfer, false)
    );

    expect(isMaticjsError(err)).equals(false);
    expect(err).property('message').contains('bor_getRootHash: range not available');

    expect(logger.warnings).lengthOf(1);
    expect(rootCause(loggedErr(logger.warnings[0]))).instanceOf(SyntaxError);
  });
});
