/**
 * Records the exit-payload ground-truth fixtures under
 * `tests/fixtures/exits/` from live Polygon mainnet:
 *
 *  1. walks recent-but-checkpointed block receipts (via public RPC)
 *     looking for one burn-shaped log per token standard —
 *     ERC-20 `Transfer(from, 0x0, v)` (3 topics), ERC-721
 *     `Transfer(from, 0x0, id)` (4 topics), ERC-1155
 *     `TransferSingle(op, from, 0x0, ...)`;
 *  2. fetches the ground-truth exit payload for each burn from the
 *     production proof-generation API;
 *  3. VERIFIES the SDK's local construction reproduces the API payload
 *     byte-for-byte (against the built `dist/`) before writing anything;
 *  4. writes the fixture JSONs consumed by
 *     `tests/integration/exit-payload.test.ts`.
 *
 * Run from packages/maticjs after `pnpm run build`:
 *   node scripts/record-exit-fixture.mjs
 *
 * Plain JavaScript so it runs on any supported Node. Any burn works —
 * the fixture pins ENCODING, not bridge-token semantics — but only
 * checkpointed blocks can produce a payload, hence the ~75-minute
 * look-back.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHILD_RPC = process.env.POS_SDK_TEST_MAINNET_CHILD_RPC ?? 'https://polygon.drpc.org';
const PARENT_RPC = process.env.POS_SDK_TEST_MAINNET_PARENT_RPC ?? 'https://ethereum-rpc.publicnode.com';
const PROOF_API = 'https://proof-generator.polygon.technology';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const ZERO32 = `0x${'0'.repeat(64)}`;

const rpc = async (method, params) => {
  const res = await fetch(CHILD_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000)
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
};

// 1. Discover one burn per standard from checkpointed blocks.
const latest = parseInt(await rpc('eth_blockNumber', []), 16);
const found = { erc20: null, erc721: null, erc1155: null };
for (let b = latest - 2300; b > latest - 3500 && !(found.erc20 && found.erc721 && found.erc1155); b--) {
  const receipts = await rpc('eth_getBlockReceipts', [`0x${b.toString(16)}`]).catch(() => null);
  if (!receipts) continue;
  for (const r of receipts) {
    for (const l of r.logs ?? []) {
      if (l.topics?.[0] === TRANSFER && l.topics.length === 3 && l.topics[2] === ZERO32 && !found.erc20)
        found.erc20 = { tx: r.transactionHash, block: b, sig: TRANSFER, standard: 'ERC-20', note: 'Transfer(from, 0x0, value) — 3-topic burn log' };
      if (l.topics?.[0] === TRANSFER && l.topics.length === 4 && l.topics[2] === ZERO32 && !found.erc721)
        found.erc721 = { tx: r.transactionHash, block: b, sig: TRANSFER, standard: 'ERC-721', note: 'Transfer(from, 0x0, tokenId) — 4-topic burn log' };
      if (l.topics?.[0] === TRANSFER_SINGLE && l.topics.length === 4 && l.topics[3] === ZERO32 && !found.erc1155)
        found.erc1155 = { tx: r.transactionHash, block: b, sig: TRANSFER_SINGLE, standard: 'ERC-1155', note: 'TransferSingle(op, from, 0x0, ...) burn log' };
    }
  }
}
for (const [kind, f] of Object.entries(found)) {
  if (!f) throw new Error(`no ${kind} burn found in scan window — widen the look-back`);
  console.log(`${kind}: ${f.tx} @ ${f.block}`);
}

// 2. Ground truth from the proof-generation API.
for (const f of Object.values(found)) {
  const url = `${PROOF_API}/api/v1/matic/exit-payload/${f.tx}?eventSignature=${f.sig}`;
  const j = await fetch(url, { signal: AbortSignal.timeout(120_000) }).then((r) => r.json());
  if (typeof j?.result !== 'string') throw new Error(`proof API gave no payload for ${f.tx}: ${JSON.stringify(j).slice(0, 200)}`);
  f.payload = j.result;
}
console.log('ground-truth payloads fetched');

// 3. Verify local construction reproduces every payload before writing.
const { POSClient } = await import(join(pkgDir, 'dist', 'index.js'));
const { viemAdapter } = await import(join(pkgDir, 'dist', 'adapters', 'viem.js'));
const { createPublicClient, http } = await import('viem');
const pos = await POSClient.init({
  network: 'mainnet',
  parent: viemAdapter({ public: createPublicClient({ transport: http(PARENT_RPC) }) }),
  child: viemAdapter({ public: createPublicClient({ transport: http(CHILD_RPC) }) })
});
for (const [kind, f] of Object.entries(found)) {
  const local = await pos.buildExitPayload(f.tx, f.sig, false);
  if (local.toLowerCase() !== f.payload.toLowerCase()) {
    throw new Error(`${kind}: local construction DIVERGES from proof API — refusing to record. Investigate before re-running.`);
  }
  console.log(`${kind}: local === API ✓`);
}

// 4. Write fixtures.
const today = new Date().toISOString().slice(0, 10);
for (const [kind, f] of Object.entries(found)) {
  const fixture = {
    PROVENANCE: `Real Polygon-mainnet ${f.standard} burn (${f.note}), block ${f.block}, recorded ${today}. expectedPayloadHex is the proof-generation API's payload for this burn, INDEPENDENTLY verified byte-identical to the SDK's local construction at recording time. Re-record with scripts/record-exit-fixture.mjs.`,
    network: 'mainnet',
    burnTxHash: f.tx,
    eventSignature: f.sig,
    blockNumber: f.block,
    expectedPayloadHex: f.payload
  };
  writeFileSync(join(pkgDir, 'tests', 'fixtures', 'exits', `${kind}-burn-1.json`), JSON.stringify(fixture, null, 2) + '\n');
}
console.log('fixtures written');
