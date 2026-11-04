/**
 * Contract of the SDK's byte and keccak primitives (`src/utils/bytes.ts`,
 * `src/utils/keccak.ts` and each adapter's `keccak256`).
 *
 * These helpers sit under the merkle tree, the receipt trie and the
 * exit-payload builder, so a change in any digest or hex conversion
 * changes consensus-relevant bytes. Every expectation below was captured
 * from the implementation these helpers previously delegated to (a
 * wrapper over `@noble/hashes` 1.4.0) and is written as a literal, so the
 * file guards the contract independently of whichever library provides
 * it.
 *
 * Invalid input is pinned as "throws an Error" rather than by class or
 * message: those are the library's wording, not the SDK's contract.
 */

import { JsonRpcProvider, Network as V6Network } from 'ethers';
import { providers as v5Providers } from 'ethers-v5';
import { createPublicClient, http } from 'viem';
import { afterAll, describe, expect, it } from 'vitest';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.js';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.js';
import { viemAdapter } from '../../src/adapters/viem.js';
import { POSBridgeError } from '../../src/errors.js';
import {
  bytesToHex,
  compareBytes,
  concatBytes,
  hexToBytes,
  setLengthLeft,
  utf8ToBytes
} from '../../src/utils/bytes.js';
import { Keccak } from '../../src/utils/keccak.js';

const KECCAK_EMPTY = {
  224: 'f71837502ba8e10837bdd8d365adb85591895602fc552b48b7390abd',
  256: 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  384: '2c23146a63a29acf99e73b88f8c24eaa7dc60aa771780ccc006afbfa8fe2479b2dd2b21362337441ac12b515911957ff',
  512: '0eab42de4c3ceb9235fc91acffe746b29c29a8c366b7c60e4e67c466f36a4304c00fa9caf9d87976ba469bcbe06713b435f091ef2769fb160cdab33d3670680e'
} as const;

const KECCAK_FOO = {
  224: 'daa94da7f6806bf5a4e0af60379d75c62cadd6be5427c16d01e76cca',
  256: '41b1a0649752af1b28b3dc29a1556eee781e4a4c3a1f7f53f90fa834de098c4d',
  384: '19d3f8607d2c6519443ab70bf1f7c86e9da4fda7fbcba7bfae0cab6190d24606f48334a7382c60db479d49bfd9fa815c',
  512: '1597842aac52bc9d13fe249d808afbf44da13524759477404c3592ee331173e89fe1cbf21a7e4360990d565fad4643cdb209d80fa41a91dea97e665022c92135'
} as const;

const WIDTHS = [224, 256, 384, 512] as const;

/** Deterministic 1,000-byte input; long enough to span several keccak blocks. */
const LONG_INPUT = new Uint8Array(1000).map((_, i) => (i * 7 + 3) & 0xff);
const LONG_INPUT_KECCAK256 = '80cdc8dd52cbb3dbaea8f383209893fa2bb52efbd5aedbb4b26dcfe307fcdc9b';

describe('bytesToHex', () => {
  it('encodes to unprefixed lowercase hex', () => {
    expect(bytesToHex(new Uint8Array())).to.equal('');
    expect(bytesToHex(Uint8Array.of(0x00))).to.equal('00');
    expect(bytesToHex(Uint8Array.of(0xff))).to.equal('ff');
    expect(bytesToHex(new Uint8Array(32).map((_, i) => i * 8))).to.equal(
      '0008101820283038404850586068707880889098a0a8b0b8c0c8d0d8e0e8f0f8'
    );
  });

  it('encodes a subarray view by its own bounds', () => {
    expect(bytesToHex(Uint8Array.of(9, 1, 2, 9).subarray(1, 3))).to.equal('0102');
  });
});

