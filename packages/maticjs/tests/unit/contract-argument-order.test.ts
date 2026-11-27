import { decodeAbiParameters } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Hex } from '../../src/adapter.ts';
import type { POSBridgeHelpers } from '../../src/internal/pos-bridge-helpers.ts';

import {
  ChildERC1155ABI,
  ChildERC20ABI,
  ChildERC721ABI,
  GasSwapperABI,
  RootChainManagerABI
} from '../../src/abi/index.ts';
import { encodeAbiParameters } from '../../src/internal/abi-encode.ts';
import { noopLogger } from '../../src/logger.ts';
import { POSClient } from '../../src/pos-client.ts';
import { ERC20 } from '../../src/pos/erc20.ts';
import { ERC721 } from '../../src/pos/erc721.ts';
import { ERC1155 } from '../../src/pos/erc1155.ts';
import { GasSwapper } from '../../src/pos/gas_swapper.ts';
import { RootChainManager } from '../../src/pos/root_chain_manager.ts';
import { __resetAddressCacheForTesting } from '../../src/services/address-service.ts';
import {
  ADDRESSES,
  RecordingAdapter,
  RequestLog,
  STAKING_ADDRESSES
} from './contract-call-harness.ts';

/**
 * Two arguments of the same type swapped in the SDK source still compile
 * (addresses are plain strings, amounts are bigints), and nothing else offline
 * pins their order. Each row calls a public method with a distinct value for
 * every parameter and expects the request to carry them in the order the ABI
 * names its inputs, so the expectation is read from the ABI, not retyped.
 */

const TOKEN: Hex = '0x00000000000000000000000000000000000000c1';
const A: Hex = '0x00000000000000000000000000000000000000a1';
const B: Hex = '0x00000000000000000000000000000000000000b2';
const ETHER = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const BYTES = '0xdeadbeef';

type Abi = readonly { type: string; name?: string; inputs?: readonly { name: string }[] }[];

interface Row {
  method: string;
  functionName: string;
  abi: Abi;
  /** The contract the request must go to. */
  to: string;
  /** The value each ABI input (by name) must receive. */
  values: Record<string, unknown>;
  /** ABI-encoded inputs: decoded against `types`, they must hold `values`. */
  blobs?: Record<string, { types: string[]; values: unknown[] }>;
  run: (w: World) => Promise<unknown>;
}

interface World {
  log: RequestLog;
  erc20: ERC20;
  erc721: ERC721;
  erc1155: ERC1155;
  child1155: ERC1155;
  pos: POSClient;
}

const INDEX = { ...ADDRESSES, ...STAKING_ADDRESSES };

/** Each contract a row can hit: its ABI and where the request must go. */
const ON_721 = { abi: ChildERC721ABI, to: TOKEN };
const ON_1155 = { abi: ChildERC1155ABI, to: TOKEN };
const ON_20 = { abi: ChildERC20ABI, to: TOKEN };
const ON_ROOT = { abi: RootChainManagerABI, to: ADDRESSES.RootChainManager };
const ON_SWAPPER = { abi: GasSwapperABI, to: ADDRESSES.GasSwapper };

const world = async (): Promise<World> => {
  const log = new RequestLog();
  const adapter = new RecordingAdapter({ side: 'parent', log });
  const rootChainManager = new RootChainManager({
    adapter,
    getAddress: () => Promise.resolve(ADDRESSES.RootChainManager),
    logger: noopLogger
  });
  const gasSwapper = new GasSwapper({
    adapter,
    getAddress: () => Promise.resolve(ADDRESSES.GasSwapper),
    logger: noopLogger
  });
  const bridge = { getPredicateAddress: () => Promise.resolve(B) } as unknown as POSBridgeHelpers;
  const config = (isParent: boolean) => ({
    tokenAddress: TOKEN,
    isParent,
    adapter,
    bridge,
    rootChainManager,
    gasSwapper,
    parentAdapter: adapter,
    encodeParameters: encodeAbiParameters,
    logger: noopLogger
  });
  const pos = await POSClient.init({
    network: 'mainnet',
    parent: adapter,
    child: new RecordingAdapter({ side: 'child', log: new RequestLog() }),
    addressIndexUrl: 'https://address-index.test/argument-order'
  });
  return {
    log,
    erc20: new ERC20(config(true)),
    erc721: new ERC721(config(true)),
    erc1155: new ERC1155(config(true)),
    child1155: new ERC1155(config(false)),
    pos
  };
};

