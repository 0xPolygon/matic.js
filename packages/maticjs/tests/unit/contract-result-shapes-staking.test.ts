import type { ReadAnswers, Row, TableRead } from './contract-call-harness.ts';

import {
  addressShapes,
  BOOLEAN_SHAPES,
  integerShapes,
  INTEGER_SHAPES,
  registerTable,
  STAKING_ADDRESSES,
  STAKING_ANSWERS,
  stakingWorld,
  USER,
  VALIDATOR_SHARE
} from './contract-call-harness.ts';

/**
 * What the staking reads do with every shape a contract call can come back in.
 *
 * Each table pins the outcome for each shape, well formed or not: the value a
 * public method returns, or the class it throws (and, for the SDK's own
 * errors, the `info` that names the field). A shape the ABI describes comes
 * back as the SDK value; a shape it does not describe is rejected with an SDK
 * error that names the method and field, before any other code sees it. The
 * rows are the specification of that check, so a row changes only when the
 * check does.
 */

const answering = (answers: ReadAnswers) => stakingWorld({ ...STAKING_ANSWERS, ...answers });
const share = async (answers: ReadAnswers) =>
  (await answering(answers)).staking.validatorShare(VALIDATOR_SHARE);

// --- single integers --------------------------------------------------------------------

const scalar = ({
  name,
  field,
  run
}: {
  name: string;
  field: string;
  run: (raw: unknown) => Promise<unknown>;
}): TableRead => ({ name, field, run });

const INTEGER_READS: TableRead[] = [
  scalar({
    name: 'stakeManager.getValidatorId',
    field: 'getValidatorId',
    run: async (raw) =>
      (await answering({ getValidatorId: raw })).staking.stakeManager.getValidatorId({ user: USER })
  }),
  scalar({
    name: 'stakeManager.getDelegatedAmount',
    field: 'delegatedAmount',
    run: async (raw) =>
      (await answering({ delegatedAmount: raw })).staking.stakeManager.getDelegatedAmount({
        validatorId: 1n
      })
  }),
  scalar({
    name: 'stakeManager.getValidatorStake',
    field: 'validatorStake',
    run: async (raw) =>
      (await answering({ validatorStake: raw })).staking.stakeManager.getValidatorStake({
        validatorId: 1n
      })
  }),
  scalar({
    name: 'stakeManager.getMinDeposit',
    field: 'minDeposit',
    run: async (raw) => (await answering({ minDeposit: raw })).staking.stakeManager.getMinDeposit()
  }),
  scalar({
    name: 'stakeManager.getMinHeimdallFee',
    field: 'minHeimdallFee',
    run: async (raw) =>
      (await answering({ minHeimdallFee: raw })).staking.stakeManager.getMinHeimdallFee()
  }),
  scalar({
    name: 'stakeManager.getWithdrawalDelay',
    field: 'WITHDRAWAL_DELAY',
    run: async (raw) =>
      (await answering({ WITHDRAWAL_DELAY: raw })).staking.stakeManager.getWithdrawalDelay()
  }),
  scalar({
    name: 'stakeManager.getCheckpointReward',
    field: 'CHECKPOINT_REWARD',
    run: async (raw) =>
      (await answering({ CHECKPOINT_REWARD: raw })).staking.stakeManager.getCheckpointReward()
  }),
  scalar({
    name: 'stakeManager.getCurrentEpoch',
    field: 'currentEpoch',
    run: async (raw) =>
      (await answering({ currentEpoch: raw })).staking.stakeManager.getCurrentEpoch()
  }),
  scalar({
    name: 'stakeManager.getTotalStaked',
    field: 'currentValidatorSetTotalStake',
    run: async (raw) =>
      (
        await answering({ currentValidatorSetTotalStake: raw })
      ).staking.stakeManager.getTotalStaked()
  }),
  scalar({
    name: 'validatorShare.getExchangeRate',
    field: 'exchangeRate',
    run: async (raw) => (await share({ exchangeRate: raw })).getExchangeRate()
  }),
  scalar({
    name: 'validatorShare.getLiquidRewards',
    field: 'getLiquidRewards',
    run: async (raw) => (await share({ getLiquidRewards: raw })).getLiquidRewards({ user: USER })
  }),
  scalar({
    name: 'validatorShare.getMinAmount',
    field: 'minAmount',
    run: async (raw) => (await share({ minAmount: raw })).getMinAmount()
  }),
  scalar({
    name: 'validatorShare.getBalance',
    field: 'balanceOf',
    run: async (raw) => (await share({ balanceOf: raw })).getBalance({ user: USER })
  }),
  scalar({
    name: 'validatorShare.getUnbondNonce',
    field: 'unbondNonces',
    run: async (raw) => (await share({ unbondNonces: raw })).getUnbondNonce({ user: USER })
  }),
  scalar({
    name: 'validatorShare.getValidatorId',
    field: 'validatorId',
    run: async (raw) => (await share({ validatorId: raw })).getValidatorId()
  }),
  scalar({
    name: 'pol.getBalance',
    field: 'balanceOf',
    run: async (raw) => (await answering({ balanceOf: raw })).staking.pol.getBalance({ user: USER })
  }),
  scalar({
    name: 'matic.getBalance',
    field: 'balanceOf',
    run: async (raw) =>
      (await answering({ balanceOf: raw })).staking.matic.getBalance({ user: USER })
  }),
  scalar({
    name: 'pol.getAllowanceForStakeManager',
    field: 'allowance',
    run: async (raw) =>
      (await answering({ allowance: raw })).staking.pol.getAllowanceForStakeManager({ owner: USER })
  }),
  scalar({
    name: 'pol.getNonce',
    field: 'nonces',
    run: async (raw) => (await answering({ nonces: raw })).staking.pol.getNonce({ owner: USER })
  })
];

