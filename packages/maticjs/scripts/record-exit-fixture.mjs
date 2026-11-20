/**
 * Records the exit-payload ground-truth fixtures under
 * `tests/fixtures/exits/` from live Polygon mainnet, and the offline
 * cassettes under `tests/fixtures/exits/cassettes/` that replay the RPC
 * traffic the SDK's local payload construction consumes.
 *
 * Modes (see `--help`):
 *
 *  default      1. walks recent-but-checkpointed block receipts (via public
 *                  RPC) looking for one burn-shaped log per token standard
 *                  (ERC-20 / ERC-721 / ERC-1155);
 *               2. fetches the ground-truth exit payload for each burn from
 *                  the production proof-generation API;
 *               3. VERIFIES the SDK's local construction reproduces the API
 *                  payload byte-for-byte (against the built `dist/`) before
 *                  writing anything;
 *               4. writes the three `*-burn-1.json` fixtures consumed by
 *                  `tests/live/exit-payload.live.test.ts`.
 *  --cassette   records a cassette per fixture that already exists; never
 *               rewrites a fixture. Accepts names (`erc20 erc721 erc1155
 *               plasma-erc20`) to limit the set.
 *  --plasma     finds a recent checkpointed burn of the native token
 *               (the Plasma withdraw log), fetches its payload from the proof
 *               API with that event signature, refuses to write unless local
 *               construction reproduces it byte for byte, then writes
 *               `plasma-erc20-burn-1.json` and its cassette.
 *
 * Run from packages/maticjs after `pnpm run build`:
 *   node scripts/record-exit-fixture.mjs
 *
 * Plain JavaScript so it runs on any supported Node. Any burn works —
 * the fixture pins ENCODING, not bridge-token semantics — but only
 * checkpointed blocks can produce a payload, hence the look-back.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage: node scripts/record-exit-fixture.mjs [mode]

Run from packages/maticjs after \`pnpm run build\`. Reads mainnet only; needs no key.

Modes:
  (none)                    Record the ERC-20, ERC-721 and ERC-1155 ground-truth
                            fixtures (tests/fixtures/exits/*-burn-1.json).
                            Rewrites them: only after an intentional protocol change.
  --cassette [name ...]     Record the offline cassettes (tests/fixtures/exits/cassettes/)
                            for fixtures that already exist, without touching any
                            fixture. Names: erc20, erc721, erc1155, plasma-erc20.
                            Default: all four.
  --plasma                  Find a recent checkpointed burn of the native token
                            (Plasma withdraw log), fetch its payload from the proof
                            API with that event signature, refuse to write unless local
                            construction reproduces it byte for byte, then write
                            plasma-erc20-burn-1.json and its cassette.
  --help                    Print this text.

Environment:
  POS_SDK_TEST_MAINNET_CHILD_RPC   Polygon PoS mainnet RPC (default https://polygon.drpc.org).
                                   --plasma needs one that serves eth_getLogs over a few
                                   thousand blocks.
  POS_SDK_TEST_MAINNET_PARENT_RPC  Ethereum mainnet RPC (default https://ethereum-rpc.publicnode.com).
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const mode = args.includes('--plasma')
  ? 'plasma'
  : args.includes('--cassette')
    ? 'cassette'
    : args.length === 0
      ? 'default'
      : null;
if (mode === null) {
  console.error(USAGE);
  process.exit(2);
}

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXITS_DIR = join(pkgDir, 'tests', 'fixtures', 'exits');
const CASSETTES_DIR = join(EXITS_DIR, 'cassettes');
const CHILD_RPC = process.env.POS_SDK_TEST_MAINNET_CHILD_RPC ?? 'https://polygon.drpc.org';
const PARENT_RPC =
  process.env.POS_SDK_TEST_MAINNET_PARENT_RPC ?? 'https://ethereum-rpc.publicnode.com';
const PROOF_API = 'https://proof-generator.polygon.technology';
/** Largest cassette this script will write, in bytes. */
const MAX_CASSETTE_BYTES = 1_500_000;

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
/** Plasma withdraw log: `Withdraw(address indexed token, address indexed from, uint256, uint256, uint256)`. */
const PLASMA_WITHDRAW = '0xebff2602b3f468259e1e99f613fed6691f3a6526effe6ef3e768ba7ae7a36c4f';
/** The native token's emitter address on the child chain. */
const NATIVE_TOKEN = '0x0000000000000000000000000000000000001010';
const ZERO32 = `0x${'0'.repeat(64)}`;

