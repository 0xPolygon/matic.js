import { describe, expect, it } from 'vitest';

import type {
  Adapter,
  PreparedTx,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';
import type { NetworkAddresses } from '../../src/networks.ts';

import { UntrustedPredicateError } from '../../src/errors.ts';
import { POSClient } from '../../src/pos-client.ts';

/**
 * `typeToPredicate` is read from an RPC and becomes the spender of an
 * approval, so an answer outside the address index must be refused before
 * any write, and must not be cached.
 */

const TOKEN = '0x3333333333333333333333333333333333333333';
const ATTACKER = '0x9999999999999999999999999999999999999999';
const ERC20_PREDICATE = '0x2222222222222222222222222222222222222223';
const MINTABLE_ERC20_PREDICATE = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const TYPE = `0x${'01'.padStart(64, '0')}`;
const GAS = { gasLimit: 100_000n };

const ADDRESSES: NetworkAddresses = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: ERC20_PREDICATE,
  ERC721Predicate: '0x3333333333333333333333333333333333333334',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666',
  MintableERC20Predicate: MINTABLE_ERC20_PREDICATE
};

class RpcAdapter implements Adapter {
  predicate: string;
  readonly typeToPredicateReads: number[] = [];
  readonly writes: WriteRequest[] = [];
  readonly prepared: WriteRequest[] = [];

  constructor(predicate: string) {
    this.predicate = predicate;
  }

  getChainId(): Promise<number> {
    return Promise.resolve(11155111);
  }
  read(req: ReadRequest): Promise<unknown> {
    if (req.functionName === 'tokenToType') return Promise.resolve(TYPE);
    if (req.functionName === 'typeToPredicate') {
      this.typeToPredicateReads.push(1);
      return Promise.resolve(this.predicate);
    }
    return Promise.resolve(undefined);
  }
  write(req: WriteRequest): Promise<TxResult> {
    this.writes.push(req);
    return Promise.resolve({ hash: '0x0', confirmed: () => Promise.resolve({} as Receipt) });
  }
  prepareWrite(req: WriteRequest): Promise<PreparedTx> {
    this.prepared.push(req);
    return Promise.resolve({ to: req.address, data: '0x' });
  }
  estimateGas(): Promise<bigint> {
    return Promise.resolve(21_000n);
  }
  getTransactionReceipt(): Promise<Receipt | null> {
    return Promise.resolve(null);
  }
  keccak256(): string {
    return '0x0';
  }
  request<T>(): Promise<T> {
    return Promise.resolve(undefined as T);
  }
}

const settle = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e
  );

const init = (parent: RpcAdapter): Promise<POSClient> =>
  POSClient.init({
    network: 'amoy',
    parent,
    child: new RpcAdapter(ATTACKER),
    addresses: ADDRESSES
  });

describe('approval spender allow-list', () => {
  const approvals: Array<[string, (pos: POSClient) => Promise<unknown>]> = [
    ['approve', (pos) => pos.parent.erc20(TOKEN).approve(1n, GAS)],
    ['approveMax', (pos) => pos.parent.erc20(TOKEN).approveMax(GAS)],
    ['prepareApprove', (pos) => pos.parent.erc20(TOKEN).prepareApprove(1n)],
    ['prepareApproveMax', (pos) => pos.parent.erc20(TOKEN).prepareApproveMax()],
    ['erc721 approveAll', (pos) => pos.parent.erc721(TOKEN).approveAll(GAS)],
    ['erc1155 approveAll', (pos) => pos.parent.erc1155(TOKEN).approveAll(GAS)]
  ];

  for (const [name, call] of approvals) {
    it(`${name} rejects an attacker predicate before any write`, async () => {
      const rpc = new RpcAdapter(ATTACKER);
      const pos = await init(rpc);
      const err = await settle(call(pos));
      const found = UntrustedPredicateError.find(err);
      expect(found).not.equals(null);
      expect(found).nested.property('info.predicate').equals(ATTACKER);
      expect(rpc.writes).length(0);
      expect(rpc.prepared).length(0);
    });
  }

  it('does not cache a rejected predicate: the next call reads the RPC again', async () => {
    const rpc = new RpcAdapter(ATTACKER);
    const pos = await init(rpc);
    await settle(pos.parent.erc20(TOKEN).approveMax(GAS));
    await settle(pos.parent.erc20(TOKEN).approveMax(GAS));
    expect(rpc.typeToPredicateReads).length(2);

    // The RPC recovers: the same token now resolves, proving nothing stuck.
    rpc.predicate = ERC20_PREDICATE;
    await pos.parent.erc20(TOKEN).approveMax(GAS);
    expect(rpc.writes).length(1);
  });

  it('accepts a mintable predicate that the index publishes', async () => {
    const rpc = new RpcAdapter(MINTABLE_ERC20_PREDICATE);
    const pos = await init(rpc);
    await pos.parent.erc20(TOKEN).approveMax(GAS);
    expect(rpc.writes).length(1);
  });

  it('compares addresses case-insensitively', async () => {
    const rpc = new RpcAdapter(ERC20_PREDICATE.toUpperCase().replace('0X', '0x'));
    const pos = await init(rpc);
    await pos.parent.erc20(TOKEN).approveMax(GAS);
    expect(rpc.writes).length(1);
  });

  it('an explicit spenderAddress is the consumer’s choice and is not checked', async () => {
    const rpc = new RpcAdapter(ATTACKER);
    const pos = await init(rpc);
    await pos.parent.erc20(TOKEN).approveMax({ ...GAS, spenderAddress: ATTACKER });
    expect(rpc.writes).length(1);
    expect(rpc.typeToPredicateReads).length(0);
  });
});
