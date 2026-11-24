import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { describe, expect, it } from 'vitest';

import type { Hex } from '../../src/adapter.ts';
import type { StubNode } from './contract-call-harness.ts';

import { ChildERC721ABI } from '../../src/abi/ChildERC721.ts';
import { InvalidNumericValueError } from '../../src/errors.ts';
import { noopLogger } from '../../src/logger.ts';
import { POSClient } from '../../src/pos-client.ts';
import { __resetAddressCacheForTesting } from '../../src/services/address-service.ts';
import { StakingClient } from '../../src/staking/staking-client.ts';
import {
  adapterOver,
  ADDRESSES,
  outcomeOf,
  quantity,
  RecordingAdapter,
  RequestLog,
  show,
  STAKING_ADDRESSES,
  USER,
  VALIDATOR_SHARE
} from './contract-call-harness.ts';

/**
 * What the two public methods that take a plain `number` for an integer
 * contract argument do with each number, well formed or not: the ERC-721
 * `index` of `getTokenIdAtIndexForUser` and the permit `v` of
 * `delegateWithPermit` / `prepareDelegateWithPermit`.
 *
 * Each row pins the outcome on a recording adapter, which shows the argument
 * the SDK hands the adapter, and for the real viem adapter over a stub
 * transport, which shows what reaches the node (or what the library throws
 * while encoding it). A number that is not a non-negative safe integer is
 * rejected with the SDK's own `InvalidNumericValueError` before any request
 * is built.
 */

const ERC721: Hex = '0x00000000000000000000000000000000000000c2';
const R: Hex = `0x${'01'.repeat(32)}`;
const S: Hex = `0x${'02'.repeat(32)}`;

const INPUTS: ReadonlyArray<readonly [name: string, value: number]> = [
  ['0', 0],
  ['3', 3],
  ['0.5', 0.5],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-1', -1],
  ['MAX_SAFE_INTEGER + 2', Number.MAX_SAFE_INTEGER + 2]
];

const IDX = '0x00000000000000000000000000000000000000a1';
const NODE_IDX = '0x00000000000000000000000000000000000000A1';
const READ_REJECTED = 'threw TokenReadError > InvalidNumericValueError';
const WRITE_REJECTED = 'threw StakingWriteError > InvalidNumericValueError';
const SENT = 'value sent';
const PREPARED = 'value prepared';
const word = (n: number): string => `value v word 0x${n.toString(16).padStart(64, '0')}`;

/** `[input, recording adapter, viem adapter]`: what the adapter received, and what reached the node. */
type Row = readonly [input: string, recording: string, viem: string];

const INDEX_ROWS: readonly Row[] = [
  [
    '0',
    `value 42n | adapter ["${IDX}", 0n]`,
    `value 42n | node tokenOfOwnerByIndex["${NODE_IDX}", 0n]`
  ],
  [
    '3',
    `value 42n | adapter ["${IDX}", 3n]`,
    `value 42n | node tokenOfOwnerByIndex["${NODE_IDX}", 3n]`
  ],
  ['0.5', `${READ_REJECTED} | adapter not called`, `${READ_REJECTED} | node not called`],
  ['NaN', `${READ_REJECTED} | adapter not called`, `${READ_REJECTED} | node not called`],
  ['Infinity', `${READ_REJECTED} | adapter not called`, `${READ_REJECTED} | node not called`],
  ['-1', `${READ_REJECTED} | adapter not called`, `${READ_REJECTED} | node not called`],
  [
    'MAX_SAFE_INTEGER + 2',
    `${READ_REJECTED} | adapter not called`,
    `${READ_REJECTED} | node not called`
  ]
];

