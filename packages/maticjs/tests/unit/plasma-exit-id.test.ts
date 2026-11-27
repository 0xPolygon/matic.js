import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RLP } from '@ethereumjs/rlp';
import { toEventSelector } from 'viem';
import { describe, expect, it } from 'vitest';

import type { Hex, Receipt } from '../../src/adapter.ts';

import { PlasmaEventSignature } from '../../src/plasma/events.ts';
import {
  addressOfTopic,
  branchMaskForTransactionIndex,
  branchMaskOf,
  burnBlockOf,
  exitableAtOf,
  startedExitsFromReceipt
} from '../../src/plasma/exit-id.ts';
import { cassetteAdapter, loadCassette } from './cassette-adapter.ts';

const MANAGER: Hex = '0x32Ac76FdbF38b50D584DD943daCDA4b07FdcBFC7';
const EXITOR: Hex = '0x00000000000000000000000000000000000000aa';
const hex32 = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;

/** The id layout the withdraw manager builds: `age << 1`, age = exitableAt << 127 | block << 32 | mask. */
const buildExitId = ({
  exitableAt,
  block,
  mask
}: {
  exitableAt: bigint;
  block: bigint;
  mask: bigint;
}): bigint => (exitableAt << 128n) | (block << 33n) | (mask << 1n);

const receiptWith = (logs: Receipt['logs']): Pick<Receipt, 'logs'> => ({ logs });

describe('PlasmaEventSignature.ExitStarted', () => {
  it('is the keccak topic of the ExitStarted event', () => {
    expect(PlasmaEventSignature.ExitStarted).equals(
      toEventSelector('ExitStarted(address,uint256,address,uint256,bool)')
    );
  });
});

describe('exit id fields', () => {
  it('round-trips exitableAt and the burn block through an id built from both', () => {
    const exitId = buildExitId({ exitableAt: 1_731_000_000n, block: 97_394_752n, mask: 0b1010n });
    expect(exitableAtOf(exitId)).equals(1_731_000_000n);
    expect(burnBlockOf(exitId)).equals(97_394_752n);
  });

  it('is not disturbed by a full branch mask or the widest burn block', () => {
    const widestBlock = 2n ** 95n - 1n;
    const exitId = buildExitId({ exitableAt: 7n, block: widestBlock, mask: 2n ** 31n - 1n });
    expect(burnBlockOf(exitId)).equals(widestBlock);
    expect(exitableAtOf(exitId)).equals(7n);
  });

  it('reads the id observed on a devnet exit', () => {
    // exit id from a devnet confirm: burn at child block 266, exitable at
    // parent timestamp 486.
    const exitId = 165377230323576093243200059214124273369344n;
    expect(burnBlockOf(exitId)).equals(266n);
    expect(exitableAtOf(exitId)).equals(486n);
  });
});

describe('branchMaskOf', () => {
  it('reads bits 1 to 32 of the id, leaving the block and exitableAt fields out', () => {
    const exitId = buildExitId({ exitableAt: 7n, block: 2n ** 95n - 1n, mask: 0x8180n });
    expect(branchMaskOf(exitId)).equals(0x8180n);
  });

  it('reads a full 32-bit mask whole', () => {
    const exitId = buildExitId({ exitableAt: 7n, block: 266n, mask: 2n ** 32n - 1n });
    expect(branchMaskOf(exitId)).equals(2n ** 32n - 1n);
    expect(burnBlockOf(exitId)).equals(266n);
  });

  it('reads the mask of the id observed on a devnet exit as 0x80', () => {
    // A burn first in its block has the path 0x80, the RLP of index 0.
    expect(branchMaskOf(165377230323576093243200059214124273369344n)).equals(0x80n);
  });
});

