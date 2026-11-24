import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Hex } from '../../src/adapter.ts';
import type { PosWorldOptions, ReadAnswers, TableRead } from './contract-call-harness.ts';

import { noopLogger } from '../../src/logger.ts';
import { RootChain } from '../../src/pos/root_chain.ts';
import {
  addressShapes,
  ADDRESSES,
  BOOLEAN_SHAPES,
  failedDelivery,
  HASH_RECORD,
  hex32,
  integerShapes,
  INTEGER_SHAPES,
  OTHER,
  PAYLOAD_RECORD,
  posWorld,
  receiptOf,
  RecordingAdapter,
  registerTable,
  RequestLog,
  USER
} from './contract-call-harness.ts';

/**
 * What the PoS reads do with every shape a contract call can come back in.
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

const ERC20: Hex = '0x00000000000000000000000000000000000000c1';
const ERC721: Hex = '0x00000000000000000000000000000000000000c2';
const ERC1155: Hex = '0x00000000000000000000000000000000000000c3';
const ERC20_BURN = 'erc20-burn-1.json';
const ERC721_BURN = 'erc721-burn-1.json';
const ERC1155_BURN = 'erc1155-burn-1.json';

const burnHash = (file: string): string =>
  (
    JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'fixtures', 'exits', file), 'utf8')
    ) as { burnTxHash: string }
  ).burnTxHash;

/** A PoS world whose parent chain answers `answers` and everything else well formed. */
const answering = async (answers: ReadAnswers, rest: PosWorldOptions = {}) =>
  posWorld({
    ...rest,
    parent: { ...rest.parent, answers: { ...rest.parent?.answers, ...answers } }
  });

const rootChainOn = (answers: ReadAnswers): RootChain =>
  new RootChain({
    adapter: new RecordingAdapter({
      side: 'parent',
      log: new RequestLog(),
      answers: { currentHeaderBlock: 20_000n, ...answers }
    }),
    chainId: 1,
    getAddress: () => Promise.resolve(ADDRESSES.RootChain),
    logger: noopLogger
  });

// --- integers read through BigInt(...) ---------------------------------------------

const BIGINT_READS: TableRead[] = [
  {
    name: 'erc20.getBalance',
    field: 'balanceOf.0',
    run: async (raw) =>
      (await answering({ balanceOf: raw })).pos.parent.erc20(ERC20).getBalance(USER)
  },
  {
    name: 'erc20.getAllowance',
    field: 'allowance.0',
    run: async (raw) =>
      (await answering({ allowance: raw })).pos.parent
        .erc20(ERC20)
        .getAllowance(USER, { spenderAddress: OTHER })
  },
  {
    name: 'erc721.getTokenIdAtIndexForUser',
    field: 'tokenOfOwnerByIndex.0',
    run: async (raw) =>
      (await answering({ tokenOfOwnerByIndex: raw })).pos.parent
        .erc721(ERC721)
        .getTokenIdAtIndexForUser(0, USER)
  },
  {
    name: 'erc1155.getBalance',
    field: 'balanceOf.0',
    run: async (raw) =>
      (await answering({ balanceOf: raw })).pos.parent.erc1155(ERC1155).getBalance(USER, 1n)
  },
  {
    name: 'rootChain.getLastChildBlock',
    field: 'getLastChildBlock.0',
    run: (raw) => rootChainOn({ getLastChildBlock: raw }).getLastChildBlock()
  }
];

registerTable({
  title: 'an integer read through BigInt',
  reads: BIGINT_READS.slice(0, 4),
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

registerTable({
  title: 'an integer read through BigInt, on the root chain',
  reads: BIGINT_READS.slice(4),
  shapes: INTEGER_SHAPES,
  rows: [
    ['bigint', 'value 5n'],
    ['decimal string', 'value 5n'],
    ['hex string', 'value 5n'],
    ['BigNumber', 'value 5n'],
    ['number', 'value 5n'],
    [
      'undefined',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'non-numeric string',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'true',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "boolean"}'
    ], // changes when the read is decoded
    [
      'fraction',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'negative bigint',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "bigint"}'
    ], // changes when the read is decoded
    [
      'unsafe number',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'NaN',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'one-element array',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "object"}'
    ] // changes when the read is decoded
  ]
});

