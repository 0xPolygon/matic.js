import type { JsonRpcError, JsonRpcPayload, JsonRpcResult } from 'ethers';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JsonRpcApiProvider, Network } from 'ethers';
import { providers as v5providers } from 'ethers-v5';
import { createPublicClient, custom } from 'viem';
import { describe, expect, it } from 'vitest';

import type { Adapter, Hex } from '../../src/adapter.ts';
import type { DepositStatus } from '../../src/pos/bridge-status.ts';

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { decodeBytesParameter, encodeAbiParameters } from '../../src/internal/abi-encode.ts';
import { POSClient } from '../../src/pos-client.ts';
import { expectLibraryErrorByIdentity, recordingAdapter } from './library-errors.ts';

/**
 * `getDepositStatus` against a real mainnet failed delivery (state id
 * 3212421), through each of the three adapters. The REAL adapters decode the
 * receipt and the contract reads; only the JSON-RPC transport is stubbed, so
 * the status is read from exactly the bytes a node returned for the deposit.
 */

interface Fixture {
  transactionHash: string;
  blockNumber: string;
  stateSyncedLog: { address: Hex; topics: Hex[]; data: Hex; logIndex: string };
  childFailedStateSyncHash: Hex;
}

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'mainnet-state-sync-3212421.json'), 'utf8')
) as Fixture;

interface LegacyFixture {
  transactionHash: string;
  blockNumber: string;
  stateSyncedLog: { address: Hex; topics: Hex[]; data: Hex; logIndex: string };
  childFailedStateSyncPayload: Hex;
}

/** State id 3192364: a real PoS deposit that failed before the Uburu fork and is still stored. */
const LEGACY = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'mainnet-state-sync-3192364.json'), 'utf8')
) as LegacyFixture;
const LEGACY_STATE_ID = 3192364n;
const LEGACY_RECEIVER: Hex = '0xa6fa4fb5f76172d178d61b04b0ecd319c5d1c0aa';

const STATE_ID = 3212421n;
const RECEIVER: Hex = '0x8397259c983751daf40400790063935a11afa28a';
const PARENT_CHAIN = 1;
const CHILD_CHAIN = 137;
const ADDR = '0x1111111111111111111111111111111111111111';
const LAST_STATE_ID_SELECTOR = '0x5407ca67';
const FAILED_HASH_SELECTOR = '0x8c828b8a';
const FAILED_PAYLOAD_SELECTOR = '0x6757e5d9';

const word = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;

type NodeError = { code: number; message: string };

/** The parent chain holds the deposit receipt; the child chain answers the StateReceiver reads. */
class StubChain {
  readonly calls: string[] = [];
  lastStateId = STATE_ID;
  failedHash: Hex = FIXTURE.childFailedStateSyncHash;
  /** The pre-Uburu record; `0x` is the empty `bytes` the receiver returns for none. */
  failedPayload: Hex = '0x';
  hashReadError: NodeError | undefined;
  payloadReadError: NodeError | undefined;
  /** The deposit whose receipt the parent chain serves. */
  deposit: {
    transactionHash: string;
    blockNumber: string;
    stateSyncedLog: Fixture['stateSyncedLog'];
  } = FIXTURE;

  private readonly chainId: number;

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  /** The node's error for this call, if the script says it fails. */
  failureFor(method: string, params: readonly unknown[]): NodeError | undefined {
    if (method === 'eth_call' && this.selectorOf(params) === FAILED_HASH_SELECTOR) {
      return this.hashReadError;
    }
    if (method === 'eth_call' && this.selectorOf(params) === FAILED_PAYLOAD_SELECTOR) {
      return this.payloadReadError;
    }
    return undefined;
  }

  private selectorOf(params: readonly unknown[]): string {
    const call = params[0] as { data?: string; input?: string };
    return (call.data ?? call.input ?? '').slice(0, 10).toLowerCase();
  }

