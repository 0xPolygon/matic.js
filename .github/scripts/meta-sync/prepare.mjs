/**
 * Moves `@polygonlabs/meta` to a newer release in the working tree it runs
 * in, regenerates the vendored ABIs, and writes everything the pull-request
 * step needs to a directory.
 *
 * Why it is a plain script and not workflow YAML: the same code runs on a
 * runner and on a laptop, so a bump can be rehearsed locally before the
 * workflow ever touches the repository. Why it does no git or network
 * writes: it runs package code (codegen imports the freshly installed
 * package) in a job that must hold no credential. Everything it produces is
 * data that `open-pr.cjs` validates again before committing it.
 *
 * It MUTATES the tree it runs in. Run it in a throwaway worktree.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const META = '@polygonlabs/meta';
const REGISTRY = 'https://registry.npmjs.org';
const PACKAGE_DIR = 'packages/maticjs';
const ABI_DIR = `${PACKAGE_DIR}/src/abi`;
const HAND_FILE = `${ABI_DIR}/failed-state-sync.ts`;

// The only paths a meta bump may touch. A compromised release can therefore
// reach the pull request only as ABI data, the manifest line and the
// lockfile, all of which a person reviews in a draft. `open-pr.cjs` keeps
// its own copy of this list on purpose: each side checks independently.
const SEGMENT = '[A-Za-z0-9_-][A-Za-z0-9._-]*';
export const ALLOWLIST = [
  /^packages\/maticjs\/package\.json$/,
  /^pnpm-lock\.yaml$/,
  new RegExp(`^packages/maticjs/src/abi/${SEGMENT}\\.ts$`),
  new RegExp(`^\\.changeset/meta-sync-${SEGMENT}\\.md$`)
];

export const ALLOWLIST_TEXT = [
  'packages/maticjs/package.json',
  'pnpm-lock.yaml',
  'packages/maticjs/src/abi/*.ts',
  '.changeset/meta-sync-*.md'
];

// The nine proxy and token addresses `live-cdn.live.test.ts` compares with
// the live index, on both networks. A meta release that moves one of them
// changes where the SDK sends transactions, so it is worth a person's time
// even when no ABI item the source uses changed.
const ADDRESS_NETWORKS = [
  { network: 'mainnet', file: 'network/mainnet/v1/index.json' },
  { network: 'amoy', file: 'network/testnet/amoy/index.json' }
];

const ADDRESS_KEYS = [
  { key: 'RootChainManagerProxy', path: ['Main', 'POSContracts', 'RootChainManagerProxy'] },
  { key: 'ERC20PredicateProxy', path: ['Main', 'POSContracts', 'ERC20PredicateProxy'] },
  { key: 'ERC721PredicateProxy', path: ['Main', 'POSContracts', 'ERC721PredicateProxy'] },
  { key: 'ERC1155PredicateProxy', path: ['Main', 'POSContracts', 'ERC1155PredicateProxy'] },
  { key: 'EtherPredicateProxy', path: ['Main', 'POSContracts', 'EtherPredicateProxy'] },
  { key: 'RootChainProxy', path: ['Main', 'Contracts', 'RootChainProxy'] },
  { key: 'StakeManagerProxy', path: ['Main', 'Contracts', 'StakeManagerProxy'] },
  { key: 'Tokens.MaticToken', path: ['Main', 'Contracts', 'Tokens', 'MaticToken'] },
  { key: 'PolygonEcosystemToken', path: ['Main', 'Contracts', 'PolygonEcosystemToken'] }
];

const OPEN_WHEN_VALUES = ['relevant', 'any'];

const USAGE =
  'Usage: node .github/scripts/meta-sync/prepare.mjs [--target <version>] [--allow-downgrade] [--out <dir>]';

const HELP = [
  USAGE,
  '',
  'Reads META_SYNC_TARGET, META_SYNC_DRY_RUN, META_SYNC_OPEN_WHEN, GITHUB_OUTPUT and',
  'GITHUB_STEP_SUMMARY from the environment.',
  `META_SYNC_OPEN_WHEN (open_when) is ${OPEN_WHEN_VALUES.join(' or ')}, default relevant: with relevant, a`,
  'bump that touches nothing the SDK depends on is summarised but opens no pull request.',
  'Mutates the working tree it runs in; run it in a throwaway worktree.',
  '',
  'Only these paths may change, anything else fails the run:',
  ...ALLOWLIST_TEXT.map((p) => `  ${p}`)
].join('\n');

export const isAllowedPath = (path) => ALLOWLIST.some((re) => re.test(path));

export const findDisallowedPaths = ({ changed, deleted }) =>
  [...changed, ...deleted].filter((p) => !isAllowedPath(p));

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export const isStableVersion = (version) => {
  const match = SEMVER.exec(version);
  return match !== null && match[4] === undefined;
};

const comparePrerelease = ({ a, b }) => {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    const l = /^\d+$/.test(left[i]);
    const r = /^\d+$/.test(right[i]);
    if (l && r && Number(left[i]) !== Number(right[i])) {
      return Number(left[i]) < Number(right[i]) ? -1 : 1;
    }
    if (l !== r) return l ? -1 : 1;
    if (!l && left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
};

/**
 * Semver precedence, numeric per component: compared as strings,
 * `1.10.0` would sort below `1.2.0` and a real bump would be skipped.
 */
