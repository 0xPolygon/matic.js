/**
 * Plasma ERC-20 bridge through each adapter, against the devnet's Plasma
 * contracts. The devnet has no proof API, so this file covers the local-proof
 * path (`confirmWithdraw`); the proof-API path (`confirmWithdrawFast`) is
 * covered by the unit tests and a recorded-payload comparison.
 *
 * The token is POL. A deposit pulls POL on L1 and pays the same amount of the
 * child chain's native token; the burn is `withdraw` on the native-token
 * contract, which queues its exit under the legacy MATIC token even though
 * the exit pays out POL. That is why `completeWithdraw` is called on the POL
 * handle: the SDK has to map POL to the MATIC queue.
 *
 * Balances are read with plain viem, so a write the SDK misreports cannot
 * hide behind the SDK's own reads. Every write takes the default gas path: a
 * caller `gasLimit` would sidestep the SDK sizing under test.
 *
 * # One exit queue for three rows
 *
 * The rows run at the same time and share the MATIC exit queue, and one
 * `processExits` pays out every exit whose window has ended. So a row's
 * `completeWithdraw` may pay another row's exit, and may find nothing left
 * to process because another row already did. Each row therefore asserts its
 * OWN exit reached `{ exited: true }`, and treats `ExitQueueEmptyError` as
 * fine only when its own status already reads exited.
 *
 * The exit window is one block on the devnet, so the same sharing would
 * otherwise race the status read right after a row's confirm: a faster row's
 * `processExits` can pay a slower row's exit before that row has looked. No
 * row processes the queue until every row has read its post-confirm status,
 * so that read sees `'in-exit-window'` or `'ready-to-process'` every time.
 */
import { describe, expect, it } from 'vitest';

import type { PlasmaClient, PlasmaWithdrawStatus } from '@polygonlabs/maticjs/plasma';

import { ExitQueueEmptyError } from '@polygonlabs/maticjs/plasma';

import type { AdapterRow } from '../src/adapters.ts';

import { buildAdapters } from '../src/adapters.ts';
import { getTestEnv } from '../src/test-env.ts';
import { pollUntil } from '../src/wait.ts';
import {
  confirmSuccess,
  CHECKPOINT_TIMEOUT_MS,
  CYCLE_TIMEOUT_MS,
  erc20BalanceOf,
  initPlasma,
  POLL_MS,
  readers,
  waitForExitable,
  waitForStateSync
} from './cycle.ts';

const AMOUNT = 10n ** 17n;

/** The child chain's native-token contract: a burn here is a Plasma exit. */
const NATIVE_TOKEN_CONTRACT = '0x0000000000000000000000000000000000001010';

const rows = buildAdapters({ suite: 'plasma-erc20' });

/**
 * Opens once every party has arrived. A row that fails before it gets there
 * still arrives (see its `finally`), so one failure releases the others
 * instead of leaving them to wait out the cycle timeout.
 */
function createBarrier(parties: number) {
  let remaining = parties;
  const { promise, resolve } = Promise.withResolvers<void>();
  return {
    arrive: () => {
      remaining -= 1;
      if (remaining === 0) resolve();
    },
    opened: promise
  };
}

/** Opens when every row has read its status right after its own confirm. */
const allConfirmedAndRead = createBarrier(rows.length);

/** Token handles for the POL deposit side and the native burn side. */
function handles(plasma: PlasmaClient) {
  const { addresses } = getTestEnv().E2E_ADDRESSES_JSON;
  return {
    pol: plasma.parent.erc20(addresses.PolToken),
    native: plasma.child.erc20(NATIVE_TOKEN_CONTRACT)
  };
}

/**
 * Approve and deposit `AMOUNT` of POL, then wait until the child native
 * balance has risen by it. Returns the balances from before the deposit.
 */
