import { encodeAbiParameters, getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import type { Hex } from '../../src/adapter.ts';
import type { AbiFunction, AbiParameter } from '../../src/internal/abi-types.ts';
import type { LibraryName } from './contract-call-harness.ts';

import {
  FailedStateSyncHashesABI,
  ReplayFailedStateSyncABI
} from '../../src/abi/failed-state-sync.ts';
import * as bridgeAbis from '../../src/abi/index.ts';
import * as plasmaAbis from '../../src/abi/plasma/index.ts';
import { decodeAbiResult, decodeAbiValue } from '../../src/internal/decode.ts';
import { adapterOver, LIBRARIES, quantity } from './contract-call-harness.ts';

/**
 * The type mapping in `abi-types.ts` and the decoder in `decode.ts` are two
 * readings of the same ABI that TypeScript cannot compare. This test is what
 * pins them together, for EVERY function of every vendored ABI:
 *
 * 1. every input and output type is one the decoder supports, so a future ABI
 *    that carries a tuple fails here, loudly, instead of being typed loosely;
 * 2. for every view function, a result encoded by viem is read back through
 *    the real viem, ethers v5 and ethers v6 adapters (over a stub transport),
 *    each raw value is decoded, and the three decoded values are equal to one
 *    another and to the value that was encoded, with the run-time kind the
 *    type mapping names (`bigint` for any integer, a `0x` string for an
 *    address or bytes, ...).
 *
 * Only `function` entries are walked: constructors, events and errors are
 * never read.
 */

const ABIS: ReadonlyArray<readonly [string, readonly unknown[]]> = [
  ...Object.entries(bridgeAbis),
  ...Object.entries(plasmaAbis),
  ['FailedStateSyncHashesABI', FailedStateSyncHashesABI],
  ['ReplayFailedStateSyncABI', ReplayFailedStateSyncABI]
];

const isFunction = (entry: unknown): entry is AbiFunction =>
  typeof entry === 'object' && entry !== null && 'type' in entry && entry.type === 'function';

const ARRAY_SUFFIX = /^(.*)\[([0-9]*)\]$/;

/**
 * A value of an ABI type in the form viem and the SDK both use: bigint for an
 * integer, a checksummed address, a lowercase hex for bytes. `seed` makes
 * values differ per position so a swapped field would show.
 */
const sampleOf = ({ type, seed }: { type: string; seed: number }): unknown => {
  const array = ARRAY_SUFFIX.exec(type);
  if (array !== null) {
    const [, element = '', size = ''] = array;
    const length = size === '' ? 2 : Number(size);
    return Array.from({ length }, (_unused, i) => sampleOf({ type: element, seed: seed + i + 1 }));
  }
  if (type === 'address') return getAddress(`0x${(seed + 1).toString(16).padStart(40, 'a')}`);
  if (type === 'bool') return seed % 2 === 0;
  if (type === 'string') return `text ${seed}`;
  if (type === 'bytes') return `0x${(seed + 1).toString(16).padStart(6, '0')}`;
  const fixed = /^bytes([0-9]+)$/.exec(type);
  if (fixed !== null)
    return `0x${(seed + 1).toString(16).padStart(2, '0').repeat(Number(fixed[1]))}`;
  const integer = /^(u?)int([0-9]*)$/.exec(type);
  if (integer !== null) {
    // Small enough for uint8 and for int8 in either sign.
    const magnitude = BigInt((seed % 100) + 1);
    return integer[1] === 'u' ? magnitude : -magnitude;
  }
  throw new Error(`no sample for ABI type ${type}`);
};

const samplesOf = (params: readonly AbiParameter[]): unknown[] =>
  params.map((p, i) => sampleOf({ type: p.type, seed: i * 7 }));

/** The run-time kind the type mapping names for an ABI type. */
const kindOk = ({ type, value }: { type: string; value: unknown }): boolean => {
  const array = ARRAY_SUFFIX.exec(type);
  if (array !== null) {
    const [, element = ''] = array;
    return Array.isArray(value) && value.every((v: unknown) => kindOk({ type: element, value: v }));
  }
  if (type === 'bool') return typeof value === 'boolean';
  if (type === 'string') return typeof value === 'string';
  if (type === 'address') return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
  if (type.startsWith('bytes'))
    return typeof value === 'string' && /^0x([0-9a-f]{2})*$/.test(value);
  return typeof value === 'bigint';
};

const ADDRESS: Hex = '0x00000000000000000000000000000000000000c1';
const CHAIN_ID = 1;

/** The three real adapters over a node that answers `eth_call` with `data()`. */
const adaptersAnswering = (
  data: () => Hex
): Record<LibraryName, ReturnType<typeof adapterOver>> => {
  const node = {
    chainId: CHAIN_ID,
    rpc: (method: string): unknown => {
      if (method === 'eth_chainId') return quantity(CHAIN_ID);
      if (method === 'eth_blockNumber') return quantity(1_000_000n);
      if (method === 'eth_call') return data();
      throw new Error(`stub node: unscripted ${method}`);
    }
  };
  return {
    viem: adapterOver({ library: 'viem', node }),
    'ethers v5': adapterOver({ library: 'ethers v5', node }),
    'ethers v6': adapterOver({ library: 'ethers v6', node })
  };
};

let encoded: Hex = '0x';
const adapters = adaptersAnswering(() => encoded);

describe.each(ABIS)('%s', (_name, abi) => {
  const functions = abi.filter(isFunction);

  it('has only types the decoder supports, on every input and output', () => {
    for (const fn of functions) {
      for (const [i, p] of [...fn.inputs, ...(fn.outputs ?? [])].entries()) {
        // Decoding a sample of the type succeeds only if the type is supported.
        expect(() =>
          decodeAbiValue({
            type: p.type,
            value: sampleOf({ type: p.type, seed: i }),
            field: `${fn.name}.${i}`
          })
        ).not.throw();
      }
    }
  });

  for (const fn of functions.filter(
    (f) =>
      (f.stateMutability === 'view' || f.stateMutability === 'pure') && (f.outputs?.length ?? 0) > 0
  )) {
    it.each(LIBRARIES)(
      `${fn.name}(${fn.inputs.map((p) => p.type).join(',')}) reads back the same on %s`,
      async (library) => {
        const outputs = fn.outputs ?? [];
        const values = samplesOf(outputs);
        const expected = outputs.length === 1 ? values[0] : values;
        // What a node answers an `eth_call` with: the ABI encoding of the outputs.
        encoded = encodeAbiParameters(outputs, values);
        const raw = await adapters[library].read({
          address: ADDRESS,
          abi,
          functionName: fn.name,
          args: samplesOf(fn.inputs)
        });
        const decoded = decodeAbiResult({ abi, method: fn.name, raw });
        expect(decoded).deep.equal(expected);
        if (outputs.length === 1) {
          expect(kindOk({ type: outputs[0]?.type ?? '', value: decoded })).equal(true);
        } else if (Array.isArray(decoded)) {
          outputs.forEach((o, i) => {
            expect(kindOk({ type: o.type, value: decoded[i] })).equal(true);
          });
        }
      }
    );
  }
});

describe('coverage', () => {
  it('walks every exported ABI, each with at least one function', () => {
    // The two barrels export 21 ABIs and the hand-carried file adds two fragments.
    expect(ABIS.length).least(23);
    for (const [name, abi] of ABIS) {
      expect(abi.filter(isFunction).length, name).least(1);
    }
  });
});