registerTable({
  title: 'erc721.getTokensCount reads its integer through Number',
  reads: [
    {
      name: 'erc721.getTokensCount',
      run: async (raw) =>
        (await answering({ balanceOf: raw })).pos.parent.erc721(ERC721).getTokensCount(USER)
    }
  ],
  shapes: INTEGER_SHAPES,
  rows: [
    ['bigint', 'value 5'],
    ['decimal string', 'value 5'],
    ['hex string', 'value 5'],
    ['BigNumber', 'value 5'],
    ['number', 'value 5'],
    [
      'undefined',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'non-numeric string',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'true',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "boolean"}'
    ], // changes when the read is decoded
    [
      'fraction',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'negative bigint',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "bigint"}'
    ], // changes when the read is decoded
    [
      'unsafe number',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'NaN',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'one-element array',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "object"}'
    ] // changes when the read is decoded
  ]
});

registerTable({
  title: 'erc721.getAllTokens counts through Number and caps at the limit',
  reads: [
    {
      name: 'erc721.getAllTokens',
      run: async (raw) =>
        (await answering({ balanceOf: raw })).pos.parent.erc721(ERC721).getAllTokens(USER, 3)
    }
  ],
  shapes: INTEGER_SHAPES,
  rows: [
    ['bigint', 'value [42n, 42n, 42n]'],
    ['decimal string', 'value [42n, 42n, 42n]'],
    ['hex string', 'value [42n, 42n, 42n]'],
    ['BigNumber', 'value [42n, 42n, 42n]'],
    ['number', 'value [42n, 42n, 42n]'],
    [
      'undefined',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'non-numeric string',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'true',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "boolean"}'
    ], // changes when the read is decoded
    [
      'fraction',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'negative bigint',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "bigint"}'
    ], // changes when the read is decoded
    [
      'unsafe number',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'NaN',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'one-element array',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "balanceOf.0", valueType: "object"}'
    ] // changes when the read is decoded
  ]
});

// --- booleans -----------------------------------------------------------------------

registerTable({
  title: 'a boolean read is returned as it came',
  reads: [
    {
      name: 'erc721.isApprovedAll',
      field: 'isApprovedForAll.0',
      run: async (raw) =>
        (await answering({ isApprovedForAll: raw })).pos.parent.erc721(ERC721).isApprovedAll(USER)
    },
    {
      name: 'erc1155.isApprovedAll',
      field: 'isApprovedForAll.0',
      run: async (raw) =>
        (await answering({ isApprovedForAll: raw })).pos.parent.erc1155(ERC1155).isApprovedAll(USER)
    }
  ],
  shapes: BOOLEAN_SHAPES,
  rows: [
    ['true', 'value true'],
    ['false', 'value false'],
    [
      'string "true"',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'string "false"',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'number 1',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'number 0',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "number"}'
    ], // changes when the read is decoded
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
      'empty string',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "{field}", valueType: "string"}'
    ] // changes when the read is decoded
  ]
});

registerTable({
  title: 'a boolean read is returned as it came, on the root chain manager',
  reads: [
    {
      name: 'rootChainManager.isExitProcessed',
      field: 'processedExits.0',
      run: async (raw) =>
        (await answering({ processedExits: raw })).pos.rootChainManager.isExitProcessed(hex32(1n))
    }
  ],
  shapes: BOOLEAN_SHAPES,
  rows: [
    ['true', 'value true'],
    ['false', 'value false'],
    [
      'string "true"',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "{field}", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'string "false"',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "{field}", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'number 1',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "{field}", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'number 0',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "{field}", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'undefined',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "{field}", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "{field}", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "{field}", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "{field}", valueType: "string"}'
    ] // changes when the read is decoded
  ]
});

// --- addresses -----------------------------------------------------------------------