/** The permit write has no viem column: a real write needs a signer, and the prepared call shows the same encoding. */
const WRITE_V_ROWS: readonly Row[] = [
  ['0', `${SENT} | adapter v [0n]`, ''],
  ['3', `${SENT} | adapter v [3n]`, ''],
  ['0.5', `${WRITE_REJECTED} | adapter v not called`, ''],
  ['NaN', `${WRITE_REJECTED} | adapter v not called`, ''],
  ['Infinity', `${WRITE_REJECTED} | adapter v not called`, ''],
  ['-1', `${WRITE_REJECTED} | adapter v not called`, ''],
  ['MAX_SAFE_INTEGER + 2', `${WRITE_REJECTED} | adapter v not called`, '']
];

const PREPARE_V_ROWS: readonly Row[] = [
  ['0', `${PREPARED} | adapter v [0n]`, word(0)],
  ['3', `${PREPARED} | adapter v [3n]`, word(3)],
  ['0.5', `${WRITE_REJECTED} | adapter v not called`, WRITE_REJECTED],
  ['NaN', `${WRITE_REJECTED} | adapter v not called`, WRITE_REJECTED],
  ['Infinity', `${WRITE_REJECTED} | adapter v not called`, WRITE_REJECTED],
  ['-1', `${WRITE_REJECTED} | adapter v not called`, WRITE_REJECTED],
  ['MAX_SAFE_INTEGER + 2', `${WRITE_REJECTED} | adapter v not called`, WRITE_REJECTED]
];

// --- harness -----------------------------------------------------------------------

const argsText = (args: readonly unknown[] | undefined): string => show(args ?? []);

const posRecording = async (): Promise<{ run: (n: number) => Promise<string> }> => {
  return {
    run: async (index) => {
      const log = new RequestLog();
      __resetAddressCacheForTesting();
      const pos = await POSClient.init({
        network: 'mainnet',
        parent: new RecordingAdapter({
          side: 'parent',
          log,
          chainId: 1,
          answers: { tokenOfOwnerByIndex: 42n }
        }),
        child: new RecordingAdapter({ side: 'child', log, chainId: 137 }),
        addresses: ADDRESSES,
        logger: noopLogger
      });
      const token = pos.parent.erc721(ERC721);
      const outcome = await outcomeOf({ run: () => token.getTokenIdAtIndexForUser(index, USER) });
      const [entry] = log.entries.filter((e) => e.req.functionName === 'tokenOfOwnerByIndex');
      return `${outcome} | adapter ${entry === undefined ? 'not called' : argsText(entry.req.args)}`;
    }
  };
};

const posViem = async (index: number): Promise<string> => {
  const sent: string[] = [];
  const node = (chainId: number): StubNode => ({
    chainId,
    rpc: (method, params) => {
      if (method === 'eth_chainId') return quantity(chainId);
      if (method === 'eth_call') {
        const call = params[0] as { data?: string; input?: string };
        const data = (call.data ?? call.input ?? '0x') as Hex;
        const { functionName, args } = decodeFunctionData({ abi: ChildERC721ABI, data });
        sent.push(`${functionName}${argsText(args)}`);
        return encodeFunctionResult({
          abi: ChildERC721ABI,
          functionName: 'tokenOfOwnerByIndex',
          result: 42n
        });
      }
      throw new Error(`stub node: unscripted ${method}`);
    }
  });
  __resetAddressCacheForTesting();
  const pos = await POSClient.init({
    network: 'mainnet',
    parent: adapterOver({ library: 'viem', node: node(1) }),
    child: adapterOver({ library: 'viem', node: node(137) }),
    addresses: ADDRESSES,
    logger: noopLogger
  });
  const token = pos.parent.erc721(ERC721);
  const outcome = await outcomeOf({ run: () => token.getTokenIdAtIndexForUser(index, USER) });
  return `${outcome} | node ${sent.length === 0 ? 'not called' : sent.join(' ')}`;
};

const permit = (v: number) => ({
  amount: 5n,
  minSharesToMint: 4n,
  deadline: 1_900_000_000n,
  v,
  r: R,
  s: S
});