const rpcTo = async (url, method, params) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000)
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
};
const rpc = (method, params) => rpcTo(CHILD_RPC, method, params);

const proofApiPayload = async (tx, sig) => {
  const url = `${PROOF_API}/api/v1/matic/exit-payload/${tx}?eventSignature=${sig}`;
  const j = await fetch(url, { signal: AbortSignal.timeout(120_000) }).then((r) => r.json());
  if (typeof j?.result !== 'string')
    throw new Error(`proof API gave no payload for ${tx}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.result;
};

// ---------------------------------------------------------------------------
// Cassette recording. The wire format below is replayed by
// tests/unit/cassette-adapter.ts, which carries the same `canonicalKey` and
// bigint tagging; change them together.
// ---------------------------------------------------------------------------

const bigintReplacer = (_key, value) =>
  typeof value === 'bigint' ? { $bigint: value.toString() } : value;

/** Method plus params, with object keys sorted and bigints tagged. */
const canonicalKey = (method, params) => {
  const sorted = (v) => {
    if (typeof v === 'bigint') return { $bigint: v.toString() };
    if (Array.isArray(v)) return v.map(sorted);
    if (v !== null && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sorted(v[k])])
      );
    return v;
  };
  return `${method} ${JSON.stringify(sorted(params))}`;
};

/**
 * Wraps an adapter so every `read`, `request` and `getTransactionReceipt`
 * response is captured under its canonical key. Everything else passes
 * straight through. The first response to a key wins.
 */
const recordingAdapter = (inner) => {
  const entries = {};
  const capture = async (key, call) => {
    const value = await call();
    if (!(key in entries)) entries[key] = JSON.parse(JSON.stringify(value, bigintReplacer));
    return value;
  };
  const adapter = {
    getChainId: () => capture(canonicalKey('getChainId', []), () => inner.getChainId()),
    read: (req) =>
      capture(
        canonicalKey('read', {
          address: req.address.toLowerCase(),
          functionName: req.functionName,
          args: req.args ?? [],
          blockTag: req.blockTag ?? null
        }),
        () => inner.read(req)
      ),
    request: (method, params) =>
      capture(canonicalKey('request', { method, params }), () => inner.request(method, params)),
    getTransactionReceipt: (hash) =>
      capture(canonicalKey('getTransactionReceipt', [hash.toLowerCase()]), () =>
        inner.getTransactionReceipt(hash)
      ),
    write: (req) => inner.write(req),
    prepareWrite: (req) => inner.prepareWrite(req),
    estimateGas: (req) => inner.estimateGas(req),
    keccak256: (data) => inner.keccak256(data)
  };
  return { adapter, entries };
};

const loadSdk = async () => {
  const { POSClient } = await import(join(pkgDir, 'dist', 'index.js'));
  const { viemAdapter } = await import(join(pkgDir, 'dist', 'adapters', 'viem.js'));
  const { createPublicClient, http } = await import('viem');
  const adapterFor = (url) => viemAdapter({ public: createPublicClient({ transport: http(url) }) });
  return { POSClient, adapterFor };
};

/** The address index the SDK resolves for mainnet, flattened by the SDK itself. */
const resolveMainnetAddresses = async ({ POSClient, adapterFor }) => {
  const pos = await POSClient.init({
    network: 'mainnet',
    parent: adapterFor(PARENT_RPC),
    child: adapterFor(CHILD_RPC)
  });
  return pos.getAddresses();
};

/**
 * Builds the payload for one fixture's burn through recording adapters and
 * returns the cassette (not yet written). Throws unless the payload equals
 * the fixture's `expectedPayloadHex`: a cassette that does not reproduce the
 * ground truth would pin the wrong bytes.
 */
const recordCassette = async ({ sdk, addresses, fixture, name }) => {
  const parent = recordingAdapter(sdk.adapterFor(PARENT_RPC));
  const child = recordingAdapter(sdk.adapterFor(CHILD_RPC));
  const pos = await sdk.POSClient.init({
    network: 'mainnet',
    parent: parent.adapter,
    child: child.adapter,
    addresses
  });
  const payload = await pos.buildExitPayload(fixture.burnTxHash, fixture.eventSignature, false);
  if (payload.toLowerCase() !== fixture.expectedPayloadHex.toLowerCase()) {
    throw new Error(
      `${name}: local construction DIVERGES from the fixture's expectedPayloadHex — refusing to record a cassette.`
    );
  }
  return {
    PROVENANCE: `RPC responses the SDK's local exit-payload construction consumed for the ${name} burn ${fixture.burnTxHash} (block ${fixture.blockNumber}), recorded ${new Date().toISOString().slice(0, 10)} from public mainnet RPCs. Replayed with no network by tests/unit/exit-payload-golden.test.ts. Re-record with scripts/record-exit-fixture.mjs --cassette.`,
    network: 'mainnet',
    burnTxHash: fixture.burnTxHash,
    addresses,
    parent: parent.entries,
    child: child.entries
  };
};

