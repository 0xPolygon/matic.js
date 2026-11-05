import { describe, expect, it } from 'vitest';

import type {
  Adapter,
  PreparedTx,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';

import { POSBridgeError } from '../../src/errors.ts';
import { createBridgeChildClient } from '../../src/internal/bridge-child-client.ts';
import { parseHeaderBlocksResult } from '../../src/pos/find_checkpoint_slot.ts';

/**
 * Pins the two RPC/adapter shape contracts that broke against the real
 * world despite a green unit suite (go-live review, Cluster 2):
 *
 * 1. `headerBlocks` decode — viem returns a plain POSITIONAL array for
 *    multi-output functions (no `.start`/`.end` named properties), while
 *    ethers v5/v6 return a `Result` array subclass that carries both.
 *    Reading named properties directly threw `TypeError` for every viem
 *    consumer on every checkpoint lookup.
 *
 * 2. `eth_getBlockByNumber` — geth v1.14+ (and current bor) removed
 *    `totalDifficulty` from block responses; unconditional parsing
 *    crashed all local exit construction against modern RPC endpoints.
 */

describe('parseHeaderBlocksResult — adapter decode shapes', () => {
  // Outputs: [root, start, end, createdAt, proposer]
  const ROOT = '0xabababababababababababababababababababababababababababababababab';
  const PROPOSER = '0xC26880A0AF2EA0c7E8130e6EC47Af756465452E8';

  it('decodes the viem shape: plain positional array of bigints', () => {
    const viemResult = [ROOT, 100n, 200n, 5n, PROPOSER];
    expect(parseHeaderBlocksResult(viemResult)).deep.equals({ start: 100n, end: 200n });
  });

  it('decodes the ethers-v6 shape: array subclass with named properties', () => {
    // ethers Result is an Array subclass carrying named props; emulate it.
    const result = Object.assign([ROOT, 100n, 200n, 5n, PROPOSER], {
      start: 100n,
      end: 200n
    });
    // Array.isArray is true for Result — positional path must win and agree.
    expect(parseHeaderBlocksResult(result)).deep.equals({ start: 100n, end: 200n });
  });

  it('decodes the ethers-v5 shape: BigNumber-like values coerced via toString', () => {
    const bn = (v: bigint): { toString(): string } => ({ toString: () => v.toString() });
    const result = [bn(0n), bn(100n), bn(200n), bn(5n), PROPOSER];
    expect(parseHeaderBlocksResult(result)).deep.equals({ start: 100n, end: 200n });
  });

  it('decodes a plain named-property object (defensive fallback)', () => {
    expect(parseHeaderBlocksResult({ start: '100', end: 200 })).deep.equals({
      start: 100n,
      end: 200n
    });
  });

  it('throws a typed error on a short array', () => {
    const err = (() => {
      try {
        parseHeaderBlocksResult([ROOT]);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).instanceOf(POSBridgeError);
    expect((err as POSBridgeError).code).equals('BRIDGE_EVENT_DECODE_FAILED');
  });

  it('throws a typed error on an unrecognisable shape', () => {
    const err = (() => {
      try {
        parseHeaderBlocksResult(42);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).instanceOf(POSBridgeError);
    expect((err as POSBridgeError).code).equals('BRIDGE_EVENT_DECODE_FAILED');
  });
});

describe('getBlockWithTransaction — modern RPC block shape', () => {
  /** A realistic bor block response; `totalDifficulty` injected per test. */
  function rawBlock(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      size: '0x2af',
      difficulty: '0x1',
      uncles: [],
      number: '0x23a1b2c',
      hash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      parentHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
      nonce: '0x0000000000000000',
      sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
      logsBloom: `0x${'0'.repeat(512)}`,
      transactionsRoot: '0x3333333333333333333333333333333333333333333333333333333333333333',
      stateRoot: '0x4444444444444444444444444444444444444444444444444444444444444444',
      receiptsRoot: '0x5555555555555555555555555555555555555555555555555555555555555555',
      miner: '0x0000000000000000000000000000000000000000',
      extraData: '0x',
      gasLimit: '0x1c9c380',
      gasUsed: '0x5208',
      timestamp: '0x66f2a1b0',
      baseFeePerGas: '0x19',
      transactions: [],
      ...extra
    };
  }

  function adapterReturningBlock(block: Record<string, unknown>): Adapter {
    const unreached = (): never => {
      throw new Error('not used in this test');
    };
    return {
      getChainId: () => Promise.resolve(137),
      read: (_req: ReadRequest) => Promise.resolve(unreached()),
      write: (_req: WriteRequest) => Promise.resolve(unreached() as TxResult),
      prepareWrite: (_req: WriteRequest) => Promise.resolve(unreached() as PreparedTx),
      estimateGas: (_req: WriteRequest) => Promise.resolve(unreached() as bigint),
      getTransactionReceipt: (_hash: string) => Promise.resolve(unreached() as Receipt | null),
      keccak256: () => unreached(),
      request: <T>() => Promise.resolve(block as T)
    };
  }

  it('parses a modern block with NO totalDifficulty (geth 1.14+ / current bor)', async () => {
    const client = createBridgeChildClient(adapterReturningBlock(rawBlock()));
    const block = await client.getBlockWithTransaction(37337900);
    expect(block).property('difficulty').equals(1);
    expect(block).not.property('totalDifficulty');
    expect(block).property('number').equals(0x23a1b2c);
  });

  it('still maps totalDifficulty when a legacy node sends it', async () => {
    const client = createBridgeChildClient(
      adapterReturningBlock(rawBlock({ totalDifficulty: '0xa' }))
    );
    const block = await client.getBlockWithTransaction(37337900);
    expect(block).property('totalDifficulty').equals(10);
  });
});