export const compareVersions = ({ a, b }) => {
  const left = SEMVER.exec(a);
  const right = SEMVER.exec(b);
  if (!left || !right) throw new Error(`Not a version: ${left ? b : a}`);
  for (let i = 1; i <= 3; i += 1) {
    const l = Number(left[i]);
    const r = Number(right[i]);
    if (l !== r) return l < r ? -1 : 1;
  }
  if (left[4] === undefined && right[4] === undefined) return 0;
  if (left[4] === undefined) return 1;
  if (right[4] === undefined) return -1;
  return comparePrerelease({ a: left[4], b: right[4] });
};

/**
 * The version of `@polygonlabs/meta` the maticjs package resolves, read from
 * the lockfile rather than package.json: the manifest holds a range, the
 * lockfile holds what actually installs.
 */
export const readInstalledVersion = ({ lockText }) => {
  const lines = lockText.split('\n');
  const start = lines.indexOf(`  ${PACKAGE_DIR}:`);
  if (start === -1) throw new Error(`pnpm-lock.yaml has no importer for ${PACKAGE_DIR}`);
  for (let i = start + 1; i < lines.length; i += 1) {
    // The next importer (two-space indent) ends this block.
    if (/^ {0,2}\S/.test(lines[i])) break;
    if (lines[i].trim() === `'${META}':`) {
      const version = /^\s+version:\s*(\S+)/.exec(lines[i + 2] ?? '');
      if (!version)
        throw new Error(`Could not read the resolved ${META} version from the lockfile`);
      return version[1].replace(/\(.*$/, '');
    }
  }
  throw new Error(`${PACKAGE_DIR} does not depend on ${META} in pnpm-lock.yaml`);
};

const registryUrl = (version) => `${REGISTRY}/${META}/${encodeURIComponent(version)}`;

/** `latest` dist-tag version from the public registry (no credential). */
export const fetchLatestVersion = async ({ fetchImpl = fetch } = {}) => {
  const res = await fetchImpl(registryUrl('latest'));
  if (!res.ok) throw new Error(`Registry lookup for ${META}@latest failed: HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body.version !== 'string')
    throw new Error(`Registry returned no version for ${META}@latest`);
  return body.version;
};

export const versionExists = async ({ version, fetchImpl = fetch }) => {
  const res = await fetchImpl(registryUrl(version));
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Registry lookup for ${META}@${version} failed: HTTP ${res.status}`);
  return true;
};

/**
 * Decide what a run does. Scheduled runs (`requested` empty) bump only to a
 * stable `latest` strictly above what is installed; anything else is a
 * quiet no-op so a day with nothing new ends green. An explicit older
 * target is refused unless it is a dry run, because rehearsing against a
 * scratch branch is the only reason to go backwards.
 */
export const decideTarget = ({
  installed,
  latest,
  requested,
  dryRun = false,
  allowDowngrade = false
}) => {
  if (requested) {
    if (!SEMVER.test(requested)) throw new Error(`Target "${requested}" is not a version`);
    const order = compareVersions({ a: requested, b: installed });
    if (order === 0) return { action: 'noop', reason: `${META} is already at ${requested}` };
    if (order < 0 && !dryRun && !allowDowngrade) {
      throw new Error(
        `Target ${requested} is older than installed ${installed}; refusing unless this is a dry run`
      );
    }
    return { action: 'bump', target: requested };
  }
  if (!isStableVersion(latest)) {
    return { action: 'noop', reason: `latest (${latest}) is not a stable version` };
  }
  if (compareVersions({ a: latest, b: installed }) <= 0) {
    return {
      action: 'noop',
      reason: `installed ${installed} is already at or above latest ${latest}`
    };
  }
  return { action: 'bump', target: latest };
};

/**
 * `open_when` decides whether a bump that is not relevant still opens a pull
 * request. Empty means the default (a scheduled run has no input); anything
 * else unknown fails the run rather than quietly choosing a behaviour.
 */
export const parseOpenWhen = ({ value }) => {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return 'relevant';
  if (!OPEN_WHEN_VALUES.includes(trimmed)) {
    throw new Error(`open_when "${trimmed}" is not one of: ${OPEN_WHEN_VALUES.join(', ')}`);
  }
  return trimmed;
};

const readPath = ({ root, path }) => {
  let node = root;
  for (const part of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
};

/**
 * The nine proxy and token addresses, read by path from the installed
 * package's network index JSON (the tree the live index is served from), so
 * nothing from the package is executed to read them. Keys look like
 * `mainnet.RootChainManagerProxy`; a missing key reads as undefined, which
 * counts as a change if the other side has it.
 */
export const readAddressKeys = ({ metaDir }) => {
  const values = {};
  for (const { network, file } of ADDRESS_NETWORKS) {
    const root = JSON.parse(readFileSync(join(metaDir, file), 'utf8'));
    for (const { key, path } of ADDRESS_KEYS) {
      values[`${network}.${key}`] = readPath({ root, path });
    }
  }
  return values;
};

/** Keys whose value differs between two `readAddressKeys` results. */
export const changedAddressKeys = ({ before, after }) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => before[key] !== after[key]
  );

/**
 * Whether a bump touches something a person must look at. Any one reason is
 * enough: the diff removed or changed an item the SDK source uses, a
 * hand-carried fragment is now published (so it can be folded in), or a
 * proxy or token address moved. Everything else (added items, format-only
 * changes, unused removals) is routine and can wait for the next relevant
 * release.
 */
export const computeRelevance = ({ flagged, overlap, addressChanges }) => {
  const reasons = [];
  if (flagged.length > 0) {
    reasons.push(
      `${flagged.length} removed or changed ABI item(s) are referenced in the SDK source`
    );
  }
  if (overlap.length > 0) {
    reasons.push(`${overlap.length} hand-carried fragment(s) are now published by meta`);
  }
  if (addressChanges.length > 0) {
    reasons.push(`proxy or token address changed: ${addressChanges.join(', ')}`);
  }
  return { relevant: reasons.length > 0, reasons };
};

/** The pull-request body: the ABI summary plus why a pull request exists. */
export const buildPrBody = ({ markdown, openWhen, reasons }) => {
  const why =
    reasons.length > 0 ? reasons.map((r) => `- ${r}`) : [`- opened because open_when=${openWhen}`];
  return `${markdown.trimEnd()}\n\n### Why this pull request was opened\n${why.join('\n')}\n`;
};

/** Job summary when a real bump is deliberately not turned into a pull request. */
export const buildSkipSummary = ({ markdown, from, to }) =>
  `${markdown.trimEnd()}\n\nNo pull request was opened for ${META} ${from} -> ${to}: nothing in it is referenced by the SDK source, no hand-carried fragment is now published and no proxy or token address changed. Dispatch with open_when=any to pull it in anyway.\n`;

const MAX_SIGNATURES = 12;

const changesetLines = ({ name, result }) => {
  const total = result.added.length + result.removed.length + result.changed.length;
  const out = [
    `- \`${name}\`: ${result.added.length} added, ${result.removed.length} removed, ${result.changed.length} changed`
  ];
  const shown = [];
  for (const [label, items] of [
    ['added', result.added],
    ['removed', result.removed],
    ['changed', result.changed]
  ]) {
    for (const item of items) shown.push(`${label} \`${item.kind} ${item.signature}\``);
  }
  out.push(...shown.slice(0, MAX_SIGNATURES).map((line) => `  - ${line}`));
  if (total > MAX_SIGNATURES) out.push(`  - and ${total - MAX_SIGNATURES} more`);
  return out;
};

/**
 * Changeset text (rule: never minor or major, a person raises the level).
 *
 * Empty when no published file moved: only a devDependency and the lockfile
 * changed, so there is nothing to release. `patch` otherwise, because the
 * published ABI files changed. The first body line is prose, not a heading:
 * the changelog prefixes it with a commit hash.
 */
export const buildChangeset = ({ target, abiChanged, diff }) => {
  if (!abiChanged) return '---\n---\n';
  const lines = [
    '---',
    "'@polygonlabs/maticjs': patch",
    '---',
    '',
    `Update the vendored contract ABIs to \`${META}\` ${target}.`,
    ''
  ];
  if (diff) {
    for (const name of diff.onlyAfter) lines.push(`- Added the \`${name}\` ABI`);
    for (const name of diff.onlyBefore) lines.push(`- Removed the \`${name}\` ABI`);
    let formatOnly = 0;
    for (const [name, result] of Object.entries(diff.contracts)) {
      const total = result.added.length + result.removed.length + result.changed.length;
      if (total > 0) lines.push(...changesetLines({ name, result }));
      else if (result.formatOnly > 0) formatOnly += 1;
    }
    if (formatOnly > 0)
      lines.push(`- ${formatOnly} contract ABI(s) reformatted with no callable change`);
    lines.push('');
  }
  return lines.join('\n');
};

export const changesetPath = ({ target }) =>
  `.changeset/meta-sync-${target.replaceAll('.', '-')}.md`;

export const buildTitle = ({ target, dryRun }) =>
  `${dryRun ? '[dry run] ' : ''}chore(maticjs): update vendored ABIs to ${META} ${target}`;

export const buildBranch = ({ dryRun }) =>
  dryRun ? 'automation/meta-sync-dryrun' : 'automation/meta-sync';

/** `run-e2e` starts the devnet tier, which only matters when the ABIs moved. */
export const buildLabels = ({ abiChanged }) => [
  'dependencies',
  'automation',
  ...(abiChanged ? ['run-e2e'] : [])
];

export const buildManifest = ({ from, to, baseSha, dryRun, changed, deleted, abiChanged }) => ({
  from,
  to,
  baseSha,
  dryRun,
  title: buildTitle({ target: to, dryRun }),
  branch: buildBranch({ dryRun }),
  labels: buildLabels({ abiChanged }),
  changed: [...changed].sort(),
  deleted: [...deleted].sort()
});

/**
 * Changed and deleted paths from `git status --porcelain=v1 -z -uall`.
 * NUL-separated so odd file names need no unquoting; a rename or copy is
 * reported as its old path deleted and its new path changed.
 */
export const parsePorcelain = ({ output }) => {
  const changed = [];
  const deleted = [];
  const entries = output.split('\0').filter((e) => e.length > 0);
  for (let i = 0; i < entries.length; i += 1) {
    const status = entries[i].slice(0, 2);
    const path = entries[i].slice(3);
    if (status.includes('R') || status.includes('C')) {
      i += 1;
      if (status.includes('R')) deleted.push(entries[i]);
      changed.push(path);
    } else if (status.includes('D')) {
      deleted.push(path);
    } else {
      changed.push(path);
    }
  }
  return { changed, deleted };
};

const parseCliArgs = ({ argv }) => {
  const args = { help: false, allowDowngrade: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--allow-downgrade') args.allowDowngrade = true;
    else if (arg === '--target' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(USAGE);
      args[arg.slice(2)] = value;
      i += 1;
    } else throw new Error(USAGE);
  }
  return args;
};

const isTrue = (value) => value === 'true' || value === '1';

const run = ({ cmd, args, cwd, capture = false }) => {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit'
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${res.status}`);
  return res.stdout ?? '';
};

const setOutputs = ({ values }) => {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(
    file,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}\n`)
      .join('')
  );
};

