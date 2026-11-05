/**
 * Records the staking read fixtures under `tests/fixtures/staking/`
 * (`reads-mainnet.json`, `reads-sepolia.json`) from live parent chains,
 * consumed by `tests/live/staking-reads.live.test.ts`.
 *
 * For each network it:
 *
 *  1. probes that the RPC serves `eth_call` 5000 blocks back — the test
 *     replays every read at the pinned block, so a pruned (non-archive)
 *     endpoint would fail the moment the pin ages out of its window;
 *  2. pins the current `finalized` block, so the recorded values cannot
 *     be reorged away;
 *  3. reads through the BUILT `dist/staking` entry with that `blockTag`
 *     and writes `{ PROVENANCE, network, rpc, blockNumber, reads }`.
 *
 * Every read is a pure function of chain state at a finalized block,
 * so the fixtures never go stale. A test mismatch means the SDK decodes
 * differently (or the endpoint served the wrong state) — never re-record
 * to make a test pass.
 *
 * Run from packages/maticjs after `pnpm run build`:
 *   node scripts/record-staking-read-fixtures.mjs
 *
 * RPC overrides: `POS_SDK_TEST_MAINNET_PARENT_RPC` (Ethereum mainnet)
 * and `POS_SDK_TEST_PARENT_RPC` (Sepolia); both default to public,
 * credential-free endpoints.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const ZERO = '0x0000000000000000000000000000000000000000';
const VALIDATOR_ID = 1n;
const ARCHIVE_DEPTH = 5000;

// Defaults must be credential-free AND archive-capable, because the test
// replays reads at a block that only gets older. Checked 2026-11-04:
// publicnode's mainnet endpoint refuses historical state without a token
// and its Sepolia endpoint prunes after roughly 190k blocks (~26 days);
// dRPC's free tier has no Sepolia. These two serve full history.
const MAINNET_DEFAULT_RPC = 'https://eth.drpc.org';
const SEPOLIA_DEFAULT_RPC = 'https://sepolia.gateway.tenderly.co';

const NETWORKS = [
  {
    file: 'reads-mainnet.json',
    label: 'Ethereum mainnet',
    network: 'mainnet',
    rpc: process.env.POS_SDK_TEST_MAINNET_PARENT_RPC ?? MAINNET_DEFAULT_RPC
  },
  {
    file: 'reads-sepolia.json',
    label: 'Sepolia',
    network: 'amoy',
    rpc: process.env.POS_SDK_TEST_PARENT_RPC ?? SEPOLIA_DEFAULT_RPC
  }
];

const { StakingClient } = await import(join(pkgDir, 'dist', 'staking', 'index.js'));
const { viemAdapter } = await import(join(pkgDir, 'dist', 'adapters', 'viem.js'));
const { createPublicClient, http } = await import('viem');

/** bigint → decimal string, recursively; everything else as is. */
const encode = (v) => {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(encode);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  }
  return v;
};

/** Never print a token-bearing RPC URL into a committed fixture. */
const publicRpcLabel = (rpc) => {
  const u = new URL(rpc);
  return u.search === '' && u.username === '' && u.password === ''
    ? rpc
    : `${u.origin} (query redacted)`;
};

const today = new Date().toISOString().slice(0, 10);

