import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JsonRpcProvider, Network } from 'ethers';
import { createPublicClient, http } from 'viem';
import { describe, expect, it } from 'vitest';

import type { Adapter, Hex } from '../../src/adapter.ts';
import type { Network as PolygonNetwork, NetworkAddresses } from '../../src/networks.ts';

import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { StakingClient } from '../../src/staking/staking-client.ts';

/**
 * Staking read ground truth — every staking read replayed against a live
 * parent chain at a pinned, finalized block and compared with the value
 * recorded there.
 *
 * # Why this runs on every `pnpm test`, creds-free
 *
 * Reads need no keys, only an archive-capable public RPC, and a decode
 * bug in a read (a swapped struct field, a mis-sized tuple, an address
 * returned where a number was expected) is exactly what unit tests with
 * hand-written adapter answers cannot catch. Pinning the block makes the
 * answer immutable, so the comparison is exact, never tolerant.
 *
 * # Determinism
 *
 * The block is finalized and every read is pinned to it with
 * `blockTag`; addresses come from the fixture (not the live CDN index),
 * so a later protocol redeploy cannot move the target. A mismatch is a
 * decoding regression, or an endpoint serving the wrong state — never a
 * reason to re-record. Overrides: `POS_SDK_TEST_MAINNET_PARENT_RPC`
 * (mainnet) and `POS_SDK_TEST_PARENT_RPC` (Sepolia), as for the
 * recorder, `scripts/record-staking-read-fixtures.mjs`.
 *
 * Mainnet additionally runs under ethers v6: both adapters must decode
 * the same on-chain bytes to the same values.
 */

// Kept equal to the recorder's defaults: credential-free and serving full
// history (the pinned block only ever gets older).
const MAINNET_RPC = process.env['POS_SDK_TEST_MAINNET_PARENT_RPC'] ?? 'https://eth.drpc.org';
const SEPOLIA_RPC = process.env['POS_SDK_TEST_PARENT_RPC'] ?? 'https://sepolia.gateway.tenderly.co';

// --- fixture loading (validated, not cast) ------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(obj: unknown, key: string): unknown {
  if (!isRecord(obj) || !(key in obj)) throw new Error(`fixture: missing ${key}`);
  return obj[key];
}

function hexField(obj: unknown, key: string): Hex {
  const v = field(obj, key);
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) {
    throw new Error(`fixture: ${key} is not hex`);
  }
  return `0x${v.slice(2)}`;
}

function strField(obj: unknown, key: string): string {
  const v = field(obj, key);
  if (typeof v !== 'string') throw new Error(`fixture: ${key} is not a string`);
  return v;
}

/** A recorded read parameter: `0x…` is an address, anything else an integer. */
type Param = Hex | bigint;

interface FixtureRead {
  target: string;
  method: string;
  params: Record<string, Param>;
  expected: unknown;
}

interface ReadFixture {
  network: PolygonNetwork;
  blockNumber: bigint;
  addresses: { StakeManager: Hex; MaticToken: Hex; PolToken: Hex };
  validatorShareAddress: Hex;
  reads: FixtureRead[];
}

function parseParam(v: unknown): Param {
  if (typeof v !== 'string') throw new Error('fixture: param is not a string');
  return v.startsWith('0x') ? `0x${v.slice(2)}` : BigInt(v);
}

function loadFixture(name: string): ReadFixture {
  const raw: unknown = JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'staking', name), 'utf8')
  );
  const network = strField(raw, 'network');
  if (network !== 'mainnet' && network !== 'amoy') throw new Error(`fixture: network ${network}`);
  const blockNumber = field(raw, 'blockNumber');
  if (typeof blockNumber !== 'number') throw new Error('fixture: blockNumber is not a number');
  const addresses = field(raw, 'addresses');
  const reads = field(raw, 'reads');
  if (!Array.isArray(reads)) throw new Error('fixture: reads is not an array');
  return {
    network,
    blockNumber: BigInt(blockNumber),
    addresses: {
      StakeManager: hexField(addresses, 'StakeManager'),
      MaticToken: hexField(addresses, 'MaticToken'),
      PolToken: hexField(addresses, 'PolToken')
    },
    validatorShareAddress: hexField(raw, 'validatorShareAddress'),
    reads: reads.map((r: unknown) => {
      const params = field(r, 'params');
      return {
        target: strField(r, 'target'),
        method: strField(r, 'method'),
        params: isRecord(params)
          ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, parseParam(v)]))
          : {},
        expected: field(r, 'expected')
      };
    })
  };
}

