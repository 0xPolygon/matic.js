#!/usr/bin/env bash
#
# Run the e2e tier against a devnet that is already up (see README.md).
#
#     pnpm run e2e                    # from the repo root; the devnet stays up
#     pnpm run e2e -- --down          # also tear the devnet down afterwards
#     E2E_DOWN=1 pnpm run e2e         # same as --down
#
# Teardown is opt-in, and `down` removes only a devnet this run booted
# (`.github/scripts/e2e-setup.sh` marks that); it refuses one `up` merely
# attached to, which may be one you, or another session, still need. CI boots
# its own devnet and passes --down so the runner cleans up what it created.
#
# CI and local runs both go through this script, so the two paths match.

set -euo pipefail

DOWN="${E2E_DOWN:-0}"
for arg in "$@"; do
  case "$arg" in
    --down) DOWN=1 ;;
    # pnpm passes the `--` from `pnpm run e2e -- --down` through.
    --) ;;
    *) echo "run-e2e: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

# The tests import the SDK's built dist, exactly as a consumer does.
pnpm --filter @polygonlabs/maticjs run build

# `eval "$(...)"` in one expression would hide a failing `up` from `set -e`
# (eval of empty input succeeds). Assigning first makes `up`'s exit status
# abort the script.
env_exports=$(pnpm --filter @polygonlabs/maticjs-e2e run --silent up)
eval "$env_exports"

pnpm --filter @polygonlabs/maticjs-e2e run seed
pnpm --filter @polygonlabs/maticjs-e2e run test:e2e

if [ "$DOWN" = "1" ]; then
  pnpm --filter @polygonlabs/maticjs-e2e run down
fi
