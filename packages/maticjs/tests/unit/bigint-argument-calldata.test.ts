import { encodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';

import type { Hex } from '../../src/adapter.ts';

import { ChildERC721ABI, GasSwapperABI, RootChainABI } from '../../src/abi/index.ts';
import { noopLogger } from '../../src/logger.ts';
import { GasSwapper } from '../../src/pos/gas_swapper.ts';
import { adapterOver, LIBRARIES, quantity } from './contract-call-harness.ts';

/**
 * Integer contract arguments reach the adapter as `bigint`, and each web3
 * library encodes them its own way. The expected calldata here is derived, not
 * recorded: viem's `encodeFunctionData` over the ABI and the plain value. Each
 * library's adapter must send exactly that.
 *
 * Only the arguments whose calldata no other suite pins on all three libraries
 * are here. The staking writes (the permit's `v` among them) are byte-checked
 * against the 3.x capture in `staking-calldata-ground-truth`, and the Plasma
 * writes in `plasma-calldata-ground-truth`.
 */

const TOKEN: Hex = '0x00000000000000000000000000000000000000c1';
const OWNER: Hex = '0x00000000000000000000000000000000000000a1';
const SWAPPER: Hex = '0x7777777777777777777777777777777777777777';

/** Past `Number.MAX_SAFE_INTEGER`, so a library that routes it through a JS number loses digits. */
const BIG = 2n ** 64n + 1n;

/** The `data` of every `eth_call` a read puts on the wire. */
const readCalldata = async ({
  library,
  read
}: {
  library: (typeof LIBRARIES)[number];
  read: { abi: typeof RootChainABI | typeof ChildERC721ABI; functionName: string; args: unknown[] };
}): Promise<string[]> => {
  const sent: string[] = [];
  const adapter = adapterOver({
    library,
    node: {
      chainId: 1,
      rpc: (method, params) => {
        if (method === 'eth_chainId') return quantity(1);
        if (method !== 'eth_call') throw new Error(`stub node: unscripted ${method}`);
        const call = params[0] as { data?: string; input?: string };
        sent.push(call.data ?? call.input ?? '0x');
        // Five zero words: a valid encoding of every output these reads declare.
        return `0x${'00'.repeat(32 * 5)}`;
      }
    }
  });
  await adapter.read({ address: TOKEN, ...read });
  return sent;
};

describe.each(LIBRARIES)('integer arguments encode to the same calldata on %s', (library) => {
  it.each([20_000n, BIG])('RootChain.headerBlocks(%s): the checkpoint id', async (id) => {
    const sent = await readCalldata({
      library,
      read: { abi: RootChainABI, functionName: 'headerBlocks', args: [id] }
    });
    expect(sent).deep.equal([
      encodeFunctionData({ abi: RootChainABI, functionName: 'headerBlocks', args: [id] })
    ]);
  });

  it.each([0n, 3n, BIG])('ERC-721 tokenOfOwnerByIndex(owner, %s): the index', async (index) => {
    const sent = await readCalldata({
      library,
      read: { abi: ChildERC721ABI, functionName: 'tokenOfOwnerByIndex', args: [OWNER, index] }
    });
    expect(sent).deep.equal([
      encodeFunctionData({
        abi: ChildERC721ABI,
        functionName: 'tokenOfOwnerByIndex',
        args: [OWNER, index]
      })
    ]);
  });

  it.each([5n, 2n ** 256n - 1n])('GasSwapper.swapAndBridge: the amount %s', async (amount) => {
    const swapper = new GasSwapper({
      adapter: adapterOver({ library, node: { chainId: 1, rpc: () => '0x' } }),
      getAddress: () => Promise.resolve(SWAPPER),
      logger: noopLogger
    });
    const swapCallData: Hex = '0xabcdef';
    // The SDK's callers hand the amount over as a 32-byte hex word.
    const word = `0x${amount.toString(16).padStart(64, '0')}`;
    const prepared = await swapper.prepareDepositWithGas(TOKEN, word, OWNER, swapCallData);
    expect(prepared.to.toLowerCase()).equal(SWAPPER);
    expect(prepared.data).equal(
      encodeFunctionData({
        abi: GasSwapperABI,
        functionName: 'swapAndBridge',
        args: [TOKEN, amount, OWNER, swapCallData]
      })
    );
  });
});