registerTable({
  title: 'a staking integer read goes through toBigInt',
  reads: INTEGER_READS,
  shapes: INTEGER_SHAPES,
  rows: [
    ['bigint', 'value 5n'],
    ['decimal string', 'value 5n'],
    ['hex string', 'value 5n'],
    ['BigNumber', 'value 5n'],
    ['number', 'value 5n'],
    [
      'undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "{field}.0", valueType: "undefined"}'
    ],
    [
      'null',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "{field}.0", valueType: "object"}'
    ],
    [
      'empty object',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "{field}.0", valueType: "object"}'
    ],
    [
      'non-numeric string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "{field}.0", valueType: "string"}'
    ],
    [
      'empty string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "{field}.0", valueType: "string"}'
    ],
    [
      'true',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "{field}.0", valueType: "boolean"}'
    ],
    [
      'fraction',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "{field}.0", valueType: "number"}'
    ],
    [
      'negative bigint',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "{field}.0", valueType: "bigint"}'
    ],
    [
      'unsafe number',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "{field}.0", valueType: "number"}'
    ],
    [
      'NaN',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "{field}.0", valueType: "number"}'
    ],
    [
      'one-element array',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "{field}.0", valueType: "object"}'
    ]
  ]
});

// --- booleans and addresses -----------------------------------------------------------------

registerTable({
  title: 'isLocked insists on a boolean',
  reads: [
    {
      name: 'stakeManager.isLocked',
      run: async (raw) => (await answering({ locked: raw })).staking.stakeManager.isLocked()
    }
  ],
  shapes: BOOLEAN_SHAPES,
  rows: [
    ['true', 'value true'],
    ['false', 'value false'],
    [
      'string "true"',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "locked.0", valueType: "string"}'
    ],
    [
      'string "false"',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "locked.0", valueType: "string"}'
    ],
    [
      'number 1',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "locked.0", valueType: "number"}'
    ],
    [
      'number 0',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "locked.0", valueType: "number"}'
    ],
    [
      'undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "locked.0", valueType: "undefined"}'
    ],
    [
      'null',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "locked.0", valueType: "object"}'
    ],
    [
      'empty object',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "locked.0", valueType: "object"}'
    ],
    [
      'empty string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "locked.0", valueType: "string"}'
    ]
  ]
});