describe('hexToBytes', () => {
  it('decodes unprefixed even-length hex, either case', () => {
    expect(hexToBytes('')).to.deep.equal(new Uint8Array());
    expect(hexToBytes('00ff')).to.deep.equal(Uint8Array.of(0x00, 0xff));
    expect(hexToBytes('ABcdEF')).to.deep.equal(Uint8Array.of(0xab, 0xcd, 0xef));
  });

  it('strips exactly one lowercase 0x prefix', () => {
    expect(hexToBytes('0xabcd')).to.deep.equal(Uint8Array.of(0xab, 0xcd));
    expect(hexToBytes('0x')).to.deep.equal(new Uint8Array());
    expect(() => hexToBytes('0x0xab')).to.throw(Error);
  });

  it('does not strip an uppercase 0X prefix', () => {
    expect(() => hexToBytes('0Xab')).to.throw(Error);
  });

  it('rejects odd-length and non-hex input', () => {
    expect(() => hexToBytes('abc')).to.throw(Error);
    expect(() => hexToBytes('0xabc')).to.throw(Error);
    expect(() => hexToBytes('zz')).to.throw(Error);
    expect(() => hexToBytes(' ab')).to.throw(Error);
  });

  it('round-trips with bytesToHex', () => {
    expect(bytesToHex(hexToBytes(bytesToHex(LONG_INPUT)))).to.equal(bytesToHex(LONG_INPUT));
  });
});

describe('concatBytes', () => {
  it('concatenates zero, one and several arrays', () => {
    expect(concatBytes()).to.deep.equal(new Uint8Array());
    expect(concatBytes(Uint8Array.of(1))).to.deep.equal(Uint8Array.of(1));
    expect(concatBytes(Uint8Array.of(1), new Uint8Array(), Uint8Array.of(2, 3))).to.deep.equal(
      Uint8Array.of(1, 2, 3)
    );
  });

  it('returns a fresh array, never a view of an input', () => {
    const only = Uint8Array.of(7);
    const out = concatBytes(only);
    out[0] = 8;
    expect(only[0]).to.equal(7);
  });
});

describe('utf8ToBytes', () => {
  it('encodes the state-sync receipt prefix', () => {
    expect(bytesToHex(utf8ToBytes('matic-bor-receipt-'))).to.equal(
      '6d617469632d626f722d726563656970742d'
    );
  });
});

describe('compareBytes', () => {
  it('orders like Buffer.compare', () => {
    expect(compareBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).to.equal(0);
    expect(compareBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).to.equal(-1);
    expect(compareBytes(Uint8Array.of(0xff), Uint8Array.of(0x01, 0x00))).to.equal(1);
    expect(compareBytes(Uint8Array.of(1), Uint8Array.of(1, 0))).to.equal(-1);
    expect(compareBytes(Uint8Array.of(1, 0), Uint8Array.of(1))).to.equal(1);
  });
});

describe('setLengthLeft', () => {
  it('left-pads short input and keeps the rightmost bytes of long input', () => {
    expect(setLengthLeft(Uint8Array.of(1, 2), 4)).to.deep.equal(Uint8Array.of(0, 0, 1, 2));
    expect(setLengthLeft(Uint8Array.of(1, 2, 3, 4), 2)).to.deep.equal(Uint8Array.of(3, 4));
    expect(setLengthLeft(Uint8Array.of(1, 2), 2)).to.deep.equal(Uint8Array.of(1, 2));
  });
});