const isInside = ({ parent, child }) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
};

const assertOutDirUsable = ({ out, repoRoot }) => {
  if (isInside({ parent: repoRoot, child: out })) {
    throw new Error(`--out must be outside the repository (${out}), it would show up as a change`);
  }
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`--out ${out} is not empty`);
};

const computeReport = async ({ repoRoot, snapshotDir, from, to }) => {
  // Loaded here, not at module top, so --help and the failure paths before
  // any install do not depend on the package being installed.
  const diffModule = await import(
    pathToFileURL(join(repoRoot, PACKAGE_DIR, 'scripts', 'abi-diff.mjs')).href
  );
  const abiDir = join(repoRoot, ABI_DIR);
  const diff = await diffModule.diffAbis({ beforeDir: snapshotDir, afterDir: abiDir });
  // The ABI directory holds every generated name itself; scanning it would
  // mark every item as used.
  const used = diffModule.collectUsages({
    srcDir: join(repoRoot, PACKAGE_DIR, 'src'),
    excludeDirs: [abiDir]
  });
  const handFile = join(repoRoot, HAND_FILE);
  const result = {
    diff,
    flagged: diffModule.flagUsed({ diff, used }),
    overlap: existsSync(handFile)
      ? await diffModule.findHandCarriedOverlap({ generatedDir: abiDir, handFile })
      : []
  };
  return { result, markdown: diffModule.renderMarkdown(result, { from, to }) };
};

