import { describe, expect, it } from 'vitest';

import { BridgeEventDecodeFailedError } from '../../src/errors.ts';
import {
  decodeAbiResult,
  decodeAbiValue,
  decodeAddress,
  decodeBool,
  decodeBytes,
  decodeInteger,
  decodeString
} from '../../src/internal/decode.ts';

/**
 * The decoder is the one place a contract read becomes an SDK value, so each
 * rule is pinned by an accept row and a reject row: what the three libraries
 * return for a well-formed result must come out as the same SDK value, and
 * anything else must fail with `BridgeEventDecodeFailedError` naming the
 * field.
 */

/** What ethers v5 returns for a `uint256`: not a bigint, but its string form is a decimal. */
class BigNumberLike {
  readonly #decimal: string;
  constructor(decimal: string) {
    this.#decimal = decimal;
  }
  toString(): string {
    return this.#decimal;
  }
}

/** The error a decode threw; fails the test when nothing was thrown. */
const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the decode to throw');
};

const rejected = (fn: () => unknown): BridgeEventDecodeFailedError => {
  const err = caught(fn);
  expect(err).instanceOf(BridgeEventDecodeFailedError);
  if (!(err instanceof BridgeEventDecodeFailedError)) throw new Error('unreachable');
  // The value is judged malformed by this code, so there is no library error to wrap.
  expect(err.cause).equal(undefined);
  return err;
};

const ADDRESS = '0x00000000000000000000000000000000000000aB';
const BYTES32 = `0x${'ab'.repeat(32)}`;

describe('decodeInteger', () => {
  const accepted: [string, string, unknown, bigint][] = [
    ['bigint', 'uint256', 5n, 5n],
    ['safe-integer number', 'uint8', 5, 5n],
    ['zero', 'uint256', 0, 0n],
    [
      'decimal string',
      'uint256',
      '123456789012345678901234567890',
      123456789012345678901234567890n
    ],
    ['0x string', 'uint256', '0x10', 16n],
    ['uppercase 0x digits', 'uint256', '0xFF', 255n],
    ['BigNumber-like object', 'uint256', new BigNumberLike('42'), 42n],
    ['uint8 maximum', 'uint8', 255n, 255n],
    ['uint256 maximum', 'uint256', 2n ** 256n - 1n, 2n ** 256n - 1n],
    ['negative int256', 'int256', -5n, -5n],
    ['negative decimal string for an int', 'int8', '-128', -128n],
    ['int8 maximum', 'int8', 127, 127n],
    ['bare uint is 256 bits', 'uint', 2n ** 255n, 2n ** 255n]
  ];

  it.each(accepted)('accepts %s', (_name, type, value, expected) => {
    expect(decodeInteger({ type, value, field: 'm.0' })).equal(expected);
  });

  const rejects: [string, string, unknown, string][] = [
    ['undefined', 'uint256', undefined, 'undefined'],
    ['null', 'uint256', null, 'object'],
    ['empty string', 'uint256', '', 'string'],
    ['non-numeric string', 'uint256', 'abc', 'string'],
    ['bare 0x', 'uint256', '0x', 'string'],
    ['fractional string', 'uint256', '1.5', 'string'],
    ['true', 'uint256', true, 'boolean'],
    ['false', 'uint256', false, 'boolean'],
    ['one-element array', 'uint256', [5n], 'object'],
    ['fraction', 'uint256', 1.5, 'number'],
    ['NaN', 'uint256', Number.NaN, 'number'],
    ['Infinity', 'uint256', Number.POSITIVE_INFINITY, 'number'],
    ['unsafe number', 'uint256', 1e21, 'number'],
    ['empty object', 'uint256', {}, 'object'],
    ['object with no prototype', 'uint256', Object.create(null), 'object'],
    ['object whose string form is not a decimal', 'uint256', new BigNumberLike('0x10'), 'object'],
    ['symbol', 'uint256', Symbol('x'), 'symbol'],
    ['negative uint', 'uint256', -1n, 'bigint'],
    ['uint8 above its maximum', 'uint8', 256n, 'bigint'],
    ['uint256 above its maximum', 'uint256', 2n ** 256n, 'bigint'],
    ['int8 above its maximum', 'int8', 128, 'number'],
    ['int8 below its minimum', 'int8', -129n, 'bigint']
  ];

  it.each(rejects)('rejects %s', (_name, type, value, valueType) => {
    const err = rejected(() => decodeInteger({ type, value, field: 'm.0' }));
    expect(err.info).property('field', 'm.0');
    expect(err.info).property('valueType', valueType);
  });

  it('treats a type that is not an integer as a programming error, not bad data', () => {
    const err = caught(() => decodeInteger({ type: 'address', value: 1n, field: 'm.0' }));
    expect(err).instanceOf(Error);
    expect(err).not.instanceOf(BridgeEventDecodeFailedError);
  });
});

