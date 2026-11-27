/**
 * `PlasmaERC20`: the native-burn value guard, the POL to MATIC queue mapping,
 * the proof API requirement for the fast confirm, and the runtime side guards
 * for plain-JavaScript callers.
 *
 * Only the chain boundary is faked: a recording adapter per chain. The client
 * wiring, contract callers, address resolution and operation errors are the
 * real code. The exit-payload builder is stubbed where a case is about the
 * call it feeds, because building a payload is covered by the exit-payload
 * golden tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  Adapter,
  Hex,
  PreparedTx,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';
import type { PlasmaAddresses } from '../../src/plasma/addresses.ts';
import type { PlasmaChildERC20, PlasmaERC20, PlasmaParentERC20 } from '../../src/plasma/erc20.ts';

import {
  AllowedOnChildError,
  AllowedOnRootError,
  ChildBurnValueNotAllowedError,
  NativeBurnValueMismatchError,
  ProofApiNotSetError
} from '../../src/errors.ts';
import { ExitProofBuilder } from '../../src/internal/exit-proof.ts';
import { PlasmaClient } from '../../src/plasma/plasma-client.ts';

const PARENT_ID = 1111;
const CHILD_ID = 2222;
const MANAGER: Hex = '0x1111111111111111111111111111111111111111';
const DEPOSIT_MANAGER: Hex = '0x2222222222222222222222222222222222222222';
const PREDICATE: Hex = '0x3333333333333333333333333333333333333333';
const EXIT_NFT: Hex = '0x4444444444444444444444444444444444444444';
const MATIC: Hex = '0x5555555555555555555555555555555555555555';
const POL: Hex = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';
const POL_LOWER: Hex = '0xabcdef0123456789abcdef0123456789abcdef01';
const ROOT_CHAIN: Hex = '0x7777777777777777777777777777777777777777';
const OTHER_TOKEN: Hex = '0x8888888888888888888888888888888888888888';
const CHILD_TOKEN: Hex = '0x9999999999999999999999999999999999999999';
const NATIVE: Hex = '0x0000000000000000000000000000000000001010';
const QUEUE: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const USER: Hex = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ZERO: Hex = '0x0000000000000000000000000000000000000000';
const BURN = `0x${'ab'.repeat(32)}`;
const AMOUNT = 12_345n;
const PAYLOAD = '0xfeedface';
const ESTIMATE = 100_000n;

const ADDRESSES: PlasmaAddresses = {
  RootChain: ROOT_CHAIN,
  DepositManager: DEPOSIT_MANAGER,
  WithdrawManager: MANAGER,
  PlasmaERC20Predicate: PREDICATE,
  ExitNFT: EXIT_NFT,
  MaticToken: MATIC,
  PolToken: POL
};

/** One chain behind one adapter; records everything that would reach the wire. */
class RecordingChain implements Adapter {
  readonly reads: ReadRequest[] = [];
  readonly writes: WriteRequest[] = [];
  readonly prepares: WriteRequest[] = [];
  readonly estimates: WriteRequest[] = [];
  /** token (lowercase) -> its exit queue contract. */
  readonly queues = new Map<string, Hex>();
  queueSize = 0n;

  getChainId(): Promise<number> {
    return Promise.resolve(1);
  }
  read(req: ReadRequest): Promise<unknown> {
    this.reads.push(req);
    const [first] = req.args ?? [];
    switch (req.functionName) {
      case 'exitsQueues':
        return Promise.resolve(this.queues.get(String(first).toLowerCase()) ?? ZERO);
      case 'currentSize':
        return Promise.resolve(this.queueSize);
      case 'ON_FINALIZE_GAS_LIMIT':
        return Promise.resolve(300_000n);
      case 'getLastChildBlock':
        return Promise.resolve(100n);
      default:
        return Promise.reject(new Error(`unscripted read ${req.functionName}`));
    }
  }
  write(req: WriteRequest): Promise<TxResult> {
    this.writes.push(req);
    return Promise.resolve({
      hash: `0x${'aa'.repeat(32)}`,
      confirmed: () => Promise.reject(new Error('not used'))
    });
  }
  prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    this.prepares.push(req);
    return Promise.resolve(preparedOf(req));
  }
  estimateGas(req: WriteRequest): Promise<bigint> {
    this.estimates.push(req);
    return Promise.resolve(ESTIMATE);
  }
  getTransactionReceipt(): Promise<Receipt | null> {
    return Promise.resolve(null);
  }
  keccak256(): string {
    throw new Error('not used');
  }
  request<T>(method: string): Promise<T> {
    return Promise.reject(new Error(`unscripted ${method}`));
  }
  get sent(): number {
    return this.writes.length + this.prepares.length;
  }
}

/** What the recording adapter returns for a prepare; also derivable from the write request. */
const preparedOf = (req: WriteRequest): PreparedTx => ({
  to: req.address,
  data: `${req.functionName}(${JSON.stringify(req.args, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v
  )})` as Hex,
  ...(req.value !== undefined ? { value: req.value } : {})
});

