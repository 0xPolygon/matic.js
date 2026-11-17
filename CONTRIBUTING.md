# Contributing to matic.js

1. [Clone](https://help.github.com/articles/cloning-a-repository/) this repository to your local machine.
2. Checkout new branch to start development `git checkout -b <branch-name>`.

_Branch naming convention:_

- Feature - `feat_custom_token`
- Release/Build - `release_2.1` or `v2.1`
- Fix/Bug - `fix_unknown_token` or `fixes` (if more than one)

_Note: No strict convention while naming branch, but try to keep it meaningful for your team members to understand._

1. Add files to be committed and then commit changes to your local machine `git commit -m <commit-message>`

_Commit message convention:_

- Feature - `feat: integrate token balances`
- Release/Build - `chore: release v2.1` or `chore: bump version to 2.1`
- Fix/Bug - `fix: token balances` or `fix: token list, transfers` (if more than one)

_Note: Keep commit message meaningful for your team members to understand while reviewing merge/pull request._

1. Push changes to remote repository `git push origin <branch-name>`

2. Create a merge/pull request against `master` branch.

_Note: Don't push changes to `master` branch directly. Write proper description of the changes while creating merge/pull request_

## Updating `@polygonlabs/meta`

Do not bump `@polygonlabs/meta` by hand or merge a Dependabot bump of it. The `meta sync` workflow (`.github/workflows/meta-sync.yml`) opens a draft pull request daily when a new release exists, with the regenerated ABIs, a changeset and a summary of what moved. See [`.github/scripts/meta-sync/README.md`](.github/scripts/meta-sync/README.md) for how it works and how to rehearse it.