function bigintParam(params: Record<string, Param>, key: string): bigint {
  const v = params[key];
  if (typeof v !== 'bigint') throw new Error(`fixture: param ${key} is not an integer`);
  return v;
}

function hexParam(params: Record<string, Param>, key: string): Hex {
  const v = params[key];
  if (typeof v !== 'string') throw new Error(`fixture: param ${key} is not an address`);
  return v;
}

// --- dispatch -----------------------------------------------------------

type Call = (args: {
  client: StakingClient;
  shareAddress: Hex;
  params: Record<string, Param>;
  blockTag: bigint;
}) => Promise<unknown>;

const CALLS: Record<string, Call> = {
  'stakeManager.getValidator': ({ client, params, blockTag }) =>
    client.stakeManager.getValidator(
      { validatorId: bigintParam(params, 'validatorId') },
      { blockTag }
    ),
  'stakeManager.getValidatorContract': ({ client, params, blockTag }) =>
    client.stakeManager.getValidatorContract(
      { validatorId: bigintParam(params, 'validatorId') },
      { blockTag }
    ),
  'stakeManager.getDelegatedAmount': ({ client, params, blockTag }) =>
    client.stakeManager.getDelegatedAmount(
      { validatorId: bigintParam(params, 'validatorId') },
      { blockTag }
    ),
  'stakeManager.getMinDeposit': ({ client, blockTag }) =>
    client.stakeManager.getMinDeposit({ blockTag }),
  'stakeManager.getMinHeimdallFee': ({ client, blockTag }) =>
    client.stakeManager.getMinHeimdallFee({ blockTag }),
  'stakeManager.getWithdrawalDelay': ({ client, blockTag }) =>
    client.stakeManager.getWithdrawalDelay({ blockTag }),
  'stakeManager.getCurrentEpoch': ({ client, blockTag }) =>
    client.stakeManager.getCurrentEpoch({ blockTag }),
  'stakeManager.getTotalStaked': ({ client, blockTag }) =>
    client.stakeManager.getTotalStaked({ blockTag }),
  'stakeManager.isLocked': ({ client, blockTag }) => client.stakeManager.isLocked({ blockTag }),
  'validatorShare.getExchangeRate': ({ client, shareAddress, blockTag }) =>
    client.validatorShare(shareAddress).getExchangeRate({ blockTag }),
  'validatorShare.getMinAmount': ({ client, shareAddress, blockTag }) =>
    client.validatorShare(shareAddress).getMinAmount({ blockTag }),
  'validatorShare.getValidatorId': ({ client, shareAddress, blockTag }) =>
    client.validatorShare(shareAddress).getValidatorId({ blockTag }),
  'validatorShare.getUnbondNonce': ({ client, shareAddress, params, blockTag }) =>
    client
      .validatorShare(shareAddress)
      .getUnbondNonce({ user: hexParam(params, 'user') }, { blockTag }),
  'validatorShare.getLiquidRewards': ({ client, shareAddress, params, blockTag }) =>
    client
      .validatorShare(shareAddress)
      .getLiquidRewards({ user: hexParam(params, 'user') }, { blockTag }),
  'validatorShare.getBalance': ({ client, shareAddress, params, blockTag }) =>
    client
      .validatorShare(shareAddress)
      .getBalance({ user: hexParam(params, 'user') }, { blockTag }),
  'pol.getBalance': ({ client, params, blockTag }) =>
    client.pol.getBalance({ user: hexParam(params, 'user') }, { blockTag }),
  'pol.getNonce': ({ client, params, blockTag }) =>
    client.pol.getNonce({ owner: hexParam(params, 'owner') }, { blockTag }),
  'pol.getAllowanceForStakeManager': ({ client, params, blockTag }) =>
    client.pol.getAllowanceForStakeManager({ owner: hexParam(params, 'owner') }, { blockTag }),
  'matic.getBalance': ({ client, params, blockTag }) =>
    client.matic.getBalance({ user: hexParam(params, 'user') }, { blockTag })
};

