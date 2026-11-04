import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JsonRpcProvider, Network } from 'ethers';
import { providers } from 'ethers-v5';
import { createPublicClient, hashTypedData, http, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';

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

import { ethersV5Adapter } from '../../src/adapters/ethers-v5.ts';
import { ethersV6Adapter } from '../../src/adapters/ethers-v6.ts';
import { viemAdapter } from '../../src/adapters/viem.ts';
import { MAX_AMOUNT } from '../../src/constant.ts';
import { StakingClient } from '../../src/staking/staking-client.ts';

/**
 * Calldata ground truth — the proof that the staking port encodes every
 * write exactly as the 3.x staking plugin did.
 *
 * `calldata-3x.json` holds the `to` and `data` the 3.x plugin returned
 * for fixed inputs (captured with `returnTransaction: true`, nothing
 * signed or broadcast). Each write here is prepared through the 4.0
 * surface under all three adapters and must match byte-for-byte. The
 * selector is checked separately against the fixture's function name so
 * a same-shaped but differently named function cannot pass by accident.
 *
 * `permit-typed-data-3x.json` holds the EIP-712 Permit the plugin handed
 * to `eth_signTypedData_v4`. The digest of the typed data 4.0 prepares
 * from the same on-chain inputs must equal the digest of that capture.
 *
 * A mismatch means the encoding changed: every byte is what the contract
 * decodes, so any diff is a real regression. Never re-record the
 * fixtures to make this pass; see `tests/fixtures/staking/README.md`.
 *
 * `approveStakeManager({ amount })` has no 3.x counterpart (the plugin
 * only had the max-approve), so it is checked for self-consistency: at
 * `MAX_AMOUNT` it must encode identically to the captured max-approve.
 *
 * No network: preparing a write never touches the provider, so every
 * adapter points at an unroutable local URL.
 */

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'staking');
const UNROUTABLE = 'http://127.0.0.1:1';

// --- fixture loading (validated, not cast) ------------------------------

type Json = unknown;

