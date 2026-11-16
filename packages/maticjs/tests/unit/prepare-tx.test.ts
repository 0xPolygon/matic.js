import { describe, expect, it } from 'vitest';

import type { Adapter, PreparedTx, ReadRequest, Receipt, TxResult, WriteRequest } from '../../src/adapter.ts';

import { ChildERC20ABI } from '../../src/abi/index.ts';
import { ContractCaller } from '../../src/internal/contract-caller.ts';
import { noopLogger } from '../../src/logger.ts';

/**
 * `prepareXxx` is a pure-function path — no chain interaction, no
 * gas estimation, no chain-id lookup. The right place to validate it
 * is at the unit level: assert that the encoded `to` / `data` / `value`
 * the SDK produces are byte-correct.
 *
 * Each adapter encodes via its native library (viem's
 * `encodeFunctionData`, ethers' `Interface.encodeFunctionData`); the
 * three should produce identical calldata for a given (abi, fn, args).
 * That parity is exercised by the integration suite which runs each
 * test under all three adapters. This file pins the contract caller's
 * routing — that the right address, the right method, and the right
 * args reach the adapter.
 */

interface RecordedCall {
  req: WriteRequest;
}

class RecordingAdapter implements Adapter {
  readonly calls: RecordedCall[] = [];

  getChainId(): Promise<number> {
    return Promise.resolve(1);
  }
  read(_req: ReadRequest): Promise<unknown> {
    return Promise.resolve(undefined);
  }
  write(req: WriteRequest): Promise<TxResult> {
    this.calls.push({ req });
    return Promise.resolve({ hash: '0xdead', confirmed: () => Promise.resolve({} as Receipt) });
  }
  prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    this.calls.push({ req });
    return Promise.resolve(
      req.value !== undefined
        ? { to: req.address, data: '0xfeed', value: req.value }
        : { to: req.address, data: '0xfeed' }
    );
  }
  estimateGas(_req: WriteRequest): Promise<bigint> {
    return Promise.resolve(21_000n);
  }
  getTransactionReceipt(_hash: string): Promise<Receipt | null> {
    return Promise.resolve(null);
  }
  keccak256(_data: Uint8Array | string): string {
    return '0x0';
  }
  request<T>(_method: string, _params: readonly unknown[]): Promise<T> {
    return Promise.resolve(undefined as T);
  }
}

describe('ContractCaller.prepareWrite', () => {
  it('routes the address, method, and args to the adapter without broadcasting', async () => {
    const adapter = new RecordingAdapter();
    const caller = new ContractCaller({
      adapter,
      getAddress: () => Promise.resolve('0x1111111111111111111111111111111111111111'),
      abi: ChildERC20ABI,
      isParent: false,
      logger: noopLogger
    });

    const tx = await caller.prepareWrite('approve', [
      '0x2222222222222222222222222222222222222222',
      1_000n
    ]);

    // The single recorded call is the prepareWrite call itself — we
    // never reached the broadcasting `write` path.
    expect(adapter.calls).lengthOf(1);
    expect(adapter.calls[0]?.req.functionName).equals('approve');
    expect(adapter.calls[0]?.req.address).equals(
      '0x1111111111111111111111111111111111111111'
    );
    expect(tx.to).equals('0x1111111111111111111111111111111111111111');
    expect(tx.data).equals('0xfeed');
    // No `value` was supplied, so the prepared tx omits it.
    expect(tx.value).equals(undefined);
  });

  it('forwards `value` when present; omits when not', async () => {
    const adapter = new RecordingAdapter();
    const caller = new ContractCaller({
      adapter,
      getAddress: () => Promise.resolve('0x1111111111111111111111111111111111111111'),
      abi: ChildERC20ABI,
      isParent: true,
      logger: noopLogger
    });

    const noValue = await caller.prepareWrite('approve', ['0x0', 0n]);
    expect(noValue.value).equals(undefined);

    const withValue = await caller.prepareWrite(
      'approve',
      ['0x0', 0n],
      { value: 5_000_000n }
    );
    expect(withValue.value).equals(5_000_000n);
  });

  it('does not touch the network — no chain-id lookup, no gas estimation', async () => {
    const adapter = new RecordingAdapter();
    const caller = new ContractCaller({
      adapter,
      getAddress: () => Promise.resolve('0x1111111111111111111111111111111111111111'),
      abi: ChildERC20ABI,
      isParent: true,
      logger: noopLogger
    });

    let chainIdCalled = 0;
    let estimateCalled = 0;
    const original = adapter.getChainId.bind(adapter);
    adapter.getChainId = async () => {
      chainIdCalled++;
      return original();
    };
    const originalEstimate = adapter.estimateGas.bind(adapter);
    adapter.estimateGas = async (req: WriteRequest) => {
      estimateCalled++;
      return originalEstimate(req);
    };

    await caller.prepareWrite('approve', ['0x0', 0n]);

    expect(chainIdCalled).equals(0);
    expect(estimateCalled).equals(0);
  });
});
