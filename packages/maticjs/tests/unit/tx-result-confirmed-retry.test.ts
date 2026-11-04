import type { PublicClient, WalletClient } from 'viem';

import { describe, expect, it } from 'vitest';

import { ChildERC20ABI } from '../../src/abi/index.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';

/**
 * Pins the `confirmed()` memoisation contract (go-live review, major):
 * concurrent callers share ONE in-flight receipt wait, but a REJECTION
 * is evicted from the memo so the next call starts a fresh wait. The
 * old behaviour cached the rejection forever — a single transient RPC
 * blip (or viem's default 180s wait timeout) permanently poisoned the
 * TxResult even though the tx later mined.
 */

const HASH = '0x1111111111111111111111111111111111111111111111111111111111111111';
const RECEIPT = {
  transactionHash: HASH,
  status: 'success',
  blockNumber: 123n,
  logs: []
};

function stubClients(waitBehaviours: Array<'reject' | 'resolve'>): {
  public: PublicClient;
  wallet: WalletClient;
  waitCalls: () => number;
} {
  let calls = 0;
  const publicClient = {
    getChainId: () => Promise.resolve(80002),
    waitForTransactionReceipt: () => {
      const behaviour = waitBehaviours[Math.min(calls, waitBehaviours.length - 1)];
      calls++;
      return behaviour === 'reject'
        ? Promise.reject(new Error('WaitForTransactionReceiptTimeoutError: transient'))
        : Promise.resolve(RECEIPT);
    }
  };
  const walletClient = {
    account: { address: '0x2222222222222222222222222222222222222222', type: 'json-rpc' },
    chain: null,
    writeContract: () => Promise.resolve(HASH)
  };
  return {
    public: publicClient as unknown as PublicClient,
    wallet: walletClient as unknown as WalletClient,
    waitCalls: () => calls
  };
}

describe('TxResult.confirmed() — memoisation with rejection eviction', () => {
  it('a transient wait failure does not poison the result: retry succeeds', async () => {
    const clients = stubClients(['reject', 'resolve']);
    const adapter = viemAdapter({ public: clients.public, wallet: clients.wallet });
    const result = await adapter.write({
      address: '0x3333333333333333333333333333333333333333',
      abi: ChildERC20ABI,
      functionName: 'withdraw',
      args: [1n]
    });

    const first = await result.confirmed().then(
      () => null,
      (e: unknown) => e
    );
    expect(first).instanceOf(Error);
    expect((first as Error).message).contains('transient');

    const receipt = await result.confirmed();
    expect(receipt).property('status').equals('success');
    expect(receipt).property('blockNumber').equals(123n);
    expect(clients.waitCalls()).equals(2);
  });

  it('concurrent callers share one in-flight wait (memoisation preserved)', async () => {
    const clients = stubClients(['resolve']);
    const adapter = viemAdapter({ public: clients.public, wallet: clients.wallet });
    const result = await adapter.write({
      address: '0x3333333333333333333333333333333333333333',
      abi: ChildERC20ABI,
      functionName: 'withdraw',
      args: [1n]
    });

    const [a, b] = await Promise.all([result.confirmed(), result.confirmed()]);
    expect(a).property('transactionHash').equals(HASH);
    expect(b).property('transactionHash').equals(HASH);
    expect(clients.waitCalls()).equals(1);
  });

  it('a successful receipt stays memoised across later calls', async () => {
    const clients = stubClients(['resolve']);
    const adapter = viemAdapter({ public: clients.public, wallet: clients.wallet });
    const result = await adapter.write({
      address: '0x3333333333333333333333333333333333333333',
      abi: ChildERC20ABI,
      functionName: 'withdraw',
      args: [1n]
    });

    await result.confirmed();
    await result.confirmed();
    expect(clients.waitCalls()).equals(1);
  });
});

describe('WriteRequest.chainId cross-chain mis-send guard', () => {
  it('rejects the write before broadcasting when the connected chain differs', async () => {
    const clients = stubClients(['resolve']);
    const adapter = viemAdapter({ public: clients.public, wallet: clients.wallet });
    const err = await adapter
      .write({
        address: '0x3333333333333333333333333333333333333333',
        abi: ChildERC20ABI,
        functionName: 'withdraw',
        args: [1n],
        chainId: 137 // stub chain reports 80002
      })
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(err).not.equals(null);
    expect(err).property('code').equals('UNSUPPORTED_NETWORK');
    expect((err as { info: { actual: number } }).info).property('actual').equals(80002);
  });

  it('proceeds when the pinned chainId matches', async () => {
    const clients = stubClients(['resolve']);
    const adapter = viemAdapter({ public: clients.public, wallet: clients.wallet });
    const result = await adapter.write({
      address: '0x3333333333333333333333333333333333333333',
      abi: ChildERC20ABI,
      functionName: 'withdraw',
      args: [1n],
      chainId: 80002
    });
    expect(result).property('hash').equals(HASH);
  });
});

describe('adapter runtime shape — inspectable and Proxy-safe (no hard-private fields)', () => {
  it('exposes the exact clients the consumer passed in', () => {
    const clients = stubClients(['resolve']);
    const adapter = viemAdapter({ public: clients.public, wallet: clients.wallet });
    const viewed = adapter as unknown as { publicClient: unknown; walletClient: unknown };
    expect(viewed.publicClient).equals(clients.public);
    expect(viewed.walletClient).equals(clients.wallet);
  });

  it('methods work through a Proxy wrapper (Vue reactive() / Pinia state shape)', async () => {
    const clients = stubClients(['resolve']);
    const adapter = viemAdapter({ public: clients.public, wallet: clients.wallet });
    // Hard `#` privates throw 'Cannot read private member' here — this
    // pins the deliberate choice of TS-private plain properties.
    const proxied = new Proxy(adapter, {});
    expect(await proxied.getChainId()).equals(80002);
    const result = await proxied.write({
      address: '0x3333333333333333333333333333333333333333',
      abi: ChildERC20ABI,
      functionName: 'withdraw',
      args: [1n]
    });
    expect(result).property('hash').equals(HASH);
  });
});
