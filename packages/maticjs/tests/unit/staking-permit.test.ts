import { hashTypedData } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  Adapter,
  Hex,
  PreparedTx,
  ReadRequest,
  Receipt,
  TxResult,
  WriteRequest
} from '../../src/adapter.ts';
import type { NetworkAddresses } from '../../src/networks.ts';

import { PermitNotSupportedError } from '../../src/errors.ts';
import { buildPermitTypedData, splitSignature } from '../../src/staking/permit.ts';
import { StakingClient } from '../../src/staking/staking-client.ts';

/**
 * The SDK prepares permit typed data but never signs it. These tests
 * pin the parts that decide whether the contract accepts the signature:
 * the domain is read from the token (not hardcoded), the nonce comes
 * from `nonces(owner)`, the spender defaults to the StakeManager proxy,
 * and `splitSignature` lifts a raw 0/1 recovery id to 27/28.
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
const STAKE_MANAGER: Hex = '0x7777777777777777777777777777777777777777';
const POL: Hex = '0x9999999999999999999999999999999999999999';
const OWNER: Hex = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const SPENDER: Hex = '0xcCCccccCCCCCCCcccccCcCCcCcCcCcCCccCccCcC';
const R = '11'.repeat(32);
const S = '22'.repeat(32);

/** Answers `eip712Domain()` and `nonces(owner)` the way a viem client decodes them. */
class TokenReadAdapter implements Adapter {
  readonly reads: ReadRequest[] = [];
  private readonly domainName: string;
  constructor(domainName = 'Polygon Ecosystem Token') {
    this.domainName = domainName;
  }
  getChainId(): Promise<number> {
    return Promise.resolve(1);
  }
  read(req: ReadRequest): Promise<unknown> {
    this.reads.push(req);
    if (req.functionName === 'eip712Domain') {
      return Promise.resolve(['0x0f', this.domainName, '1', 1n, POL, `0x${'00'.repeat(32)}`, []]);
    }
    if (req.functionName === 'nonces') return Promise.resolve(7n);
    return Promise.reject(new Error(`unexpected read ${req.functionName}`));
  }
  write(_req: WriteRequest): Promise<TxResult> {
    return Promise.reject(new Error('unexpected write'));
  }
  prepareWrite(_req: WriteRequest): Promise<PreparedTx> {
    return Promise.reject(new Error('unexpected prepareWrite'));
  }
  estimateGas(_req: WriteRequest): Promise<bigint> {
    return Promise.resolve(0n);
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

async function setup(
  domainName?: string
): Promise<{ adapter: TokenReadAdapter; client: StakingClient }> {
  const adapter = new TokenReadAdapter(domainName);
  const client = await StakingClient.init({
    network: 'mainnet',
    parent: adapter,
    addresses: ADDRESSES
  });
  return { adapter, client };
}

describe('splitSignature', () => {
  it('splits r ‖ s ‖ v with v already 27', () => {
    expect(splitSignature(`0x${R}${S}1b`)).deep.equals({ v: 27, r: `0x${R}`, s: `0x${S}` });
  });

  it('keeps v = 28', () => {
    expect(splitSignature(`0x${R}${S}1c`))
      .property('v')
      .equals(28);
  });

  it('lifts a raw recovery id 0 to 27', () => {
    expect(splitSignature(`0x${R}${S}00`))
      .property('v')
      .equals(27);
  });

  it('lifts a raw recovery id 1 to 28', () => {
    expect(splitSignature(`0x${R}${S}01`))
      .property('v')
      .equals(28);
  });

  it('accepts upper-case hex', () => {
    const sig: Hex = `0x${'AB'.repeat(32)}${'CD'.repeat(32)}1B`;
    expect(splitSignature(sig)).deep.equals({
      v: 27,
      r: `0x${'AB'.repeat(32)}`,
      s: `0x${'CD'.repeat(32)}`
    });
  });

  it('rejects a 64-byte compact signature with InvalidHexStringError', () => {
    expect(() => splitSignature(`0x${R}${S}`))
      .throws()
      .property('name', 'InvalidHexStringError');
  });

  it('rejects non-hex characters', () => {
    expect(() => splitSignature(`0x${'zz'.repeat(65)}`))
      .throws()
      .property('name', 'InvalidHexStringError');
  });
});

describe('buildPermitTypedData', () => {
  it('builds the EIP-2612 Permit shape without an EIP712Domain type', () => {
    const domain = {
      name: 'Polygon Ecosystem Token',
      version: '1',
      chainId: 1,
      verifyingContract: POL
    };
    const td = buildPermitTypedData({
      domain,
      owner: OWNER,
      spender: SPENDER,
      value: 5n,
      nonce: 2n,
      deadline: 99n
    });
    expect(td).property('primaryType').equals('Permit');
    expect(td).property('domain').deep.equals(domain);
    expect(td)
      .property('message')
      .deep.equals({ owner: OWNER, spender: SPENDER, value: 5n, nonce: 2n, deadline: 99n });
    expect(td.types).not.property('EIP712Domain');
    expect(td.types.Permit.map((f) => `${f.type} ${f.name}`)).deep.equals([
      'address owner',
      'address spender',
      'uint256 value',
      'uint256 nonce',
      'uint256 deadline'
    ]);
  });
});

describe('pol.preparePermit', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads eip712Domain and nonces(owner) through the adapter', async () => {
    const { adapter, client } = await setup();
    const td = await client.pol.preparePermit({ owner: OWNER, value: 10n, deadline: 123n });
    const fns = adapter.reads.map((r) => r.functionName).sort();
    expect(fns).deep.equals(['eip712Domain', 'nonces']);
    expect(adapter.reads.every((r) => r.address === POL)).equals(true);
    expect(adapter.reads.find((r) => r.functionName === 'nonces'))
      .property('args')
      .deep.equals([OWNER]);
    expect(td).property('domain').deep.equals({
      name: 'Polygon Ecosystem Token',
      version: '1',
      chainId: 1,
      verifyingContract: POL
    });
    expect(td).nested.property('message.nonce').equals(7n);
    expect(td).nested.property('message.value').equals(10n);
    expect(td).nested.property('message.deadline').equals(123n);
  });

