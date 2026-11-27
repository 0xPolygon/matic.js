import { describe, expect, it } from 'vitest';

import type {
  Adapter,
  Hex,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';
import type { PlasmaAddresses } from '../../src/plasma/addresses.ts';
import type { PlasmaWithdrawStatus } from '../../src/plasma/index.ts';

import {
  ExitNotStartedError,
  InvalidHexStringError,
  TransactionHashRequiredError,
  TransactionNotFoundError
} from '../../src/errors.ts';
import { PlasmaClient } from '../../src/plasma/plasma-client.ts';
import { cassetteAdapter, loadCassette } from './cassette-adapter.ts';

/**
 * The Plasma status matrix, driven through the public methods only
 * (`PlasmaClient.getWithdrawStatus` and the parent token's
 * `getWithdrawStatus`) over a scripted parent chain and child chain.
 *
 * Every row of the status table is here: each way a burn can be
 * not-yet-exited, the exited answer, the boundary of the exit window, and
 * the inputs that are not a status at all because the confirm transaction is
 * not this burn's confirm (`ExitNotStartedError`: no exit log, another block,
 * another account, another position in the block). The answers are
 * returned, never thrown; the throws are exactly those inputs.
 *
 * Only the RPC boundary is faked. Receipt parsing, checkpoint reads, exit-id
 * decoding and the SDK's own checks are the real code.
 */

const hex32 = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const quantity = (n: bigint | number): string => `0x${n.toString(16)}`;

/**
 * Topic 0 of `ExitStarted(address,uint256,address,uint256,bool)`, written out
 * here so a wrong constant in the source cannot make this test agree with it.
 */
const EXIT_STARTED = '0xaa5303fdad123ab5ecaefaf69137bf8632257839546d43a3b3dd148cc2879d6f';

const MANAGER: Hex = '0x3333333333333333333333333333333333333333';
const FOREIGN: Hex = '0x9999999999999999999999999999999999999999';
const ADDRESSES: PlasmaAddresses = {
  RootChain: '0x1111111111111111111111111111111111111111',
  DepositManager: '0x2222222222222222222222222222222222222222',
  WithdrawManager: MANAGER,
  PlasmaERC20Predicate: '0x5555555555555555555555555555555555555555',
  ExitNFT: '0x4444444444444444444444444444444444444444',
  MaticToken: '0x6666666666666666666666666666666666666666',
  PolToken: '0x7777777777777777777777777777777777777777'
};

const TOKEN: Hex = ADDRESSES.PolToken;
const LAST_CHECKPOINTED_BLOCK = 100n;
const BURN_BLOCK = 50n;
const EXITABLE_AT = 1_000n;
const BURNER: Hex = '0x00000000000000000000000000000000000000aa';
const OTHER_ACCOUNT: Hex = '0x00000000000000000000000000000000000000bb';
/**
 * Where the checkpointed burn sits in its block, and the branch mask the
 * withdraw manager records for it: the RLP of 200 is `0x81c8`, written out
 * here so a wrong derivation in the source cannot make this test agree.
 */
const BURN_INDEX = 200;
const BURN_MASK = 0x81c8n;
/** A second burn in the same block, one position later: RLP of 201 is `0x81c9`. */
const NEIGHBOUR_INDEX = 201;
const NEIGHBOUR_MASK = 0x81c9n;
/** The layout the withdraw manager builds: `age << 1`, age = exitableAt << 127 | block << 32 | mask. */
const exitIdOf = ({
  block = BURN_BLOCK,
  mask = BURN_MASK
}: { block?: bigint; mask?: bigint } = {}): bigint =>
  (EXITABLE_AT << 128n) | (block << 33n) | (mask << 1n);
const EXIT_ID = exitIdOf();
const NEIGHBOUR_EXIT_ID = exitIdOf({ mask: NEIGHBOUR_MASK });

/** Topic 0 of the Plasma `Withdraw` event the burn emits, written out likewise. */
const WITHDRAW = '0xebff2602b3f468259e1e99f613fed6691f3a6526effe6ef3e768ba7ae7a36c4f';
const CHILD_TOKEN: Hex = '0x0000000000000000000000000000000000001010';

/** Parent-chain block of the confirm transaction, where the exit token is minted. */
const CONFIRM_BLOCK = 484n;

const PENDING = hex32(0xa1n);
const MINED_UNCHECKPOINTED = hex32(0xa2n);
const MINED_CHECKPOINTED = hex32(0xa3n);
const SAME_BLOCK_NEIGHBOUR = hex32(0xa4n);
const FIRST_IN_BLOCK = hex32(0xa5n);
const NO_RECEIPT = hex32(0xa6n);
const UNKNOWN_BURN = hex32(0xa7n);
const CONFIRM = hex32(0xc1n);
const NEIGHBOUR_CONFIRM = hex32(0xc2n);

interface ChildBurn {
  /** `null` while the burn is in no block. */
  block: bigint | null;
  index: number;
  burner: Hex;
  /** The node reports the burn in a block but has no receipt for it. */
  noReceipt?: boolean;
}

/** What the child chain knows about each burn: its block, position and burner. */
class ChildChain implements Adapter {
  readonly burns = new Map<string, ChildBurn>([
    [PENDING, { block: null, index: 0, burner: BURNER }],
    [
      MINED_UNCHECKPOINTED,
      { block: LAST_CHECKPOINTED_BLOCK + 50n, index: BURN_INDEX, burner: BURNER }
    ],
    [MINED_CHECKPOINTED, { block: BURN_BLOCK, index: BURN_INDEX, burner: BURNER }],
    [SAME_BLOCK_NEIGHBOUR, { block: BURN_BLOCK, index: NEIGHBOUR_INDEX, burner: BURNER }],
    [FIRST_IN_BLOCK, { block: BURN_BLOCK, index: 0, burner: BURNER }],
    [NO_RECEIPT, { block: BURN_BLOCK, index: BURN_INDEX, burner: BURNER, noReceipt: true }]
  ]);

  request<T>(method: string, params: readonly unknown[]): Promise<T> {
    const hash = String(params[0]);
    const burn = this.burns.get(hash);
    if (method === 'eth_getTransactionByHash') {
      const tx =
        burn === undefined
          ? null
          : { hash, blockNumber: burn.block === null ? null : quantity(burn.block) };
      return Promise.resolve(tx as T);
    }
    if (method === 'eth_getTransactionReceipt') {
      const receipt =
        burn === undefined || burn.block === null || burn.noReceipt === true
          ? null
          : {
              transactionHash: hash,
              transactionIndex: quantity(burn.index),
              blockHash: hex32(0xb10cn),
              blockNumber: quantity(burn.block),
              // The transaction's sender is deliberately not the burner: the
              // exit is for the account the Withdraw log names, as on the
              // recorded mainnet burn whose sender is the zero address.
              from: ADDRESSES.RootChain,
              to: ADDRESSES.RootChain,
              contractAddress: null,
              cumulativeGasUsed: '0x5208',
              gasUsed: '0x5208',
              status: '0x1',
              logsBloom: `0x${'00'.repeat(256)}`,
              logs: [
                {
                  address: CHILD_TOKEN,
                  topics: [WITHDRAW, hex32(BigInt(TOKEN)), hex32(BigInt(burn.burner))],
                  data: hex32(10n ** 18n),
                  blockNumber: quantity(burn.block),
                  transactionHash: hash,
                  transactionIndex: quantity(burn.index),
                  blockHash: hex32(0xb10cn),
                  logIndex: '0x0',
                  removed: false
                }
              ]
            };
      return Promise.resolve(receipt as T);
    }
    return Promise.reject(new Error(`child chain: unscripted ${method}`));
  }
  getChainId(): Promise<number> {
    return Promise.resolve(137);
  }
  read(_req: ReadRequest): Promise<unknown> {
    return Promise.reject(new Error('child chain: unscripted read'));
  }
  write(_req: WriteRequest): Promise<TxResult> {
    return Promise.reject(new Error('child chain: not used'));
  }
  prepareWrite(_req: WriteRequest): Promise<never> {
    return Promise.reject(new Error('child chain: not used'));
  }
  estimateGas(_req: WriteRequest): Promise<bigint> {
    return Promise.reject(new Error('child chain: not used'));
  }
  getTransactionReceipt(_hash: string): Promise<Receipt | null> {
    return Promise.reject(new Error('child chain: unscripted'));
  }
  keccak256(): string {
    throw new Error('child chain: not used');
  }
}

/** The parent chain: the checkpoint, the confirm receipts, the exit token and the clock. */
class ParentChain implements Adapter {
  readonly existenceReads: bigint[] = [];
  readonly receipts = new Map<string, Receipt | null>();
  readonly existing = new Set<bigint>();
  /** The block each existence read was pinned to, or `undefined` for an unpinned one. */
  readonly existenceBlocks: Array<ReadRequest['blockTag']> = [];
  now = 0n;
  /** Height of this node's latest block. A node behind the confirm's block has not seen the exit. */
  head = CONFIRM_BLOCK + 100n;

  getChainId(): Promise<number> {
    return Promise.resolve(1);
  }
  read(req: ReadRequest): Promise<unknown> {
    if (req.functionName === 'getLastChildBlock') return Promise.resolve(LAST_CHECKPOINTED_BLOCK);
    if (req.functionName === 'exists') {
      const exitId = BigInt(String(req.args?.[0]));
      this.existenceReads.push(exitId);
      this.existenceBlocks.push(req.blockTag);
      // The exit token is minted in the confirm's block: state read before
      // that block has no such token, whatever happened later.
      const readAt = typeof req.blockTag === 'bigint' ? req.blockTag : this.head;
      return Promise.resolve(this.existing.has(exitId) && readAt >= CONFIRM_BLOCK);
    }
    return Promise.reject(new Error(`parent chain: unscripted read ${req.functionName}`));
  }
  request<T>(method: string, params: readonly unknown[]): Promise<T> {
    if (method === 'eth_getBlockByNumber' && params[0] === 'latest') {
      return Promise.resolve({ number: quantity(this.head), timestamp: quantity(this.now) } as T);
    }
    return Promise.reject(new Error(`parent chain: unscripted ${method}`));
  }
  getTransactionReceipt(hash: string): Promise<Receipt | null> {
    return Promise.resolve(this.receipts.get(hash) ?? null);
  }
  write(_req: WriteRequest): Promise<TxResult> {
    return Promise.reject(new Error('parent chain: not used'));
  }
  prepareWrite(_req: WriteRequest): Promise<never> {
    return Promise.reject(new Error('parent chain: not used'));
  }
  estimateGas(_req: WriteRequest): Promise<bigint> {
    return Promise.reject(new Error('parent chain: not used'));
  }
  keccak256(): string {
    throw new Error('parent chain: not used');
  }
}

const exitStarted = ({
  emitter = MANAGER,
  exitId = EXIT_ID,
  exitor = BURNER
}: { emitter?: Hex; exitId?: bigint; exitor?: Hex } = {}): Receipt['logs'][number] => ({
  address: emitter,
  topics: [EXIT_STARTED, hex32(BigInt(exitor)), hex32(exitId), hex32(2n)],
  data: '0x',
  logIndex: 0
});

const confirmReceipt = ({
  status = 'success',
  logs
}: {
  status?: Receipt['status'];
  logs: Receipt['logs'];
}): Receipt => ({ transactionHash: CONFIRM, status, blockNumber: CONFIRM_BLOCK, logs });

const rejection = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e
  );