registerTable({
  title: 'getValidatorContract accepts any string that starts with 0x',
  reads: [
    {
      name: 'stakeManager.getValidatorContract',
      run: async (raw) =>
        (await answering({ getValidatorContract: raw })).staking.stakeManager.getValidatorContract({
          validatorId: 1n
        })
    }
  ],
  shapes: { ...addressShapes(VALIDATOR_SHARE), 'bare 0x': '0x' },
  rows: [
    ['matching address', 'value "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"'],
    ['matching address, upper-case hex', 'value "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"'],
    ['other address', 'value "0x00000000000000000000000000000000000000b2"'],
    ['zero address', 'value "0x0000000000000000000000000000000000000000"'],
    [
      'undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getValidatorContract.0", valueType: "undefined"}'
    ],
    [
      'null',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getValidatorContract.0", valueType: "object"}'
    ],
    [
      'number',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getValidatorContract.0", valueType: "number"}'
    ],
    [
      'empty object',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getValidatorContract.0", valueType: "object"}'
    ],
    [
      'empty string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getValidatorContract.0", valueType: "string"}'
    ],
    [
      'non-hex string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getValidatorContract.0", valueType: "string"}'
    ],
    [
      'short hex',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getValidatorContract.0", valueType: "string"}'
    ],
    [
      'bytes32 hex',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getValidatorContract.0", valueType: "string"}'
    ],
    [
      'bare 0x',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getValidatorContract.0", valueType: "string"}'
    ]
  ]
});

// --- tuples ------------------------------------------------------------------------------------

/** The thirteen outputs of `validators`, with the ones named in `over` replaced by index. */
const validatorTuple = (over: Readonly<Record<number, unknown>> = {}): unknown[] =>
  [1n, 2n, 3n, 4n, 5n, USER, VALIDATOR_SHARE, 1, 8n, 9n, 10n, 11n, 12n].map((v, i) =>
    i in over ? over[i] : v
  );

const VALIDATOR_SHAPES: Readonly<Record<string, unknown>> = {
  'well-formed tuple': validatorTuple(),
  'ethers Result: an array that also carries names': Object.assign(validatorTuple(), {
    amount: 1n
  }),
  'twelve elements': validatorTuple().slice(0, 12),
  'empty array': [],
  'named object': { amount: 1n, reward: 2n },
  undefined: undefined,
  null: null,
  string: 'abc',
  'amount is a BigNumber': validatorTuple({ 0: integerShapes(5n)['BigNumber'] }),
  'amount is a decimal string': validatorTuple({ 0: '5' }),
  'amount is undefined': validatorTuple({ 0: undefined }),
  'amount is an empty object': validatorTuple({ 0: {} }),
  'amount is a non-numeric string': validatorTuple({ 0: 'abc' }),
  'amount is an empty string': validatorTuple({ 0: '' }),
  'amount is a boolean': validatorTuple({ 0: true }),
  'amount is a fraction': validatorTuple({ 0: 1.5 }),
  'signer is not hex': validatorTuple({ 5: 'abc' }),
  'signer is a bare 0x': validatorTuple({ 5: '0x' }),
  'signer is a number': validatorTuple({ 5: 5 }),
  'contractAddress is undefined': validatorTuple({ 6: undefined }),
  'status is a bigint': validatorTuple({ 7: 1n }),
  'status is a boolean': validatorTuple({ 7: true }),
  'status is undefined': validatorTuple({ 7: undefined }),
  'initialRewardPerStake is undefined': validatorTuple({ 12: undefined })
};

registerTable({
  title: 'getValidator maps a thirteen-element tuple',
  reads: [
    {
      name: 'stakeManager.getValidator',
      project: (v) => {
        const info = v as Record<string, unknown>;
        return `amount ${String(info['amount'])}, status ${String(info['status'])}, signer ${String(info['signer'])}`;
      },
      run: async (raw) =>
        (await answering({ validators: raw })).staking.stakeManager.getValidator({
          validatorId: 1n
        })
    }
  ],
  shapes: VALIDATOR_SHAPES,
  rows: [
    [
      'well-formed tuple',
      'value amount 1, status 1, signer 0x00000000000000000000000000000000000000a1'
    ],
    [
      'ethers Result: an array that also carries names',
      'value amount 1, status 1, signer 0x00000000000000000000000000000000000000a1'
    ],
    [
      'twelve elements',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators", length: 12, minLength: 13}'
    ],
    [
      'empty array',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators", length: 0, minLength: 13}'
    ],
    [
      'named object',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators", valueType: "object"}'
    ],
    [
      'undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators", valueType: "undefined"}'
    ],
    [
      'null',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators", valueType: "object"}'
    ],
    [
      'string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators", valueType: "string"}'
    ],
    [
      'amount is a BigNumber',
      'value amount 5, status 1, signer 0x00000000000000000000000000000000000000a1'
    ],
    [
      'amount is a decimal string',
      'value amount 5, status 1, signer 0x00000000000000000000000000000000000000a1'
    ],
    [
      'amount is undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators.amount", valueType: "undefined"}'
    ],
    [
      'amount is an empty object',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators.amount", valueType: "object"}'
    ],
    [
      'amount is a non-numeric string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators.amount", valueType: "string"}'
    ],
    [
      'amount is an empty string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators.amount", valueType: "string"}'
    ],
    [
      'amount is a boolean',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators.amount", valueType: "boolean"}'
    ],
    [
      'amount is a fraction',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators.amount", valueType: "number"}'
    ],
    [
      'signer is not hex',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators.signer", valueType: "string"}'
    ],
    [
      'signer is a bare 0x',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators.signer", valueType: "string"}'
    ],
    [
      'signer is a number',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators.signer", valueType: "number"}'
    ],
    [
      'contractAddress is undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators.contractAddress", valueType: "undefined"}'
    ],
    [
      'status is a bigint',
      'value amount 1, status 1, signer 0x00000000000000000000000000000000000000a1'
    ],
    [
      'status is a boolean',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators.status", valueType: "boolean"}'
    ],
    [
      'status is undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators.status", valueType: "undefined"}'
    ],
    [
      'initialRewardPerStake is undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "validators.initialRewardPerStake", valueType: "undefined"}'
    ]
  ]
});