describe('decodeAddress', () => {
  it.each([
    ['checksummed', ADDRESS],
    ['lowercase', ADDRESS.toLowerCase()],
    ['zero address', `0x${'00'.repeat(20)}`]
  ])('accepts %s', (_name, value) => {
    expect(decodeAddress({ value, field: 'm.0' })).equal(value);
  });

  it.each<[string, unknown, string]>([
    ['undefined', undefined, 'undefined'],
    ['null', null, 'object'],
    ['a number', 5, 'number'],
    ['an empty string', '', 'string'],
    ['a bare 0x', '0x', 'string'],
    ['a short hex', `0x${'ab'.repeat(19)}`, 'string'],
    ['a bytes32 hex', BYTES32, 'string'],
    ['a long hex', `0x${'ab'.repeat(21)}`, 'string'],
    ['non-hex digits', `0x${'zz'.repeat(20)}`, 'string'],
    ['no 0x prefix', 'ab'.repeat(20), 'string'],
    ['an object', {}, 'object']
  ])('rejects %s', (_name, value, valueType) => {
    const err = rejected(() => decodeAddress({ value, field: 'm.0' }));
    expect(err.info).property('field', 'm.0');
    expect(err.info).property('valueType', valueType);
  });
});

describe('decodeBool', () => {
  it.each([true, false])('accepts %s', (value) => {
    expect(decodeBool({ value, field: 'm.0' })).equal(value);
  });

  it.each<[string, unknown, string]>([
    ['the string "true"', 'true', 'string'],
    ['the string "false", which is truthy', 'false', 'string'],
    ['the number 1', 1, 'number'],
    ['the number 0', 0, 'number'],
    ['undefined', undefined, 'undefined'],
    ['null', null, 'object'],
    ['an empty object', {}, 'object'],
    ['an empty string', '', 'string']
  ])('rejects %s', (_name, value, valueType) => {
    const err = rejected(() => decodeBool({ value, field: 'm.0' }));
    expect(err.info).property('field', 'm.0');
    expect(err.info).property('valueType', valueType);
  });
});

describe('decodeString', () => {
  it.each(['', 'abc', 'Polygon Ecosystem Token'])('accepts %j', (value) => {
    expect(decodeString({ value, field: 'm.0' })).equal(value);
  });

  it.each<[string, unknown, string]>([
    ['a number', 5, 'number'],
    ['undefined', undefined, 'undefined'],
    ['null', null, 'object'],
    ['an object', {}, 'object'],
    ['a bigint', 5n, 'bigint']
  ])('rejects %s', (_name, value, valueType) => {
    const err = rejected(() => decodeString({ value, field: 'm.0' }));
    expect(err.info).property('field', 'm.0');
    expect(err.info).property('valueType', valueType);
  });
});