interface World {
  parent: ParentChain;
  child: ChildChain;
}

/** A parent chain on which the confirm started the burn's exit and the exit token still exists. */
const queuedExit = (now: bigint): World => {
  const parent = new ParentChain();
  parent.receipts.set(CONFIRM, confirmReceipt({ logs: [exitStarted()] }));
  parent.existing.add(EXIT_ID);
  parent.now = now;
  return { parent, child: new ChildChain() };
};

interface Row {
  name: string;
  world: () => World;
  params: { burnTxHash: string; confirmTxHash?: string };
  expected: PlasmaWithdrawStatus;
}

const ROWS: Row[] = [
  {
    name: "'pending': the burn is in no block",
    world: () => ({ parent: new ParentChain(), child: new ChildChain() }),
    params: { burnTxHash: PENDING },
    expected: { exited: false, reason: 'pending' }
  },
  {
    name: "'not-checkpointed': mined past the last checkpoint",
    world: () => ({ parent: new ParentChain(), child: new ChildChain() }),
    params: { burnTxHash: MINED_UNCHECKPOINTED },
    expected: { exited: false, reason: 'not-checkpointed' }
  },
  {
    name: "'not-checkpointed': a confirm hash does not skip the checkpoint",
    world: () => queuedExit(0n),
    params: { burnTxHash: MINED_UNCHECKPOINTED, confirmTxHash: CONFIRM },
    expected: { exited: false, reason: 'not-checkpointed' }
  },
  {
    name: "'not-confirmed': checkpointed, no confirm transaction given",
    world: () => queuedExit(0n),
    params: { burnTxHash: MINED_CHECKPOINTED },
    expected: { exited: false, reason: 'not-confirmed' }
  },
  {
    name: "'not-confirmed': the confirm transaction has no receipt yet",
    world: () => ({ parent: new ParentChain(), child: new ChildChain() }),
    params: { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM },
    expected: { exited: false, reason: 'not-confirmed' }
  },
  {
    name: "'not-confirmed': the confirm transaction reverted",
    world: () => {
      const parent = new ParentChain();
      parent.receipts.set(CONFIRM, confirmReceipt({ status: 'reverted', logs: [exitStarted()] }));
      parent.existing.add(EXIT_ID);
      return { parent, child: new ChildChain() };
    },
    params: { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM },
    expected: { exited: false, reason: 'not-confirmed' }
  },
  {
    name: "'in-exit-window': a second before exitableAt",
    world: () => queuedExit(EXITABLE_AT - 1n),
    params: { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM },
    expected: { exited: false, reason: 'in-exit-window' }
  },
  {
    name: "'ready-to-process': exactly at exitableAt",
    world: () => queuedExit(EXITABLE_AT),
    params: { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM },
    expected: { exited: false, reason: 'ready-to-process' }
  },
  {
    name: 'exited: the exit token is gone, before exitableAt',
    world: () => {
      const world = queuedExit(EXITABLE_AT - 1n);
      world.parent.existing.clear();
      return world;
    },
    params: { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM },
    expected: { exited: true }
  },
  {
    name: 'exited: the exit token is gone, after exitableAt',
    world: () => {
      const world = queuedExit(EXITABLE_AT + 1n);
      world.parent.existing.clear();
      return world;
    },
    params: { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM },
    expected: { exited: true }
  },
  {
    name: 'the exitor is compared whatever the case of the topic the node returned',
    world: () => {
      const world = queuedExit(EXITABLE_AT - 1n);
      const upperCaseExitor: Hex = `0x${'00'.repeat(12)}${'AA'.padStart(40, '0')}`;
      const log = exitStarted();
      world.parent.receipts.set(
        CONFIRM,
        confirmReceipt({
          logs: [{ ...log, topics: [EXIT_STARTED, upperCaseExitor, hex32(EXIT_ID)] }]
        })
      );
      return world;
    },
    params: { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM },
    expected: { exited: false, reason: 'in-exit-window' }
  },
  {
    name: 'a burn first in its block is matched by the branch mask 0x80',
    world: () => {
      const world = queuedExit(EXITABLE_AT - 1n);
      const genuine = exitIdOf({ mask: 0x80n });
      world.parent.receipts.set(
        CONFIRM,
        confirmReceipt({ logs: [exitStarted({ exitId: genuine })] })
      );
      world.parent.existing.add(genuine);
      return world;
    },
    params: { burnTxHash: FIRST_IN_BLOCK, confirmTxHash: CONFIRM },
    expected: { exited: false, reason: 'in-exit-window' }
  }
];

