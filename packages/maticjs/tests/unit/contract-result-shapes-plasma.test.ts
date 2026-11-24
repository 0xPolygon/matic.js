import { describe, expect, it } from 'vitest';

import type { Hex } from '../../src/adapter.ts';
import type { ReadAnswers, TableRead } from './contract-call-harness.ts';

import {
  addressShapes,
  integerShapes,
  INTEGER_SHAPES,
  outcomeOf,
  PLASMA_ADDRESSES,
  PLASMA_QUEUE,
  PLASMA_STATUS,
  plasmaWorld,
  registerTable,
  USER
} from './contract-call-harness.ts';

/**
 * What the Plasma reads do with every shape a contract call can come back in.
 *
 * Each table pins TODAY'S outcome for each shape, well formed or not: the
 * value a public method returns, or the class it throws (and, for the SDK's
 * own errors, the `info` that names the field). The rows are a record of the
 * code as it is, not of what it should do. A row marked
 * `changes when the read is decoded` is one whose outcome today is a native
 * error, a wrong answer, or an SDK error that names the malformed value
 * differently from how a validating read will; only those rows may be edited
 * when reads are validated.
 */

const TOKEN: Hex = '0x00000000000000000000000000000000000000c1';

const answering = (answers: ReadAnswers) => plasmaWorld({ answers });

// --- token balances and allowances ---------------------------------------------------------

registerTable({
  title: 'a Plasma token integer read goes through BigInt',
  reads: [
    {
      name: 'erc20.getBalance',
      field: 'balanceOf.0',
      run: async (raw) =>
        (await answering({ balanceOf: raw })).plasma.parent.erc20(TOKEN).getBalance(USER)
    },
    {
      name: 'erc20.getAllowance',
      field: 'allowance.0',
      run: async (raw) =>
        (await answering({ allowance: raw })).plasma.parent.erc20(TOKEN).getAllowance(USER)
    }
  ],
  shapes: INTEGER_SHAPES,
  rows: [
    ['bigint', 'value 5n'],
    ['decimal string', 'value 5n'],
    ['hex string', 'value 5n'],
    ['BigNumber', 'value 5n'],
    ['number', 'value 5n'],
    [
      'undefined',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'non-numeric string',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'true',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "boolean"}'
    ], // changes when the read is decoded
    [
      'fraction',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'negative bigint',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "bigint"}'
    ], // changes when the read is decoded
    [
      'unsafe number',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'NaN',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'one-element array',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "object"}'
    ] // changes when the read is decoded
  ]
});

// --- the exit queue ------------------------------------------------------------------------------

/** The gas limit the queue sizes feed into; `value 1071000n` is the 21000 estimate plus three exits. */
const GAS_LIMIT_READS = ({ answer }: { answer: (raw: unknown) => ReadAnswers }): TableRead[] => [
  {
    name: 'erc20.getCompleteWithdrawGasLimit',
    run: async (raw) =>
      (await answering(answer(raw))).plasma.parent.erc20(TOKEN).getCompleteWithdrawGasLimit({
        from: USER
      })
  },
  {
    name: 'client.getProcessExitsGasLimit',
    run: async (raw) =>
      (await answering(answer(raw))).plasma.getProcessExitsGasLimit(
        { tokens: [TOKEN] },
        { from: USER }
      )
  }
];

registerTable({
  title: 'exitsQueues answers the queue address, and the zero address means nothing is queued',
  reads: GAS_LIMIT_READS({ answer: (raw) => ({ exitsQueues: raw }) }),
  shapes: addressShapes(PLASMA_QUEUE),
  rows: [
    ['matching address', 'value 1071000n'],
    ['matching address, upper-case hex', 'value 1071000n'],
    ['other address', 'value 1071000n'],
    ['zero address', 'threw ExitError > ExitQueueEmptyError'],
    [
      'undefined',
      'threw ExitError > BridgeEventDecodeFailedError {field: "exitsQueues.0", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw ExitError > BridgeEventDecodeFailedError {field: "exitsQueues.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'number',
      'threw ExitError > BridgeEventDecodeFailedError {field: "exitsQueues.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw ExitError > BridgeEventDecodeFailedError {field: "exitsQueues.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw ExitError > BridgeEventDecodeFailedError {field: "exitsQueues.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'non-hex string',
      'threw ExitError > BridgeEventDecodeFailedError {field: "exitsQueues.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'short hex',
      'threw ExitError > BridgeEventDecodeFailedError {field: "exitsQueues.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'bytes32 hex',
      'threw ExitError > BridgeEventDecodeFailedError {field: "exitsQueues.0", valueType: "string"}'
    ] // changes when the read is decoded
  ]
});