const BIG_PAIR = (a: unknown, b: unknown): unknown[] => [a, b];

const PAIR_SHAPES: Readonly<Record<string, unknown>> = {
  'well-formed pair': BIG_PAIR(5n, 6n),
  'pair of BigNumbers': BIG_PAIR(integerShapes(5n)['BigNumber'], integerShapes(6n)['BigNumber']),
  'pair of decimal strings': BIG_PAIR('5', '6'),
  'ethers Result: an array that also carries names': Object.assign(BIG_PAIR(5n, 6n), {
    stake: 5n
  }),
  'array of one': [5n],
  'empty array': [],
  'named object': { stake: 5n, rate: 6n },
  undefined: undefined,
  null: null,
  string: 'abc',
  'first is undefined': BIG_PAIR(undefined, 6n),
  'first is an empty object': BIG_PAIR({}, 6n),
  'first is a non-numeric string': BIG_PAIR('abc', 6n),
  'first is an empty string': BIG_PAIR('', 6n),
  'first is a boolean': BIG_PAIR(true, 6n),
  'second is undefined': BIG_PAIR(5n, undefined),
  'second is a fraction': BIG_PAIR(5n, 1.5)
};

const pairTable = ({
  title,
  name,
  rows,
  run
}: {
  title: string;
  name: string;
  rows: readonly Row[];
  run: (raw: unknown) => Promise<unknown>;
}): void => {
  registerTable({
    title,
    reads: [
      {
        name,
        project: (v) =>
          Object.entries(v as Record<string, unknown>)
            .map(([k, x]) => `${k} ${String(x)}`)
            .join(', '),
        run
      }
    ],
    shapes: PAIR_SHAPES,
    rows
  });
};

pairTable({
  title: 'getTotalStake maps two outputs',
  name: 'validatorShare.getTotalStake',
  run: async (raw) => (await share({ getTotalStake: raw })).getTotalStake({ user: USER }),
  rows: [
    ['well-formed pair', 'value stake 5, rate 6'],
    ['pair of BigNumbers', 'value stake 5, rate 6'],
    ['pair of decimal strings', 'value stake 5, rate 6'],
    ['ethers Result: an array that also carries names', 'value stake 5, rate 6'],
    [
      'array of one',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getTotalStake", length: 1, minLength: 2}'
    ],
    [
      'empty array',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getTotalStake", length: 0, minLength: 2}'
    ],
    [
      'named object',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getTotalStake", valueType: "object"}'
    ],
    [
      'undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getTotalStake", valueType: "undefined"}'
    ],
    [
      'null',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getTotalStake", valueType: "object"}'
    ],
    [
      'string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getTotalStake", valueType: "string"}'
    ],
    [
      'first is undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getTotalStake.0", valueType: "undefined"}'
    ],
    [
      'first is an empty object',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getTotalStake.0", valueType: "object"}'
    ],
    [
      'first is a non-numeric string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getTotalStake.0", valueType: "string"}'
    ],
    [
      'first is an empty string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getTotalStake.0", valueType: "string"}'
    ],
    [
      'first is a boolean',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getTotalStake.0", valueType: "boolean"}'
    ],
    [
      'second is undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getTotalStake.1", valueType: "undefined"}'
    ],
    [
      'second is a fraction',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "getTotalStake.1", valueType: "number"}'
    ]
  ]
});