function isRecord(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(obj: Json, key: string): Json {
  if (!isRecord(obj) || !(key in obj)) throw new Error(`fixture: missing ${key}`);
  return obj[key];
}

function str(obj: Json, key: string): string {
  const v = field(obj, key);
  if (typeof v !== 'string') throw new Error(`fixture: ${key} is not a string`);
  return v;
}

function hex(obj: Json, key: string): Hex {
  const v = str(obj, key);
  if (!/^0x[0-9a-fA-F]*$/.test(v)) throw new Error(`fixture: ${key} is not hex`);
  return `0x${v.slice(2)}`;
}

function int(obj: Json, key: string): bigint {
  const v = field(obj, key);
  if (typeof v !== 'string' && typeof v !== 'number') {
    throw new Error(`fixture: ${key} is not an integer`);
  }
  return BigInt(v);
}

function bool(obj: Json, key: string): boolean {
  const v = field(obj, key);
  if (typeof v !== 'boolean') throw new Error(`fixture: ${key} is not a boolean`);
  return v;
}

function readJson(name: string): Json {
  const parsed: Json = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
  return parsed;
}

interface FixtureWrite {
  row: number;
  method3x: string;
  contract: string;
  functionName: string;
  to: Hex;
  data: Hex;
}

const calldata = readJson('calldata-3x.json');
const rawInputs = field(calldata, 'inputs');
const rawAddresses = field(calldata, 'addresses');
const rawWrites = field(calldata, 'writes');
if (!Array.isArray(rawWrites)) throw new Error('fixture: writes is not an array');

const WRITES: FixtureWrite[] = rawWrites.map((w: Json) => {
  const row = field(w, 'row');
  if (typeof row !== 'number') throw new Error('fixture: row is not a number');
  return {
    row,
    method3x: str(w, 'method3x'),
    contract: str(w, 'contract'),
    functionName: str(w, 'functionName'),
    to: hex(w, 'to'),
    data: hex(w, 'data')
  };
});

const INPUTS = {
  user: hex(rawInputs, 'user'),
  amount: int(rawInputs, 'amount'),
  minSharesToMint: int(rawInputs, 'minSharesToMint'),
  maxSharesToBurn: int(rawInputs, 'maxSharesToBurn'),
  heimdallFee: int(rawInputs, 'heimdallFee'),
  validatorId: int(rawInputs, 'validatorId'),
  fromValidatorId: int(rawInputs, 'fromValidatorId'),
  toValidatorId: int(rawInputs, 'toValidatorId'),
  nonce: int(rawInputs, 'nonce'),
  commissionRate: int(rawInputs, 'commissionRate'),
  signerPubkey: hex(rawInputs, 'signerPubkey'),
  deadline: int(rawInputs, 'deadline'),
  v: Number(int(rawInputs, 'v')),
  r: hex(rawInputs, 'r'),
  s: hex(rawInputs, 's'),
  acceptDelegation: bool(rawInputs, 'acceptDelegation'),
  stakeRewards: bool(rawInputs, 'stakeRewards'),
  validatorShareAddress: hex(rawInputs, 'validatorShareAddress')
};

const STAKE_MANAGER = hex(rawAddresses, 'StakeManager');
const MATIC_TOKEN = hex(rawAddresses, 'MaticToken');
const POL_TOKEN = hex(rawAddresses, 'PolToken');

// Only the staking keys are under test; the bridge keys are unreachable
// placeholders that `StakingClient` never reads.
const ADDRESSES: NetworkAddresses = {
  RootChainManager: '0x0000000000000000000000000000000000000001',
  ERC20Predicate: '0x0000000000000000000000000000000000000002',
  ERC721Predicate: '0x0000000000000000000000000000000000000003',
  ERC1155Predicate: '0x0000000000000000000000000000000000000004',
  EtherPredicate: '0x0000000000000000000000000000000000000005',
  RootChain: '0x0000000000000000000000000000000000000006',
  StakeManager: STAKE_MANAGER,
  MaticToken: MATIC_TOKEN,
  PolToken: POL_TOKEN
};

// --- fixture write → 4.0 prepare call -----------------------------------

type Prepare = (client: StakingClient) => Promise<PreparedTx>;

const STAKE_FOR_PARAMS = {
  user: INPUTS.user,
  amount: INPUTS.amount,
  heimdallFee: INPUTS.heimdallFee,
  acceptDelegation: INPUTS.acceptDelegation,
  signerPubkey: INPUTS.signerPubkey
};

const share = (client: StakingClient) => client.validatorShare(INPUTS.validatorShareAddress);

/** Keyed by `row` (and, for row 18, by token contract). */
const PREPARE_BY_ROW: Record<string, { label: string; prepare: Prepare }> = {
  '1': {
    label: 'validatorShare.prepareDelegateMatic',
    prepare: (c) =>
      share(c).prepareDelegateMatic({
        amount: INPUTS.amount,
        minSharesToMint: INPUTS.minSharesToMint
      })
  },
  '2': {
    label: 'validatorShare.prepareDelegate',
    prepare: (c) =>
      share(c).prepareDelegate({ amount: INPUTS.amount, minSharesToMint: INPUTS.minSharesToMint })
  },
  '3': {
    label: 'validatorShare.prepareDelegateWithPermit',
    prepare: (c) =>
      share(c).prepareDelegateWithPermit({
        amount: INPUTS.amount,
        minSharesToMint: INPUTS.minSharesToMint,
        deadline: INPUTS.deadline,
        v: INPUTS.v,
        r: INPUTS.r,
        s: INPUTS.s
      })
  },
  '4': {
    label: 'validatorShare.prepareClaimUndelegated',
    prepare: (c) => share(c).prepareClaimUndelegated({ nonce: INPUTS.nonce })
  },
  '5': {
    label: 'validatorShare.prepareUndelegate',
    prepare: (c) =>
      share(c).prepareUndelegate({
        amount: INPUTS.amount,
        maxSharesToBurn: INPUTS.maxSharesToBurn
      })
  },
  '6': {
    label: 'validatorShare.prepareRestakeRewards',
    prepare: (c) => share(c).prepareRestakeRewards()
  },
  '7': {
    label: 'validatorShare.prepareWithdrawRewards',
    prepare: (c) => share(c).prepareWithdrawRewards()
  },
  '8': {
    label: 'stakeManager.prepareMigrateDelegation',
    prepare: (c) =>
      c.stakeManager.prepareMigrateDelegation({
        fromValidatorId: INPUTS.fromValidatorId,
        toValidatorId: INPUTS.toValidatorId,
        amount: INPUTS.amount
      })
  },
  '9': {
    label: 'stakeManager.prepareRestake',
    prepare: (c) =>
      c.stakeManager.prepareRestake({
        validatorId: INPUTS.validatorId,
        amount: INPUTS.amount,
        stakeRewards: INPUTS.stakeRewards
      })
  },
  '10': {
    label: 'stakeManager.prepareWithdrawValidatorRewards',
    prepare: (c) =>
      c.stakeManager.prepareWithdrawValidatorRewards({ validatorId: INPUTS.validatorId })
  },
  '11': {
    label: 'stakeManager.prepareTopUpHeimdallFee',
    prepare: (c) =>
      c.stakeManager.prepareTopUpHeimdallFee({ user: INPUTS.user, amount: INPUTS.amount })
  },
  '12': {
    label: 'stakeManager.prepareUnstake',
    prepare: (c) => c.stakeManager.prepareUnstake({ validatorId: INPUTS.validatorId })
  },
  '13': {
    label: 'stakeManager.prepareClaimUnstaked',
    prepare: (c) => c.stakeManager.prepareClaimUnstaked({ validatorId: INPUTS.validatorId })
  },
  '14': {
    label: 'stakeManager.prepareStakeForMatic',
    prepare: (c) => c.stakeManager.prepareStakeForMatic(STAKE_FOR_PARAMS)
  },
  '15': {
    label: 'stakeManager.prepareStakeFor',
    prepare: (c) => c.stakeManager.prepareStakeFor(STAKE_FOR_PARAMS)
  },
  '16': {
    label: 'stakeManager.prepareUpdateCommissionRate',
    prepare: (c) =>
      c.stakeManager.prepareUpdateCommissionRate({
        validatorId: INPUTS.validatorId,
        commissionRate: INPUTS.commissionRate
      })
  },
  '17': {
    label: 'stakeManager.prepareUpdateSigner',
    prepare: (c) =>
      c.stakeManager.prepareUpdateSigner({
        validatorId: INPUTS.validatorId,
        signerPubkey: INPUTS.signerPubkey
      })
  },
  '18:MaticToken': {
    label: 'matic.prepareApproveMaxForStakeManager',
    prepare: (c) => c.matic.prepareApproveMaxForStakeManager()
  },
  '18:PolToken': {
    label: 'pol.prepareApproveMaxForStakeManager',
    prepare: (c) => c.pol.prepareApproveMaxForStakeManager()
  }
};

/** The amount-taking approve, for the self-consistency check on row 18. */
const APPROVE_AT_MAX: Record<string, Prepare> = {
  MaticToken: (c) => c.matic.prepareApproveStakeManager({ amount: MAX_AMOUNT }),
  PolToken: (c) => c.pol.prepareApproveStakeManager({ amount: MAX_AMOUNT })
};

function keyFor(w: FixtureWrite): string {
  return w.row === 18 ? `18:${w.contract}` : String(w.row);
}

// A fixture that gained, lost or renumbered a write must fail loudly
// rather than silently shrink the comparison.
{
  const fixtureKeys = WRITES.map(keyFor).sort().join(',');
  const mappedKeys = Object.keys(PREPARE_BY_ROW).sort().join(',');
  if (WRITES.length !== 19 || fixtureKeys !== mappedKeys) {
    throw new Error(`fixture writes [${fixtureKeys}] do not match mapped rows [${mappedKeys}]`);
  }
}

// --- adapters -----------------------------------------------------------

const ADAPTERS: ReadonlyArray<{ name: string; build: () => Adapter }> = [
  {
    name: 'viem',
    build: () => viemAdapter({ public: createPublicClient({ transport: http(UNROUTABLE) }) })
  },
  {
    name: 'ethers v5',
    build: () => ethersV5Adapter({ provider: new providers.JsonRpcProvider(UNROUTABLE) })
  },
  {
    name: 'ethers v6',
    build: () =>
      ethersV6Adapter({
        provider: new JsonRpcProvider(UNROUTABLE, Network.from(1), { staticNetwork: true })
      })
  }
];

// --- tests --------------------------------------------------------------

describe('staking calldata — 3.x ground truth', () => {
  for (const adapter of ADAPTERS) {
    describe(`under ${adapter.name}`, () => {
      let client: StakingClient | undefined;
      async function getClient(): Promise<StakingClient> {
        client ??= await StakingClient.init({
          network: 'mainnet',
          parent: adapter.build(),
          addresses: ADDRESSES
        });
        return client;
      }

      for (const w of WRITES) {
        const mapped = PREPARE_BY_ROW[keyFor(w)];
        const label = mapped === undefined ? 'unmapped' : mapped.label;
        it(`row ${w.row} ${w.contract}.${w.functionName} (3.x ${w.method3x}) → ${label}`, async () => {
          if (mapped === undefined) throw new Error(`no 4.0 mapping for row ${keyFor(w)}`);
          const c = await getClient();
          const prepared = await mapped.prepare(c);

          expect(prepared.data).equals(w.data);
          expect(prepared.to.toLowerCase()).equals(w.to.toLowerCase());
          // The selector must be the fixture function's, not merely a
          // function with the same argument shape.
          expect(prepared.data.slice(0, 10)).equals(
            toFunctionSelector(`function ${functionSignature(w)}`)
          );

          const approveAtMax = APPROVE_AT_MAX[w.contract];
          if (w.row === 18 && approveAtMax !== undefined) {
            const amountApprove = await approveAtMax(c);
            expect(amountApprove).deep.equals(prepared);
          }
        });
      }
    });
  }

  it('pol.preparePermit hashes to the 3.x permit digest', async () => {
    const permit = readJson('permit-typed-data-3x.json');
    const typedData = field(permit, 'typedData');
    const message = field(typedData, 'message');
    const domain = field(typedData, 'domain');
    const digest = hex(permit, 'digest');
    const nonceAtCapture = int(permit, 'nonceAtCapture');

    // Answers the two reads `preparePermit` makes with what the token
    // returned on mainnet: the `eip712Domain()` tuple (fields 0x0f, no
    // salt, no extensions) and `nonces(owner)` at the capture block.
    const adapter = new PermitReadAdapter({
      domain: [
        '0x0f',
        str(domain, 'name'),
        str(domain, 'version'),
        int(domain, 'chainId'),
        hex(domain, 'verifyingContract'),
        `0x${'00'.repeat(32)}`,
        []
      ],
      nonce: nonceAtCapture
    });
    const c = await StakingClient.init({
      network: 'mainnet',
      parent: adapter,
      addresses: ADDRESSES
    });

    const prepared = await c.pol.preparePermit({
      owner: hex(message, 'owner'),
      value: int(message, 'value'),
      deadline: int(message, 'deadline')
    });

    expect(prepared.message).property('spender').equals(hex(message, 'spender'));
    expect(prepared.message).property('nonce').equals(nonceAtCapture);
    expect(hashTypedData(prepared)).equals(digest);
  });
});

/**
 * Canonical signatures, keyed by contract and function (ValidatorShare
 * and StakeManager both have a `restakePOL` and a `withdrawRewardsPOL`
 * with different arguments). Written out by hand rather than read from
 * the SDK's ABI, so the selector check is independent of the ABI the
 * port encodes with.
 */
const SIGNATURES: Record<string, string> = {
  'ValidatorShare.buyVoucher': 'buyVoucher(uint256,uint256)',
  'ValidatorShare.buyVoucherPOL': 'buyVoucherPOL(uint256,uint256)',
  'ValidatorShare.buyVoucherWithPermit':
    'buyVoucherWithPermit(uint256,uint256,uint256,uint8,bytes32,bytes32)',
  'ValidatorShare.unstakeClaimTokens_newPOL': 'unstakeClaimTokens_newPOL(uint256)',
  'ValidatorShare.sellVoucher_newPOL': 'sellVoucher_newPOL(uint256,uint256)',
  'ValidatorShare.restakePOL': 'restakePOL()',
  'ValidatorShare.withdrawRewardsPOL': 'withdrawRewardsPOL()',
  'StakeManager.migrateDelegation': 'migrateDelegation(uint256,uint256,uint256)',
  'StakeManager.restakePOL': 'restakePOL(uint256,uint256,bool)',
  'StakeManager.withdrawRewardsPOL': 'withdrawRewardsPOL(uint256)',
  'StakeManager.topUpForFee': 'topUpForFee(address,uint256)',
  'StakeManager.unstakePOL': 'unstakePOL(uint256)',
  'StakeManager.unstakeClaimPOL': 'unstakeClaimPOL(uint256)',
  'StakeManager.stakeFor': 'stakeFor(address,uint256,uint256,bool,bytes)',
  'StakeManager.stakeForPOL': 'stakeForPOL(address,uint256,uint256,bool,bytes)',
  'StakeManager.updateCommissionRate': 'updateCommissionRate(uint256,uint256)',
  'StakeManager.updateSigner': 'updateSigner(uint256,bytes)',
  'MaticToken.approve': 'approve(address,uint256)',
  'PolToken.approve': 'approve(address,uint256)'
};

function functionSignature(w: FixtureWrite): string {
  const sig = SIGNATURES[`${w.contract}.${w.functionName}`];
  if (sig === undefined) throw new Error(`no signature for ${w.contract}.${w.functionName}`);
  return sig;
}

/**
 * Answers `eip712Domain()` and `nonces(owner)` with fixed values, in the
 * decoded shape a client returns; anything else is a test bug.
 */
class PermitReadAdapter implements Adapter {
  private readonly domain: readonly unknown[];
  private readonly nonce: bigint;
  constructor(args: { domain: readonly unknown[]; nonce: bigint }) {
    this.domain = args.domain;
    this.nonce = args.nonce;
  }
  getChainId(): Promise<number> {
    return Promise.resolve(1);
  }
  read(req: ReadRequest): Promise<unknown> {
    if (req.functionName === 'eip712Domain') return Promise.resolve(this.domain);
    if (req.functionName === 'nonces') return Promise.resolve(this.nonce);
    return Promise.reject(new Error(`unexpected read ${req.functionName}`));
  }
  write(_req: WriteRequest): Promise<TxResult> {
    return Promise.reject(new Error('unexpected write'));
  }
  prepareWrite(_req: WriteRequest): Promise<PreparedTx> {
    return Promise.reject(new Error('unexpected prepareWrite'));
  }
  estimateGas(_req: WriteRequest): Promise<bigint> {
    return Promise.reject(new Error('unexpected estimateGas'));
  }
  getTransactionReceipt(_hash: string): Promise<Receipt | null> {
    return Promise.resolve(null);
  }
  keccak256(_data: Uint8Array | string): string {
    return '0x0';
  }
  request<T>(method: string, _params: readonly unknown[]): Promise<T> {
    return Promise.reject(new Error(`unexpected request ${method}`));
  }
}