registerTable({
  title: 'currentSize goes through BigInt',
  reads: GAS_LIMIT_READS({ answer: (raw) => ({ currentSize: raw }) }),
  shapes: INTEGER_SHAPES,
  rows: [
    ['bigint', 'value 1771000n'],
    ['decimal string', 'value 1771000n'],
    ['hex string', 'value 1771000n'],
    ['BigNumber', 'value 1771000n'],
    ['number', 'value 1771000n'],
    [
      'undefined',
      'threw ExitError > BridgeEventDecodeFailedError {field: "currentSize.0", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw ExitError > BridgeEventDecodeFailedError {field: "currentSize.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw ExitError > BridgeEventDecodeFailedError {field: "currentSize.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'non-numeric string',
      'threw ExitError > BridgeEventDecodeFailedError {field: "currentSize.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw ExitError > BridgeEventDecodeFailedError {field: "currentSize.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'true',
      'threw ExitError > BridgeEventDecodeFailedError {field: "currentSize.0", valueType: "boolean"}'
    ], // changes when the read is decoded
    [
      'fraction',
      'threw ExitError > BridgeEventDecodeFailedError {field: "currentSize.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'negative bigint',
      'threw ExitError > BridgeEventDecodeFailedError {field: "currentSize.0", valueType: "bigint"}'
    ], // changes when the read is decoded
    [
      'unsafe number',
      'threw ExitError > BridgeEventDecodeFailedError {field: "currentSize.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'NaN',
      'threw ExitError > BridgeEventDecodeFailedError {field: "currentSize.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'one-element array',
      'threw ExitError > BridgeEventDecodeFailedError {field: "currentSize.0", valueType: "object"}'
    ] // changes when the read is decoded
  ]
});

// --- the finalize gas limit -----------------------------------------------------------------------

const withoutConstant =
  (name: string, extra: object): (() => never) =>
  () => {
    throw Object.assign(new Error(name), extra);
  };

const FINALIZE_SHAPES: Readonly<Record<string, unknown>> = {
  ...integerShapes(300_000n),
  'a limit the sent gas cannot cover': 900_000,
  'viem: the call returned no data': withoutConstant('zero data', {
    name: 'ContractFunctionZeroDataError'
  }),
  'ethers: CALL_EXCEPTION with no revert data': withoutConstant('call exception', {
    code: 'CALL_EXCEPTION'
  }),
  'a node error that is not a missing constant': withoutConstant('boom', { code: 'SERVER_ERROR' })
};

registerTable({
  title: 'malformed ON_FINALIZE_GAS_LIMIT rejects, no fallback',
  reads: [
    {
      name: 'erc20.prepareCompleteWithdraw with an explicit gas limit',
      project: () => 'prepared',
      run: async (raw) =>
        (await answering({ ON_FINALIZE_GAS_LIMIT: raw })).plasma.parent
          .erc20(TOKEN)
          .prepareCompleteWithdraw({ gasLimit: 900_000n })
    },
    {
      name: 'client.prepareProcessExits with an explicit gas limit',
      project: () => 'prepared',
      run: async (raw) =>
        (await answering({ ON_FINALIZE_GAS_LIMIT: raw })).plasma.prepareProcessExits(
          { tokens: [TOKEN] },
          { gasLimit: 900_000n }
        )
    }
  ],
  shapes: FINALIZE_SHAPES,
  rows: [
    ['bigint', 'value prepared'],
    ['decimal string', 'value prepared'],
    ['hex string', 'value prepared'],
    ['BigNumber', 'value prepared'],
    ['number', 'value prepared'],
    [
      'undefined',
      'threw ExitError > BridgeEventDecodeFailedError {field: "ON_FINALIZE_GAS_LIMIT.0", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw ExitError > BridgeEventDecodeFailedError {field: "ON_FINALIZE_GAS_LIMIT.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw ExitError > BridgeEventDecodeFailedError {field: "ON_FINALIZE_GAS_LIMIT.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'non-numeric string',
      'threw ExitError > BridgeEventDecodeFailedError {field: "ON_FINALIZE_GAS_LIMIT.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw ExitError > BridgeEventDecodeFailedError {field: "ON_FINALIZE_GAS_LIMIT.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'true',
      'threw ExitError > BridgeEventDecodeFailedError {field: "ON_FINALIZE_GAS_LIMIT.0", valueType: "boolean"}'
    ], // changes when the read is decoded
    [
      'fraction',
      'threw ExitError > BridgeEventDecodeFailedError {field: "ON_FINALIZE_GAS_LIMIT.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'negative bigint',
      'threw ExitError > BridgeEventDecodeFailedError {field: "ON_FINALIZE_GAS_LIMIT.0", valueType: "bigint"}'
    ], // changes when the read is decoded
    [
      'unsafe number',
      'threw ExitError > BridgeEventDecodeFailedError {field: "ON_FINALIZE_GAS_LIMIT.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'NaN',
      'threw ExitError > BridgeEventDecodeFailedError {field: "ON_FINALIZE_GAS_LIMIT.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'one-element array',
      'threw ExitError > BridgeEventDecodeFailedError {field: "ON_FINALIZE_GAS_LIMIT.0", valueType: "object"}'
    ], // changes when the read is decoded
    ['a limit the sent gas cannot cover', 'threw ExitError > ExitGasLimitTooLowError'],
    ['viem: the call returned no data', 'value prepared'],
    ['ethers: CALL_EXCEPTION with no revert data', 'value prepared'],
    ['a node error that is not a missing constant', 'threw Error']
  ]
});