interface Fixture {
  parent: RecordingChain;
  child: RecordingChain;
  plasma: PlasmaClient;
  buildPayload: ReturnType<typeof stubPayload>;
}

const stubPayload = () =>
  vi.spyOn(ExitProofBuilder.prototype, 'buildExitPayload').mockResolvedValue(PAYLOAD);

const fixture = async ({
  proofGenerationApiUrl
}: { proofGenerationApiUrl?: string } = {}): Promise<Fixture> => {
  const parent = new RecordingChain();
  const child = new RecordingChain();
  const buildPayload = stubPayload();
  const plasma = await PlasmaClient.init({
    network: 'amoy',
    parent,
    child,
    addresses: ADDRESSES,
    chainIds: { parent: PARENT_ID, child: CHILD_ID },
    ...(proofGenerationApiUrl !== undefined ? { proofGenerationApiUrl } : {})
  });
  return { parent, child, plasma, buildPayload };
};

const rejection = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
};

afterEach(() => {
  vi.restoreAllMocks();
});

type TxOptions = Parameters<PlasmaERC20['startWithdraw']>[1];

/** The write and its prepare sibling share one guard; every row runs against both. */
const BURN_VARIANTS: Array<
  [
    name: string,
    record: 'writes' | 'prepares',
    call: (token: PlasmaERC20, options?: TxOptions) => Promise<unknown>
  ]
> = [
  ['startWithdraw', 'writes', (t, o) => t.startWithdraw(AMOUNT, o)],
  ['prepareStartWithdraw', 'prepares', (t, o) => t.prepareStartWithdraw(AMOUNT, o)]
];

describe.each(BURN_VARIANTS)('PlasmaERC20.%s burn value', (_name, record, call) => {
  it('sets a native burn value to the amount, whether the caller passes none or the amount', async () => {
    const { plasma, child } = await fixture();
    await call(asRuntimeHandle(plasma.child.erc20(NATIVE)));
    await call(asRuntimeHandle(plasma.child.erc20(NATIVE)), { value: AMOUNT });
    expect(child[record]).lengthOf(2);
    expect(child[record][0]).property('value').equals(AMOUNT);
    expect(child[record][1]).property('value').equals(AMOUNT);
  });

  it.each([[1n], [AMOUNT + 1n], [0n]])(
    'rejects a native burn whose value is %s, sending and estimating nothing',
    async (value) => {
      const { plasma, parent, child } = await fixture();
      const err = await rejection(() =>
        call(asRuntimeHandle(plasma.child.erc20(NATIVE)), { value })
      );
      expect(err).property('name').equals('WithdrawStartError');
      const mismatch = NativeBurnValueMismatchError.find(err);
      expect(mismatch?.info.amount).equals(AMOUNT);
      expect(mismatch?.info.value).equals(value);
      expect(child.sent + parent.sent).equals(0);
      expect(child.estimates).lengthOf(0);
    }
  );

  it('passes a child ERC-20 burn through when value is absent, 0n, or a plain-JavaScript 0', async () => {
    const { plasma, child } = await fixture();
    const token = asRuntimeHandle(plasma.child.erc20(CHILD_TOKEN));
    await call(token);
    await call(token, { value: 0n });
    await call(token, { value: 0 as never });
    expect(child[record]).lengthOf(3);
    expect(child[record][0]).property('value').equals(undefined);
    expect(child[record][1]).property('value').equals(0n);
    expect(child[record][2]).property('value').equals(0);
  });

  it('rejects a non-zero value on a child ERC-20 burn, estimating and sending nothing', async () => {
    const { plasma, parent, child } = await fixture();
    const err = await rejection(() =>
      call(asRuntimeHandle(plasma.child.erc20(CHILD_TOKEN)), { value: 1n })
    );
    expect(err).property('name').equals('WithdrawStartError');
    expect(ChildBurnValueNotAllowedError.find(err)?.info.value).equals(1n);
    expect(NativeBurnValueMismatchError.has(err)).equals(false);
    expect(child.sent + parent.sent).equals(0);
    expect(child.estimates).lengthOf(0);
  });
});

describe('PlasmaERC20.confirmWithdrawFast', () => {
  it('without a proof API URL rejects with ProofApiNotSetError and sends nothing', async () => {
    const { plasma, parent, buildPayload } = await fixture();
    buildPayload.mockRestore();
    const err = await rejection(() => plasma.parent.erc20(POL).confirmWithdrawFast(BURN));
    expect(err).property('name').equals('ExitError');
    expect(ProofApiNotSetError.has(err)).equals(true);
    expect(parent.sent).equals(0);
  });
});