registerTable({
  title: 'erc721.isApproved compares the approved address with the predicate',
  reads: [
    {
      name: 'erc721.isApproved',
      run: async (raw) =>
        (
          await answering({ getApproved: raw, typeToPredicate: ADDRESSES.ERC721Predicate })
        ).pos.parent
          .erc721(ERC721)
          .isApproved(8n)
    }
  ],
  shapes: addressShapes(ADDRESSES.ERC721Predicate),
  rows: [
    ['matching address', 'value true'],
    ['matching address, upper-case hex', 'value true'],
    ['other address', 'value false'],
    ['zero address', 'value false'],
    [
      'undefined',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "getApproved.0", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "getApproved.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'number',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "getApproved.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "getApproved.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "getApproved.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'non-hex string',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "getApproved.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'short hex',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "getApproved.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'bytes32 hex',
      'threw TokenReadError > BridgeEventDecodeFailedError {field: "getApproved.0", valueType: "string"}'
    ] // changes when the read is decoded
  ]
});

const TYPE_SHAPES: Readonly<Record<string, unknown>> = {
  'registered type': hex32(1n),
  'zero type': hex32(0n),
  undefined: undefined,
  null: null,
  'empty string': '',
  'empty object': {},
  'short hex': '0x01',
  'non-hex string': 'abc',
  'bigint 1': 1n,
  'number 0': 0
};

registerTable({
  title: 'getPredicateAddress reads the token type',
  reads: [
    {
      name: 'pos.getPredicateAddress',
      run: async (raw) => (await answering({ tokenToType: raw })).pos.getPredicateAddress(ERC20)
    }
  ],
  shapes: TYPE_SHAPES,
  rows: [
    ['registered type', 'value "0x2222222222222222222222222222222222222222"'],
    ['zero type', 'threw AddressLookupError > InvalidTokenTypeError'],
    [
      'undefined',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "tokenToType.0", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "tokenToType.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "tokenToType.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "tokenToType.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'short hex',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "tokenToType.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'non-hex string',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "tokenToType.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'bigint 1',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "tokenToType.0", valueType: "bigint"}'
    ], // changes when the read is decoded
    [
      'number 0',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "tokenToType.0", valueType: "number"}'
    ] // changes when the read is decoded
  ]
});

registerTable({
  title: 'getPredicateAddress reads the predicate and checks it against the index',
  reads: [
    {
      name: 'pos.getPredicateAddress',
      run: async (raw) => (await answering({ typeToPredicate: raw })).pos.getPredicateAddress(ERC20)
    }
  ],
  shapes: addressShapes(ADDRESSES.ERC20Predicate),
  rows: [
    ['matching address', 'value "0x2222222222222222222222222222222222222222"'],
    ['matching address, upper-case hex', 'value "0x2222222222222222222222222222222222222222"'],
    ['other address', 'threw AddressLookupError > UntrustedPredicateError'],
    ['zero address', 'threw AddressLookupError > UntrustedPredicateError'],
    [
      'undefined',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "typeToPredicate.0", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "typeToPredicate.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'number',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "typeToPredicate.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "typeToPredicate.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "typeToPredicate.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'non-hex string',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "typeToPredicate.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'short hex',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "typeToPredicate.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'bytes32 hex',
      'threw AddressLookupError > BridgeEventDecodeFailedError {field: "typeToPredicate.0", valueType: "string"}'
    ] // changes when the read is decoded
  ]
});

// --- the exit status, replayed from recorded burns ------------------------------------

const statusLine = (v: unknown): string => {
  const s = v as { exited: boolean; reason?: string };
  return s.exited ? 'exited' : `not exited (${s.reason ?? '?'})`;
};

