/**
 * Content checks for the meta sync artifact, run by `open-pr.cjs` before it
 * commits anything.
 *
 * Why they exist: the artifact comes from a job that installed and ran a
 * freshly published third-party package, so every byte of it is attacker
 * controlled. A path allowlist alone would still let a hostile release put
 * an extra dependency in package.json, a tarball URL in the lockfile or a
 * trailing statement in an ABI file, and the App token would then sign it.
 * Each check therefore pins a file to the exact shape the legitimate bump
 * produces and throws a plain Error on anything else.
 *
 * Plain ESM, Node builtins only (plus the shared ABI file format, read from
 * the trusted checkout): the job that calls this installs nothing.
 */
// A relative path, not the package name: the job that runs this installs
// nothing, so only the checkout's own files can be imported.
// eslint-disable-next-line import-x/no-relative-packages
import { parseAbiFile, renderAbiFile } from '../../../packages/maticjs/scripts/abi-file-format.mjs';

const META = '@polygonlabs/meta';
const PACKAGE_JSON = 'packages/maticjs/package.json';
const LOCKFILE = 'pnpm-lock.yaml';
const ABI_DIR = 'packages/maticjs/src/abi/';
const NOT_GENERATED = new Set(['index.ts', 'failed-state-sync.ts']);
const BRANCH = 'automation/meta-sync';
const DRY_RUN_BRANCH = 'automation/meta-sync-dryrun';
// What prepare.mjs emits and nothing else: a label outside this set would
// reach the repository through the App's token.
const LABELS = new Set(['dependencies', 'automation', 'run-e2e']);
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{40}$/;

const fail = (message) => {
  throw new Error(message);
};

export const isStableVersion = ({ version }) => typeof version === 'string' && STABLE.test(version);

const requireTarget = ({ target }) => {
  if (!isStableVersion({ version: target }))
    fail(`Target "${target}" is not a stable x.y.z version`);
};

/**
 * The artifact must be built on the commit this run executes and on the
 * live head of the default branch. The first makes the scripts that
 * validate it the ones that were reviewed for that commit; the second stops
 * a stale or crafted base from rewinding the bot branch onto old history.
 */
export const checkBase = ({ baseSha, contextSha, liveHead }) => {
  if (!COMMIT.test(baseSha ?? '')) fail('The manifest base is not a commit id');
  if (baseSha !== contextSha) fail('The artifact base is not the commit this run checked out');
  if (baseSha !== liveHead) {
    fail('The artifact base is not the current head of the default branch; start a new run (re-running reuses the old commit)');
  }
};

/**
 * package.json may differ from the base only by the version string of the
 * meta devDependency. Replacing that one string in the base text and
 * comparing bytes also rules out reordered keys, changed formatting and
 * smuggled fields, which a parsed comparison would let through.
 */
export const checkPackageJson = ({ baseText, newText, target }) => {
  requireTarget({ target });
  const base = JSON.parse(baseText);
  const current = base.devDependencies?.[META];
  if (typeof current !== 'string') fail(`The base package.json has no ${META} devDependency`);
  const entry = `"${META}": "${current}"`;
  if (baseText.split(entry).length !== 2) fail(`The base package.json is not shaped as expected`);
  const expected = baseText.replace(entry, () => `"${META}": "^${target}"`);
  if (newText !== expected) {
    fail(`${PACKAGE_JSON} differs from the base by more than ${META} ^${target}`);
  }
};

const indentOf = (line) => line.length - line.trimStart().length;

// Index range of the lines under a header line, up to the next line at the
// header's indent or shallower (blank lines belong to the block).
const blockRange = ({ lines, headerIndex }) => {
  const indent = indentOf(lines[headerIndex]);
  let end = headerIndex + 1;
  while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > indent))
    end += 1;
  return { start: headerIndex + 1, end };
};

const findOne = ({ lines, from, to, test, what }) => {
  const hits = [];
  for (let i = from; i < to; i += 1) if (test(lines[i])) hits.push(i);
  if (hits.length !== 1) fail(`pnpm-lock.yaml: expected one ${what}, found ${hits.length}`);
  return hits[0];
};

const SHA512 = /^ {4}resolution: \{integrity: sha512-[A-Za-z0-9+/]{86}==\}$/;
// The one shape pnpm writes for a node range (`{node: '>=20'}`); anything else
// on that line, such as a comment or an anchor, is not engines metadata.
const ENGINES = /^ {4}engines: \{node: '[0-9<>=^~. |xX*-]+'\}$/;

/**
 * Cuts the three meta-specific pieces out of a lockfile and returns them
 * beside what is left, so the caller can demand that the remainders match
 * byte for byte and that only the pieces differ.
 */