describe('the finalize gas limit fallback', () => {
  it('is used only when the contract answered without the constant', async () => {
    const outcome = await outcomeOf({
      project: () => 'prepared',
      run: async () =>
        (
          await answering({
            ON_FINALIZE_GAS_LIMIT: FINALIZE_SHAPES['viem: the call returned no data']
          })
        ).plasma.parent
          .erc20(TOKEN)
          .prepareCompleteWithdraw({ gasLimit: 330_000n })
    });
    // 300,000 is the fallback; 330,000 is exactly the floor it implies, so the
    // limit passes only if the fallback was used.
    expect(outcome).equals('value prepared');
  });

  it('is not used for a malformed answer', async () => {
    const outcome = await outcomeOf({
      run: async () =>
        (await answering({ ON_FINALIZE_GAS_LIMIT: 'abc' })).plasma.parent
          .erc20(TOKEN)
          .prepareCompleteWithdraw({ gasLimit: 330_000n })
    });
    expect(outcome).not.equals('value prepared');
  });
});

// --- the exit token's existence --------------------------------------------------------------------

const statusLine = (v: unknown): string => {
  const s = v as { exited: boolean; reason?: string };
  return s.exited ? 'exited' : `not exited (${s.reason ?? '?'})`;
};

const STATUS_PARAMS = { burnTxHash: PLASMA_STATUS.burn, confirmTxHash: PLASMA_STATUS.confirm };

const statusReads = ({ answer }: { answer: (raw: unknown) => ReadAnswers }): TableRead[] => [
  {
    name: 'erc20.getWithdrawStatus',
    project: statusLine,
    run: async (raw) =>
      (await plasmaWorld({ status: true, answers: answer(raw) })).plasma.parent
        .erc20(PLASMA_ADDRESSES.PolToken)
        .getWithdrawStatus(STATUS_PARAMS)
  },
  {
    name: 'client.getWithdrawStatus',
    project: statusLine,
    run: async (raw) =>
      (await plasmaWorld({ status: true, answers: answer(raw) })).plasma.getWithdrawStatus(
        STATUS_PARAMS
      )
  }
];

/** Named for the read they feed, so a table row says which answer it is. */
const EXISTS_SHAPES: Readonly<Record<string, unknown>> = {
  'exists: true': true,
  'exists: false': false,
  'exists: string "false"': 'false',
  'exists: string "true"': 'true',
  'exists: number 0': 0,
  'exists: number 1': 1,
  'exists: undefined': undefined,
  'exists: null': null,
  'exists: empty object': {},
  'exists: empty string': ''
};

registerTable({
  title: 'the exit status reads whether the exit token exists (exists)',
  reads: statusReads({ answer: (raw) => ({ exists: raw }) }),
  shapes: EXISTS_SHAPES,
  rows: [
    ['exists: true', 'value not exited (ready-to-process)'],
    ['exists: false', 'value exited'],
    ['exists: string "false"', 'value not exited (ready-to-process)'], // changes when the read is decoded
    ['exists: string "true"', 'value not exited (ready-to-process)'], // changes when the read is decoded
    ['exists: number 0', 'value not exited (ready-to-process)'], // changes when the read is decoded
    ['exists: number 1', 'value not exited (ready-to-process)'], // changes when the read is decoded
    ['exists: undefined', 'value not exited (ready-to-process)'], // changes when the read is decoded
    ['exists: null', 'value not exited (ready-to-process)'], // changes when the read is decoded
    ['exists: empty object', 'value not exited (ready-to-process)'], // changes when the read is decoded
    ['exists: empty string', 'value not exited (ready-to-process)'] // changes when the read is decoded
  ]
});

registerTable({
  title: 'the exit status reads the last checkpointed block through BigInt',
  reads: statusReads({ answer: (raw) => ({ getLastChildBlock: raw }) }),
  shapes: integerShapes(100n),
  rows: [
    ['bigint', 'value not exited (ready-to-process)'],
    ['decimal string', 'value not exited (ready-to-process)'],
    ['hex string', 'value not exited (ready-to-process)'],
    ['BigNumber', 'value not exited (ready-to-process)'],
    ['number', 'value not exited (ready-to-process)'],
    [
      'undefined',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "getLastChildBlock.0", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "getLastChildBlock.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "getLastChildBlock.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'non-numeric string',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "getLastChildBlock.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "getLastChildBlock.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'true',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "getLastChildBlock.0", valueType: "boolean"}'
    ], // changes when the read is decoded
    [
      'fraction',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "getLastChildBlock.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'negative bigint',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "getLastChildBlock.0", valueType: "bigint"}'
    ], // changes when the read is decoded
    [
      'unsafe number',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "getLastChildBlock.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'NaN',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "getLastChildBlock.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'one-element array',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "getLastChildBlock.0", valueType: "object"}'
    ] // changes when the read is decoded
  ]
});
