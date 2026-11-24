import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  Adapter,
  PreparedTx,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';
import type * as ContractCallerModule from '../../src/internal/contract-caller.ts';
import type { ContractCallerConfig } from '../../src/internal/contract-caller.ts';
import type { NetworkAddresses } from '../../src/networks.ts';
import type { PlasmaAddresses } from '../../src/plasma/addresses.ts';

import { RootChainABI } from '../../src/abi/RootChain.ts';
import { RootChainManagerABI } from '../../src/abi/RootChainManager.ts';
import { noopLogger } from '../../src/logger.ts';
import { PlasmaClient } from '../../src/plasma/plasma-client.ts';
import { POSClient } from '../../src/pos-client.ts';
import { GasSwapper } from '../../src/pos/gas_swapper.ts';

// Every `ContractCaller` built while a test runs records the ABI it was built
// over, and otherwise behaves as the real class. Counting constructions per ABI
// is how the tests below see how many callers a client init builds, without
// reaching into any private field.
const built = vi.hoisted((): unknown[] => []);

vi.mock('../../src/internal/contract-caller.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ContractCallerModule>();
  class CountingCaller<TAbi extends readonly unknown[]> extends actual.ContractCaller<TAbi> {
    constructor(config: ContractCallerConfig<TAbi>) {
      super(config);
      built.push(config.abi);
    }
  }
  return { ...actual, ContractCaller: CountingCaller };
});

const builtOver = (abi: unknown): number => built.filter((a) => a === abi).length;

/**
 * The contract callers inside the bridge handles are an implementation detail
 * of the SDK, not something a consumer may reach. They were once readable
 * members marked as internal in a comment only, so they appeared in the
 * published declarations and were reachable from plain JavaScript. They are
 * now `#` fields: absent from the declarations, and not a property at run
 * time. The `@ts-expect-error` lines below are checked by `tsc`, so each one
 * fails the typecheck the day the member comes back.
 */

const ADDRESSES: NetworkAddresses = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666',
  StakeManager: '0x7777777777777777777777777777777777777777',
  MaticToken: '0x8888888888888888888888888888888888888888',
  PolToken: '0x9999999999999999999999999999999999999999'
};

class NoopAdapter implements Adapter {
  getChainId(): Promise<number> {
    return Promise.resolve(1);
  }
  read(_req: ReadRequest): Promise<unknown> {
    return Promise.resolve(0n);
  }
  write(_req: WriteRequest): Promise<TxResult> {
    return Promise.resolve({ hash: '0xdead', confirmed: () => Promise.resolve({} as Receipt) });
  }
  prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    return Promise.resolve({ to: req.address, data: '0xfeed' });
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

describe('the callers inside the bridge handles are not reachable', () => {
  const init = (): Promise<POSClient> =>
    POSClient.init({
      network: 'mainnet',
      parent: new NoopAdapter(),
      child: new NoopAdapter(),
      addresses: ADDRESSES
    });

  it('RootChainManager has no caller member, in the types or at run time', async () => {
    const pos = await init();
    // @ts-expect-error the member is private to the class
    void pos.rootChainManager.caller;
    expect('caller' in pos.rootChainManager).equals(false);
    expect(Object.getOwnPropertyNames(pos.rootChainManager)).not.include('caller');
  });

  it('RootChain has no caller member, in the types or at run time', async () => {
    const pos = await init();
    // @ts-expect-error the member is private to the class
    void pos.rootChain.caller;
    expect('caller' in pos.rootChain).equals(false);
    expect(Object.getOwnPropertyNames(pos.rootChain)).not.include('caller');
  });

  it('GasSwapper has no caller member, in the types or at run time', () => {
    const swapper = new GasSwapper({
      adapter: new NoopAdapter(),
      getAddress: () => Promise.resolve('0x1111111111111111111111111111111111111111'),
      logger: noopLogger
    });
    // @ts-expect-error the member is private to the class
    void swapper.caller;
    expect('caller' in swapper).equals(false);
    expect(Object.getOwnPropertyNames(swapper)).not.include('caller');
  });

  it('the handles still call through their private caller', async () => {
    const pos = await init();
    const prepared = await pos.rootChainManager.prepareExit('0x');
    expect(prepared.to).equals(ADDRESSES.RootChainManager);
    expect(await pos.rootChain.getLastChildBlock()).equals(0n);
  });
});

const PLASMA_ADDRESSES: PlasmaAddresses = {
  RootChain: '0x6666666666666666666666666666666666666666',
  DepositManager: '0x1111111111111111111111111111111111111111',
  WithdrawManager: '0x2222222222222222222222222222222222222222',
  PlasmaERC20Predicate: '0x3333333333333333333333333333333333333333',
  ExitNFT: '0x4444444444444444444444444444444444444444',
  MaticToken: '0x8888888888888888888888888888888888888888',
  PolToken: '0x9999999999999999999999999999999999999999'
};

describe('a client init builds each shared caller once', () => {
  beforeEach(() => {
    built.length = 0;
  });

  // The handle, the bridge helpers and the ETH deposit each need the contract's
  // caller. Any of them building its own would show up as a second construction.
  it('POSClient builds one RootChainManager caller and one RootChain caller', async () => {
    await POSClient.init({
      network: 'mainnet',
      parent: new NoopAdapter(),
      child: new NoopAdapter(),
      addresses: ADDRESSES
    });
    expect(builtOver(RootChainManagerABI)).equals(1);
    expect(builtOver(RootChainABI)).equals(1);
  });

  it('PlasmaClient builds one RootChain caller, shared with the exit-proof builder', async () => {
    await PlasmaClient.init({
      network: 'mainnet',
      parent: new NoopAdapter(),
      child: new NoopAdapter(),
      addresses: PLASMA_ADDRESSES
    });
    expect(builtOver(RootChainABI)).equals(1);
  });
});