pairTable({
  title: 'getUnbond maps two outputs',
  name: 'validatorShare.getUnbond',
  run: async (raw) => (await share({ unbonds: raw })).getUnbond({ user: USER }),
  rows: [
    ['well-formed pair', 'value shares 5, withdrawEpoch 6'],
    ['pair of BigNumbers', 'value shares 5, withdrawEpoch 6'],
    ['pair of decimal strings', 'value shares 5, withdrawEpoch 6'],
    ['ethers Result: an array that also carries names', 'value shares 5, withdrawEpoch 6'],
    [
      'array of one',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds", length: 1, minLength: 2}'
    ],
    [
      'empty array',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds", length: 0, minLength: 2}'
    ],
    [
      'named object',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds", valueType: "object"}'
    ],
    [
      'undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds", valueType: "undefined"}'
    ],
    [
      'null',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds", valueType: "object"}'
    ],
    [
      'string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds", valueType: "string"}'
    ],
    [
      'first is undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds.shares", valueType: "undefined"}'
    ],
    [
      'first is an empty object',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds.shares", valueType: "object"}'
    ],
    [
      'first is a non-numeric string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds.shares", valueType: "string"}'
    ],
    [
      'first is an empty string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds.shares", valueType: "string"}'
    ],
    [
      'first is a boolean',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds.shares", valueType: "boolean"}'
    ],
    [
      'second is undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds.withdrawEpoch", valueType: "undefined"}'
    ],
    [
      'second is a fraction',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds.withdrawEpoch", valueType: "number"}'
    ]
  ]
});

pairTable({
  title: 'getUnbondNew maps two outputs',
  name: 'validatorShare.getUnbondNew',
  run: async (raw) => (await share({ unbonds_new: raw })).getUnbondNew({ user: USER, nonce: 2n }),
  rows: [
    ['well-formed pair', 'value shares 5, withdrawEpoch 6'],
    ['pair of BigNumbers', 'value shares 5, withdrawEpoch 6'],
    ['pair of decimal strings', 'value shares 5, withdrawEpoch 6'],
    ['ethers Result: an array that also carries names', 'value shares 5, withdrawEpoch 6'],
    [
      'array of one',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds_new", length: 1, minLength: 2}'
    ],
    [
      'empty array',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds_new", length: 0, minLength: 2}'
    ],
    [
      'named object',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds_new", valueType: "object"}'
    ],
    [
      'undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds_new", valueType: "undefined"}'
    ],
    [
      'null',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds_new", valueType: "object"}'
    ],
    [
      'string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds_new", valueType: "string"}'
    ],
    [
      'first is undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds_new.shares", valueType: "undefined"}'
    ],
    [
      'first is an empty object',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds_new.shares", valueType: "object"}'
    ],
    [
      'first is a non-numeric string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds_new.shares", valueType: "string"}'
    ],
    [
      'first is an empty string',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds_new.shares", valueType: "string"}'
    ],
    [
      'first is a boolean',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds_new.shares", valueType: "boolean"}'
    ],
    [
      'second is undefined',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds_new.withdrawEpoch", valueType: "undefined"}'
    ],
    [
      'second is a fraction',
      'threw StakingReadError > BridgeEventDecodeFailedError {field: "unbonds_new.withdrawEpoch", valueType: "number"}'
    ]
  ]
});

// --- the permit's EIP-712 domain ------------------------------------------------------------------

const DOMAIN = (over: Readonly<Record<number, unknown>> = {}): unknown[] =>
  [
    '0x0f',
    'Polygon Ecosystem Token',
    '1',
    1n,
    STAKING_ADDRESSES.PolToken,
    `0x${'0'.repeat(64)}`,
    []
  ].map((v, i) => (i in over ? over[i] : v));