  answer(method: string, params: readonly unknown[]): unknown {
    switch (method) {
      case 'eth_chainId':
        return `0x${this.chainId.toString(16)}`;
      case 'eth_blockNumber':
        return '0x64';
      case 'net_version':
        return String(this.chainId);
      case 'eth_getTransactionReceipt': {
        const deposit = this.deposit;
        const log = deposit.stateSyncedLog;
        return {
          transactionHash: deposit.transactionHash,
          transactionIndex: '0x0',
          blockHash: `0x${'b1'.repeat(32)}`,
          blockNumber: deposit.blockNumber,
          from: ADDR,
          to: log.address,
          contractAddress: null,
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          effectiveGasPrice: '0x1',
          type: '0x2',
          status: '0x1',
          logsBloom: `0x${'00'.repeat(256)}`,
          logs: [
            {
              ...log,
              transactionHash: deposit.transactionHash,
              transactionIndex: '0x0',
              blockHash: `0x${'b1'.repeat(32)}`,
              blockNumber: deposit.blockNumber,
              removed: false
            }
          ]
        };
      }
      case 'eth_call': {
        const selector = this.selectorOf(params);
        this.calls.push(selector);
        if (selector === LAST_STATE_ID_SELECTOR) return word(this.lastStateId);
        if (selector === FAILED_HASH_SELECTOR) return this.failedHash;
        if (selector === FAILED_PAYLOAD_SELECTOR) {
          return encodeAbiParameters([this.failedPayload], ['bytes']);
        }
        throw Object.assign(new Error(`stub chain: unexpected eth_call ${selector}`), {
          code: -32601
        });
      }
      default:
        throw Object.assign(new Error(`stub chain: unexpected RPC ${method}`), { code: -32601 });
    }
  }
}

const thrown = ({ code, message }: NodeError): Error => Object.assign(new Error(message), { code });

class V5Stub extends v5providers.StaticJsonRpcProvider {
  private readonly chain: StubChain;

  constructor(chain: StubChain, chainId: number) {
    super('http://stub.invalid', { chainId, name: 'stub' });
    this.chain = chain;
  }
  override async send(method: string, params: unknown[]): Promise<unknown> {
    const failure = this.chain.failureFor(method, params);
    if (failure !== undefined) throw thrown(failure);
    return this.chain.answer(method, params);
  }
}

class V6Stub extends JsonRpcApiProvider {
  private readonly chain: StubChain;

  constructor(chain: StubChain, chainId: number) {
    super(Network.from(chainId), { staticNetwork: true, batchMaxCount: 1 });
    this.chain = chain;
  }
  override async _send(
    payload: JsonRpcPayload | JsonRpcPayload[]
  ): Promise<Array<JsonRpcResult | JsonRpcError>> {
    const batch = Array.isArray(payload) ? payload : [payload];
    return batch.map((p) => {
      const params = Array.isArray(p.params) ? p.params : [];
      const failure = this.chain.failureFor(p.method, params);
      if (failure !== undefined) return { id: p.id, error: { ...failure } };
      try {
        return { id: p.id, result: this.chain.answer(p.method, params) };
      } catch (err) {
        return { id: p.id, error: { code: -32601, message: String(err) } };
      }
    });
  }
}

const harnesses: Array<[string, (chain: StubChain, chainId: number) => Adapter]> = [
  ['ethers v5', (chain, id) => ethersV5Adapter({ provider: new V5Stub(chain, id) })],
  ['ethers v6', (chain, id) => ethersV6Adapter({ provider: new V6Stub(chain, id) })],
  [
    'viem',
    (chain) =>
      viemAdapter({
        public: createPublicClient({
          transport: custom({
            request: async ({ method, params }: { method: string; params?: unknown }) => {
              const list = Array.isArray(params) ? params : [];
              const failure = chain.failureFor(method, list);
              if (failure !== undefined) throw thrown(failure);
              return chain.answer(method, list);
            }
          })
        })
      })
  ]
];

describe('the stored hash formula against the mainnet record', () => {
  it('equals keccak256(abi.encode(receiver, payload)) of the deposit own StateSynced log', async () => {
    const adapter = harnesses[2]?.[1](new StubChain(CHILD_CHAIN), CHILD_CHAIN);
    const data = decodeBytesParameter(FIXTURE.stateSyncedLog.data);
    expect(adapter?.keccak256(encodeAbiParameters([RECEIVER, data], ['address', 'bytes']))).equal(
      FIXTURE.childFailedStateSyncHash
    );
  });
});

describe('the stored payload against the pre-Uburu mainnet record', () => {
  it('equals abi.encode(receiver, data) of the deposit own StateSynced log', () => {
    const data = decodeBytesParameter(LEGACY.stateSyncedLog.data);
    const encoded = encodeAbiParameters([LEGACY_RECEIVER, data], ['address', 'bytes']);
    expect(encoded).equal(LEGACY.childFailedStateSyncPayload);
  });
});

