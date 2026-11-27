/**
 * Tests for the refusals in `open-pr.cjs` that run while the App token is
 * held. Only GitHub's API objects are mocked; the script, the content checks
 * and the file reads are the real ones, working on a temp directory.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface Params {
  github: object;
  context: object;
  core: object;
}
const openPrUrl = new URL('../../../../.github/scripts/meta-sync/open-pr.cjs', import.meta.url)
  .href;
const { default: openPr }: { default: (params: Params) => Promise<void> } = await import(openPrUrl);

const TARGET = '1.2.0';
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const BRANCH = 'automation/meta-sync';
const CHANGESET = '.changeset/meta-sync-1-2-0.md';
const PACKAGE_JSON = 'packages/maticjs/package.json';
const LOCKFILE = 'pnpm-lock.yaml';

const packageJson = (range: string) =>
  `{\n  "devDependencies": {\n    "@polygonlabs/meta": "${range}"\n  }\n}\n`;
const lockfile = (version: string) => `importers:

  packages/maticjs:
    devDependencies:
      '@polygonlabs/meta':
        specifier: ^${version}
        version: ${version}

packages:

  '@polygonlabs/meta@${version}':
    resolution: {integrity: sha512-${'A'.repeat(86)}==}

snapshots:

  '@polygonlabs/meta@${version}': {}
`;

const manifest = {
  from: '1.1.1',
  to: TARGET,
  baseSha: BASE,
  dryRun: false,
  title: `chore(maticjs): update vendored ABIs to @polygonlabs/meta ${TARGET}`,
  branch: BRANCH,
  labels: ['dependencies'],
  changed: [CHANGESET, PACKAGE_JSON, LOCKFILE],
  deleted: []
};
const artifactFiles: Record<string, string | Buffer> = {
  [CHANGESET]: '---\n---\n',
  [PACKAGE_JSON]: packageJson(`^${TARGET}`),
  [LOCKFILE]: lockfile(TARGET)
};

const scratch = mkdtempSync(join(tmpdir(), 'meta-sync-open-pr-'));
const startDir = process.cwd();
let counter = 0;

/** Writes an artifact the way prepare.mjs lays it out and points the script at it. */
const stage = ({
  manifestFields = {},
  files = artifactFiles
}: { manifestFields?: object; files?: Record<string, string | Buffer> } = {}) => {
  counter += 1;
  const out = join(scratch, `out-${counter}`);
  mkdirSync(out);
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ ...manifest, ...manifestFields }));
  writeFileSync(join(out, 'pr-body.md'), 'body');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(out, 'files', path)), { recursive: true });
    writeFileSync(join(out, 'files', path), content);
  }
  process.env.META_SYNC_OUT = out;
  return out;
};

const failure = (run: Promise<void>) =>
  run.then(
    () => undefined,
    (err: unknown) => err
  );

// Set per test: makes GitHub reject the guarded ref update.
let casFails = false;

const mocks = () => {
  const github = {
    rest: {
      git: {
        getRef: vi.fn(async ({ ref }: { ref: string }) => ({
          data: { object: { sha: ref === 'heads/master' ? BASE : HEAD } }
        })),
        createRef: vi.fn()
      },
      repos: {
        get: vi.fn(async () => ({ data: { node_id: 'R_node' } })),
        compareCommitsWithBasehead: vi.fn<(params: { basehead: string }) => Promise<object>>(
          async () => ({
            data: {
              ahead_by: 1,
              commits: [{ author: { login: 'app[bot]' }, parents: [{ sha: 'c'.repeat(40) }] }]
            }
          })
        ),
        getCommit: vi.fn<(params: { ref: string }) => Promise<object>>()
      },
      pulls: {
        list: vi.fn(),
        create: vi.fn(async () => ({ data: { number: 7 } })),
        update: vi.fn()
      },
      issues: { addLabels: vi.fn() }
    },
    paginate: vi.fn(async () => []),
    graphql: vi.fn<(query: string, variables: unknown) => Promise<object>>(async (query) => {
      if (query.includes('updateRefs') && casFails) throw new Error('beforeOid mismatch');
      return {};
    })
  };
  const core = { setFailed: vi.fn(), info: vi.fn(), warning: vi.fn() };
  const context = {
    repo: { owner: 'o', repo: 'r' },
    sha: BASE,
    payload: { repository: { default_branch: 'master' } }
  };
  return { github, core, run: () => openPr({ github, context, core }) };
};

