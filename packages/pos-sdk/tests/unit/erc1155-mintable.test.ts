/**
 * Unit tests for `ERC1155.approveAllForMintable`.
 *
 * The mintable-ERC-1155 predicate is now plumbed from the address index
 * (`NetworkAddresses.MintableERC1155Predicate`). When present, the approve
 * targets it; when absent, the call throws the network-capability error
 * `CONTRACT_NOT_AVAILABLE_ON_NETWORK` (no longer the removed
 * `BRIDGE_ADAPTER_NOT_FOUND`).
 */
import { describe, expect, it } from 'vitest';

import type {
  Adapter,
  PreparedTx,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';
import type { POSBridgeHelpers } from '../../src/internal/pos-bridge-helpers.ts';
import type { RootChainManager } from '../../src/pos/root_chain_manager.ts';

import { encodeAbiParameters } from '../../src/internal/abi-encode.ts';
import { noopLogger } from '../../src/logger.ts';
import { ERC1155 } from '../../src/pos/erc1155.ts';

const MINTABLE_PREDICATE = '0x4444444444444444444444444444444444444444';
const TOKEN = '0x5555555555555555555555555555555555555555' as const;

class RecordingAdapter implements Adapter {
  readonly writes: WriteRequest[] = [];
  getChainId(): Promise<number> {
    return Promise.resolve(1);
  }
  read(_req: ReadRequest): Promise<unknown> {
    return Promise.resolve(undefined);
  }
  write(req: WriteRequest): Promise<TxResult> {
    this.writes.push(req);
    return Promise.resolve({ hash: '0xdead', confirmed: () => Promise.resolve({} as Receipt) });
  }
  prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    return Promise.resolve({ to: req.address, data: '0x' });
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

// The mintable path never touches the bridge or root-chain-manager — it
// reads the injected predicate address directly — so trivially-typed
// stubs suffice for those collaborators.
const bridgeStub = {} as POSBridgeHelpers;
const rootChainManagerStub = {} as RootChainManager;

function makeErc1155(adapter: Adapter, mintablePredicateAddress?: string): ERC1155 {
  return new ERC1155({
    tokenAddress: TOKEN,
    isParent: true,
    adapter,
    bridge: bridgeStub,
    rootChainManager: rootChainManagerStub,
    parentAdapter: adapter,
    encodeParameters: encodeAbiParameters,
    ...(mintablePredicateAddress !== undefined ? { mintablePredicateAddress } : {}),
    logger: noopLogger
  });
}

describe('ERC1155.approveAllForMintable', () => {
  it('approves the configured mintable predicate when present', async () => {
    const adapter = new RecordingAdapter();
    const erc1155 = makeErc1155(adapter, MINTABLE_PREDICATE);
    await erc1155.approveAllForMintable();
    expect(adapter.writes).to.have.length(1);
    expect(adapter.writes[0]?.functionName).to.equal('setApprovalForAll');
    expect(adapter.writes[0]?.args?.[0]).to.equal(MINTABLE_PREDICATE);
    expect(adapter.writes[0]?.args?.[1]).to.equal(true);
  });

  it('throws CONTRACT_NOT_AVAILABLE_ON_NETWORK when no mintable predicate is configured', () => {
    const adapter = new RecordingAdapter();
    const erc1155 = makeErc1155(adapter);
    // The guard throws synchronously (before the promise is created), so a
    // plain function wrapper captures it without a floating promise.
    let caught: unknown;
    try {
      void erc1155.approveAllForMintable();
    } catch (err) {
      caught = err;
    }
    expect(caught).to.have.property('code', 'CONTRACT_NOT_AVAILABLE_ON_NETWORK');
    expect(adapter.writes).to.have.length(0);
  });
});