const surfaces: ReadonlyArray<
  [string, (plasma: PlasmaClient, params: Row['params']) => Promise<PlasmaWithdrawStatus>]
> = [
  ['PlasmaClient.getWithdrawStatus', (plasma, params) => plasma.getWithdrawStatus(params)],
  [
    'PlasmaERC20.getWithdrawStatus',
    (plasma, params) => plasma.parent.erc20(TOKEN).getWithdrawStatus(params)
  ]
];

const clientOn = ({ parent, child }: World): Promise<PlasmaClient> =>
  PlasmaClient.init({ network: 'amoy', parent, child, addresses: ADDRESSES });

describe.each(surfaces)('%s: the status matrix', { timeout: 10_000 }, (_name, read) => {
  it.each(ROWS)('$name', async ({ world, params, expected }) => {
    const plasma = await clientOn(world());
    expect(await read(plasma, params)).deep.equals(expected);
  });

  describe('a node that answers from before the confirm', () => {
    // A load-balanced RPC can serve the confirm's receipt from one node and
    // the next call from a node one block behind. On that node the exit token
    // is not minted yet, which looks exactly like a processed exit.
    it('does not read a queued exit as exited when the latest block is behind the confirm', async () => {
      const world = queuedExit(EXITABLE_AT - 1n);
      world.parent.head = CONFIRM_BLOCK - 1n;
      const plasma = await clientOn(world);

      const status = await read(plasma, {
        burnTxHash: MINED_CHECKPOINTED,
        confirmTxHash: CONFIRM
      });

      expect(status).deep.equals({ exited: false, reason: 'in-exit-window' });
    });

    it('answers in-exit-window, not exited, when the exit was processed but the latest block is behind the confirm', async () => {
      const world = queuedExit(EXITABLE_AT + 1n);
      world.parent.existing.clear();
      world.parent.head = CONFIRM_BLOCK - 1n;
      const plasma = await clientOn(world);

      const status = await read(plasma, {
        burnTxHash: MINED_CHECKPOINTED,
        confirmTxHash: CONFIRM
      });

      expect(status).deep.equals({ exited: false, reason: 'in-exit-window' });
      expect(world.parent.existenceReads).lengthOf(0);
    });

    it('answers in-exit-window, not ready-to-process, when the latest block is behind the confirm and exitableAt has passed', async () => {
      const world = queuedExit(EXITABLE_AT + 86_400n);
      world.parent.head = CONFIRM_BLOCK - 1n;
      const plasma = await clientOn(world);

      const status = await read(plasma, {
        burnTxHash: MINED_CHECKPOINTED,
        confirmTxHash: CONFIRM
      });

      expect(status).deep.equals({ exited: false, reason: 'in-exit-window' });
    });

    it('answers ready-to-process once the latest block is exactly the confirm block and exitableAt has passed', async () => {
      const world = queuedExit(EXITABLE_AT);
      world.parent.head = CONFIRM_BLOCK;
      const plasma = await clientOn(world);

      const status = await read(plasma, {
        burnTxHash: MINED_CHECKPOINTED,
        confirmTxHash: CONFIRM
      });

      expect(status).deep.equals({ exited: false, reason: 'ready-to-process' });
    });

    it('reads the exit token at the block the clock was read from', async () => {
      const world = queuedExit(EXITABLE_AT);
      const plasma = await clientOn(world);

      await read(plasma, { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM });

      expect(world.parent.existenceBlocks).deep.equals([world.parent.head]);
    });

    it('still reads exited once the latest block has reached the confirm', async () => {
      const world = queuedExit(EXITABLE_AT);
      world.parent.existing.clear();
      world.parent.head = CONFIRM_BLOCK;
      const plasma = await clientOn(world);

      const status = await read(plasma, {
        burnTxHash: MINED_CHECKPOINTED,
        confirmTxHash: CONFIRM
      });

      expect(status).deep.equals({ exited: true });
    });
  });

  it('rejects, without answering, when the latest block carries no height', async () => {
    const world = queuedExit(EXITABLE_AT);
    world.parent.existing.clear();
    world.parent.request = <T>(): Promise<T> =>
      Promise.resolve({ timestamp: quantity(EXITABLE_AT) } as T);
    const plasma = await clientOn(world);

    const err = await rejection(
      read(plasma, { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM })
    );

    expect(err).property('name').equals('BridgeStatusError');
    expect(err).nested.property('cause.name').equals('InvalidNumericValueError');
    expect(world.parent.existenceReads).lengthOf(0);
  });

  describe('a burn the child chain cannot supply', () => {
    it('rejects a burn hash the node does not know as a rejected dependency', async () => {
      const plasma = await clientOn(queuedExit(0n));

      const err = await rejection(read(plasma, { burnTxHash: UNKNOWN_BURN }));

      expect(err).property('name').equals('BridgeStatusError');
      expect(err).property('info').property('burnTxHash').equals(UNKNOWN_BURN);
      expect(TransactionNotFoundError.has(err)).equals(true);
    });

    it('rejects a checkpointed burn that has no receipt to read its block from', async () => {
      const plasma = await clientOn(queuedExit(0n));

      const err = await rejection(read(plasma, { burnTxHash: NO_RECEIPT, confirmTxHash: CONFIRM }));

      expect(err).property('name').equals('BridgeStatusError');
      expect(TransactionNotFoundError.has(err)).equals(true);
    });
  });

  describe('input that is not a hash', () => {
    it('rejects an empty burn hash or an empty confirm hash as missing input', async () => {
      const plasma = await clientOn(queuedExit(0n));

      const burn = await rejection(read(plasma, { burnTxHash: '' }));
      const confirm = await rejection(
        read(plasma, { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: '' })
      );

      for (const err of [burn, confirm]) {
        expect(err).property('name').equals('BridgeStatusError');
        expect(TransactionHashRequiredError.has(err)).equals(true);
      }
    });

    it.each(['0x1234', 'not-a-hash', `0x${'zz'.repeat(32)}`])(
      'rejects the malformed hash %s as invalid hex',
      async (bad) => {
        const plasma = await clientOn(queuedExit(0n));

        const burn = await rejection(read(plasma, { burnTxHash: bad }));
        const confirm = await rejection(
          read(plasma, { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: bad })
        );

        for (const err of [burn, confirm]) {
          expect(err).property('name').equals('BridgeStatusError');
          expect(InvalidHexStringError.has(err)).equals(true);
        }
      }
    );
  });

  describe('a confirm transaction that is not this burn’s confirm', () => {
    it('throws ExitNotStartedError when its receipt has no ExitStarted log', async () => {
      const world = queuedExit(0n);
      world.parent.receipts.set(CONFIRM, confirmReceipt({ logs: [] }));
      const plasma = await clientOn(world);

      const err = await rejection(
        read(plasma, { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM })
      );

      expect(err).property('name').equals('BridgeStatusError');
      const notStarted = ExitNotStartedError.find(err);
      expect(notStarted).nested.property('info.reason').equals('no-exit-started-log');
      expect(notStarted).nested.property('info.burnTxHash').equals(MINED_CHECKPOINTED);
      expect(notStarted).nested.property('info.confirmTxHash').equals(CONFIRM);
      expect(world.parent.existenceReads).lengthOf(0);
    });

    it('does not take an ExitStarted log from another contract for the exit', async () => {
      const world = queuedExit(0n);
      world.parent.receipts.set(
        CONFIRM,
        confirmReceipt({ logs: [exitStarted({ emitter: FOREIGN })] })
      );
      const plasma = await clientOn(world);

      const err = await rejection(
        read(plasma, { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM })
      );

      expect(ExitNotStartedError.find(err))
        .nested.property('info.reason')
        .equals('no-exit-started-log');
    });

    it('throws ExitNotStartedError when the exit belongs to a burn in another block', async () => {
      const world = queuedExit(0n);
      const otherBlock = exitIdOf({ block: BURN_BLOCK + 1n });
      world.parent.receipts.set(
        CONFIRM,
        confirmReceipt({ logs: [exitStarted({ exitId: otherBlock })] })
      );
      world.parent.existing.add(otherBlock);
      const plasma = await clientOn(world);

      const err = await rejection(
        read(plasma, { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM })
      );

      expect(err).property('name').equals('BridgeStatusError');
      const notStarted = ExitNotStartedError.find(err);
      expect(notStarted).nested.property('info.reason').equals('burn-block-mismatch');
      expect(notStarted).nested.property('info.burnTxHash').equals(MINED_CHECKPOINTED);
      expect(notStarted).nested.property('info.confirmTxHash').equals(CONFIRM);
      expect(world.parent.existenceReads).lengthOf(0);
    });

    it('throws ExitNotStartedError when the exit was started for another account', async () => {
      const world = queuedExit(0n);
      world.parent.receipts.set(
        CONFIRM,
        confirmReceipt({ logs: [exitStarted({ exitor: OTHER_ACCOUNT })] })
      );
      const plasma = await clientOn(world);

      const err = await rejection(
        read(plasma, { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM })
      );

      expect(err).property('name').equals('BridgeStatusError');
      const notStarted = ExitNotStartedError.find(err);
      expect(notStarted).nested.property('info.reason').equals('exitor-mismatch');
      expect(notStarted).nested.property('info.burnTxHash').equals(MINED_CHECKPOINTED);
      expect(notStarted).nested.property('info.confirmTxHash').equals(CONFIRM);
      expect(world.parent.existenceReads).lengthOf(0);
    });

    it('expects the branch mask 0x80, not 0, for a burn first in its block', async () => {
      const world = queuedExit(0n);
      const zero = exitIdOf({ mask: 0n });
      world.parent.receipts.set(CONFIRM, confirmReceipt({ logs: [exitStarted({ exitId: zero })] }));
      world.parent.existing.add(zero);
      const plasma = await clientOn(world);

      const err = await rejection(
        read(plasma, { burnTxHash: FIRST_IN_BLOCK, confirmTxHash: CONFIRM })
      );

      expect(ExitNotStartedError.find(err))
        .nested.property('info.reason')
        .equals('branch-mask-mismatch');
    });

    describe('two burns in the same block', () => {
      /** Both burns confirmed by the same account: the block and the exitor agree. */
      const twoConfirmedBurns = (now: bigint): World => {
        const world = queuedExit(now);
        world.parent.receipts.set(
          NEIGHBOUR_CONFIRM,
          confirmReceipt({ logs: [exitStarted({ exitId: NEIGHBOUR_EXIT_ID })] })
        );
        world.parent.existing.add(NEIGHBOUR_EXIT_ID);
        return world;
      };

      it("throws ExitNotStartedError for the other burn's confirm, whichever way round", async () => {
        const plasma = await clientOn(twoConfirmedBurns(EXITABLE_AT));

        const first = await rejection(
          read(plasma, { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: NEIGHBOUR_CONFIRM })
        );
        const second = await rejection(
          read(plasma, { burnTxHash: SAME_BLOCK_NEIGHBOUR, confirmTxHash: CONFIRM })
        );

        for (const err of [first, second]) {
          expect(err).property('name').equals('BridgeStatusError');
          expect(ExitNotStartedError.find(err))
            .nested.property('info.reason')
            .equals('branch-mask-mismatch');
        }
      });

      it('does not answer for a burn that was never confirmed from its neighbour’s exit', async () => {
        // Only the first burn was confirmed and its exit is gone. The second
        // burn passing that confirm must not read `exited: true`.
        const world = queuedExit(EXITABLE_AT);
        world.parent.existing.clear();
        const plasma = await clientOn(world);

        expect(
          await read(plasma, { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM })
        ).deep.equals({ exited: true });
        const err = await rejection(
          read(plasma, { burnTxHash: SAME_BLOCK_NEIGHBOUR, confirmTxHash: CONFIRM })
        );
        expect(ExitNotStartedError.has(err)).equals(true);
        expect(world.parent.existenceReads).lengthOf(1);
      });

      it('still answers each burn from its own confirm', async () => {
        const plasma = await clientOn(twoConfirmedBurns(EXITABLE_AT));

        expect(
          await read(plasma, { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM })
        ).deep.equals({ exited: false, reason: 'ready-to-process' });
        expect(
          await read(plasma, { burnTxHash: SAME_BLOCK_NEIGHBOUR, confirmTxHash: NEIGHBOUR_CONFIRM })
        ).deep.equals({ exited: false, reason: 'ready-to-process' });
      });
    });

    describe('one confirm transaction that confirms several burns', () => {
      const SECOND_BURNER_BURN = hex32(0xa8n);
      const confirmWith = (world: World, logs: Receipt['logs']): void => {
        world.parent.receipts.set(CONFIRM, confirmReceipt({ logs }));
      };

      it('answers each of two burns in the same block from its own exit, in either log order', async () => {
        for (const order of [
          [EXIT_ID, NEIGHBOUR_EXIT_ID],
          [NEIGHBOUR_EXIT_ID, EXIT_ID]
        ]) {
          const world = queuedExit(EXITABLE_AT);
          confirmWith(
            world,
            order.map((exitId) => exitStarted({ exitId }))
          );
          world.parent.existing.add(NEIGHBOUR_EXIT_ID);
          const plasma = await clientOn(world);

          expect(
            await read(plasma, { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM })
          ).deep.equals({ exited: false, reason: 'ready-to-process' });
          expect(
            await read(plasma, { burnTxHash: SAME_BLOCK_NEIGHBOUR, confirmTxHash: CONFIRM })
          ).deep.equals({ exited: false, reason: 'ready-to-process' });
        }
      });

      it('reads the exit token of the matching exit, not of the first log', async () => {
        const world = queuedExit(EXITABLE_AT);
        confirmWith(world, [exitStarted(), exitStarted({ exitId: NEIGHBOUR_EXIT_ID })]);
        // Only the second burn's exit was processed; the first is still queued.
        world.parent.existing.add(EXIT_ID);
        const plasma = await clientOn(world);

        expect(
          await read(plasma, { burnTxHash: SAME_BLOCK_NEIGHBOUR, confirmTxHash: CONFIRM })
        ).deep.equals({ exited: true });
        expect(world.parent.existenceReads).deep.equals([NEIGHBOUR_EXIT_ID]);
      });

      it('tells two burns by different accounts apart, including at the same position', async () => {
        const world = queuedExit(EXITABLE_AT);
        world.child.burns.set(SECOND_BURNER_BURN, {
          block: BURN_BLOCK,
          index: BURN_INDEX,
          burner: OTHER_ACCOUNT
        });
        // Same id from two exitors is the case only the exitor can separate.
        confirmWith(world, [exitStarted(), exitStarted({ exitor: OTHER_ACCOUNT })]);
        const plasma = await clientOn(world);

        expect(
          await read(plasma, { burnTxHash: SECOND_BURNER_BURN, confirmTxHash: CONFIRM })
        ).deep.equals({ exited: false, reason: 'ready-to-process' });
        expect(
          await read(plasma, { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM })
        ).deep.equals({ exited: false, reason: 'ready-to-process' });

        world.child.burns.set(SECOND_BURNER_BURN, {
          block: BURN_BLOCK,
          index: NEIGHBOUR_INDEX,
          burner: OTHER_ACCOUNT
        });
        confirmWith(world, [
          exitStarted(),
          exitStarted({ exitId: NEIGHBOUR_EXIT_ID, exitor: OTHER_ACCOUNT })
        ]);
        world.parent.existing.add(NEIGHBOUR_EXIT_ID);
        expect(
          await read(plasma, { burnTxHash: SECOND_BURNER_BURN, confirmTxHash: CONFIRM })
        ).deep.equals({ exited: false, reason: 'ready-to-process' });
      });

      it('reports the closest reason when none of several exits is the burn’s', async () => {
        const world = queuedExit(EXITABLE_AT);
        const otherBlockAndMask = exitIdOf({ block: BURN_BLOCK + 1n, mask: NEIGHBOUR_MASK });
        // The first exit passes only the exitor check; the second passes the
        // block and the exitor and misses only the position.
        confirmWith(world, [
          exitStarted({ exitId: otherBlockAndMask }),
          exitStarted({ exitId: NEIGHBOUR_EXIT_ID })
        ]);
        const plasma = await clientOn(world);

        const err = await rejection(
          read(plasma, { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM })
        );

        expect(err).property('name').equals('BridgeStatusError');
        expect(ExitNotStartedError.find(err))
          .nested.property('info.reason')
          .equals('branch-mask-mismatch');
        expect(world.parent.existenceReads).lengthOf(0);
      });

      it('breaks a tie between equally close exits by log order', async () => {
        const world = queuedExit(EXITABLE_AT);
        // Both pass one check: the first only the exitor, the second only the block.
        const wrongBlockAndMask = exitIdOf({ block: BURN_BLOCK + 1n, mask: NEIGHBOUR_MASK });
        confirmWith(world, [
          exitStarted({ exitId: wrongBlockAndMask }),
          exitStarted({ exitId: NEIGHBOUR_EXIT_ID, exitor: OTHER_ACCOUNT })
        ]);
        const plasma = await clientOn(world);

        const err = await rejection(
          read(plasma, { burnTxHash: MINED_CHECKPOINTED, confirmTxHash: CONFIRM })
        );

        expect(ExitNotStartedError.find(err))
          .nested.property('info.reason')
          .equals('burn-block-mismatch');
      });
    });
  });
});