for (const n of NETWORKS) {
  const publicClient = createPublicClient({ transport: http(n.rpc) });

  // 1. Archive probe.
  const latest = await publicClient.getBlockNumber();
  const probeBlock = latest - BigInt(ARCHIVE_DEPTH);
  try {
    await publicClient.getBalance({ address: ZERO, blockNumber: probeBlock });
  } catch (err) {
    throw new Error(
      `${n.label} RPC ${publicRpcLabel(n.rpc)} cannot serve state at block ${probeBlock} ` +
        `(latest - ${ARCHIVE_DEPTH}); use an archive-capable endpoint. Cause: ${err.message}`
    );
  }

  // 2. Pin a finalized block.
  const finalized = await publicClient.getBlock({ blockTag: 'finalized' });
  const blockTag = finalized.number;

  // 3. Record.
  const staking = await StakingClient.init({
    network: n.network,
    parent: viemAdapter({ public: publicClient })
  });
  const addresses = await staking.getAddresses();
  const opts = { blockTag };
  const reads = [];
  const record = async (target, method, params, call) => {
    reads.push({ target, method, params: encode(params), expected: encode(await call()) });
  };

  const sm = staking.stakeManager;
  const vid = { validatorId: VALIDATOR_ID };
  await record('stakeManager', 'getValidator', vid, () => sm.getValidator(vid, opts));
  await record('stakeManager', 'getValidatorContract', vid, () =>
    sm.getValidatorContract(vid, opts)
  );
  await record('stakeManager', 'getDelegatedAmount', vid, () => sm.getDelegatedAmount(vid, opts));
  await record('stakeManager', 'getMinDeposit', null, () => sm.getMinDeposit(opts));
  await record('stakeManager', 'getMinHeimdallFee', null, () => sm.getMinHeimdallFee(opts));
  await record('stakeManager', 'getWithdrawalDelay', null, () => sm.getWithdrawalDelay(opts));
  await record('stakeManager', 'getCurrentEpoch', null, () => sm.getCurrentEpoch(opts));
  await record('stakeManager', 'getTotalStaked', null, () => sm.getTotalStaked(opts));
  await record('stakeManager', 'isLocked', null, () => sm.isLocked(opts));

  const shareAddress = await sm.getValidatorContract(vid, opts);
  if (shareAddress.toLowerCase() === ZERO) {
    throw new Error(`${n.label}: validator ${VALIDATOR_ID} has no ValidatorShare contract`);
  }
  const share = staking.validatorShare(shareAddress);
  const zeroUser = { user: ZERO };
  await record('validatorShare', 'getExchangeRate', null, () => share.getExchangeRate(opts));
  await record('validatorShare', 'getMinAmount', null, () => share.getMinAmount(opts));
  await record('validatorShare', 'getValidatorId', null, () => share.getValidatorId(opts));
  await record('validatorShare', 'getUnbondNonce', zeroUser, () =>
    share.getUnbondNonce(zeroUser, opts)
  );
  await record('validatorShare', 'getLiquidRewards', zeroUser, () =>
    share.getLiquidRewards(zeroUser, opts)
  );
  await record('validatorShare', 'getBalance', zeroUser, () => share.getBalance(zeroUser, opts));

  const smHolder = { user: addresses.StakeManager };
  const zeroOwner = { owner: ZERO };
  await record('pol', 'getBalance', smHolder, () => staking.pol.getBalance(smHolder, opts));
  await record('pol', 'getNonce', zeroOwner, () => staking.pol.getNonce(zeroOwner, opts));
  await record('matic', 'getBalance', smHolder, () => staking.matic.getBalance(smHolder, opts));
  await record('pol', 'getAllowanceForStakeManager', zeroOwner, () =>
    staking.pol.getAllowanceForStakeManager(zeroOwner, opts)
  );

  const fixture = {
    PROVENANCE:
      `Staking reads on ${n.label} at finalized block ${blockTag}, recorded ${today} through the ` +
      `built SDK (viem adapter) with blockTag pinned to that block. Validator ${VALIDATOR_ID}; ` +
      `the ValidatorShare reads target its contract (validatorShareAddress). Every value is chain ` +
      `state at a finalized block and never changes. Re-record with ` +
      `scripts/record-staking-read-fixtures.mjs only after an intentional decoding change.`,
    network: n.network,
    rpc: publicRpcLabel(n.rpc),
    blockNumber: Number(blockTag),
    addresses: {
      StakeManager: addresses.StakeManager,
      MaticToken: addresses.MaticToken,
      PolToken: addresses.PolToken
    },
    validatorShareAddress: shareAddress,
    reads
  };
  writeFileSync(
    join(pkgDir, 'tests', 'fixtures', 'staking', n.file),
    JSON.stringify(fixture, null, 2) + '\n'
  );
  console.log(`${n.label}: pinned block ${blockTag}, ${reads.length} reads → ${n.file}`);
}