describe('PlasmaERC20.completeWithdraw queue', () => {
  const queued = async () => {
    const f = await fixture();
    f.parent.queues.set(MATIC.toLowerCase(), QUEUE);
    f.parent.queues.set(OTHER_TOKEN.toLowerCase(), QUEUE);
    f.parent.queueSize = 1n;
    return f;
  };

  it('processes the MATIC queue from a POL handle, since a native burn queues under MATIC', async () => {
    const { plasma, parent } = await queued();
    await plasma.parent.erc20(POL).completeWithdraw();
    expect(parent.writes).lengthOf(1);
    expect(parent.writes[0]).property('address').equals(MANAGER);
    expect(parent.writes[0]).property('functionName').equals('processExits');
    expect(parent.writes[0]).property('args').deep.equals([MATIC]);
    expect(parent.writes[0]).property('chainId').equals(PARENT_ID);
  });

  it('leaves a MATIC handle on the MATIC queue', async () => {
    const { plasma, parent } = await queued();
    await plasma.parent.erc20(MATIC).completeWithdraw();
    expect(parent.writes[0]).property('args').deep.equals([MATIC]);
  });

  it('leaves any other token on its own queue', async () => {
    const { plasma, parent } = await queued();
    await plasma.parent.erc20(OTHER_TOKEN).completeWithdraw();
    expect(parent.writes[0]).property('args').deep.equals([OTHER_TOKEN]);
  });

  it('maps POL to MATIC whatever the case of the handle address', async () => {
    const { plasma, parent } = await queued();
    await plasma.parent.erc20(POL_LOWER).completeWithdraw();
    expect(parent.writes[0]).property('args').deep.equals([MATIC]);
  });
});

describe('PlasmaERC20.getWithdrawStatus', () => {
  it('is a parent-chain call and rejects on a child handle', async () => {
    const { plasma } = await fixture();
    const err = await rejection(() =>
      asRuntimeHandle(plasma.child.erc20(CHILD_TOKEN)).getWithdrawStatus({ burnTxHash: BURN })
    );
    expect(err).property('name').equals('BridgeStatusError');
    expect(AllowedOnRootError.has(err)).equals(true);
  });
});

/**
 * Views a side-typed handle as the full runtime class. The client's types
 * hide the methods that only throw on that side; the guard tests call them
 * anyway, to prove the runtime still refuses for plain-JavaScript callers.
 */
const asRuntimeHandle = (handle: PlasmaParentERC20 | PlasmaChildERC20): PlasmaERC20 =>
  handle as PlasmaERC20;

describe('PlasmaERC20 side guards', () => {
  const PARENT_ONLY: Array<[string, (token: PlasmaERC20) => Promise<unknown>, string]> = [
    ['getAllowance', (t) => t.getAllowance(USER), 'TokenReadError'],
    ['approve', (t) => t.approve(1n), 'ApproveError'],
    ['prepareApprove', (t) => t.prepareApprove(1n), 'ApproveError'],
    ['approveMax', (t) => t.approveMax(), 'ApproveError'],
    ['prepareApproveMax', (t) => t.prepareApproveMax(), 'ApproveError'],
    ['deposit', (t) => t.deposit(1n, USER), 'DepositError'],
    ['prepareDeposit', (t) => t.prepareDeposit(1n, USER), 'DepositError'],
    ['confirmWithdraw', (t) => t.confirmWithdraw(BURN), 'ExitError'],
    ['prepareConfirmWithdraw', (t) => t.prepareConfirmWithdraw(BURN), 'ExitError'],
    ['confirmWithdrawFast', (t) => t.confirmWithdrawFast(BURN), 'ExitError'],
    ['prepareConfirmWithdrawFast', (t) => t.prepareConfirmWithdrawFast(BURN), 'ExitError'],
    ['completeWithdraw', (t) => t.completeWithdraw(), 'ExitError'],
    ['prepareCompleteWithdraw', (t) => t.prepareCompleteWithdraw(), 'ExitError'],
    ['getCompleteWithdrawGasLimit', (t) => t.getCompleteWithdrawGasLimit(), 'ExitError']
  ];

  it.each(PARENT_ONLY)('%s rejects on a child handle and sends nothing', async (_n, call, op) => {
    const { plasma, parent, child, buildPayload } = await fixture();
    const err = await rejection(() => call(asRuntimeHandle(plasma.child.erc20(CHILD_TOKEN))));
    expect(err).property('name').equals(op);
    expect(AllowedOnRootError.has(err)).equals(true);
    expect(parent.sent + child.sent).equals(0);
    expect(buildPayload.mock.calls).lengthOf(0);
  });

  it.each([
    ['startWithdraw', (t: PlasmaERC20) => t.startWithdraw(1n)],
    ['prepareStartWithdraw', (t: PlasmaERC20) => t.prepareStartWithdraw(1n)]
  ])('%s rejects on a parent handle and sends nothing', async (_n, call) => {
    const { plasma, parent, child } = await fixture();
    const err = await rejection(() => call(asRuntimeHandle(plasma.parent.erc20(POL))));
    expect(err).property('name').equals('WithdrawStartError');
    expect(AllowedOnChildError.has(err)).equals(true);
    expect(parent.sent + child.sent).equals(0);
  });
});
