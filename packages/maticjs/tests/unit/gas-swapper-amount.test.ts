import { createPublicClient, createWalletClient, custom } from 'viem';
import { describe, expect, it } from 'vitest';

import type { Adapter, Hex } from '../../src/adapter.ts';

import { viemAdapter } from '../../src/adapters/viem.ts';
import { noopLogger } from '../../src/logger.ts';
import { GasSwapper } from '../../src/pos/gas_swapper.ts';
import {
  ADDRESSES,
  outcomeOf,
  quantity,
  RecordingAdapter,
  RequestLog,
  show,
  tagged,
  USER
} from './contract-call-harness.ts';

/**
 * What the gas swapper does with the deposit amount it is given.
 *
 * Every SDK caller builds the amount as a 32-byte ABI-encoded hex string
 * (`encodeParameters([amount], ['uint256'])`) and passes it as `depositAmount`.
 * The contract takes a `uint256`, so the adapter is handed an integer. The
 * table pins, for each shape of `depositAmount`, what the adapter receives (the
 * argument's type and value) and, for the shapes that fail, the error a real viem
 * adapter over a stub node ends in. A throw
 * reads as the whole chain of error classes, outermost first.
 */

const TOKEN: Hex = '0x00000000000000000000000000000000000000c1';
const SWAP_CALL_DATA: Hex = '0xabcdef';
const SENDER: Hex = USER;
const WORD = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;

interface Run {
  /** Both entry points, so a difference between them would show. */
  method: 'depositWithGas' | 'prepareDepositWithGas';
}

const call = ({
  swapper,
  method,
  amount
}: {
  swapper: GasSwapper;
  method: Run['method'];
  amount: string;
}): Promise<unknown> =>
  swapper[method](TOKEN, amount, USER, SWAP_CALL_DATA, { from: SENDER, gasLimit: 100_000n });

/** The argument the adapter received for the amount, as `type value`. */
const adapterReceives = async ({
  method,
  amount
}: {
  method: Run['method'];
  amount: string;
}): Promise<string> => {
  const log = new RequestLog();
  const adapter = new RecordingAdapter({ side: 'parent', log });
  const swapper = new GasSwapper({
    adapter,
    getAddress: () => Promise.resolve(ADDRESSES.GasSwapper),
    logger: noopLogger
  });
  return outcomeOf({
    run: () => call({ swapper, method, amount }),
    project: () => {
      const req = log.entries[0]?.req;
      const arg = req?.args?.[1];
      return `adapter got ${show(tagged(arg))}`;
    }
  });
};

/** The calldata a real viem adapter sends, or the error chain it ends in. */
const viemSends = async ({
  method,
  amount
}: {
  method: Run['method'];
  amount: string;
}): Promise<string> => {
  const sent: string[] = [];
  const rpc = (rpcMethod: string, params: readonly unknown[]): unknown => {
    if (rpcMethod === 'eth_chainId') return quantity(1);
    if (rpcMethod === 'eth_estimateGas') return quantity(100_000);
    if (rpcMethod === 'eth_sendTransaction') {
      const tx = params[0] as { data: string };
      sent.push(tx.data);
      return `0x${'ab'.repeat(32)}`;
    }
    throw new Error(`stub node: unscripted ${rpcMethod}`);
  };
  const transport = custom({
    request: ({ method: m, params }: { method: string; params?: unknown }) =>
      Promise.resolve(rpc(m, Array.isArray(params) ? params : []))
  });
  const adapter: Adapter = viemAdapter({
    public: createPublicClient({ transport }),
    wallet: createWalletClient({ transport }),
    account: SENDER
  });
  const swapper = new GasSwapper({
    adapter,
    getAddress: () => Promise.resolve(ADDRESSES.GasSwapper),
    logger: noopLogger,
    chainId: 1
  });
  return outcomeOf({
    run: () => call({ swapper, method, amount }),
    project: (result) => {
      const data =
        method === 'prepareDepositWithGas'
          ? (result as { data: string }).data
          : (sent[0] ?? 'nothing sent');
      // Selector, then the amount word (the second argument), so the row stays short.
      return `calldata ${data.slice(0, 10)} amount ${data.slice(10 + 64, 10 + 128)}`;
    }
  });
};

/** The outcome line for an adapter handed this integer. */
const gotInteger = (value: bigint): string =>
  `value adapter got {type: "bigint", value: {$bigint: "${value}"}}`;

/** A malformed amount is the SDK's own error, wrapped as every deposit failure is. */
const MALFORMED = 'threw DepositError > InvalidHexStringError';

interface AmountRow {
  shape: string;
  amount: string;
  /** What the adapter receives for the amount; identical for both entry points. */
  adapter: string;
  /**
   * What a real viem adapter ends in, for the rows that end in an error; identical for both
   * entry points. The calldata of a well-formed amount is checked on all three libraries in
   * `bigint-argument-calldata.test.ts`.
   */
  viem?: string;
}

const ROWS: readonly AmountRow[] = [
  {
    shape: 'a 32-byte hex word',
    amount: WORD(5n),
    adapter: gotInteger(5n)
  },
  {
    shape: 'the largest uint256',
    amount: WORD(2n ** 256n - 1n),
    adapter: gotInteger(2n ** 256n - 1n)
  },
  {
    shape: 'a hex wider than 32 bytes',
    amount: `0x01${'00'.repeat(32)}`,
    adapter: gotInteger(2n ** 256n),
    viem: 'threw IntegerOutOfRangeError'
  },
  {
    shape: 'a short hex',
    amount: '0x05',
    adapter: gotInteger(5n)
  },
  {
    shape: 'an odd-length hex',
    amount: '0x123',
    adapter: gotInteger(0x123n)
  },
  {
    shape: 'not hex',
    amount: 'abc',
    adapter: MALFORMED,
    viem: MALFORMED
  },
  {
    shape: 'an empty string',
    amount: '',
    adapter: MALFORMED,
    viem: MALFORMED
  },
  {
    shape: 'a bare 0x',
    amount: '0x',
    adapter: MALFORMED,
    viem: MALFORMED
  },
  {
    shape: 'a decimal string',
    amount: '5',
    adapter: MALFORMED,
    viem: MALFORMED
  }
];

const METHODS: readonly Run['method'][] = ['depositWithGas', 'prepareDepositWithGas'];

describe('GasSwapper deposit amount', () => {
  for (const row of ROWS) {
    for (const method of METHODS) {
      it(`${method}: ${row.shape}`, async () => {
        expect(await adapterReceives({ method, amount: row.amount })).equals(row.adapter);
        if (row.viem !== undefined) {
          expect(await viemSends({ method, amount: row.amount })).equals(row.viem);
        }
      });
    }
  }
});