/**
 * The binding on a real burn: the recorded mainnet native-token burn, replayed
 * from its cassette. The exit id is built from the burn's own recorded facts
 * by the withdraw manager's layout: its block, the branch mask the verified
 * payload carries (`0x39` for position 57), and the account its Withdraw log
 * names. That account is not the transaction sender, which on this burn is
 * the zero address.
 */
describe('a recorded mainnet burn', { timeout: 10_000 }, () => {
  const file = 'plasma-erc20-burn-1.json';
  const cassette = loadCassette(file);
  const burnTxHash = cassette.burnTxHash;
  const RECORDED_BLOCK = 97_394_752n;
  const RECORDED_MASK = 0x39n;
  const MAINNET_MANAGER: Hex = '0x2222222222222222222222222222222222222222';
  const MAINNET_NFT: Hex = '0x4444444444444444444444444444444444444444';

  const recordedBurner = async (): Promise<Hex> => {
    const receipt = await cassetteAdapter(cassette.child).request<{
      from: string;
      logs: { topics: string[] }[];
    }>('eth_getTransactionReceipt', [burnTxHash]);
    expect(BigInt(receipt.from)).equals(0n);
    const topic = receipt.logs.find((log) => log.topics[0] === WITHDRAW)?.topics[2];
    if (topic === undefined) throw new Error('recorded burn has no Withdraw log');
    return `0x${topic.slice(-40)}`;
  };

  const plasmaConfirmedWith = async (confirm: Receipt): Promise<PlasmaClient> => {
    const replay = cassetteAdapter(cassette.parent);
    const parent: Adapter = {
      ...replay,
      getTransactionReceipt: (hash) =>
        hash === CONFIRM ? Promise.resolve(confirm) : replay.getTransactionReceipt(hash),
      read: (req) => (req.functionName === 'exists' ? Promise.resolve(true) : replay.read(req)),
      request: <T>(method: string, params: readonly unknown[]): Promise<T> =>
        method === 'eth_getBlockByNumber'
          ? Promise.resolve({ number: quantity(CONFIRM_BLOCK), timestamp: quantity(0n) } as T)
          : replay.request<T>(method, params)
    };
    return PlasmaClient.init({
      network: 'mainnet',
      parent,
      child: cassetteAdapter(cassette.child),
      addresses: {
        RootChain: cassette.addresses.RootChain,
        DepositManager: '0x1111111111111111111111111111111111111111',
        WithdrawManager: MAINNET_MANAGER,
        PlasmaERC20Predicate: '0x3333333333333333333333333333333333333333',
        ExitNFT: MAINNET_NFT,
        MaticToken: cassette.addresses.MaticToken ?? '0x5555555555555555555555555555555555555555',
        PolToken: cassette.addresses.PolToken ?? '0x6666666666666666666666666666666666666666'
      }
    });
  };

  const confirmOf = ({ exitor, mask }: { exitor: Hex; mask: bigint }): Receipt =>
    confirmReceipt({
      logs: [
        exitStarted({
          emitter: MAINNET_MANAGER,
          exitor,
          exitId: exitIdOf({ block: RECORDED_BLOCK, mask })
        })
      ]
    });

  it('accepts the genuine confirm', async () => {
    const plasma = await plasmaConfirmedWith(
      confirmOf({ exitor: await recordedBurner(), mask: RECORDED_MASK })
    );
    expect(await plasma.getWithdrawStatus({ burnTxHash, confirmTxHash: CONFIRM })).deep.equals({
      exited: false,
      reason: 'in-exit-window'
    });
  });

  it('rejects the next position in the block', async () => {
    const plasma = await plasmaConfirmedWith(
      confirmOf({ exitor: await recordedBurner(), mask: RECORDED_MASK + 1n })
    );
    const err = await rejection(plasma.getWithdrawStatus({ burnTxHash, confirmTxHash: CONFIRM }));
    expect(ExitNotStartedError.find(err))
      .nested.property('info.reason')
      .equals('branch-mask-mismatch');
  });

  it('rejects another account’s exit at the same position', async () => {
    const plasma = await plasmaConfirmedWith(
      confirmOf({ exitor: OTHER_ACCOUNT, mask: RECORDED_MASK })
    );
    const err = await rejection(plasma.getWithdrawStatus({ burnTxHash, confirmTxHash: CONFIRM }));
    expect(ExitNotStartedError.find(err)).nested.property('info.reason').equals('exitor-mismatch');
  });
});