const DOMAIN_SHAPES: Readonly<Record<string, unknown>> = {
  'well-formed domain': DOMAIN(),
  'domain of five': DOMAIN().slice(0, 5),
  'domain of four': DOMAIN().slice(0, 4),
  'empty array': [],
  undefined: undefined,
  null: null,
  'named object': { name: 'x', version: '1' },
  'name is a number': DOMAIN({ 1: 5 }),
  'version is undefined': DOMAIN({ 2: undefined }),
  'chainId is a BigNumber': DOMAIN({ 3: integerShapes(1n)['BigNumber'] }),
  'chainId is a decimal string': DOMAIN({ 3: '1' }),
  'chainId is undefined': DOMAIN({ 3: undefined }),
  'chainId is non-numeric': DOMAIN({ 3: 'abc' }),
  'chainId is a boolean': DOMAIN({ 3: true }),
  'chainId is above the safe integer range': DOMAIN({ 3: 2n ** 60n }),
  'verifyingContract is not hex': DOMAIN({ 4: 'abc' }),
  'verifyingContract is undefined': DOMAIN({ 4: undefined }),
  'verifyingContract is a number': DOMAIN({ 4: 5 })
};

registerTable({
  title: 'preparePermit reads the EIP-712 domain',
  reads: [
    {
      name: 'pol.preparePermit',
      project: (v) => {
        const domain = (v as { domain: Record<string, unknown> }).domain;
        return `domain ${Object.entries(domain)
          .map(([k, x]) => `${k} ${String(x)}`)
          .join(', ')}`;
      },
      run: async (raw) =>
        (await answering({ eip712Domain: raw })).staking.pol.preparePermit({
          owner: USER,
          value: 5n,
          deadline: 1_900_000_000n
        })
    }
  ],
  shapes: DOMAIN_SHAPES,
  rows: [
    [
      'well-formed domain',
      'value domain name Polygon Ecosystem Token, version 1, chainId 1, verifyingContract 0x9999999999999999999999999999999999999999'
    ],
    [
      'domain of five',
      'threw PermitError > BridgeEventDecodeFailedError {field: "eip712Domain", length: 5, minLength: 7}'
    ],
    [
      'domain of four',
      'threw PermitError > BridgeEventDecodeFailedError {field: "eip712Domain", length: 4, minLength: 7}'
    ],
    [
      'empty array',
      'threw PermitError > BridgeEventDecodeFailedError {field: "eip712Domain", length: 0, minLength: 7}'
    ],
    [
      'undefined',
      'threw PermitError > BridgeEventDecodeFailedError {field: "eip712Domain", valueType: "undefined"}'
    ],
    [
      'null',
      'threw PermitError > BridgeEventDecodeFailedError {field: "eip712Domain", valueType: "object"}'
    ],
    [
      'named object',
      'threw PermitError > BridgeEventDecodeFailedError {field: "eip712Domain", valueType: "object"}'
    ],
    [
      'name is a number',
      'threw PermitError > BridgeEventDecodeFailedError {field: "eip712Domain.name", valueType: "number"}'
    ],
    [
      'version is undefined',
      'threw PermitError > BridgeEventDecodeFailedError {field: "eip712Domain.version", valueType: "undefined"}'
    ],
    [
      'chainId is a BigNumber',
      'value domain name Polygon Ecosystem Token, version 1, chainId 1, verifyingContract 0x9999999999999999999999999999999999999999'
    ],
    [
      'chainId is a decimal string',
      'value domain name Polygon Ecosystem Token, version 1, chainId 1, verifyingContract 0x9999999999999999999999999999999999999999'
    ],
    [
      'chainId is undefined',
      'threw PermitError > BridgeEventDecodeFailedError {field: "eip712Domain.chainId", valueType: "undefined"}'
    ],
    [
      'chainId is non-numeric',
      'threw PermitError > BridgeEventDecodeFailedError {field: "eip712Domain.chainId", valueType: "string"}'
    ],
    [
      'chainId is a boolean',
      'threw PermitError > BridgeEventDecodeFailedError {field: "eip712Domain.chainId", valueType: "boolean"}'
    ],
    [
      'chainId is above the safe integer range',
      'threw PermitError > BridgeEventDecodeFailedError {field: "eip712Domain.chainId"}'
    ],
    [
      'verifyingContract is not hex',
      'threw PermitError > BridgeEventDecodeFailedError {field: "eip712Domain.verifyingContract", valueType: "string"}'
    ],
    [
      'verifyingContract is undefined',
      'threw PermitError > BridgeEventDecodeFailedError {field: "eip712Domain.verifyingContract", valueType: "undefined"}'
    ],
    [
      'verifyingContract is a number',
      'threw PermitError > BridgeEventDecodeFailedError {field: "eip712Domain.verifyingContract", valueType: "number"}'
    ]
  ]
});