const splitLockfile = ({ text, label }) => {
  const lines = text.split('\n');
  const topLevel = (name) =>
    findOne({
      lines,
      from: 0,
      to: lines.length,
      test: (l) => l === `${name}:`,
      what: `top-level "${name}:" section in the ${label} lockfile`
    });

  // (i) importers → packages/maticjs → devDependencies → meta
  const importers = blockRange({ lines, headerIndex: topLevel('importers') });
  const importer = findOne({
    lines,
    from: importers.start,
    to: importers.end,
    test: (l) => l === '  packages/maticjs:',
    what: `packages/maticjs importer in the ${label} lockfile`
  });
  const importerRange = blockRange({ lines, headerIndex: importer });
  const dev = findOne({
    lines,
    from: importerRange.start,
    to: importerRange.end,
    test: (l) => l === '    devDependencies:',
    what: `packages/maticjs devDependencies in the ${label} lockfile`
  });
  const devRange = blockRange({ lines, headerIndex: dev });
  const importerKey = findOne({
    lines,
    from: devRange.start,
    to: devRange.end,
    test: (l) => l === `      '${META}':`,
    what: `${META} importer entry in the ${label} lockfile`
  });
  const importerPiece = lines.slice(importerKey, importerKey + 3);

  // (ii) packages: block
  const packages = blockRange({ lines, headerIndex: topLevel('packages') });
  const metaKey = (l) => /^ {2}'@polygonlabs\/meta@[^']*':$/.test(l);
  const pkgKey = findOne({
    lines,
    from: packages.start,
    to: packages.end,
    test: metaKey,
    what: `${META} entry under packages in the ${label} lockfile`
  });
  let pkgEnd = pkgKey + 1;
  while (pkgEnd < packages.end && lines[pkgEnd].trim() !== '') pkgEnd += 1;
  const packagePiece = lines.slice(pkgKey, pkgEnd);

  // (iii) snapshots: block
  const snapshots = blockRange({ lines, headerIndex: topLevel('snapshots') });
  const snapKey = findOne({
    lines,
    from: snapshots.start,
    to: snapshots.end,
    test: (l) => /^ {2}'@polygonlabs\/meta@[^']*':/.test(l),
    what: `${META} entry under snapshots in the ${label} lockfile`
  });
  const snapshotPiece = [lines[snapKey]];

  const drop = new Set([
    ...importerPiece.map((_, i) => importerKey + i),
    ...packagePiece.map((_, i) => pkgKey + i),
    snapKey
  ]);
  const rest = lines.filter((_, i) => !drop.has(i)).join('\n');
  return { rest, importerPiece, packagePiece, snapshotPiece };
};

/**
 * pnpm-lock.yaml may differ from the base only in the meta entries of the
 * importer, the packages block and the snapshots block. The packages entry
 * must be integrity-only: a `tarball:` URL, a git or directory source would
 * point installs at something other than the npm registry.
 */
export const checkLockfile = ({ baseText, newText, target }) => {
  requireTarget({ target });
  const base = splitLockfile({ text: baseText, label: 'base' });
  const next = splitLockfile({ text: newText, label: 'new' });
  if (base.rest !== next.rest) fail(`${LOCKFILE} changes something other than the ${META} entries`);

  const [key, specifier, version] = next.importerPiece;
  if (
    key !== `      '${META}':` ||
    specifier !== `        specifier: ^${target}` ||
    version !== `        version: ${target}`
  ) {
    fail(`${LOCKFILE} importer entry for ${META} is not ^${target} resolved to ${target}`);
  }

  const [pkgKey, resolution, ...more] = next.packagePiece;
  if (pkgKey !== `  '${META}@${target}':`)
    fail(`${LOCKFILE} packages entry is not ${META}@${target}`);
  if (!SHA512.test(resolution ?? '')) {
    fail(`${LOCKFILE} packages entry must be an integrity-only resolution`);
  }
  if (more.length > 1 || (more.length === 1 && !ENGINES.test(more[0]))) {
    fail(`${LOCKFILE} packages entry has lines beyond resolution and engines`);
  }

  if (next.snapshotPiece[0] !== `  '${META}@${target}': {}`) {
    fail(`${LOCKFILE} snapshots entry must be an empty ${META}@${target}`);
  }
};

// JSON.parse makes `__proto__` an own property, and JSON.stringify writes it
// back out, so the round-trip comparison cannot see it. Once the file is
// imported, an object literal with that key sets the object's prototype.
const hasProtoKey = (value) =>
  value !== null &&
  typeof value === 'object' &&
  Object.keys(value).some((key) => key === '__proto__' || hasProtoKey(value[key]));