describe('decodeBytes', () => {
  it.each<[string, string, string]>([
    ['empty bytes', 'bytes', '0x'],
    ['bytes', 'bytes', '0x1234'],
    ['uppercase digits', 'bytes', '0xABCD'],
    ['bytes32 of exactly 32 bytes', 'bytes32', BYTES32],
    ['bytes1', 'bytes1', '0x01']
  ])('accepts %s', (_name, type, value) => {
    expect(decodeBytes({ type, value, field: 'm.0' })).equal(value);
  });

  it.each<[string, string, unknown, string]>([
    ['an odd number of digits', 'bytes', '0x123', 'string'],
    ['non-hex digits', 'bytes', '0xzz', 'string'],
    ['no 0x prefix', 'bytes', '1234', 'string'],
    ['undefined', 'bytes', undefined, 'undefined'],
    ['null', 'bytes', null, 'object'],
    ['a number', 'bytes', 5, 'number'],
    ['a byte array', 'bytes', new Uint8Array([1, 2]), 'object'],
    ['bytes32 that is too short', 'bytes32', '0x12', 'string'],
    ['bytes32 that is too long', 'bytes32', `${BYTES32}ab`, 'string'],
    ['bytes1 given two bytes', 'bytes1', '0x0102', 'string']
  ])('rejects %s', (_name, type, value, valueType) => {
    const err = rejected(() => decodeBytes({ type, value, field: 'm.0' }));
    expect(err.info).property('field', 'm.0');
    expect(err.info).property('valueType', valueType);
  });
});

describe('decodeAbiValue arrays', () => {
  it('decodes a dynamic array element by element, so every library gives the same values', () => {
    const decoded = decodeAbiValue({
      type: 'uint256[]',
      value: [1n, new BigNumberLike('2'), '3', 4],
      field: 'm.0'
    });
    expect(decoded).deep.equal([1n, 2n, 3n, 4n]);
  });

  it('accepts an empty dynamic array', () => {
    expect(decodeAbiValue({ type: 'address[]', value: [], field: 'm.0' })).deep.equal([]);
  });

  it('accepts an array that also carries names, as an ethers Result does', () => {
    const result = Object.assign([1n, 2n], { first: 1n, second: 2n });
    expect(decodeAbiValue({ type: 'uint256[]', value: result, field: 'm.0' })).deep.equal([1n, 2n]);
  });

  it('names the element that is wrong', () => {
    const err = rejected(() =>
      decodeAbiValue({ type: 'uint256[]', value: [1n, 'abc'], field: 'm.0' })
    );
    expect(err.info).property('field', 'm.0[1]');
    expect(err.info).property('valueType', 'string');
  });

  it.each<[string, unknown, string]>([
    ['undefined', undefined, 'undefined'],
    ['a string', 'abc', 'string'],
    ['null', null, 'object'],
    ['an object that is not an array', {}, 'object']
  ])('rejects %s where an array is expected', (_name, value, valueType) => {
    const err = rejected(() => decodeAbiValue({ type: 'uint256[]', value, field: 'm.0' }));
    expect(err.info).property('field', 'm.0');
    expect(err.info).property('valueType', valueType);
  });

  describe('fixed-size arrays', () => {
    const sixteen = Array.from(
      { length: 16 },
      (_unused, i) => `0x${i.toString(16).padStart(64, '0')}`
    );

    it('accepts bytes32[16] of exactly sixteen elements', () => {
      expect(decodeAbiValue({ type: 'bytes32[16]', value: sixteen, field: 'm.0' })).deep.equal(
        sixteen
      );
    });

    it.each([15, 17, 0])('rejects bytes32[16] of %i elements', (length) => {
      const err = rejected(() =>
        decodeAbiValue({
          type: 'bytes32[16]',
          value: sixteen.concat(sixteen).slice(0, length),
          field: 'm.0'
        })
      );
      expect(err.info).property('field', 'm.0');
      expect(err.info).property('length', length);
      expect(err.info).property('minLength', 16);
    });

    it('checks each element of a fixed-size array too', () => {
      const err = rejected(() =>
        decodeAbiValue({
          type: 'bytes32[16]',
          value: [...sixteen.slice(0, 15), '0x12'],
          field: 'm.0'
        })
      );
      expect(err.info).property('field', 'm.0[15]');
    });

    it('decodes the nested uint256[2][] the vendored ABIs use', () => {
      const decoded = decodeAbiValue({
        type: 'uint256[2][]',
        value: [
          [1n, 2n],
          [new BigNumberLike('3'), 4]
        ],
        field: 'm.0'
      });
      expect(decoded).deep.equal([
        [1n, 2n],
        [3n, 4n]
      ]);
    });

    it('rejects an inner array of the wrong size, naming it', () => {
      const err = rejected(() =>
        decodeAbiValue({ type: 'uint256[2][]', value: [[1n, 2n], [3n]], field: 'm.0' })
      );
      expect(err.info).property('field', 'm.0[1]');
      expect(err.info).property('length', 1);
      expect(err.info).property('minLength', 2);
    });
  });
});