/**
 * Exact comparison against a recorded value: decimal strings are
 * integers (compared as `bigint`), `0x` strings are addresses, booleans
 * are booleans, and objects are structs compared field by field with
 * the same key set.
 */
function assertMatches(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === 'boolean') {
    expect(actual, path).equals(expected);
    return;
  }
  if (typeof expected === 'string' && expected.startsWith('0x')) {
    expect(actual, path).equals(expected);
    return;
  }
  if (typeof expected === 'string') {
    expect(actual, path).equals(BigInt(expected));
    return;
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) throw new Error(`${path}: expected a struct, got ${typeof actual}`);
    expect(Object.keys(actual).sort(), `${path} keys`).deep.equals(Object.keys(expected).sort());
    for (const [key, value] of Object.entries(expected)) {
      assertMatches(actual[key], value, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path}: unsupported recorded value ${JSON.stringify(expected)}`);
}

// --- suites -------------------------------------------------------------

function addressesFor(fixture: ReadFixture): NetworkAddresses {
  // Only the staking keys are read; the bridge keys are unreachable
  // placeholders `StakingClient` never touches.
  return {
    RootChainManager: '0x0000000000000000000000000000000000000001',
    ERC20Predicate: '0x0000000000000000000000000000000000000002',
    ERC721Predicate: '0x0000000000000000000000000000000000000003',
    ERC1155Predicate: '0x0000000000000000000000000000000000000004',
    EtherPredicate: '0x0000000000000000000000000000000000000005',
    RootChain: '0x0000000000000000000000000000000000000006',
    ...fixture.addresses
  };
}

const MAINNET = loadFixture('reads-mainnet.json');
const SEPOLIA = loadFixture('reads-sepolia.json');

const SUITES: ReadonlyArray<{ label: string; fixture: ReadFixture; adapter: () => Adapter }> = [
  {
    label: 'Ethereum mainnet (viem)',
    fixture: MAINNET,
    adapter: () => viemAdapter({ public: createPublicClient({ transport: http(MAINNET_RPC) }) })
  },
  {
    label: 'Ethereum mainnet (ethers v6)',
    fixture: MAINNET,
    adapter: () =>
      ethersV6Adapter({
        provider: new JsonRpcProvider(MAINNET_RPC, Network.from(1), { staticNetwork: true })
      })
  },
  {
    label: 'Sepolia (viem)',
    fixture: SEPOLIA,
    adapter: () => viemAdapter({ public: createPublicClient({ transport: http(SEPOLIA_RPC) }) })
  }
];

for (const suite of SUITES) {
  const { fixture } = suite;
  describe(
    `staking reads — ground truth at block ${fixture.blockNumber} on ${suite.label}`,
    { timeout: 120_000 },
    () => {
      let client: StakingClient | undefined;
      async function getClient(): Promise<StakingClient> {
        client ??= await StakingClient.init({
          network: fixture.network,
          parent: suite.adapter(),
          addresses: addressesFor(fixture)
        });
        return client;
      }

      for (const read of fixture.reads) {
        const key = `${read.target}.${read.method}`;
        it(`${key} matches the recorded value`, async () => {
          const call = CALLS[key];
          if (call === undefined) throw new Error(`no dispatch for ${key}`);
          const actual = await call({
            client: await getClient(),
            shareAddress: fixture.validatorShareAddress,
            params: read.params,
            blockTag: fixture.blockNumber
          });
          assertMatches(actual, read.expected, key);
        });
      }
    }
  );
}