const gitStatus = ({ repoRoot }) =>
  parsePorcelain({
    output: run({
      cmd: 'git',
      args: ['status', '--porcelain=v1', '-z', '-uall'],
      cwd: repoRoot,
      capture: true
    })
  });

const main = async () => {
  const args = parseCliArgs({ argv: process.argv.slice(2) });
  if (args.help) {
    console.log(HELP);
    return;
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const requested = (args.target ?? process.env.META_SYNC_TARGET ?? '').trim();
  const dryRun = isTrue(process.env.META_SYNC_DRY_RUN ?? '');
  const openWhen = parseOpenWhen({ value: process.env.META_SYNC_OPEN_WHEN });
  const out = resolve(args.out ?? join(tmpdir(), 'meta-sync-out'));
  assertOutDirUsable({ out, repoRoot });

  const installed = readInstalledVersion({
    lockText: readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
  });
  // A named version must exist before anything is changed, so a typo fails
  // fast and leaves the tree untouched.
  if (requested && !(await versionExists({ version: requested }))) {
    throw new Error(`${META}@${requested} does not exist on the npm registry`);
  }
  const latest = requested ? undefined : await fetchLatestVersion();
  const decision = decideTarget({
    installed,
    latest,
    requested,
    dryRun,
    allowDowngrade: args.allowDowngrade
  });
  if (decision.action === 'noop') {
    console.log(`No change: ${decision.reason}.`);
    setOutputs({ values: { changed: 'false' } });
    return;
  }
  const { target } = decision;
  const baseSha = run({
    cmd: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: repoRoot,
    capture: true
  }).trim();
  console.log(`Bumping ${META} ${installed} -> ${target} on ${baseSha}`);

  const metaDir = join(repoRoot, PACKAGE_DIR, 'node_modules', META);
  const addressesBefore = readAddressKeys({ metaDir });
  const snapshotDir = mkdtempSync(join(tmpdir(), 'meta-sync-abi-before-'));
  cpSync(join(repoRoot, ABI_DIR), snapshotDir, { recursive: true });

  // The exact version is the spec: `pnpm add` still records `^<target>` in
  // package.json, but resolves the named release rather than the newest
  // match of a range, which would break a pinned dispatch target.
  run({
    cmd: 'pnpm',
    args: [
      '--filter',
      '@polygonlabs/maticjs',
      'add',
      '--save-dev',
      `${META}@${target}`,
      '--ignore-scripts'
    ],
    cwd: repoRoot
  });
  const resolved = readInstalledVersion({
    lockText: readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
  });
  if (resolved !== target) {
    throw new Error(`Lockfile resolves ${META} ${resolved}, expected ${target}`);
  }
  run({ cmd: 'pnpm', args: ['--filter', '@polygonlabs/maticjs', 'run', 'codegen'], cwd: repoRoot });

  const afterCodegen = gitStatus({ repoRoot });
  const abiChanged = [...afterCodegen.changed, ...afterCodegen.deleted].some((p) =>
    p.startsWith(`${ABI_DIR}/`)
  );
  const { result, markdown } = await computeReport({
    repoRoot,
    snapshotDir,
    from: installed,
    to: target
  });
  const addressChanges = changedAddressKeys({
    before: addressesBefore,
    after: readAddressKeys({ metaDir })
  });
  const { relevant, reasons } = computeRelevance({
    flagged: result.flagged,
    overlap: result.overlap,
    addressChanges
  });
  const changesetFile = changesetPath({ target });
  writeFileSync(
    join(repoRoot, changesetFile),
    buildChangeset({ target, abiChanged, diff: result.diff })
  );

  const { changed, deleted } = gitStatus({ repoRoot });
  const disallowed = findDisallowedPaths({ changed, deleted });
  if (disallowed.length > 0) {
    throw new Error(
      `Paths outside the allowlist changed, refusing to continue:\n${disallowed.map((p) => `  ${p}`).join('\n')}`
    );
  }

  mkdirSync(join(out, 'files'), { recursive: true });
  for (const path of changed) {
    mkdirSync(dirname(join(out, 'files', path)), { recursive: true });
    cpSync(join(repoRoot, path), join(out, 'files', path));
  }
  const manifest = buildManifest({
    from: installed,
    to: target,
    baseSha,
    dryRun,
    changed,
    deleted,
    abiChanged
  });
  writeFileSync(join(out, 'pr-body.md'), buildPrBody({ markdown, openWhen, reasons }));
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(snapshotDir, { recursive: true, force: true });
  setOutputs({
    values: { changed: 'true', relevant: String(relevant), base_sha: baseSha, target }
  });
  console.log(
    relevant ? `Relevant: ${reasons.join('; ')}` : 'Not relevant: nothing the SDK depends on moved.'
  );
  if (!relevant && openWhen === 'relevant') {
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    const summary = buildSkipSummary({ markdown, from: installed, to: target });
    if (summaryFile) appendFileSync(summaryFile, summary);
    else console.log(summary);
  }
  console.log(`Wrote ${out}: ${changed.length} changed, ${deleted.length} deleted.`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