describe.each(harnesses)('getDepositStatus through %s', (_library, build) => {
  const statusOf = async ({
    child,
    wrapChild = false
  }: {
    child: StubChain;
    wrapChild?: boolean;
  }): Promise<{ result: DepositStatus | undefined; err: unknown; thrown: readonly unknown[] }> => {
    const parent = new StubChain(PARENT_CHAIN);
    parent.deposit = child.deposit;
    const recorded = recordingAdapter(build(child, CHILD_CHAIN));
    const pos = await POSClient.init({
      network: 'mainnet',
      parent: build(parent, PARENT_CHAIN),
      child: wrapChild ? recorded.adapter : build(child, CHILD_CHAIN),
      addresses: {
        RootChainManager: ADDR,
        ERC20Predicate: ADDR,
        ERC721Predicate: ADDR,
        ERC1155Predicate: ADDR,
        EtherPredicate: ADDR,
        RootChain: ADDR,
        GasSwapper: ADDR
      }
    });
    const settled = await pos.getDepositStatus(child.deposit.transactionHash).then(
      (result) => ({ result, err: undefined }),
      (err: unknown) => ({ result: undefined, err })
    );
    return { ...settled, thrown: recorded.thrown };
  };

  it('not synced: reads no failed record', async () => {
    const child = new StubChain(CHILD_CHAIN);
    child.lastStateId = STATE_ID - 1n;
    const { result } = await statusOf({ child });
    expect(result).deep.equal({ deposited: false, reason: 'not-synced' });
    expect(child.calls).not.include(FAILED_HASH_SELECTOR);
    expect(child.calls).not.include(FAILED_PAYLOAD_SELECTOR);
  });

  it('failed with this deposit own record: delivery-failed, replayable', async () => {
    const { result } = await statusOf({ child: new StubChain(CHILD_CHAIN) });
    expect(result).deep.equal({
      deposited: false,
      reason: 'delivery-failed',
      stateId: STATE_ID,
      receiver: RECEIVER,
      record: 'hash',
      replayable: true
    });
  });

  it('failed with a record of different content: delivery-failed, not replayable', async () => {
    const child = new StubChain(CHILD_CHAIN);
    child.failedHash = `0x${'de'.repeat(32)}`;
    const { result } = await statusOf({ child });
    expect(result).property('reason').equal('delivery-failed');
    expect(result).property('replayable').equal(false);
    expect(result).property('record').equal('hash');
  });

  it('replayed (record cleared): deposited', async () => {
    const child = new StubChain(CHILD_CHAIN);
    child.failedHash = word(0n) as Hex;
    const { result } = await statusOf({ child });
    expect(result).deep.equal({ deposited: true });
  });

  describe('a failure recorded before the Uburu fork', () => {
    const legacyChild = (): StubChain => {
      const child = new StubChain(CHILD_CHAIN);
      child.deposit = LEGACY;
      child.lastStateId = LEGACY_STATE_ID;
      child.failedHash = word(0n) as Hex;
      child.failedPayload = LEGACY.childFailedStateSyncPayload;
      return child;
    };

    it('this deposit own payload: delivery-failed, record payload, replayable', async () => {
      const { result } = await statusOf({ child: legacyChild() });
      expect(result).deep.equal({
        deposited: false,
        reason: 'delivery-failed',
        stateId: LEGACY_STATE_ID,
        receiver: LEGACY_RECEIVER,
        record: 'payload',
        replayable: true
      });
    });

    it('a payload of different content: record payload, not replayable', async () => {
      const child = legacyChild();
      child.failedPayload = encodeAbiParameters([LEGACY_RECEIVER, '0xdead'], ['address', 'bytes']);
      const { result } = await statusOf({ child });
      expect(result).property('record').equal('payload');
      expect(result).property('replayable').equal(false);
    });

    it('both records set: the hash wins', async () => {
      const child = legacyChild();
      child.failedHash = FIXTURE.childFailedStateSyncHash;
      const { result } = await statusOf({ child });
      expect(result).property('record').equal('hash');
    });

    it('a node error on the payload read reaches the caller as the library own error', async () => {
      const child = legacyChild();
      child.payloadReadError = { code: -32000, message: 'execution aborted (timeout = 5s)' };
      const { err, thrown: seen } = await statusOf({ child, wrapChild: true });
      expectLibraryErrorByIdentity({ err, thrown: seen });
    });
  });

  it('a node error on the hash read reaches the caller as the library own error', async () => {
    const child = new StubChain(CHILD_CHAIN);
    child.hashReadError = { code: -32000, message: 'execution aborted (timeout = 5s)' };
    const { err, thrown: seen } = await statusOf({ child, wrapChild: true });
    expectLibraryErrorByIdentity({ err, thrown: seen });
  });
});