describe('Keccak', () => {
  for (const bits of WIDTHS) {
    it(`keccak${bits} of the empty input and of "foo"`, () => {
      expect(bytesToHex(Keccak.keccak(new Uint8Array(), bits))).to.equal(KECCAK_EMPTY[bits]);
      expect(bytesToHex(Keccak.keccak(utf8ToBytes('foo'), bits))).to.equal(KECCAK_FOO[bits]);
    });
  }

  it('defaults to 256 bits, and keccak256 is the same function', () => {
    expect(bytesToHex(Keccak.keccak(utf8ToBytes('foo')))).to.equal(KECCAK_FOO[256]);
    expect(bytesToHex(Keccak.keccak256(utf8ToBytes('foo')))).to.equal(KECCAK_FOO[256]);
  });

  it('hashes a multi-block input', () => {
    expect(bytesToHex(Keccak.keccak256(LONG_INPUT))).to.equal(LONG_INPUT_KECCAK256);
  });

  it('hashes a subarray view by its own bounds', () => {
    expect(bytesToHex(Keccak.keccak256(Uint8Array.of(9, 1, 2, 9).subarray(1, 3)))).to.equal(
      '22ae6da6b482f9b1b19b0b897c3fd43884180a1c5ee361e1107a1bc635649dda'
    );
  });

  it('rejects a string with POSBridgeError before hashing', () => {
    // Reflect.apply bypasses the parameter type the way a JavaScript caller would.
    const call = (): void => {
      Reflect.apply(Keccak.keccak256, undefined, ['foo']);
    };
    expect(call).to.throw(POSBridgeError);
    try {
      call();
    } catch (err) {
      expect(err).property('code', 'BUFFER_TYPE_REQUIRED');
    }
  });

  it('rejects an unsupported width', () => {
    expect(() => Keccak.keccak(new Uint8Array(), 128)).to.throw(POSBridgeError, 'keccak128');
  });
});

describe('adapter keccak256', () => {
  const UNREACHABLE = 'http://127.0.0.1:1';
  const v6Provider = new JsonRpcProvider(UNREACHABLE, V6Network.from(1), { staticNetwork: true });
  const adapters = {
    viem: viemAdapter({ public: createPublicClient({ transport: http(UNREACHABLE) }) }),
    'ethers-v5': ethersV5Adapter({
      provider: new v5Providers.StaticJsonRpcProvider(UNREACHABLE, 1)
    }),
    'ethers-v6': ethersV6Adapter({ provider: v6Provider })
  };

  afterAll(() => {
    v6Provider.destroy();
  });

  const FOO_HEX = bytesToHex(utf8ToBytes('foo'));
  const FOO_DIGEST = `0x${KECCAK_FOO[256]}`;

  for (const [name, adapter] of Object.entries(adapters)) {
    describe(name, () => {
      it('returns the same 0x-prefixed digest for a Uint8Array and for a hex string', () => {
        expect(adapter.keccak256(utf8ToBytes('foo'))).to.equal(FOO_DIGEST);
        expect(adapter.keccak256(`0x${FOO_HEX}`)).to.equal(FOO_DIGEST);
      });

      it('accepts unprefixed, uppercase-prefixed and uppercase-digit hex', () => {
        expect(adapter.keccak256(FOO_HEX)).to.equal(FOO_DIGEST);
        expect(adapter.keccak256(`0X${FOO_HEX}`)).to.equal(FOO_DIGEST);
        expect(adapter.keccak256(`0x${FOO_HEX.toUpperCase()}`)).to.equal(FOO_DIGEST);
      });

      it('strips a doubled 0x prefix (adapter strip, then hexToBytes strip)', () => {
        expect(adapter.keccak256(`0x0x${FOO_HEX}`)).to.equal(FOO_DIGEST);
      });

      it('hashes the empty input', () => {
        expect(adapter.keccak256('0x')).to.equal(`0x${KECCAK_EMPTY[256]}`);
        expect(adapter.keccak256(new Uint8Array())).to.equal(`0x${KECCAK_EMPTY[256]}`);
      });

      it('hashes a multi-block input', () => {
        expect(adapter.keccak256(LONG_INPUT)).to.equal(`0x${LONG_INPUT_KECCAK256}`);
        expect(adapter.keccak256(`0x${bytesToHex(LONG_INPUT)}`)).to.equal(
          `0x${LONG_INPUT_KECCAK256}`
        );
      });

      it('rejects odd-length and non-hex strings', () => {
        expect(() => adapter.keccak256('0xabc')).to.throw(Error);
        expect(() => adapter.keccak256('0xzz')).to.throw(Error);
      });
    });
  }
});
