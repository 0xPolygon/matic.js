import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeAbiParameters,
  toFunctionSelector
} from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Hex, TxResult } from '../../src/adapter.ts';
import type { PlasmaAddresses } from '../../src/plasma/addresses.ts';

import { viemAdapter } from '../../src/adapters/viem.ts';
import { UnsupportedNetworkError } from '../../src/errors.ts';
import { ExitProofBuilder } from '../../src/internal/exit-proof.ts';
import { L1_CHAIN_ID, L2_CHAIN_ID } from '../../src/networks.ts';
import { PlasmaClient } from '../../src/plasma/plasma-client.ts';

/**
 * Plasma writes are pinned to a chain: the parent chain for everything but
 * the burn, the child chain for the burn. The pin is only useful if the
 * adapter compares it with the chain the SIGNING wallet is on. A browser
 * wallet the user switched to the other network keeps the dapp's RPC where
 * it was, so a check against the RPC alone would pass while the wallet
 * signs on the wrong network. This drives every Plasma write through a real
 * viem public client (on the right chain) and a wallet client that can be on
 * another one, as an injected wallet is, both on stub transports. A write on
 * the wrong chain must be refused before anything is signed.
 */

const PARENT = L1_CHAIN_ID.amoy;
const CHILD = L2_CHAIN_ID.amoy;
const DECLARED = { parent: 3_151_908, child: 4_927 };
const HASH = `0x${'11'.repeat(32)}`;
const FROM: Hex = '0x2222222222222222222222222222222222222222';
const TOKEN: Hex = '0x9999999999999999999999999999999999999999';
const USER: Hex = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const QUEUE: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BURN = `0x${'ab'.repeat(32)}`;
const GAS = { gasLimit: 1_000_000n };

// Arbitrary addresses: the guard runs before anything reaches a contract.
const ADDRESSES: PlasmaAddresses = {
  RootChain: '0x1111111111111111111111111111111111111111',
  DepositManager: '0x2222222222222222222222222222222222222223',
  WithdrawManager: '0x3333333333333333333333333333333333333333',
  PlasmaERC20Predicate: '0x5555555555555555555555555555555555555555',
  ExitNFT: '0x4444444444444444444444444444444444444444',
  MaticToken: '0x6666666666666666666666666666666666666666',
  PolToken: '0x7777777777777777777777777777777777777777'
};

const word = (v: Hex | bigint): Hex =>
  encodeAbiParameters([typeof v === 'bigint' ? { type: 'uint256' } : { type: 'address' }], [v]);

const READS: Record<string, Hex> = {
  [toFunctionSelector('function exitsQueues(address)')]: word(QUEUE),
  [toFunctionSelector('function currentSize()')]: word(1n),
  [toFunctionSelector('function ON_FINALIZE_GAS_LIMIT()')]: word(300_000n)
};

/** A chain that answers its id and the queue reads `processExits` makes before it writes. */
const chainTransport = (chainId: number) =>
  custom({
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
      if (method === 'eth_call' && Array.isArray(params)) {
        const call: unknown = params[0];
        const data: unknown =
          typeof call === 'object' && call !== null ? Reflect.get(call, 'data') : undefined;
        const answer = typeof data === 'string' ? READS[data.slice(0, 10)] : undefined;
        if (answer !== undefined) return answer;
      }
      throw new Error(`stub transport: unexpected RPC ${method}`);
    }
  });

interface Chains {
  /** The chain each side's RPC is on, and the chain its wallet is on. */
  parent: { rpc: number; wallet: number };
  child: { rpc: number; wallet: number };
  chainIds?: { parent: number; child: number };
}

const build = async ({ parent, child, chainIds }: Chains) => {
  const side = ({ rpc, wallet }: { rpc: number; wallet: number }) => {
    const walletClient = createWalletClient({ account: FROM, transport: chainTransport(wallet) });
    const writeSpy = vi.spyOn(walletClient, 'writeContract').mockResolvedValue(HASH as Hex);
    return {
      adapter: viemAdapter({
        public: createPublicClient({ transport: chainTransport(rpc) }),
        wallet: walletClient
      }),
      broadcasts: () => writeSpy.mock.calls.length
    };
  };
  const parentSide = side(parent);
  const childSide = side(child);
  const plasma = await PlasmaClient.init({
    network: 'amoy',
    parent: parentSide.adapter,
    child: childSide.adapter,
    addresses: ADDRESSES,
    ...(chainIds !== undefined ? { chainIds } : {})
  });
  return {
    plasma,
    broadcasts: () => parentSide.broadcasts() + childSide.broadcasts()
  };
};

