# Meta sync

`@polygonlabs/meta` publishes the contract ABIs this SDK vendors into
`packages/maticjs/src/abi`. A new release changes those files, and
Dependabot cannot regenerate them, so its bump could never pass the
codegen drift check. The workflow `.github/workflows/meta-sync.yml` does the
whole bump instead and opens a draft pull request for a person to review.

## What runs where

The work is split in two jobs. `prepare` runs a freshly published package's
code, so it holds no secret and no repository write permission. That code
still controls the runner and can use the job's read-only token and the
Actions runtime token (artifact upload, cache writes), so everything it
produces, including the pull request body and changeset text, is untrusted
and `open-pr` validates it before the App token is minted.

- `prepare` has `contents: read`, no secret, no repository write permission
  and no restored cache. It runs `prepare.mjs`, which
  installs the new meta release, regenerates the ABIs, diffs them with
  `packages/maticjs/scripts/abi-diff.mjs`, and writes an artifact: a manifest,
  the pull request body and the changed files. The artifact is uploaded with
  `include-hidden-files: true`; without it the `.changeset` file is silently
  dropped.
- `open-pr` runs only when `prepare` found a bump (`changed=true`) that is
  also relevant, or when `open_when=any` (see below). It
  installs nothing, mints the App token last, and runs `open-pr.cjs`, which
  makes API calls only, from the checkout of the workflow run's own commit. A day with no newer meta release ends green without
  touching the App secrets; a day with one needs `META_SYNC_BOT_APP_ID` and
  `META_SYNC_BOT_APP_PRIVATE_KEY`, and fails with a message naming them when
  either is missing.

The commit is made with the GraphQL `createCommitOnBranch` mutation because
the organisation requires signed commits on every branch: GitHub signs the
commit as the App, so no key lives in the workflow. The App token (unlike
the default one) also lets the pull request start the normal checks.

## Trust boundary

`prepare` runs a package that was published minutes ago, including its code
(codegen imports the package's modules), so that code controls the runner.
Everything `prepare` produces is therefore untrusted: its job outputs and
every byte of the artifact (manifest, pull request body, files). `open-pr`
holds the App token and treats all of that as hostile:

- It checks out the commit the run started on, never a ref `prepare` named,
  so the scripts that validate the artifact are the ones that were reviewed.
- Before any write, the artifact's base must equal that commit and the live
  head of the default branch. A run that finds the default branch has moved
  stops with a message and writes nothing; start a new run (dispatch from
  `master`, or wait for the next scheduled run), because re-running reuses
  the old commit and fails again.
- It validates contents, not just paths (`checks.mjs`): `package.json` must be
  the base with only the meta version replaced, the lockfile may differ only
  in the three meta entries (integrity-only, empty snapshot), each ABI file
  must be exactly what `generate-abis.ts` writes (both use
  `packages/maticjs/scripts/abi-file-format.mjs`), naming the same meta
  module in its header as the base file, and free of `__proto__` keys, and the title, labels and
  changeset must be the fixed shapes `prepare.mjs` emits, with a stable
  target and no `major`. Anything else fails the run before the first write.

The `meta-sync` environment adds a human gate. Only `open-pr` names it, so the
App secrets live there and are invisible to `prepare` and to any other job.
It is configured to deploy from `master` only, with a required reviewer, so
every run that would open a pull request waits for an approval, and a
`workflow_dispatch` from any other branch cannot reach the App at all.

To prove it after merge, dispatch the workflow from `master` with `dry_run`
and `open_when=any`: the `open-pr` job should wait for approval, and after it
the dry-run branch and draft pull request should appear. Dispatching the same
workflow from another branch should leave `open-pr` blocked by the branch
rule.

## When a bump opens a pull request

Most meta releases change nothing this SDK depends on, and a pull request for
each one is review time spent on noise. `prepare.mjs` therefore computes
`relevant`, true when any of these holds:

- a removed or changed ABI item is referenced in the SDK source (the pull
  request body's "Items the SDK source refers to");
- a hand-carried fragment is now published (the body's "Hand-carried
  fragments now published"), so it can be folded in;
- one of the nine proxy or token addresses the live address-index test
  compares (`RootChainManagerProxy`, the four predicate proxies,
  `RootChainProxy`, `StakeManagerProxy`, `Tokens.MaticToken`,
  `PolygonEcosystemToken`) differs between the installed and the new meta, on
  mainnet or Amoy. They are read from the package's network index before and
  after the install.

`open_when` chooses what happens next. `relevant` (the default, also for
scheduled runs) opens a pull request only when `relevant` is true; `any`
opens one for every bump. When a real bump is not relevant the run is green,
opens nothing, needs no App secret, and writes the ABI summary and the reason
to the job summary. An opened pull request lists which reasons fired.

The consequence: with the default, a non-relevant meta release is not pulled
in. The installed meta stays behind, and the live address-index test reports
the pending bump as a warning until a relevant release lands or someone
dispatches the workflow with `open_when=any`.

## Path allowlist

Only these paths may change; `prepare.mjs --help` prints the same list and
both scripts check it independently, and the content checks above then pin
each file to its legitimate shape:

- `packages/maticjs/package.json`
- `pnpm-lock.yaml`
- `packages/maticjs/src/abi/*.ts`
- `.changeset/meta-sync-*.md`

## What `open-pr.cjs` does with an existing branch

"Bot-only" means the branch is at most one commit ahead of `master` and every
commit is authored by the App.

| Branch and pull request                                       | Action                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No branch                                                     | Create it at the base commit, commit, open a draft pull request, add labels.                                                                                 |
| Bot-only, and it already holds exactly this update            | Nothing.                                                                                                                                                     |
| Bot-only, anything differs (newer release, or `master` moved) | Move the branch to the new base, commit again, update the title and body. The move fails, writing nothing, if the branch was pushed to since it was checked. |
| Not bot-only (a person pushed to it)                          | Nothing, with a warning naming it.                                                                                                                           |
| Pull request closed                                           | Nothing, with a warning. Reopening is a human decision.                                                                                                      |

The script never merges, approves, marks ready, deletes a branch or comments.

## The changeset and the warning in the pull request

The changeset is empty when only the devDependency and the lockfile moved.
When anything under `src/abi` changed it is `minor` for `@polygonlabs/maticjs`
if the diff removes or changes an item in a vendored ABI (or drops a whole
contract), and `patch` if it only adds items or changes format. The ABIs are
the package's public `./abi` export, so a removed or changed item breaks a
consumer who used it; the major version is reserved for the SDK's own API, so
the automation never picks `major`. A person may still adjust the level.

When the pull request body shows "Needs a decision before merge", a removed or
changed ABI item matches a name the SDK source uses. A person must read the
listed items, fix the calling code or confirm it is unaffected, and confirm the
changeset level.

## Running it locally

`prepare.mjs` changes the tree it runs in, so use a throwaway worktree:

```sh
git worktree add ../meta-sync-try origin/master --detach
cd ../meta-sync-try
pnpm install --frozen-lockfile --ignore-scripts
node .github/scripts/meta-sync/prepare.mjs --out "$(mktemp -d)"
```

With no target it bumps to the latest stable release, or reports no change.
`--target <version>` pins one. Read the result from `git status` and the
`pr-body.md` in the output directory.

## Dispatching a dry run

Run the workflow from the Actions tab (`workflow_dispatch`) with `dry_run`
enabled. It uses the branch `automation/meta-sync-dryrun` and a `[dry run]`
title, and it allows an older `target_version`, so the whole path can be
rehearsed without touching the real branch. Close the pull request and delete
the branch afterwards; the script never does.