const statusReads = ({ answer }: { answer: (raw: unknown) => ReadAnswers }): TableRead[] => [
  {
    name: 'pos.getWithdrawStatus',
    project: statusLine,
    run: async (raw) => {
      const burn = JSON.parse(
        readFileSync(join(import.meta.dirname, '..', 'fixtures', 'exits', ERC20_BURN), 'utf8')
      ) as { eventSignature: string };
      return (await answering(answer(raw), { cassette: ERC20_BURN })).pos.getWithdrawStatus(
        burnHash(ERC20_BURN),
        burn.eventSignature
      );
    }
  },
  {
    name: 'erc20.getWithdrawExitStatus',
    project: statusLine,
    run: async (raw) =>
      (await answering(answer(raw), { cassette: ERC20_BURN })).pos.parent
        .erc20(ERC20)
        .getWithdrawExitStatus(burnHash(ERC20_BURN))
  },
  {
    name: 'erc721.getWithdrawExitStatus',
    project: statusLine,
    run: async (raw) =>
      (await answering(answer(raw), { cassette: ERC721_BURN })).pos.parent
        .erc721(ERC721)
        .getWithdrawExitStatus(burnHash(ERC721_BURN))
  },
  {
    name: 'erc1155.getWithdrawExitStatus',
    project: statusLine,
    run: async (raw) =>
      (await answering(answer(raw), { cassette: ERC1155_BURN })).pos.parent
        .erc1155(ERC1155)
        .getWithdrawExitStatus(burnHash(ERC1155_BURN))
  }
];

registerTable({
  title: 'the exit status reads processedExits for its answer',
  reads: statusReads({ answer: (raw) => ({ processedExits: raw }) }),
  shapes: BOOLEAN_SHAPES,
  rows: [
    ['true', 'value exited'],
    ['false', 'value not exited (not-exited)'],
    [
      'string "true"',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "processedExits.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'string "false"',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "processedExits.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'number 1',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "processedExits.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'number 0',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "processedExits.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'undefined',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "processedExits.0", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "processedExits.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "processedExits.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "processedExits.0", valueType: "string"}'
    ] // changes when the read is decoded
  ]
});

registerTable({
  title: 'the exit status reads the last checkpointed block to decide it is checkpointed',
  reads: statusReads({ answer: (raw) => ({ getLastChildBlock: raw, processedExits: false }) }),
  shapes: integerShapes(200_000_000n),
  rows: [
    ['bigint', 'value not exited (not-exited)'],
    ['decimal string', 'value not exited (not-exited)'],
    ['hex string', 'value not exited (not-exited)'],
    ['BigNumber', 'value not exited (not-exited)'],
    ['number', 'value not exited (not-exited)'],
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

// --- the checkpoint search ------------------------------------------------------------

const HEADER: Readonly<Record<string, unknown>> = {
  'positional array': [hex32(0x11n), 1n, 1_000_000n, 1n, OTHER],
  'array with BigNumber start and end': [
    hex32(0x11n),
    integerShapes(1n)['BigNumber'],
    integerShapes(1_000_000n)['BigNumber'],
    1n,
    OTHER
  ],
  'array with decimal strings': [hex32(0x11n), '1', '1000000', 1n, OTHER],
  'array that also carries names': Object.assign([hex32(0x11n), 1n, 1_000_000n, 1n, OTHER], {
    start: 1n,
    end: 1_000_000n
  }),
  'named object': { start: 1n, end: 1_000_000n },
  'array of three': [hex32(0x11n), 1n, 1_000_000n],
  'array of two': [hex32(0x11n), 1n],
  'empty array': [],
  'array with a non-numeric start': [hex32(0x11n), 'abc', 1_000_000n, 1n, OTHER],
  'array with an undefined end': [hex32(0x11n), 1n, undefined, 1n, OTHER],
  'array with an object end': [hex32(0x11n), 1n, {}, 1n, OTHER],
  'array with a boolean start': [hex32(0x11n), true, 1_000_000n, 1n, OTHER],
  'object missing end': { start: 1n },
  'plain bigint': 5n,
  string: 'abc',
  undefined: undefined,
  null: null
};

registerTable({
  title: 'findRootBlockFromChild reads the current header block through BigInt',
  reads: [
    {
      name: 'rootChain.findRootBlockFromChild',
      run: (raw) =>
        rootChainOn({
          currentHeaderBlock: raw,
          headerBlocks: HEADER['positional array']
        }).findRootBlockFromChild(500_000n)
    }
  ],
  shapes: integerShapes(20_000n),
  rows: [
    ['bigint', 'value 10000n'],
    ['decimal string', 'value 10000n'],
    ['hex string', 'value 10000n'],
    ['BigNumber', 'value 10000n'],
    ['number', 'value 10000n'],
    [
      'undefined',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "currentHeaderBlock.0", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "currentHeaderBlock.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "currentHeaderBlock.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'non-numeric string',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "currentHeaderBlock.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "currentHeaderBlock.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'true',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "currentHeaderBlock.0", valueType: "boolean"}'
    ], // changes when the read is decoded
    [
      'fraction',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "currentHeaderBlock.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'negative bigint',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "currentHeaderBlock.0", valueType: "bigint"}'
    ], // changes when the read is decoded
    [
      'unsafe number',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "currentHeaderBlock.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'NaN',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "currentHeaderBlock.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'one-element array',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "currentHeaderBlock.0", valueType: "object"}'
    ] // changes when the read is decoded
  ]
});

registerTable({
  title: 'findRootBlockFromChild reads each header block through parseHeaderBlocksResult',
  reads: [
    {
      name: 'rootChain.findRootBlockFromChild',
      run: (raw) => rootChainOn({ headerBlocks: raw }).findRootBlockFromChild(500_000n)
    }
  ],
  shapes: HEADER,
  rows: [
    ['positional array', 'value 10000n'],
    ['array with BigNumber start and end', 'value 10000n'],
    ['array with decimal strings', 'value 10000n'],
    ['array that also carries names', 'value 10000n'],
    [
      'named object',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "headerBlocks", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'array of three',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "headerBlocks", length: 3, minLength: 5}'
    ], // changes when the read is decoded
    [
      'array of two',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "headerBlocks", length: 2, minLength: 5}'
    ], // changes when the read is decoded
    [
      'empty array',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "headerBlocks", length: 0, minLength: 5}'
    ], // changes when the read is decoded
    [
      'array with a non-numeric start',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "headerBlocks.start", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'array with an undefined end',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "headerBlocks.end", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'array with an object end',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "headerBlocks.end", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'array with a boolean start',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "headerBlocks.start", valueType: "boolean"}'
    ], // changes when the read is decoded
    [
      'object missing end',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "headerBlocks", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'plain bigint',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "headerBlocks", valueType: "bigint"}'
    ], // changes when the read is decoded
    [
      'string',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "headerBlocks", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'undefined',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "headerBlocks", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw CheckpointReadError > BridgeEventDecodeFailedError {field: "headerBlocks", valueType: "object"}'
    ] // changes when the read is decoded
  ]
});