async function depositPol({ plasma, row }: { plasma: PlasmaClient; row: AdapterRow }) {
  const { addresses } = getTestEnv().E2E_ADDRESSES_JSON;
  const { l1, l2 } = readers();
  const { pol } = handles(plasma);
  const parentBalance = () =>
    erc20BalanceOf({ client: l1, token: addresses.PolToken, owner: row.address });
  const childBalance = () => l2.getBalance({ address: row.address });

  const parentBefore = await parentBalance();
  const childBefore = await childBalance();
  expect(parentBefore >= AMOUNT, 'seeded parent POL balance').equals(true);

  await confirmSuccess(await pol.approve(AMOUNT));
  expect(await pol.getAllowance(row.address)).equals(AMOUNT);

  await confirmSuccess(await pol.deposit(AMOUNT, row.address));
  expect(await parentBalance()).equals(parentBefore - AMOUNT);

  await waitForStateSync({
    read: childBalance,
    done: (balance) => balance === childBefore + AMOUNT,
    label: `${row.name} child native balance after the POL deposit`
  });
  return { parentBefore, childBefore, parentBalance, childBalance };
}

/**
 * Wait until the burn's block is checkpointed. Until then the status reads
 * `'not-checkpointed'`; the wait ends on `'not-confirmed'` (the only answer a
 * checkpointed burn gives without a confirm hash) and fails loudly, naming the
 * last state seen, if it never gets there.
 */
async function waitForCheckpointed({
  plasma,
  burnTxHash,
  label
}: {
  plasma: PlasmaClient;
  burnTxHash: string;
  label: string;
}) {
  const { pol } = handles(plasma);
  let last: PlasmaWithdrawStatus | undefined;
  try {
    return await pollUntil({
      fn: async () => {
        last = await pol.getWithdrawStatus({ burnTxHash });
        return !last.exited && last.reason === 'not-confirmed' ? last : undefined;
      },
      pollMs: POLL_MS,
      timeoutMs: CHECKPOINT_TIMEOUT_MS,
      label: `checkpoint: ${label}`
    });
  } catch (error) {
    throw new Error(`${label} never reached 'not-confirmed'; last state ${JSON.stringify(last)}`, {
      cause: error
    });
  }
}

/**
 * Process the queue through the POL handle, then assert this row's own exit
 * is paid out. `ExitQueueEmptyError` is accepted only when the exit already
 * reads exited (see the header).
 */
async function completeOwnExit({
  plasma,
  burnTxHash,
  confirmTxHash
}: {
  plasma: PlasmaClient;
  burnTxHash: string;
  confirmTxHash: string;
}) {
  const { pol } = handles(plasma);
  const status = () => pol.getWithdrawStatus({ burnTxHash, confirmTxHash });
  try {
    await confirmSuccess(await pol.completeWithdraw());
  } catch (err) {
    if (!ExitQueueEmptyError.has(err)) throw err;
    expect(await status(), 'own exit when the queue was already empty').property('exited').equals(
      true
    );
  }
  expect(await status(), 'own exit after completeWithdraw')
    .property('exited')
    .equals(true);
}