interface Write {
  name: string;
  side: 'parent' | 'child';
  /** The write's `info.operation`. */
  operation: string;
  run: (plasma: PlasmaClient) => Promise<TxResult>;
}

const WRITES: Write[] = [
  {
    name: 'approve',
    side: 'parent',
    operation: 'approve',
    run: (p) => p.parent.erc20(TOKEN).approve(1n, GAS)
  },
  {
    name: 'approveMax',
    side: 'parent',
    operation: 'approveMax',
    run: (p) => p.parent.erc20(TOKEN).approveMax(GAS)
  },
  {
    name: 'deposit',
    side: 'parent',
    operation: 'deposit',
    run: (p) => p.parent.erc20(TOKEN).deposit(1n, USER, GAS)
  },
  {
    name: 'startWithdraw',
    side: 'child',
    operation: 'startWithdraw',
    run: (p) => p.child.erc20(TOKEN).startWithdraw(1n, GAS)
  },
  {
    name: 'startWithdraw (native token)',
    side: 'child',
    operation: 'startWithdraw',
    run: (p) => p.child.erc20('0x0000000000000000000000000000000000001010').startWithdraw(1n, GAS)
  },
  {
    name: 'confirmWithdraw',
    side: 'parent',
    operation: 'confirmWithdraw',
    run: (p) => p.parent.erc20(TOKEN).confirmWithdraw(BURN, GAS)
  },
  {
    name: 'completeWithdraw',
    side: 'parent',
    operation: 'completeWithdraw',
    run: (p) => p.parent.erc20(TOKEN).completeWithdraw(GAS)
  },
  {
    name: 'processExits',
    side: 'parent',
    operation: 'processExits',
    run: (p) => p.processExits({ tokens: [TOKEN] }, GAS)
  }
];

const rejectionOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e
  );

describe('plasma writes: signing-wallet chain guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const stubPayload = (): void => {
    // Building a payload is the golden test's job; here it only has to exist.
    vi.spyOn(ExitProofBuilder.prototype, 'buildExitPayload').mockResolvedValue('0x01');
  };

  describe.each(WRITES)('$name', (write) => {
    const expected = write.side === 'parent' ? PARENT : CHILD;
    const other = write.side === 'parent' ? CHILD : PARENT;

    // Only the wallet is wrong: the RPC reports the right chain, so a guard that
    // looked at the RPC alone would let the write through.
    it('rejects when only the wallet is on the wrong chain, before broadcasting', async () => {
      stubPayload();
      const { plasma, broadcasts } = await build({
        parent: { rpc: PARENT, wallet: write.side === 'parent' ? other : PARENT },
        child: { rpc: CHILD, wallet: write.side === 'child' ? other : CHILD }
      });

      const err = await rejectionOf(write.run(plasma));

      expect(err).nested.property('info.operation').equals(write.operation);
      const mismatch = UnsupportedNetworkError.find(err);
      expect(mismatch).nested.property('info.expected').equals(expected);
      expect(mismatch).nested.property('info.actual').equals(other);
      expect(broadcasts()).equals(0);
    });

    it('broadcasts when the wallet is on the pinned chain', async () => {
      stubPayload();
      const { plasma, broadcasts } = await build({
        parent: { rpc: PARENT, wallet: PARENT },
        child: { rpc: CHILD, wallet: CHILD }
      });

      const result = await write.run(plasma);

      expect(result).property('hash').equals(HASH);
      expect(broadcasts()).equals(1);
    });

    it('holds a devnet to the chain ids declared in chainIds, not the network preset', async () => {
      stubPayload();
      const declared = write.side === 'parent' ? DECLARED.parent : DECLARED.child;
      const { plasma, broadcasts } = await build({
        // The wallet is on the network preset's chain: right for `amoy`, wrong for the devnet.
        parent: {
          rpc: DECLARED.parent,
          wallet: write.side === 'parent' ? PARENT : DECLARED.parent
        },
        child: { rpc: DECLARED.child, wallet: write.side === 'child' ? CHILD : DECLARED.child },
        chainIds: DECLARED
      });

      const err = await rejectionOf(write.run(plasma));

      expect(UnsupportedNetworkError.find(err)).nested.property('info.expected').equals(declared);
      expect(broadcasts()).equals(0);
    });
  });
});
