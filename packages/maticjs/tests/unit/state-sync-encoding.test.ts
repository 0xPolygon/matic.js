import { encodeAbiParameters as viemEncode } from 'viem';
import { describe, expect, it } from 'vitest';

import type { Hex } from '../../src/adapter.ts';

import { BridgeEventDecodeFailedError, InvalidHexStringError } from '../../src/errors.ts';
import { decodeBytesParameter, encodeAbiParameters } from '../../src/internal/abi-encode.ts';

const RECEIVER: Hex = '0x8397259c983751daf40400790063935a11afa28a';
const payloadOf = (size: number): Hex =>
  `0x${Array.from({ length: size }, (_, i) => ((i * 7 + 1) & 0xff).toString(16).padStart(2, '0')).join('')}`;
const SIZES = [0, 1, 32, 33, 256];

describe('the (address, bytes) shape of a state-sync record', () => {
  for (const size of SIZES) {
    it(`encodes a ${String(size)}-byte payload like viem`, () => {
      const data = payloadOf(size);
      const expected = viemEncode([{ type: 'address' }, { type: 'bytes' }], [RECEIVER, data]);
      expect(encodeAbiParameters([RECEIVER, data], ['address', 'bytes'])).equal(expected);
    });

    it(`round-trips a ${String(size)}-byte payload through the bytes decoder`, () => {
      const data = payloadOf(size);
      expect(decodeBytesParameter(encodeAbiParameters([data], ['bytes']))).equal(data);
    });
  }

  it('accepts a checksummed address', () => {
    const mixed = '0x8397259C983751DAf40400790063935a11afa28a';
    expect(encodeAbiParameters([mixed, '0x'], ['address', 'bytes'])).equal(
      encodeAbiParameters([RECEIVER, '0x'], ['address', 'bytes'])
    );
  });

  it('rejects an address that is not 20 bytes of hex', () => {
    for (const bad of ['0x1234', `0x${'zz'.repeat(20)}`, 5]) {
      expect(() => encodeAbiParameters([bad, '0x'], ['address', 'bytes'])).throw(
        InvalidHexStringError
      );
    }
  });

  it('rejects bytes whose offset word is not 0x20', () => {
    const wrongOffset = `0x${'40'.padStart(64, '0')}${'00'.repeat(32)}`;
    expect(() => decodeBytesParameter(wrongOffset)).throw(BridgeEventDecodeFailedError);
  });

  it('rejects bytes shorter than their length word and non-hex input', () => {
    const truncated = encodeAbiParameters([payloadOf(40)], ['bytes']).slice(0, -100);
    expect(() => decodeBytesParameter(truncated)).throw(BridgeEventDecodeFailedError);
    expect(() => decodeBytesParameter('0x')).throw(BridgeEventDecodeFailedError);
    expect(() => decodeBytesParameter(`0x${'zz'.repeat(64)}`)).throw(BridgeEventDecodeFailedError);
  });
});