/** One entry per line, so a re-record diffs by entry and the file stays small. */
const serializeCassette = (cassette) => {
  const side = (entries) =>
    `{\n${Object.entries(entries)
      .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(',\n')}\n  }`;
  return `{
  "PROVENANCE": ${JSON.stringify(cassette.PROVENANCE)},
  "network": ${JSON.stringify(cassette.network)},
  "burnTxHash": ${JSON.stringify(cassette.burnTxHash)},
  "addresses": ${JSON.stringify(cassette.addresses)},
  "parent": ${side(cassette.parent)},
  "child": ${side(cassette.child)}
}
`;
};

const writeCassette = (name, cassette) => {
  const text = serializeCassette(cassette);
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_CASSETTE_BYTES)
    throw new Error(`${name}: cassette is ${bytes} bytes, over the ${MAX_CASSETTE_BYTES} limit`);
  mkdirSync(CASSETTES_DIR, { recursive: true });
  writeFileSync(join(CASSETTES_DIR, `${name}-burn-1.json`), text);
  console.log(`${name}: cassette written, ${bytes} bytes`);
};

const readFixture = (name) =>
  JSON.parse(readFileSync(join(EXITS_DIR, `${name}-burn-1.json`), 'utf8'));

const todayUtc = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Mode: --cassette
// ---------------------------------------------------------------------------
if (mode === 'cassette') {
  const known = ['erc20', 'erc721', 'erc1155', 'plasma-erc20'];
  const asked = args.filter((a) => !a.startsWith('--'));
  const names = asked.length > 0 ? asked : known;
  for (const n of names) if (!known.includes(n)) throw new Error(`unknown cassette name: ${n}`);
  const sdk = await loadSdk();
  const addresses = await resolveMainnetAddresses(sdk);
  for (const name of names) {
    if (!existsSync(join(EXITS_DIR, `${name}-burn-1.json`)))
      throw new Error(`no fixture for ${name}; record the fixture first`);
    writeCassette(name, await recordCassette({ sdk, addresses, fixture: readFixture(name), name }));
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Mode: --plasma
// ---------------------------------------------------------------------------
if (mode === 'plasma') {
  const sdk = await loadSdk();
  const addresses = await resolveMainnetAddresses(sdk);

  // Newest block the root chain has checkpointed: every burn at or below it
  // can produce a payload.
  const selector = (await import('viem')).toFunctionSelector('getLastChildBlock()');
  const lastChild = parseInt(
    await rpcTo(PARENT_RPC, 'eth_call', [{ to: addresses.RootChain, data: selector }, 'latest']),
    16
  );
  console.log(`last checkpointed child block: ${lastChild}`);

  // Native-token withdrawals are rare (a few per day), so scan back in
  // chunks until there are enough to choose among.
  const SPAN = 5000;
  const candidates = [];
  for (let hi = lastChild, n = 0; n < 24 && candidates.length < 5; n++, hi -= SPAN) {
    const logs = await rpc('eth_getLogs', [
      {
        address: NATIVE_TOKEN,
        topics: [PLASMA_WITHDRAW],
        fromBlock: `0x${(hi - SPAN + 1).toString(16)}`,
        toBlock: `0x${hi.toString(16)}`
      }
    ]);
    for (const l of logs) candidates.push(l);
  }
  if (candidates.length === 0) throw new Error('no native-token burn found in the scan window');

  // The cassette holds the whole block (every receipt and transaction), so
  // try the smallest blocks first.
  const sized = [];
  for (const l of candidates) {
    const block = await rpc('eth_getBlockByNumber', [l.blockNumber, false]);
    sized.push({ log: l, txCount: block.transactions.length });
  }
  sized.sort((a, b) => a.txCount - b.txCount);

  let recorded = null;
  for (const { log, txCount } of sized) {
    const tx = log.transactionHash;
    const block = parseInt(log.blockNumber, 16);
    console.log(`trying ${tx} @ ${block} (${txCount} txs in block)`);
    const payload = await proofApiPayload(tx, PLASMA_WITHDRAW);
    const fixture = {
      PROVENANCE: `Real Polygon-mainnet burn of the native token (the Plasma withdraw log, ${PLASMA_WITHDRAW}), block ${block}, recorded ${todayUtc()}. expectedPayloadHex is the proof-generation API's payload for this burn, INDEPENDENTLY verified byte-identical to the SDK's local construction at recording time. burnLogTopic1 is the root token and burnLogTopic2 the burner, as logged. Re-record with scripts/record-exit-fixture.mjs --plasma.`,
      network: 'mainnet',
      burnTxHash: tx,
      eventSignature: PLASMA_WITHDRAW,
      blockNumber: block,
      burnLogTopic1: log.topics[1],
      burnLogTopic2: log.topics[2],
      expectedPayloadHex: payload
    };
    const cassette = await recordCassette({ sdk, addresses, fixture, name: 'plasma-erc20' });
    const bytes = Buffer.byteLength(serializeCassette(cassette));
    if (bytes > MAX_CASSETTE_BYTES) {
      console.log(`  cassette would be ${bytes} bytes, over the limit; next candidate`);
      continue;
    }
    recorded = { fixture, cassette };
    break;
  }
  if (recorded === null) throw new Error('every candidate burn exceeded the cassette size limit');

  writeFileSync(
    join(EXITS_DIR, 'plasma-erc20-burn-1.json'),
    JSON.stringify(recorded.fixture, null, 2) + '\n'
  );
  writeCassette('plasma-erc20', recorded.cassette);
  console.log(
    `plasma fixture written: ${recorded.fixture.burnTxHash} @ ${recorded.fixture.blockNumber}`
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Default mode: the three ground-truth fixtures
// ---------------------------------------------------------------------------

// 1. Discover one burn per standard from checkpointed blocks.
const latest = parseInt(await rpc('eth_blockNumber', []), 16);
const found = { erc20: null, erc721: null, erc1155: null };
for (
  let b = latest - 2300;
  b > latest - 3500 && !(found.erc20 && found.erc721 && found.erc1155);
  b--
) {
  const receipts = await rpc('eth_getBlockReceipts', [`0x${b.toString(16)}`]).catch(() => null);
  if (!receipts) continue;
  for (const r of receipts) {
    for (const l of r.logs ?? []) {
      if (
        l.topics?.[0] === TRANSFER &&
        l.topics.length === 3 &&
        l.topics[2] === ZERO32 &&
        !found.erc20
      )
        found.erc20 = {
          tx: r.transactionHash,
          block: b,
          sig: TRANSFER,
          standard: 'ERC-20',
          note: 'Transfer(from, 0x0, value) — 3-topic burn log'
        };
      if (
        l.topics?.[0] === TRANSFER &&
        l.topics.length === 4 &&
        l.topics[2] === ZERO32 &&
        !found.erc721
      )
        found.erc721 = {
          tx: r.transactionHash,
          block: b,
          sig: TRANSFER,
          standard: 'ERC-721',
          note: 'Transfer(from, 0x0, tokenId) — 4-topic burn log'
        };
      if (
        l.topics?.[0] === TRANSFER_SINGLE &&
        l.topics.length === 4 &&
        l.topics[3] === ZERO32 &&
        !found.erc1155
      )
        found.erc1155 = {
          tx: r.transactionHash,
          block: b,
          sig: TRANSFER_SINGLE,
          standard: 'ERC-1155',
          note: 'TransferSingle(op, from, 0x0, ...) burn log'
        };
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
  if (typeof j?.result !== 'string')
    throw new Error(`proof API gave no payload for ${f.tx}: ${JSON.stringify(j).slice(0, 200)}`);
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
    throw new Error(
      `${kind}: local construction DIVERGES from proof API — refusing to record. Investigate before re-running.`
    );
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
  writeFileSync(
    join(pkgDir, 'tests', 'fixtures', 'exits', `${kind}-burn-1.json`),
    JSON.stringify(fixture, null, 2) + '\n'
  );
}
console.log('fixtures written');