beforeAll(() => {
  // The checks read base files relative to the working directory, as the
  // workflow runs them from the checkout root.
  const root = join(scratch, 'checkout');
  mkdirSync(join(root, 'packages/maticjs'), { recursive: true });
  writeFileSync(join(root, PACKAGE_JSON), packageJson('^1.1.1'));
  writeFileSync(join(root, LOCKFILE), lockfile('1.1.1'));
  process.chdir(root);
  process.env.META_SYNC_APP_SLUG = 'app';
});
beforeEach(() => {
  casFails = false;
});
afterAll(() => {
  process.chdir(startDir);
  rmSync(scratch, { recursive: true, force: true });
});

describe('open-pr.cjs refusals', () => {
  it('refuses a manifest whose lists are not arrays', async () => {
    stage({ manifestFields: { changed: 'packages/maticjs/package.json' } });
    const err = await failure(mocks().run());
    expect(err)
      .property('message')
      .match(/malformed/);
  });

  it('refuses a manifest path outside the allowlist', async () => {
    stage({ manifestFields: { changed: [...manifest.changed, '.github/workflows/evil.yml'] } });
    const err = await failure(mocks().run());
    expect(err)
      .property('message')
      .match(/outside the allowlist/);
  });

  it('refuses an artifact file that is a symlink', async () => {
    const out = stage();
    const target = join(scratch, 'secret.txt');
    writeFileSync(target, '---\n---\n');
    rmSync(join(out, 'files', CHANGESET));
    symlinkSync(target, join(out, 'files', CHANGESET));
    const err = await failure(mocks().run());
    expect(err)
      .property('message')
      .match(/not a regular file/);
  });

  it('refuses an artifact file that is not valid UTF-8, writing nothing', async () => {
    stage({ files: { ...artifactFiles, [CHANGESET]: Buffer.from([0xff, 0xfe, 0x2d]) } });
    const { github, core, run } = mocks();
    await run();
    expect(core.setFailed.mock.calls).to.have.length(1);
    expect(core.setFailed.mock.calls[0]?.[0]).match(/not valid UTF-8/);
    expect(github.graphql.mock.calls).to.have.length(0);
    expect(github.rest.git.createRef.mock.calls).to.have.length(0);
  });
});

describe('open-pr.cjs moving an existing branch', () => {
  it('moves the branch only from the commit it read and checked', async () => {
    stage();
    const { github, run } = mocks();
    await run();
    const [query, variables] = github.graphql.mock.calls[0] ?? [];
    expect(query).match(/updateRefs/);
    expect(variables).deep.equal({
      input: {
        repositoryId: 'R_node',
        refUpdates: [{ name: `refs/heads/${BRANCH}`, beforeOid: HEAD, afterOid: BASE, force: true }]
      }
    });
  });

  it('asks GitHub about the commit it will guard, not the branch name', async () => {
    stage();
    const { github, run } = mocks();
    // One bot commit directly on the base, so the up-to-date check runs too.
    github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({
      data: {
        ahead_by: 1,
        commits: [{ author: { login: 'app[bot]' }, parents: [{ sha: BASE }] }]
      }
    });
    github.rest.repos.getCommit.mockResolvedValue({ data: { files: [] } });
    await run();
    expect(github.rest.repos.compareCommitsWithBasehead.mock.calls[0]?.[0])
      .property('basehead')
      .equal(`master...${HEAD}`);
    expect(github.rest.repos.getCommit.mock.calls[0]?.[0]).property('ref').equal(HEAD);
  });

  it('writes nothing further when the branch moved in the meantime', async () => {
    stage();
    casFails = true;
    const { github, core, run } = mocks();
    await run();
    expect(core.setFailed.mock.calls).to.have.length(1);
    expect(core.setFailed.mock.calls[0]?.[0]).match(/wrote nothing/);
    expect(github.graphql.mock.calls).to.have.length(1);
    expect(github.rest.pulls.create.mock.calls).to.have.length(0);
  });
});
