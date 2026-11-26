/**
 * Built-dist check that the built-in adapter registry is ONE instance.
 *
 * A read result that does not match the ABI is worded differently for the
 * SDK's own adapters (a report-an-SDK-issue message) and for a hand-written
 * one (what `read()` must return). The decoder tells them apart through a
 * registry that each built-in adapter joins in its constructor
 * (`src/internal/builtin-adapters.ts`). The adapters are separate entries
 * (`./viem`, `./ethers-v5`, `./ethers-v6`) and the decoder is reached from the
 * root entry, so the registry only works if the build hoists that module into
 * one shared chunk. A bundler change that duplicated it per entry would make
 * every built-in adapter look hand-written, and no source-level test would
 * notice, since those import the modules directly.
 *
 * So this runs against `dist/`: it constructs each built-in adapter from its
 * built entry, makes it return a malformed value for a read made through a
 * client from the built root entry, and expects the built-in message; a
 * hand-written adapter doing the same must get the other one.
 *
 * Not part of the unit suite on purpose: CI runs `pnpm test` in a job that
 * never builds, so a vitest test over `dist/` would have nothing to read there.
 *
 * The built `./ethers-v5` entry imports a bare `ethers`, which is what a v5
 * consumer has installed; here `ethers` is v6, so a resolve hook points that one
 * import at the workspace's v5 install (the `ethers-v5` dev alias).
 *
 * Run: `node scripts/check-builtin-adapter-registry.mjs` after `pnpm run build`.
 * Plain Node, no dependencies beyond the package's own.
 */
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!existsSync(join(dist, 'index.js'))) {
  console.error('builtin-adapter-registry: dist/ is missing; run `pnpm run build` first');
  process.exit(1);
}
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      const fromV5Entry = context.parentURL?.endsWith('/adapters/ethers-v5.js');
      return next(specifier === 'ethers' && fromV5Entry ? 'ethers-v5' : specifier, context);
    }
  `)}`,
  import.meta.url
);
const load = (file) => import(pathToFileURL(join(dist, file)).href);

const { POSClient, AdapterResultMismatchError } = await load('index.js');
const { viemAdapter } = await load('adapters/viem.js');
const { ethersV5Adapter } = await load('adapters/ethers-v5.js');
const { ethersV6Adapter } = await load('adapters/ethers-v6.js');

const USER = '0x00000000000000000000000000000000000000a1';
const TOKEN = '0x00000000000000000000000000000000000000c1';
const ADDRESSES = {
  RootChainManager: '0x1111111111111111111111111111111111111111',
  ERC20Predicate: '0x2222222222222222222222222222222222222222',
  ERC721Predicate: '0x3333333333333333333333333333333333333333',
  ERC1155Predicate: '0x4444444444444444444444444444444444444444',
  EtherPredicate: '0x5555555555555555555555555555555555555555',
  RootChain: '0x6666666666666666666666666666666666666666'
};

/** `balanceOf` is declared `uint256`; a string that is not a number is a mismatch from any adapter. */
const MALFORMED = 'not a number';

/** The mismatch error a malformed `balanceOf` result produces through `adapter`, from the built root entry. */
const mismatchThrough = async (adapter) => {
  const client = await POSClient.init({
    network: 'amoy',
    parent: adapter,
    child: adapter,
    addresses: ADDRESSES
  });
  try {
    await client.parent.erc20(TOKEN).getBalance(USER);
  } catch (err) {
    const found = AdapterResultMismatchError.find(err);
    if (found !== null) return found;
    throw new Error(`expected an AdapterResultMismatchError, got: ${String(err)}`);
  }
  throw new Error('expected the read to reject');
};

/** A built-in adapter whose `read` hands back the malformed value, as a faulty adapter would. */
const faulty = (adapter) => {
  adapter.getChainId = () => Promise.resolve(80002);
  adapter.read = () => Promise.resolve(MALFORMED);
  return adapter;
};

/** A hand-written adapter: the members the read path touches, nothing from the SDK. */
const handWritten = () => ({
  getChainId: () => Promise.resolve(80002),
  read: () => Promise.resolve(MALFORMED)
});

const BUILT_IN =
  /^The built-in adapter returned a string that is not an integer for balanceOf output 0 \(the ABI declares uint256\)\. This should not happen with valid data; report it as an issue against @polygonlabs\/maticjs\.$/;
const CUSTOM =
  /^Your adapter's read\(\) returned a string that is not an integer for balanceOf output 0 \(the ABI declares uint256\)\. read\(\) must return the value viem or ethers produces for that output\.$/;

const cases = [
  ['viem (./viem entry)', () => faulty(viemAdapter({ public: {} })), BUILT_IN],
  ['ethers v5 (./ethers-v5 entry)', () => faulty(ethersV5Adapter({ provider: {} })), BUILT_IN],
  ['ethers v6 (./ethers-v6 entry)', () => faulty(ethersV6Adapter({ provider: {} })), BUILT_IN],
  ['hand-written adapter', handWritten, CUSTOM]
];

let failed = false;
for (const [name, build, expected] of cases) {
  try {
    const err = await mismatchThrough(build());
    const ok = expected.test(err.message);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${err.message}`);
    if (!ok) failed = true;
  } catch (err) {
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
    failed = true;
  }
}
if (failed) {
  console.error(
    'builtin-adapter-registry: the registry is not one shared instance across the built entries, or a message variant is wrong'
  );
  process.exit(1);
}
console.log(
  'builtin-adapter-registry: one registry across ./viem, ./ethers-v5, ./ethers-v6 and the root entry'
);
