/**
 * Commits the files `prepare.mjs` produced to a bot branch through the
 * GraphQL API and keeps one draft pull request in sync with them.
 *
 * Why the API and not `git push`: the org requires signed commits on every
 * branch, and `createCommitOnBranch` makes GitHub sign the commit as the App
 * that owns the token, with no key material in the workflow. Why this script
 * makes API calls only: it runs while the App token is held, so it executes
 * nothing from the installed packages and re-validates every path itself
 * rather than trusting the artifact.
 *
 * It never merges, approves, marks ready, deletes a branch or comments. A
 * branch a person has touched, or a pull request a person closed, is left
 * alone: those are human decisions.
 *
 * Environment: META_SYNC_OUT (directory from prepare.mjs) and
 * META_SYNC_APP_SLUG (the App's slug, to recognise its own commits).
 */
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// Deliberately a second copy of the list in prepare.mjs: each side checks
// the artifact independently, so a mistake in one cannot widen the other.
const SEGMENT = '[A-Za-z0-9_-][A-Za-z0-9._-]*';
const ALLOWLIST = [
  /^packages\/maticjs\/package\.json$/,
  /^pnpm-lock\.yaml$/,
  new RegExp(`^packages/maticjs/src/abi/${SEGMENT}\\.ts$`),
  new RegExp(`^\\.changeset/meta-sync-${SEGMENT}\\.md$`)
];

const BRANCHES = new Set(['automation/meta-sync', 'automation/meta-sync-dryrun']);

const isAllowed = (path) => ALLOWLIST.some((re) => re.test(path));

const readManifest = (out) => {
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  const { changed, deleted, branch, baseSha, title, labels } = manifest;
  if (!Array.isArray(changed) || !Array.isArray(deleted) || !Array.isArray(labels)) {
    throw new Error('manifest.json is malformed');
  }
  if (typeof title !== 'string' || title.length === 0)
    throw new Error('manifest.json has no title');
  if (!BRANCHES.has(branch)) throw new Error(`Refusing branch "${branch}"`);
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('manifest.json baseSha is not a commit id');
  const outside = [...changed, ...deleted].filter((p) => typeof p !== 'string' || !isAllowed(p));
  if (outside.length > 0) throw new Error(`Paths outside the allowlist: ${outside.join(', ')}`);
  if (changed.length + deleted.length === 0) throw new Error('manifest.json lists no changes');
  return manifest;
};

// The blob id git would give the file: lets the "already up to date" check
// compare against the commit's file list without downloading any content.
const blobSha = (buffer) =>
  createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');

module.exports = async ({ github, context, core }) => {
  const out = process.env.META_SYNC_OUT;
  const slug = process.env.META_SYNC_APP_SLUG;
  if (!out) throw new Error('META_SYNC_OUT is not set');
  if (!slug) throw new Error('META_SYNC_APP_SLUG is not set');

  const { owner, repo } = context.repo;
  const botLogin = `${slug}[bot]`;
  const manifest = readManifest(out);
  const { branch, baseSha, title, labels, changed, deleted } = manifest;
  const body = readFileSync(join(out, 'pr-body.md'), 'utf8');
  const defaultBranch = context.payload.repository?.default_branch ?? 'master';

  const files = changed.map((path) => ({ path, buffer: readFileSync(join(out, 'files', path)) }));
  const wanted = new Map([
    ...files.map(({ path, buffer }) => [path, blobSha(buffer)]),
    ...deleted.map((path) => [path, null])
  ]);

  const note = async (message) => {
    core.warning(message);
    await core.summary.addRaw(`${message}\n`, true).write();
  };

  const commit = async () => {
    await github.graphql(
      `mutation ($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) { commit { oid } }
      }`,
      {
        input: {
          branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
          // Fails the commit if the branch is anywhere but the base, so a
          // race with another run cannot interleave history.
          expectedHeadOid: baseSha,
          message: { headline: title },
          fileChanges: {
            additions: files.map(({ path, buffer }) => ({
              path,
              contents: buffer.toString('base64')
            })),
            deletions: deleted.map((path) => ({ path }))
          }
        }
      }
    );
  };

  const addLabels = async (number) => {
    if (labels.length > 0) {
      await github.rest.issues.addLabels({ owner, repo, issue_number: number, labels });
    }
  };

  const openPullRequest = async () => {
    const { data } = await github.rest.pulls.create({
      owner,
      repo,
      title,
      body,
      head: branch,
      base: defaultBranch,
      draft: true
    });
    await addLabels(data.number);
    core.info(`Opened draft pull request #${data.number}`);
  };

  let head;
  try {
    ({ data: head } = await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` }));
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  if (!head) {
    await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
    await commit();
    await openPullRequest();
    return;
  }

  const prs = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: 'all'
  });
  const open = prs.find((pr) => pr.state === 'open');

  const { data: compare } = await github.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${defaultBranch}...${branch}`
  });
  const botOnly =
    compare.ahead_by <= 1 && compare.commits.every((c) => c.author?.login === botLogin);
  if (!botOnly) {
    const where = open ? `pull request #${open.number}` : `branch ${branch}`;
    await note(
      `Meta sync left ${where} untouched: it has commits that are not the bot's. Resolve it by hand.`
    );
    return;
  }
  // A branch that was pushed and never got a pull request (the run died
  // between the two calls) is ours to finish; one whose pull request was
  // closed is not.
  if (!open && prs.length > 0) {
    await note(
      `Meta sync left branch ${branch} untouched: its pull request #${prs[0].number} is closed.`
    );
    return;
  }

  let upToDate = false;
  if (compare.ahead_by === 1 && compare.commits[0].parents[0]?.sha === baseSha) {
    const { data: tip } = await github.rest.repos.getCommit({ owner, repo, ref: branch });
    const have = new Map(
      (tip.files ?? []).map((f) => [f.filename, f.status === 'removed' ? null : f.sha])
    );
    upToDate =
      have.size === wanted.size && [...wanted].every(([path, sha]) => have.get(path) === sha);
  }

  if (upToDate && open) {
    core.info(`Branch ${branch} already holds this update; nothing to do.`);
    return;
  }
  if (!upToDate) {
    await github.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: baseSha,
      force: true
    });
    await commit();
  }
  if (!open) {
    await openPullRequest();
    return;
  }
  await github.rest.pulls.update({ owner, repo, pull_number: open.number, title, body });
  await addLabels(open.number);
  core.info(`Updated pull request #${open.number}`);
};