// --- the deposit status ---------------------------------------------------------------

const depositLine = (v: unknown): string => {
  const s = v as { deposited: boolean; reason?: string; record?: string; replayable?: boolean };
  if (s.deposited) return 'deposited';
  return s.reason === 'delivery-failed'
    ? `delivery-failed (${s.record ?? '?'} record, replayable ${String(s.replayable)})`
    : `not deposited (${s.reason ?? '?'})`;
};

const depositWorld = async ({
  record,
  answers
}: {
  record: typeof HASH_RECORD;
  answers: ReadAnswers;
}) => {
  const failed = failedDelivery(record);
  return posWorld({
    parent: { receipts: { [record.transactionHash]: receiptOf(record) } },
    child: { answers: { ...failed.answers, ...answers } }
  });
};

registerTable({
  title: 'getDepositStatus compares the state id with lastStateId through BigInt',
  reads: [
    {
      name: 'pos.getDepositStatus',
      project: depositLine,
      run: async (raw) =>
        (
          await depositWorld({ record: HASH_RECORD, answers: { lastStateId: raw } })
        ).pos.getDepositStatus(HASH_RECORD.transactionHash)
    }
  ],
  shapes: integerShapes(99_999_999n),
  rows: [
    ['bigint', 'value delivery-failed (hash record, replayable true)'],
    ['decimal string', 'value delivery-failed (hash record, replayable true)'],
    ['hex string', 'value delivery-failed (hash record, replayable true)'],
    ['BigNumber', 'value delivery-failed (hash record, replayable true)'],
    ['number', 'value delivery-failed (hash record, replayable true)'],
    [
      'undefined',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "lastStateId.0", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "lastStateId.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "lastStateId.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'non-numeric string',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "lastStateId.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "lastStateId.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'true',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "lastStateId.0", valueType: "boolean"}'
    ], // changes when the read is decoded
    [
      'fraction',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "lastStateId.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'negative bigint',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "lastStateId.0", valueType: "bigint"}'
    ], // changes when the read is decoded
    [
      'unsafe number',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "lastStateId.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'NaN',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "lastStateId.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'one-element array',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "lastStateId.0", valueType: "object"}'
    ] // changes when the read is decoded
  ]
});