  it('takes the domain name from the token, never a hardcoded string', async () => {
    const { client } = await setup('Renamed Token');
    const td = await client.pol.preparePermit({ owner: OWNER, value: 1n });
    expect(td).nested.property('domain.name').equals('Renamed Token');
  });

  it('defaults spender to the StakeManager proxy', async () => {
    const { client } = await setup();
    const td = await client.pol.preparePermit({ owner: OWNER, value: 1n });
    expect(td).nested.property('message.spender').equals(STAKE_MANAGER);
  });

  it('honours an explicit spender', async () => {
    const { client } = await setup();
    const td = await client.pol.preparePermit({ owner: OWNER, value: 1n, spender: SPENDER });
    expect(td).nested.property('message.spender').equals(SPENDER);
  });

  it('defaults deadline to now + 1800 seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_500));
    const { client } = await setup();
    const td = await client.pol.preparePermit({ owner: OWNER, value: 1n });
    expect(td).nested.property('message.deadline').equals(1_700_001_800n);
  });

  it('pol.getNonce reads nonces(owner)', async () => {
    const { client } = await setup();
    expect(await client.pol.getNonce({ owner: OWNER })).equals(7n);
  });
});

describe('matic permit surface', () => {
  it('matic.preparePermit rejects with PermitError caused by PermitNotSupportedError without touching the chain', async () => {
    const { adapter, client } = await setup();
    const err = await client.matic.preparePermit({ owner: OWNER, value: 1n }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).property('name').equals('PermitError');
    expect(err).nested.property('info.operation').equals('preparePermit');
    expect(PermitNotSupportedError.find(err)).nested.property('info.token').equals('MaticToken');
    expect(adapter.reads).lengthOf(0);
  });

  it('matic.getNonce rejects with StakingReadError caused by PermitNotSupportedError', async () => {
    const { client } = await setup();
    const err = await client.matic.getNonce({ owner: OWNER }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).property('name').equals('StakingReadError');
    expect(err).nested.property('info.operation').equals('getNonce');
    expect(PermitNotSupportedError.find(err)).nested.property('info.method').equals('getNonce');
  });
});

describe('permit digest', () => {
  // Known-good digest for these inputs, captured from the 3.x plugin's
  // permit typed data on mainnet; it equals what PolToken.permit verifies.
  const DIGEST = '0xcac70e4cb8858fc8df4c96853a43302bc305905b81f2546d76e7ab0b8a4d6c8e';
  const MAINNET_STAKE_MANAGER: Hex = '0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908';
  const MAINNET_POL: Hex = '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6';

  class MainnetPolAdapter extends TokenReadAdapter {
    override read(req: ReadRequest): Promise<unknown> {
      this.reads.push(req);
      if (req.functionName === 'eip712Domain') {
        // chainId arrives as a bigint, exactly as viem and ethers v6 decode uint256.
        return Promise.resolve([
          '0x0f',
          'Polygon Ecosystem Token',
          '1',
          1n,
          MAINNET_POL,
          `0x${'00'.repeat(32)}`,
          []
        ]);
      }
      if (req.functionName === 'nonces') return Promise.resolve(0n);
      return Promise.reject(new Error(`unexpected read ${req.functionName}`));
    }
  }

  it('preparePermit output hashes to the digest PolToken verifies', async () => {
    const client = await StakingClient.init({
      network: 'mainnet',
      parent: new MainnetPolAdapter(),
      addresses: { ...ADDRESSES, StakeManager: MAINNET_STAKE_MANAGER, PolToken: MAINNET_POL }
    });
    const td = await client.pol.preparePermit({
      owner: '0x1111111111111111111111111111111111111111',
      value: 1_000_000_000_000_000_000n,
      deadline: 1_700_000_000n
    });
    expect(td).nested.property('message.spender').equals(MAINNET_STAKE_MANAGER);
    expect(td).nested.property('domain.chainId').a('number');
    expect(hashTypedData(td)).equals(DIGEST);
  });
});