/**
 * A changed ABI file must be byte-for-byte what the generator writes for the
 * ABI it holds. Rendering the parsed parts and comparing is the whole test:
 * a trailing statement, a different header or a re-indented body all fail
 * it. It also pins the file to a contract name and to the specifier the base
 * version of the same file was generated from, so a release cannot repoint a
 * vendored ABI at another module.
 */
export const checkAbiFile = ({ path, text, baseText }) => {
  if (!path.startsWith(ABI_DIR) || !path.endsWith('.ts')) fail(`${path} is not an ABI file`);
  const file = path.slice(ABI_DIR.length, -'.ts'.length);
  if (NOT_GENERATED.has(`${file}.ts`)) fail(`${path} is not a generated file and may not change`);
  const parsed = parseAbiFile({ text });
  if (parsed.name !== file) fail(`${path} declares ${parsed.name}ABI, not ${file}ABI`);
  const { specifier: baseSpecifier } = parseAbiFile({ text: baseText });
  if (parsed.specifier !== baseSpecifier) {
    fail(
      `${path} is generated from "${parsed.specifier}", not from "${baseSpecifier}" as in the base`
    );
  }
  const { abi } = parsed;
  if (
    !Array.isArray(abi) ||
    abi.some((x) => x === null || typeof x !== 'object' || Array.isArray(x))
  ) {
    fail(`${path} does not hold an array of ABI objects`);
  }
  if (hasProtoKey(abi)) fail(`${path} holds a "__proto__" key`);
  if (renderAbiFile(parsed) !== text) fail(`${path} is not in the generator's exact output format`);
};

/**
 * Front matter must be empty, or one patch/minor bump for this package: the
 * automation never releases a major, and never another package. The file
 * name must carry the target so a changeset cannot masquerade as another.
 */
export const checkChangeset = ({ path, text, target }) => {
  requireTarget({ target });
  const expected = `.changeset/meta-sync-${target.replaceAll('.', '-')}.md`;
  if (path !== expected) fail(`${path} is not the changeset file for ${target} (${expected})`);
  if (!/^---\n(?:'@polygonlabs\/maticjs': (?:patch|minor)\n)?---\n/.test(text)) {
    fail(`${path} front matter is not empty or a patch/minor bump of @polygonlabs/maticjs`);
  }
};

/** Manifest fields prepare.mjs derives from the target, re-derived here. */
export const checkManifest = ({ manifest }) => {
  const { to, branch, dryRun, title, labels, changed, deleted } = manifest;
  requireTarget({ target: to });
  if (branch !== BRANCH && branch !== DRY_RUN_BRANCH) fail(`Refusing branch "${branch}"`);
  if (dryRun !== (branch === DRY_RUN_BRANCH))
    fail('The manifest dryRun flag disagrees with its branch');
  const expectedTitle = `${dryRun ? '[dry run] ' : ''}chore(maticjs): update vendored ABIs to ${META} ${to}`;
  if (title !== expectedTitle) fail('The manifest title is not the expected one for this target');
  if (
    !Array.isArray(labels) ||
    labels.some((l) => !LABELS.has(l)) ||
    new Set(labels).size !== labels.length
  ) {
    fail(`Labels must come from: ${[...LABELS].join(', ')}`);
  }
  if (!Array.isArray(deleted) || deleted.length > 0) fail('A meta bump deletes nothing');
  if (!Array.isArray(changed) || new Set(changed).size !== changed.length) {
    fail('The manifest changed list is malformed');
  }
  for (const required of [PACKAGE_JSON, LOCKFILE]) {
    if (!changed.includes(required)) fail(`A meta bump always changes ${required}`);
  }
  return { target: to };
};

/**
 * Runs every content check over the artifact. `readNew` returns the artifact
 * bytes of a changed path; `readBase` returns the trusted checkout's text
 * for a path, or null when it does not exist there.
 */
export const checkArtifact = ({ manifest, readNew, readBase }) => {
  const { target } = checkManifest({ manifest });
  const baseOf = (path) => {
    const text = readBase(path);
    if (text === null) fail(`${path} does not exist in the base commit`);
    return text;
  };
  const changesets = [];
  for (const path of manifest.changed) {
    const text = readNew(path);
    if (path === PACKAGE_JSON) {
      checkPackageJson({ baseText: baseOf(path), newText: text, target });
    } else if (path === LOCKFILE) {
      checkLockfile({ baseText: baseOf(path), newText: text, target });
    } else if (path.startsWith(ABI_DIR)) {
      // A new contract needs a generator change, which is not on this path.
      checkAbiFile({ path, text, baseText: baseOf(path) });
    } else {
      checkChangeset({ path, text, target });
      changesets.push(path);
    }
  }
  if (changesets.length !== 1) fail('A meta bump carries exactly one changeset file');
};
