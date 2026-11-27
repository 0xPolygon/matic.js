/**
 * Reading a Plasma exit id.
 *
 * The withdraw manager builds an exit id as `age << 1`, where
 * `age = (exitableAt << 127) | (burnBlock << 32) | branchMask`. So the id
 * carries the time the exit becomes processable in its top bits and the
 * child-chain block of the burn in the middle, and both can be read back
 * without any contract call. The low bits carry the burn receipt's position
 * in that block. Those fields, plus the exitor the `ExitStarted` log names,
 * are what let the SDK tie a confirm transaction to the burn it claims to
 * confirm: the contracts expose no lookup from a burn to its exit, and two
 * burns in one block share the block field.
 */
import { RLP } from '@ethereumjs/rlp';

import type { Hex, Receipt } from '../adapter.js';

import { PlasmaEventSignature } from './events.js';

/** Position of the burn block within an exit id: above the branch mask and the id's low bit. */
const BURN_BLOCK_SHIFT = 33n;
/** The burn block field is 95 bits wide, between the branch mask below and `exitableAt` above. */
const BURN_BLOCK_MASK = 2n ** 95n - 1n;
/** The branch mask field is 32 bits wide, starting at bit 1 of an exit id. */
const BRANCH_MASK_FIELD = 2n ** 32n - 1n;
/** Position of `exitableAt` within an exit id. */
const EXITABLE_AT_SHIFT = 128n;

/** Parent-chain timestamp (seconds) from which the exit can be processed. */
export const exitableAtOf = (exitId: bigint): bigint => exitId >> EXITABLE_AT_SHIFT;

/** Child-chain block number of the burn that this exit was started from. */
export const burnBlockOf = (exitId: bigint): bigint =>
  (exitId >> BURN_BLOCK_SHIFT) & BURN_BLOCK_MASK;

/**
 * The receipt-position field of an exit id: bits 1 to 32, between the id's
 * low bit and the burn block. The withdraw manager fills it from the exit
 * payload's branch mask, which is the burn receipt's position in its block.
 */
export const branchMaskOf = (exitId: bigint): bigint => (exitId >> 1n) & BRANCH_MASK_FIELD;

/**
 * The branch mask the withdraw manager records for a burn that sits at
 * `transactionIndex` in its block.
 *
 * The exit payload carries the receipt's merkle path, which is the RLP
 * encoding of the transaction index, behind a zero byte. The manager reads
 * that byte string back as one unsigned integer, so for index 57 the path is
 * `0x39` and the mask is `0x39`, and for index 128 the path is `0x8180` and
 * the mask is `0x8180`. Index 0 encodes as `0x80`, so a burn first in its
 * block has mask `0x80`, never 0. A path of more than four bytes would not
 * fit the 32-bit field and the manager rejects it, so no real exit has such
 * a mask.
 */
export const branchMaskForTransactionIndex = (transactionIndex: number): bigint => {
  let mask = 0n;
  for (const byte of RLP.encode(transactionIndex)) mask = (mask << 8n) | BigInt(byte);
  return mask;
};

/** The exit an `ExitStarted` log announced: its id and who it was started for. */
export interface StartedExit {
  readonly exitId: bigint;
  /** Lower-case address of the account that started the exit. */
  readonly exitor: Hex;
}

/**
 * Every exit announced by an `ExitStarted` log that `withdrawManager` emitted
 * in `receipt`, in log order; empty when the receipt has no such log. The
 * emitter is checked as well as the topic, so a log of the same shape from
 * another contract cannot be mistaken for an exit. The exitor is the event's
 * first indexed argument (topic 1) and the exit id its second (topic 2).
 *
 * All of them are returned, not the first, because one transaction can
 * confirm several burns (a Safe or batcher sending several confirms at once)
 * and so emit several logs: the caller picks the exit that belongs to the
 * burn it is asking about.
 */
export const startedExitsFromReceipt = ({
  receipt,
  withdrawManager
}: {
  receipt: Pick<Receipt, 'logs'>;
  withdrawManager: Hex;
}): StartedExit[] => {
  const manager = withdrawManager.toLowerCase();
  const exits: StartedExit[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== manager) continue;
    if (log.topics[0]?.toLowerCase() !== PlasmaEventSignature.ExitStarted) continue;
    const exitor = log.topics[1];
    const exitId = log.topics[2];
    if (exitor === undefined || exitId === undefined) continue;
    exits.push({ exitId: BigInt(exitId), exitor: addressOfTopic(exitor) });
  }
  return exits;
};

/** The address in an indexed-address topic: its low 20 bytes, lower-cased. */
export const addressOfTopic = (topic: string): Hex => `0x${topic.slice(-40).toLowerCase()}`;
