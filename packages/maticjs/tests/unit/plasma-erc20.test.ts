/**
 * `PlasmaERC20`: which contract, function and value each call sends, the
 * parent/child side guards, the POL to MATIC queue mapping, and that every
 * `prepare*` sibling hands back what its write sends.
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

import { PlasmaChildERC20ABI } from '../../src/abi/plasma/ChildERC20.ts';
import { PlasmaMRC20ABI } from '../../src/abi/plasma/MRC20.ts';
import { MAX_AMOUNT } from '../../src/constant.ts';
import {
  AllowedOnChildError,
  AllowedOnRootError,
  ExitQueueEmptyError,
  ChildBurnValueNotAllowedError,
  NativeBurnValueMismatchError,
  ProofApiNotSetError,
  TxOptionNotObjectError
} from '../../src/errors.ts';
import { ExitProofBuilder } from '../../src/internal/exit-proof.ts';
import { PlasmaEventSignature } from '../../src/plasma/events.ts';
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
      case 'balanceOf':
        return Promise.resolve(777n);
      case 'allowance':
        return Promise.resolve(888n);
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

describe('PlasmaERC20 reads and approvals', () => {
  it('reads balanceOf on the chain the handle is on', async () => {
    const { plasma, parent, child } = await fixture();
    expect(await plasma.parent.erc20(POL).getBalance(USER)).equals(777n);
    expect(parent.reads[0]).property('address').equals(POL);
    expect(parent.reads[0]).property('args').deep.equals([USER]);
    expect(await plasma.child.erc20(NATIVE).getBalance(USER)).equals(777n);
    expect(child.reads[0]).property('address').equals(NATIVE);
  });

  it('reads the allowance granted to the DepositManager, whatever the token', async () => {
    const { plasma, parent } = await fixture();
    expect(await plasma.parent.erc20(POL).getAllowance(USER)).equals(888n);
    expect(parent.reads[0]).property('functionName').equals('allowance');
    expect(parent.reads[0]).property('args').deep.equals([USER, DEPOSIT_MANAGER]);
  });

  it('approves the DepositManager on the token, pinned to the parent chain id', async () => {
    const { plasma, parent } = await fixture();
    await plasma.parent.erc20(POL).approve(AMOUNT);
    expect(parent.writes).lengthOf(1);
    expect(parent.writes[0]).property('address').equals(POL);
    expect(parent.writes[0]).property('functionName').equals('approve');
    expect(parent.writes[0]).property('args').deep.equals([DEPOSIT_MANAGER, AMOUNT]);
    expect(parent.writes[0]).property('chainId').equals(PARENT_ID);
  });

  it('approveMax approves 2^256 - 1', async () => {
    const { plasma, parent } = await fixture();
    await plasma.parent.erc20(POL).approveMax();
    expect(parent.writes[0]).property('args').deep.equals([DEPOSIT_MANAGER, MAX_AMOUNT]);
  });
});

describe('PlasmaERC20.deposit', () => {
  it('calls DepositManager.depositERC20ForUser(token, user, amount) with no value', async () => {
    const { plasma, parent } = await fixture();
    await plasma.parent.erc20(POL).deposit(AMOUNT, USER);
    expect(parent.writes).lengthOf(1);
    expect(parent.writes[0]).property('address').equals(DEPOSIT_MANAGER);
    expect(parent.writes[0]).property('functionName').equals('depositERC20ForUser');
    expect(parent.writes[0]).property('args').deep.equals([POL, USER, AMOUNT]);
    expect(parent.writes[0]).property('value').equals(undefined);
    expect(parent.writes[0]).property('chainId').equals(PARENT_ID);
  });
});

describe('PlasmaERC20.startWithdraw', () => {
  it('burns a child ERC-20 with PlasmaChildERC20.withdraw(amount) and no value', async () => {
    const { plasma, child } = await fixture();
    await plasma.child.erc20(CHILD_TOKEN).startWithdraw(AMOUNT);
    expect(child.writes).lengthOf(1);
    expect(child.writes[0]).property('address').equals(CHILD_TOKEN);
    expect(child.writes[0]).property('functionName').equals('withdraw');
    expect(child.writes[0]).property('args').deep.equals([AMOUNT]);
    expect(child.writes[0]).property('value').equals(undefined);
    expect(child.writes[0]).property('abi').equals(PlasmaChildERC20ABI);
    expect(child.writes[0]).property('chainId').equals(CHILD_ID);
  });

  it('burns the native-token contract with MRC20.withdraw(amount) and value = amount', async () => {
    const { plasma, child } = await fixture();
    await plasma.child.erc20(NATIVE).startWithdraw(AMOUNT);
    expect(child.writes[0]).property('address').equals(NATIVE);
    expect(child.writes[0]).property('functionName').equals('withdraw');
    expect(child.writes[0]).property('args').deep.equals([AMOUNT]);
    expect(child.writes[0]).property('value').equals(AMOUNT);
    expect(child.writes[0]).property('abi').equals(PlasmaMRC20ABI);
  });

  it('sends an equal value as given, with the rest of the options', async () => {
    const { plasma, child } = await fixture();
    await plasma.child.erc20(NATIVE).startWithdraw(AMOUNT, { value: AMOUNT, gasLimit: 90_000n });
    expect(child.writes).lengthOf(1);
    expect(child.writes[0]).property('value').equals(AMOUNT);
    expect(child.writes[0]).property('gasLimit').equals(90_000n);
  });

  it('rejects a native burn whose value differs from the amount, sending and estimating nothing', async () => {
    const { plasma, parent, child } = await fixture();
    const err = await rejection(() =>
      plasma.child.erc20(NATIVE).startWithdraw(AMOUNT, { value: 1n })
    );
    expect(err).property('name').equals('WithdrawStartError');
    const mismatch = NativeBurnValueMismatchError.find(err);
    expect(mismatch?.info.amount).equals(AMOUNT);
    expect(mismatch?.info.value).equals(1n);
    expect(child.sent + parent.sent).equals(0);
    expect(child.estimates).lengthOf(0);
  });

  it('rejects a zero value too: it is present, and different from the amount', async () => {
    const { plasma, child } = await fixture();
    const err = await rejection(() =>
      plasma.child.erc20(NATIVE).startWithdraw(AMOUNT, { value: 0n })
    );
    expect(NativeBurnValueMismatchError.find(err)?.info.value).equals(0n);
    expect(child.sent).equals(0);
  });

  it('passes a child ERC-20 burn through when value is absent or zero', async () => {
    const { plasma, child } = await fixture();
    await plasma.child.erc20(CHILD_TOKEN).startWithdraw(AMOUNT, { gasLimit: 90_000n });
    await plasma.child.erc20(CHILD_TOKEN).startWithdraw(AMOUNT, { value: 0n });
    expect(child.writes).lengthOf(2);
    expect(child.writes[0]).property('gasLimit').equals(90_000n);
    expect(child.writes[0]).property('value').equals(undefined);
    expect(child.writes[1]).property('value').equals(0n);
  });

  it('passes a child ERC-20 burn through when a plain-JavaScript caller gives the number 0', async () => {
    const { plasma, child } = await fixture();
    await plasma.child.erc20(CHILD_TOKEN).startWithdraw(AMOUNT, { value: 0 as never });
    expect(child.writes).lengthOf(1);
    expect(child.writes[0]).property('value').equals(0);
  });

  it('rejects a non-zero value on a child ERC-20 burn, estimating and sending nothing', async () => {
    const { plasma, parent, child } = await fixture();
    const err = await rejection(() =>
      plasma.child.erc20(CHILD_TOKEN).startWithdraw(AMOUNT, { value: 1n })
    );
    expect(err).property('name').equals('WithdrawStartError');
    expect(ChildBurnValueNotAllowedError.find(err)?.info.value).equals(1n);
    expect(NativeBurnValueMismatchError.has(err)).equals(false);
    expect(child.sent + parent.sent).equals(0);
    expect(child.estimates).lengthOf(0);
    expect(child.writes).lengthOf(0);
  });
});

describe('PlasmaERC20.prepareStartWithdraw native burn value', () => {
  it('sets value = amount when the caller passes none', async () => {
    const { plasma, child } = await fixture();
    await plasma.child.erc20(NATIVE).prepareStartWithdraw(AMOUNT);
    expect(child.prepares[0]).property('value').equals(AMOUNT);
  });

  it('keeps an equal value as given', async () => {
    const { plasma, child } = await fixture();
    await plasma.child.erc20(NATIVE).prepareStartWithdraw(AMOUNT, { value: AMOUNT });
    expect(child.prepares).lengthOf(1);
    expect(child.prepares[0]).property('value').equals(AMOUNT);
  });

  it('rejects a different value with NativeBurnValueMismatchError and prepares nothing', async () => {
    const { plasma, parent, child } = await fixture();
    const err = await rejection(() =>
      plasma.child.erc20(NATIVE).prepareStartWithdraw(AMOUNT, { value: AMOUNT + 1n })
    );
    expect(err).property('name').equals('WithdrawStartError');
    const mismatch = NativeBurnValueMismatchError.find(err);
    expect(mismatch?.info.amount).equals(AMOUNT);
    expect(mismatch?.info.value).equals(AMOUNT + 1n);
    expect(child.sent + parent.sent).equals(0);
  });

  it('passes a child ERC-20 prepare through when value is absent or zero', async () => {
    const { plasma, child } = await fixture();
    await plasma.child.erc20(CHILD_TOKEN).prepareStartWithdraw(AMOUNT);
    await plasma.child.erc20(CHILD_TOKEN).prepareStartWithdraw(AMOUNT, { value: 0n });
    expect(child.prepares).lengthOf(2);
    expect(child.prepares[0]).property('value').equals(undefined);
    expect(child.prepares[1]).property('value').equals(0n);
  });

  it('passes a child ERC-20 prepare through when a plain-JavaScript caller gives the number 0', async () => {
    const { plasma, child } = await fixture();
    await plasma.child.erc20(CHILD_TOKEN).prepareStartWithdraw(AMOUNT, { value: 0 as never });
    expect(child.prepares).lengthOf(1);
    expect(child.prepares[0]).property('value').equals(0);
  });

  it('rejects a non-zero value on a child ERC-20 prepare and prepares nothing', async () => {
    const { plasma, parent, child } = await fixture();
    const err = await rejection(() =>
      plasma.child.erc20(CHILD_TOKEN).prepareStartWithdraw(AMOUNT, { value: 1n })
    );
    expect(err).property('name').equals('WithdrawStartError');
    expect(ChildBurnValueNotAllowedError.find(err)?.info.value).equals(1n);
    expect(child.sent + parent.sent).equals(0);
    expect(child.estimates).lengthOf(0);
    expect(child.prepares).lengthOf(0);
  });
});

describe('PlasmaERC20.confirmWithdraw', () => {
  it('builds the payload for the Plasma Withdraw log and starts the exit through the predicate', async () => {
    const { plasma, parent, buildPayload } = await fixture();
    await plasma.parent.erc20(POL).confirmWithdraw(BURN);
    expect(buildPayload.mock.calls).deep.equals([
      [BURN, PlasmaEventSignature.Erc20Withdraw, false]
    ]);
    expect(parent.writes).lengthOf(1);
    expect(parent.writes[0]).property('address').equals(PREDICATE);
    expect(parent.writes[0]).property('functionName').equals('startExitWithBurntTokens');
    expect(parent.writes[0]).property('args').deep.equals([PAYLOAD]);
    expect(parent.writes[0]).property('chainId').equals(PARENT_ID);
  });

  it('confirmWithdrawFast takes the proof API arm', async () => {
    const { plasma, parent, buildPayload } = await fixture({
      proofGenerationApiUrl: 'https://proof.example.test'
    });
    await plasma.parent.erc20(POL).confirmWithdrawFast(BURN);
    expect(buildPayload.mock.calls).deep.equals([[BURN, PlasmaEventSignature.Erc20Withdraw, true]]);
    expect(parent.writes[0]).property('functionName').equals('startExitWithBurntTokens');
  });

  it('confirmWithdrawFast without a proof API URL rejects with ProofApiNotSetError and sends nothing', async () => {
    const { plasma, parent, buildPayload } = await fixture();
    buildPayload.mockRestore();
    const err = await rejection(() => plasma.parent.erc20(POL).confirmWithdrawFast(BURN));
    expect(err).property('name').equals('ExitError');
    expect(ProofApiNotSetError.has(err)).equals(true);
    expect(parent.sent).equals(0);
  });

  it('lets a payload-building failure through untouched when it is not an SDK error', async () => {
    const { plasma, parent, buildPayload } = await fixture();
    const libraryError = new Error('rpc down');
    buildPayload.mockRejectedValue(libraryError);
    expect(await rejection(() => plasma.parent.erc20(POL).confirmWithdraw(BURN))).equals(
      libraryError
    );
    expect(parent.sent).equals(0);
  });
});

describe('PlasmaERC20.completeWithdraw', () => {
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

  it('rejects with ExitQueueEmptyError, sending nothing, when the queue is empty', async () => {
    const { plasma, parent } = await fixture();
    const err = await rejection(() => plasma.parent.erc20(POL).completeWithdraw());
    expect(err).property('name').equals('ExitError');
    expect(err).property('info').property('operation').equals('completeWithdraw');
    expect(ExitQueueEmptyError.find(err)?.info.tokens).deep.equals([MATIC]);
    expect(parent.sent).equals(0);
  });

  it('uses a caller gasLimit untouched', async () => {
    const { plasma, parent } = await queued();
    await plasma.parent.erc20(POL).completeWithdraw({ gasLimit: 900_000n });
    expect(parent.writes[0]).property('gasLimit').equals(900_000n);
  });
});

describe('PlasmaERC20.getCompleteWithdrawGasLimit', () => {
  const queued = async (queueSize: bigint) => {
    const f = await fixture();
    f.parent.queues.set(MATIC.toLowerCase(), QUEUE);
    f.parent.queues.set(OTHER_TOKEN.toLowerCase(), QUEUE);
    f.parent.queueSize = queueSize;
    return f;
  };

  it.each([
    [1n, ESTIMATE + 350_000n],
    [3n, ESTIMATE + 3n * 350_000n],
    [500n, 16_000_000n]
  ])(
    'equals the limit completeWithdraw sends, for a POL handle over %s queued exits',
    async (queueSize, expected) => {
      const { plasma, parent } = await queued(queueSize);
      const token = plasma.parent.erc20(POL);
      const limit = await token.getCompleteWithdrawGasLimit();
      expect(limit).equals(expected);
      expect(parent.sent).equals(0);
      await token.completeWithdraw();
      expect(parent.writes[0]).property('gasLimit').equals(limit);
    }
  );

  it('reads the MATIC queue from a POL handle and its own queue from any other token', async () => {
    const { plasma, parent } = await queued(1n);
    await plasma.parent.erc20(POL).getCompleteWithdrawGasLimit();
    await plasma.parent.erc20(OTHER_TOKEN).getCompleteWithdrawGasLimit();
    const queueReads = parent.reads.filter((r) => r.functionName === 'exitsQueues');
    expect(queueReads.map((r) => r.args)).deep.equals([[MATIC], [OTHER_TOKEN]]);
    expect(parent.estimates.map((e) => e.args)).deep.equals([[MATIC], [OTHER_TOKEN]]);
  });

  it('estimates as the given sender, as the write does', async () => {
    const { plasma, parent } = await queued(1n);
    await plasma.parent.erc20(POL).getCompleteWithdrawGasLimit({ from: USER });
    expect(parent.estimates[0]).property('from').equals(USER);
  });

  it('rejects with ExitQueueEmptyError, estimating and sending nothing, when the queue is empty', async () => {
    const { plasma, parent } = await fixture();
    const err = await rejection(() => plasma.parent.erc20(POL).getCompleteWithdrawGasLimit());
    expect(err).property('name').equals('ExitError');
    expect(err).property('info').property('operation').equals('getCompleteWithdrawGasLimit');
    expect(ExitQueueEmptyError.find(err)?.info.tokens).deep.equals([MATIC]);
    expect(parent.sent).equals(0);
    expect(parent.estimates).lengthOf(0);
  });

  it('rethrows an estimation failure as the same object', async () => {
    const { plasma, parent } = await queued(1n);
    const libraryError = new Error('execution reverted');
    parent.estimateGas = (): Promise<bigint> => Promise.reject(libraryError);
    expect(await rejection(() => plasma.parent.erc20(POL).getCompleteWithdrawGasLimit())).equals(
      libraryError
    );
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

  it('reads the same status the client reads', async () => {
    const { plasma, child } = await fixture();
    child.request = <T>(method: string): Promise<T> =>
      Promise.resolve(
        (method === 'eth_getTransactionByHash' ? { hash: BURN, blockNumber: null } : null) as T
      );
    const params = { burnTxHash: BURN };
    const viaToken = await plasma.parent.erc20(POL).getWithdrawStatus(params);
    expect(viaToken).deep.equals({ exited: false, reason: 'pending' });
    expect(await plasma.getWithdrawStatus(params)).deep.equals(viaToken);
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

describe('PlasmaERC20 options guard', () => {
  it.each([
    ['startWithdraw', (t: PlasmaERC20, o: never) => t.startWithdraw(1n, o)],
    ['prepareStartWithdraw', (t: PlasmaERC20, o: never) => t.prepareStartWithdraw(1n, o)],
    ['completeWithdraw', (t: PlasmaERC20, o: never) => t.completeWithdraw(o)],
    ['prepareCompleteWithdraw', (t: PlasmaERC20, o: never) => t.prepareCompleteWithdraw(o)],
    ['getCompleteWithdrawGasLimit', (t: PlasmaERC20, o: never) => t.getCompleteWithdrawGasLimit(o)]
  ])('%s rejects null options as TxOptionNotObjectError', async (name, call) => {
    const { plasma, parent, child } = await fixture();
    const handle = asRuntimeHandle(
      /start/i.test(name) ? plasma.child.erc20(NATIVE) : plasma.parent.erc20(POL)
    );
    const err = await rejection(() => call(handle, null as never));
    expect(TxOptionNotObjectError.has(err)).equals(true);
    expect(parent.sent + child.sent).equals(0);
  });
});

describe('PlasmaERC20 prepare siblings match their writes', () => {
  const queuedFixture = async () => {
    const f = await fixture({ proofGenerationApiUrl: 'https://proof.example.test' });
    f.parent.queues.set(MATIC.toLowerCase(), QUEUE);
    f.parent.queueSize = 1n;
    return f;
  };

  const PAIRS: Array<
    [
      string,
      chain: 'parent' | 'child',
      write: (f: Fixture) => Promise<unknown>,
      prepare: (f: Fixture) => Promise<PreparedTx>
    ]
  > = [
    [
      'approve',
      'parent',
      (f) => f.plasma.parent.erc20(POL).approve(AMOUNT),
      (f) => f.plasma.parent.erc20(POL).prepareApprove(AMOUNT)
    ],
    [
      'approveMax',
      'parent',
      (f) => f.plasma.parent.erc20(POL).approveMax(),
      (f) => f.plasma.parent.erc20(POL).prepareApproveMax()
    ],
    [
      'deposit',
      'parent',
      (f) => f.plasma.parent.erc20(POL).deposit(AMOUNT, USER),
      (f) => f.plasma.parent.erc20(POL).prepareDeposit(AMOUNT, USER)
    ],
    [
      'startWithdraw (child ERC-20)',
      'child',
      (f) => f.plasma.child.erc20(CHILD_TOKEN).startWithdraw(AMOUNT),
      (f) => f.plasma.child.erc20(CHILD_TOKEN).prepareStartWithdraw(AMOUNT)
    ],
    [
      'startWithdraw (native)',
      'child',
      (f) => f.plasma.child.erc20(NATIVE).startWithdraw(AMOUNT),
      (f) => f.plasma.child.erc20(NATIVE).prepareStartWithdraw(AMOUNT)
    ],
    [
      'confirmWithdraw',
      'parent',
      (f) => f.plasma.parent.erc20(POL).confirmWithdraw(BURN),
      (f) => f.plasma.parent.erc20(POL).prepareConfirmWithdraw(BURN)
    ],
    [
      'confirmWithdrawFast',
      'parent',
      (f) => f.plasma.parent.erc20(POL).confirmWithdrawFast(BURN),
      (f) => f.plasma.parent.erc20(POL).prepareConfirmWithdrawFast(BURN)
    ],
    [
      'completeWithdraw',
      'parent',
      (f) => f.plasma.parent.erc20(POL).completeWithdraw(),
      (f) => f.plasma.parent.erc20(POL).prepareCompleteWithdraw()
    ]
  ];

  it.each(PAIRS)('%s', async (_name, side, write, prepare) => {
    const f = await queuedFixture();
    await write(f);
    const sent = f[side].writes[0];
    if (sent === undefined) throw new Error('the write sent nothing');
    const prepared = await prepare(f);
    expect(prepared).deep.equals(preparedOf(sent));
    expect(prepared).property('to').equals(sent.address);
    expect(f[side].prepares).lengthOf(1);
    const request = f[side].prepares[0];
    expect(request).property('functionName').equals(sent.functionName);
    expect(request).property('args').deep.equals(sent.args);
    expect(request).property('value').equals(sent.value);
    expect(f[side].writes).lengthOf(1);
  });
});