const ROWS: Row[] = [
  {
    method: 'ERC721.prepareTransfer',
    functionName: 'transferFrom',
    ...ON_721,
    values: { from: A, to: B, tokenId: 31n },
    run: (w) => w.erc721.prepareTransfer(31n, A, B)
  },
  {
    method: 'ERC1155.prepareTransfer',
    functionName: 'safeTransferFrom',
    ...ON_1155,
    values: { from: A, to: B, id: 32n, amount: 33n, data: BYTES },
    run: (w) =>
      w.erc1155.prepareTransfer({ from: A, to: B, tokenId: 32n, amount: 33n, data: BYTES })
  },
  {
    method: 'ERC1155.prepareStartWithdrawMany',
    functionName: 'withdrawBatch',
    ...ON_1155,
    values: { ids: [34n, 35n], amounts: [36n, 37n] },
    run: (w) => w.child1155.prepareStartWithdrawMany([34n, 35n], [36n, 37n])
  },
  {
    method: 'ERC1155.prepareStartWithdraw',
    functionName: 'withdrawSingle',
    ...ON_1155,
    values: { id: 38n, amount: 39n },
    run: (w) => w.child1155.prepareStartWithdraw(38n, 39n)
  },
  {
    method: 'ERC1155.prepareDepositMany',
    functionName: 'depositFor',
    ...ON_ROOT,
    values: { user: A, rootToken: TOKEN },
    blobs: {
      depositData: {
        types: ['uint256[]', 'uint256[]', 'bytes'],
        values: [[41n, 42n], [43n, 44n], BYTES]
      }
    },
    run: (w) =>
      w.erc1155.prepareDepositMany({
        tokenIds: [41n, 42n],
        amounts: [43n, 44n],
        userAddress: A,
        data: BYTES
      })
  },
  {
    method: 'ERC20.prepareDeposit',
    functionName: 'depositFor',
    ...ON_ROOT,
    values: { user: A, rootToken: TOKEN },
    blobs: { depositData: { types: ['uint256'], values: [45n] } },
    run: (w) => w.erc20.prepareDeposit(45n, A)
  },
  {
    method: 'ERC20.prepareDepositWithGas',
    functionName: 'swapAndBridge',
    ...ON_SWAPPER,
    values: { token: TOKEN, amount: 46n, user: A, swapCallData: BYTES },
    run: (w) => w.erc20.prepareDepositWithGas(46n, A, 47n, BYTES)
  },
  {
    method: 'POSClient.prepareDepositEtherWithGas',
    functionName: 'swapAndBridge',
    ...ON_SWAPPER,
    values: { token: ETHER, amount: 48n, user: A, swapCallData: BYTES },
    run: (w) => w.pos.prepareDepositEtherWithGas(48n, A, 49n, BYTES)
  },
  {
    method: 'ERC20.getAllowance',
    functionName: 'allowance',
    ...ON_20,
    values: { owner: A, spender: B },
    run: (w) => w.erc20.getAllowance(A, { spenderAddress: B })
  },
  {
    method: 'ERC721.isApprovedAll',
    functionName: 'isApprovedForAll',
    ...ON_721,
    values: { owner: A, operator: B },
    run: (w) => w.erc721.isApprovedAll(A)
  },
  {
    method: 'ERC1155.isApprovedAll',
    functionName: 'isApprovedForAll',
    ...ON_1155,
    values: { account: A, operator: B },
    run: (w) => w.erc1155.isApprovedAll(A)
  }
];

describe('arguments reach the contract in the order its ABI names them', () => {
  beforeEach(() => {
    __resetAddressCacheForTesting();
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify(INDEX), { status: 200 }))
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAddressCacheForTesting();
  });

  it.each(ROWS)('$method -> $functionName', async (row) => {
    const w = await world();
    await row.run(w);
    const sent = w.log.entries.find((e) => e.req.functionName === row.functionName);
    expect(sent).not.equal(undefined);
    const inputs =
      row.abi.find((e) => e.type === 'function' && e.name === row.functionName)?.inputs ?? [];
    const names = inputs.map((i) => i.name);
    expect([...Object.keys(row.values), ...Object.keys(row.blobs ?? {})].sort()).deep.equal(
      [...names].sort()
    );
    const args = sent?.req.args ?? [];
    expect(sent?.req.address).equals(row.to);
    expect(args).lengthOf(names.length);
    names.forEach((name, i) => {
      const blob = row.blobs?.[name];
      if (blob === undefined) {
        expect(args[i], name).deep.equal(row.values[name]);
        return;
      }
      const params = blob.types.map((type) => ({ type }));
      expect(decodeAbiParameters(params, args[i] as Hex), name).deep.equal(blob.values);
    });
  });
});