describe.concurrent('Plasma ERC-20 deposit and exit cycle', { timeout: CYCLE_TIMEOUT_MS }, () => {
  it.each(rows)('via $name', async (row) => {
    let arrived = false;
    const arrive = () => {
      if (arrived) return;
      arrived = true;
      allConfirmedAndRead.arrive();
    };
    try {
      const plasma = await initPlasma(row);
      const { pol, native } = handles(plasma);
      const { parentBefore, childBefore, parentBalance, childBalance } = await depositPol({
        plasma,
        row
      });

      // The burn is `withdraw(AMOUNT)` with AMOUNT attached as value, so the
      // native balance falls by the burn plus gas, and by less than twice it.
      const burn = await confirmSuccess(await native.startWithdraw(AMOUNT));
      const childAfterBurn = await childBalance();
      expect(childAfterBurn <= childBefore, 'child native balance after the burn').equals(true);
      expect(childBefore - childAfterBurn < AMOUNT, 'only gas is lost beyond the burn').equals(
        true
      );

      // Right after the burn either documented not-yet state is correct: the
      // devnet may already have checkpointed it.
      const burnTxHash = burn.transactionHash;
      const afterBurn = await pol.getWithdrawStatus({ burnTxHash });
      expect(afterBurn).property('exited').equals(false);
      expect(afterBurn).property('reason').oneOf(['not-checkpointed', 'not-confirmed']);
      const checkpointed = await waitForCheckpointed({
        plasma,
        burnTxHash,
        label: `${row.name} burn ${burnTxHash}`
      });
      expect(checkpointed).property('exited').equals(false);
      expect(checkpointed).property('reason').equals('not-confirmed');

      const confirm = await confirmSuccess(await pol.confirmWithdraw(burnTxHash));
      const confirmTxHash = confirm.transactionHash;
      // The exit window is one block on this devnet, so either answer is right.
      const confirmed = await pol.getWithdrawStatus({ burnTxHash, confirmTxHash });
      expect(confirmed).property('exited').equals(false);
      expect(confirmed).property('reason').oneOf(['in-exit-window', 'ready-to-process']);

      // No row processes the queue before every row has read the status above.
      arrive();
      await allConfirmedAndRead.opened;
      await waitForExitable({
        status: () => pol.getWithdrawStatus({ burnTxHash, confirmTxHash }),
        label: `${row.name} exit of burn ${burnTxHash}`
      });
      await completeOwnExit({ plasma, burnTxHash, confirmTxHash });
      expect(await parentBalance()).equals(parentBefore);
    } finally {
      arrive();
    }
  });
});

// A separate suite, so it runs after the concurrent rows above have finished
// and left the shared exit queue empty. One adapter is enough: the behaviour
// under test is the SDK's, not the adapter's.
describe('Plasma ERC-20 prepare and empty-queue behaviour via viem', { timeout: CYCLE_TIMEOUT_MS }, () => {
  const [row] = rows;
  if (row === undefined || row.name !== 'viem') throw new Error('expected the viem row first');
  const viemRow = row;

  it('completeWithdraw on an empty queue rejects with ExitQueueEmptyError and sends nothing', async () => {
    const { addresses } = getTestEnv().E2E_ADDRESSES_JSON;
    const { l1 } = readers();
    const plasma = await initPlasma(viemRow);
    const { pol } = handles(plasma);
    const nonce = () => l1.getTransactionCount({ address: viemRow.address, blockTag: 'pending' });

    const nonceBefore = await nonce();
    const rejection = await pol.completeWithdraw().then(
      () => undefined,
      (err: unknown) => err
    );
    expect(
      ExitQueueEmptyError.has(rejection),
      'completeWithdraw rejected with ExitQueueEmptyError'
    ).equals(true);
    expect(ExitQueueEmptyError.find(rejection))
      .property('info')
      .nested.property('tokens')
      .deep.equals([addresses.MaticToken]);
    expect(await nonce(), 'transactions sent by the rejected call').equals(nonceBefore);
  });

  it('prepareConfirmWithdraw returns the calldata confirmWithdraw sends', async () => {
    const { l1 } = readers();
    const plasma = await initPlasma(viemRow);
    const { pol, native } = handles(plasma);
    await depositPol({ plasma, row: viemRow });

    const burn = await confirmSuccess(await native.startWithdraw(AMOUNT));
    const burnTxHash = burn.transactionHash;
    await waitForCheckpointed({ plasma, burnTxHash, label: `viem burn ${burnTxHash}` });

    const prepared = await pol.prepareConfirmWithdraw(burnTxHash);
    const confirm = await confirmSuccess(await pol.confirmWithdraw(burnTxHash));
    const sent = await l1.getTransaction({ hash: confirm.transactionHash });
    expect(sent.input).equals(prepared.data);
    expect(sent.to?.toLowerCase()).equals(prepared.to.toLowerCase());

    // Leave the shared queue empty for the next run.
    await waitForExitable({
      status: () => pol.getWithdrawStatus({ burnTxHash, confirmTxHash: confirm.transactionHash }),
      label: `viem exit of burn ${burnTxHash}`
    });
    await completeOwnExit({ plasma, burnTxHash, confirmTxHash: confirm.transactionHash });
  });
});