const stakingRecording = async ({
  v,
  method
}: {
  v: number;
  method: 'delegateWithPermit' | 'prepareDelegateWithPermit';
}): Promise<string> => {
  const log = new RequestLog();
  __resetAddressCacheForTesting();
  const staking = await StakingClient.init({
    network: 'mainnet',
    parent: new RecordingAdapter({ side: 'parent', log, chainId: 1 }),
    addresses: STAKING_ADDRESSES,
    logger: noopLogger
  });
  const share = staking.validatorShare(VALIDATOR_SHARE);
  const outcome = await outcomeOf({
    run: () => share[method](permit(v)),
    project: () => (method === 'delegateWithPermit' ? 'sent' : 'prepared')
  });
  const [entry] = log.entries.filter((e) => e.req.functionName === 'buyVoucherWithPermit');
  const args = entry === undefined ? 'not called' : argsText(entry.req.args?.slice(3, 4));
  return `${outcome} | adapter v ${args}`;
};

const stakingViem = async (v: number): Promise<string> => {
  const node: StubNode = {
    chainId: 1,
    rpc: (method) => {
      if (method === 'eth_chainId') return quantity(1);
      throw new Error(`stub node: unscripted ${method}`);
    }
  };
  __resetAddressCacheForTesting();
  const staking = await StakingClient.init({
    network: 'mainnet',
    parent: adapterOver({ library: 'viem', node }),
    addresses: STAKING_ADDRESSES,
    logger: noopLogger
  });
  const share = staking.validatorShare(VALIDATOR_SHARE);
  // The calldata is the result, so a prepared call shows the encoded `v` byte.
  return outcomeOf({
    run: () => share.prepareDelegateWithPermit(permit(v)),
    project: (prepared) => {
      const data =
        typeof prepared === 'object' && prepared !== null ? Reflect.get(prepared, 'data') : '';
      // Selector (4 bytes) then amount, minShares, deadline, v: the fourth word.
      return typeof data === 'string'
        ? `v word 0x${data.slice(2 + 8 + 64 * 3, 2 + 8 + 64 * 4)}`
        : '?';
    }
  });
};

describe('integer arguments given as a number', { timeout: 60_000 }, () => {
  it('getTokenIdAtIndexForUser takes a non-negative safe integer index', async () => {
    const recording = await posRecording();
    const rows: Row[] = [];
    for (const [name, value] of INPUTS) {
      rows.push([name, await recording.run(value), await posViem(value)]);
    }
    expect(rows).deep.equals(INDEX_ROWS);
  });

  it('delegateWithPermit takes a non-negative safe integer v', async () => {
    const rows: Row[] = [];
    for (const [name, value] of INPUTS) {
      rows.push([name, await stakingRecording({ v: value, method: 'delegateWithPermit' }), '']);
    }
    expect(rows).deep.equals(WRITE_V_ROWS);
  });

  it('prepareDelegateWithPermit takes a non-negative safe integer v', async () => {
    const rows: Row[] = [];
    for (const [name, value] of INPUTS) {
      rows.push([
        name,
        await stakingRecording({ v: value, method: 'prepareDelegateWithPermit' }),
        await stakingViem(value)
      ]);
    }
    expect(rows).deep.equals(PREPARE_V_ROWS);
  });

  it('rejects with an error that names the argument and carries no cause', async () => {
    const log = new RequestLog();
    __resetAddressCacheForTesting();
    const staking = await StakingClient.init({
      network: 'mainnet',
      parent: new RecordingAdapter({ side: 'parent', log, chainId: 1 }),
      addresses: STAKING_ADDRESSES,
      logger: noopLogger
    });
    const share = staking.validatorShare(VALIDATOR_SHARE);
    const thrown = await share.prepareDelegateWithPermit(permit(0.5)).then(
      () => undefined,
      (err: unknown) => err
    );
    const inner = InvalidNumericValueError.find(thrown);
    expect(inner).an.instanceOf(InvalidNumericValueError);
    expect(inner?.message).include('v must be');
    expect(inner?.info).property('value').equals(0.5);
    expect(inner?.cause).equals(undefined);
  });
});