describe('decodeAbiValue types it does not know', () => {
  it.each(['tuple', 'tuple[]', 'function', 'mapping'])(
    'fails %s loudly as a programming error, not as bad data',
    (type) => {
      const err = caught(() => decodeAbiValue({ type, value: [], field: 'm.0' }));
      expect(err).instanceOf(Error);
      expect(err).not.instanceOf(BridgeEventDecodeFailedError);
    }
  );
});

describe('decodeAbiResult', () => {
  const abi = [
    { type: 'constructor', inputs: [] },
    { type: 'event', name: 'balanceOf', inputs: [] },
    {
      type: 'function',
      name: 'balanceOf',
      inputs: [{ name: 'user', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }],
      stateMutability: 'view'
    },
    {
      type: 'function',
      name: 'locked',
      inputs: [],
      outputs: [{ name: 'isLocked', type: 'bool' }],
      stateMutability: 'view'
    },
    {
      type: 'function',
      name: 'headerBlocks',
      inputs: [{ name: 'id', type: 'uint256' }],
      outputs: [
        { name: 'root', type: 'bytes32' },
        { name: 'start', type: 'uint256' },
        { name: 'end', type: 'uint256' },
        { name: '', type: 'uint256' },
        { name: 'proposer', type: 'address' }
      ],
      stateMutability: 'view'
    },
    {
      type: 'function',
      name: 'owners',
      inputs: [],
      outputs: [{ name: '', type: 'address[]' }],
      stateMutability: 'view'
    },
    { type: 'function', name: 'ping', inputs: [], outputs: [], stateMutability: 'view' },
    { type: 'function', name: 'noOutputsKey', inputs: [], stateMutability: 'view' },
    {
      type: 'function',
      name: 'pair',
      inputs: [],
      outputs: [
        { name: '', type: 'uint256' },
        { name: '', type: 'bool' }
      ],
      stateMutability: 'view'
    },
    {
      type: 'function',
      name: 'withTuple',
      inputs: [],
      outputs: [{ name: '', type: 'tuple' }],
      stateMutability: 'view'
    }
  ] as const;

  const header = [BYTES32, 1n, 2n, 0n, ADDRESS];

  it('returns the bare value for one output, whichever library produced it', () => {
    for (const raw of [5n, new BigNumberLike('5'), 5, '5']) {
      expect(decodeAbiResult({ abi, method: 'balanceOf', raw })).equal(5n);
    }
  });

  it('returns a positional array for several outputs', () => {
    expect(decodeAbiResult({ abi, method: 'headerBlocks', raw: header })).deep.equal(header);
  });

  it('normalises each field of a multi-output read', () => {
    const raw = Object.assign([BYTES32, new BigNumberLike('1'), 2, '0x3', ADDRESS], {
      start: 'named, ignored'
    });
    expect(decodeAbiResult({ abi, method: 'headerBlocks', raw })).deep.equal([
      BYTES32,
      1n,
      2n,
      3n,
      ADDRESS
    ]);
  });

  it('tolerates extra trailing elements and returns only the declared outputs', () => {
    const decoded = decodeAbiResult({ abi, method: 'headerBlocks', raw: [...header, 99n] });
    expect(decoded).deep.equal(header);
  });

  it('decodes an array output as the bare array', () => {
    expect(decodeAbiResult({ abi, method: 'owners', raw: [ADDRESS] })).deep.equal([ADDRESS]);
  });

  it('skips entries that are not the named function', () => {
    // An event and a constructor sit before the function in this ABI.
    expect(decodeAbiResult({ abi, method: 'balanceOf', raw: 1n })).equal(1n);
  });

  it('returns undefined for a function with no outputs', () => {
    expect(decodeAbiResult({ abi, method: 'ping', raw: undefined })).equal(undefined);
    expect(decodeAbiResult({ abi, method: 'noOutputsKey', raw: undefined })).equal(undefined);
  });

  describe('field names', () => {
    it('uses method.<index> for a single unnamed output', () => {
      const err = rejected(() => decodeAbiResult({ abi, method: 'balanceOf', raw: 'abc' }));
      expect(err.info).property('field', 'balanceOf.0');
    });

    it('uses method.<name> for a single named output', () => {
      const err = rejected(() => decodeAbiResult({ abi, method: 'locked', raw: 'true' }));
      expect(err.info).property('field', 'locked.isLocked');
    });

    it('uses method.<name> or method.<index> per output of a multi-output read', () => {
      const named = rejected(() =>
        decodeAbiResult({ abi, method: 'headerBlocks', raw: [BYTES32, 'x', 2n, 0n, ADDRESS] })
      );
      expect(named.info).property('field', 'headerBlocks.start');
      const unnamed = rejected(() =>
        decodeAbiResult({ abi, method: 'headerBlocks', raw: [BYTES32, 1n, 2n, 'x', ADDRESS] })
      );
      expect(unnamed.info).property('field', 'headerBlocks.3');
      const second = rejected(() => decodeAbiResult({ abi, method: 'pair', raw: [1n, 'true'] }));
      expect(second.info).property('field', 'pair.1');
    });

    it('names an element of an array output', () => {
      const err = rejected(() =>
        decodeAbiResult({ abi, method: 'owners', raw: [ADDRESS, '0x12'] })
      );
      expect(err.info).property('field', 'owners.0[1]');
    });
  });

  describe('rejects a multi-output read that is not a long enough array', () => {
    it.each<[string, unknown]>([
      ['a named object', { root: BYTES32, start: 1n, end: 2n }],
      ['undefined', undefined],
      ['null', null],
      ['a string', 'abc'],
      ['a bigint', 5n]
    ])('given %s', (_name, raw) => {
      const err = rejected(() => decodeAbiResult({ abi, method: 'headerBlocks', raw }));
      expect(err.info).property('field', 'headerBlocks');
      expect(err.info).property('valueType', typeof raw);
    });

    it.each([0, 4])('given an array of %i elements', (length) => {
      const err = rejected(() =>
        decodeAbiResult({ abi, method: 'headerBlocks', raw: header.slice(0, length) })
      );
      expect(err.info).property('field', 'headerBlocks');
      expect(err.info).property('length', length);
      expect(err.info).property('minLength', 5);
    });
  });

  it('fails a method the ABI does not carry as a programming error, not as bad data', () => {
    const err = caught(() => decodeAbiResult({ abi, method: 'absent', raw: 1n }));
    expect(err).instanceOf(Error);
    expect(err).not.instanceOf(BridgeEventDecodeFailedError);
    expect(err).property('message').include('absent');
  });

  it('fails an output type it does not know as a programming error', () => {
    const err = caught(() => decodeAbiResult({ abi, method: 'withTuple', raw: [] }));
    expect(err).not.instanceOf(BridgeEventDecodeFailedError);
  });
});