describe('branchMaskForTransactionIndex', () => {
  // The withdraw manager reads the payload's branch mask, the receipt's merkle
  // path (the RLP of the transaction index) behind a zero byte, as one uint.
  it.each([
    [0, 0x80n],
    [1, 0x01n],
    [57, 0x39n],
    [127, 0x7fn],
    [128, 0x8180n],
    [255, 0x81ffn],
    [256, 0x820100n],
    [65_535, 0x82ffffn],
    [65_536, 0x83010000n]
  ])('is the RLP of index %i read as an integer', (index, expected) => {
    expect(branchMaskForTransactionIndex(index)).equals(expected);
  });

  it('is never the plain index: index 0 is 0x80 and index 128 is 0x8180', () => {
    expect(branchMaskForTransactionIndex(0)).not.equals(0n);
    expect(branchMaskForTransactionIndex(128)).not.equals(128n);
  });

  describe('against the recorded mainnet burn', () => {
    const file = 'plasma-erc20-burn-1.json';
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '..', 'fixtures', 'exits', file), 'utf8')
    ) as { burnTxHash: string; expectedPayloadHex: string };

    it("equals the payload's branch mask, which the manager copies into the exit id", async () => {
      // The payload is the proof API's, verified byte-identical to the SDK's.
      // Its ninth field is `0x00 || path`; `getBranchMaskAsUint` reads it as
      // one integer and `verifyInclusion` ORs that into the age, which the
      // predicate shifts left by one to make the exit id.
      const fields = RLP.decode(Buffer.from(fixture.expectedPayloadHex.slice(2), 'hex'));
      const branchMaskField = fields[8];
      if (!(branchMaskField instanceof Uint8Array)) throw new Error('payload field 8 is not bytes');
      expect(branchMaskField[0]).equals(0);
      const payloadMask = BigInt(`0x${Buffer.from(branchMaskField).toString('hex')}`);

      const child = cassetteAdapter(loadCassette(file).child);
      const receipt = await child.request<{ transactionIndex: string }>(
        'eth_getTransactionReceipt',
        [fixture.burnTxHash]
      );
      const transactionIndex = Number(receipt.transactionIndex);

      expect(transactionIndex).equals(57);
      expect(payloadMask).equals(0x39n);
      expect(branchMaskForTransactionIndex(transactionIndex)).equals(payloadMask);
      expect(
        branchMaskOf(buildExitId({ exitableAt: 1n, block: 97_394_752n, mask: payloadMask }))
      ).equals(branchMaskForTransactionIndex(transactionIndex));
    });
  });
});

describe('addressOfTopic', () => {
  it('takes the low 20 bytes of an indexed-address topic, lower-cased', () => {
    expect(addressOfTopic(`0x${'00'.repeat(12)}${'Ab'.repeat(20)}`)).equals(`0x${'ab'.repeat(20)}`);
  });
});

describe('startedExitsFromReceipt', () => {
  const exitId = buildExitId({ exitableAt: 486n, block: 266n, mask: 0n });
  const started = (address: Hex, id: bigint): Receipt['logs'][number] => ({
    address,
    topics: [PlasmaEventSignature.ExitStarted, hex32(BigInt(EXITOR)), hex32(id), hex32(2n)],
    data: '0x',
    logIndex: 0
  });

  it('matches the emitter regardless of address case', () => {
    expect(
      startedExitsFromReceipt({
        receipt: receiptWith([started(MANAGER, exitId)]),
        withdrawManager: MANAGER.toLowerCase() as Hex
      })
    ).deep.equals([{ exitId, exitor: EXITOR }]);
  });

  it('ignores other events from the withdraw manager', () => {
    const transfer = { ...started(MANAGER, exitId), topics: [hex32(9n), hex32(1n), hex32(exitId)] };
    expect(
      startedExitsFromReceipt({ receipt: receiptWith([transfer]), withdrawManager: MANAGER })
    ).deep.equals([]);
  });

  it('skips a malformed log that lacks the exit id topic and finds a later good one', () => {
    const short: Receipt['logs'][number] = {
      ...started(MANAGER, exitId),
      topics: [PlasmaEventSignature.ExitStarted, hex32(1n)]
    };
    expect(
      startedExitsFromReceipt({
        receipt: receiptWith([short, started(MANAGER, exitId)]),
        withdrawManager: MANAGER
      })
    ).deep.equals([{ exitId, exitor: EXITOR }]);
  });

  it('returns every exit of the manager in log order, for a transaction that confirms several burns', () => {
    const second = buildExitId({ exitableAt: 486n, block: 266n, mask: 1n });
    const foreign = started('0x9999999999999999999999999999999999999999', 7n);
    expect(
      startedExitsFromReceipt({
        receipt: receiptWith([started(MANAGER, exitId), foreign, started(MANAGER, second)]),
        withdrawManager: MANAGER
      })
    ).deep.equals([
      { exitId, exitor: EXITOR },
      { exitId: second, exitor: EXITOR }
    ]);
  });
});