const HASH32_SHAPES: Readonly<Record<string, unknown>> = {
  'zero hash': hex32(0n),
  'the record hash': HASH_RECORD.childFailedStateSyncHash,
  'another hash': hex32(0xabcdn),
  undefined: undefined,
  null: null,
  'empty string': '',
  'empty object': {},
  'short hex': '0x01',
  'non-hex string': 'abc',
  'number 0': 0,
  'bigint 0': 0n
};

registerTable({
  title: 'getDepositStatus reads failedStateSyncHashes through BigInt',
  reads: [
    {
      name: 'pos.getDepositStatus',
      project: depositLine,
      run: async (raw) =>
        (
          await depositWorld({
            record: HASH_RECORD,
            answers: { failedStateSyncHashes: raw, failedStateSyncs: '0x' }
          })
        ).pos.getDepositStatus(HASH_RECORD.transactionHash)
    }
  ],
  shapes: HASH32_SHAPES,
  rows: [
    ['zero hash', 'value deposited'],
    ['the record hash', 'value delivery-failed (hash record, replayable true)'],
    ['another hash', 'value delivery-failed (hash record, replayable false)'],
    [
      'undefined',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "failedStateSyncHashes.0", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "failedStateSyncHashes.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "failedStateSyncHashes.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "failedStateSyncHashes.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'short hex',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "failedStateSyncHashes.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'non-hex string',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "failedStateSyncHashes.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'number 0',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "failedStateSyncHashes.0", valueType: "number"}'
    ], // changes when the read is decoded
    [
      'bigint 0',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "failedStateSyncHashes.0", valueType: "bigint"}'
    ] // changes when the read is decoded
  ]
});

const BYTES_SHAPES: Readonly<Record<string, unknown>> = {
  'empty bytes': '0x',
  'the record payload': PAYLOAD_RECORD.childFailedStateSyncPayload,
  'other bytes': '0x1234',
  undefined: undefined,
  null: null,
  'empty string': '',
  'empty object': {},
  'odd-length hex': '0x123',
  'non-hex string': 'zz',
  'number 0': 0
};

registerTable({
  title: 'getDepositStatus reads failedStateSyncs and tests it against 0x',
  reads: [
    {
      name: 'pos.getDepositStatus',
      project: depositLine,
      run: async (raw) =>
        (
          await depositWorld({
            record: PAYLOAD_RECORD,
            answers: { failedStateSyncHashes: hex32(0n), failedStateSyncs: raw }
          })
        ).pos.getDepositStatus(PAYLOAD_RECORD.transactionHash)
    }
  ],
  shapes: BYTES_SHAPES,
  rows: [
    ['empty bytes', 'value deposited'],
    ['the record payload', 'value delivery-failed (payload record, replayable true)'],
    ['other bytes', 'value delivery-failed (payload record, replayable false)'],
    [
      'undefined',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "failedStateSyncs.0", valueType: "undefined"}'
    ], // changes when the read is decoded
    [
      'null',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "failedStateSyncs.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'empty string',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "failedStateSyncs.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'empty object',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "failedStateSyncs.0", valueType: "object"}'
    ], // changes when the read is decoded
    [
      'odd-length hex',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "failedStateSyncs.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'non-hex string',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "failedStateSyncs.0", valueType: "string"}'
    ], // changes when the read is decoded
    [
      'number 0',
      'threw BridgeStatusError > BridgeEventDecodeFailedError {field: "failedStateSyncs.0", valueType: "number"}'
    ] // changes when the read is decoded
  ]
});
