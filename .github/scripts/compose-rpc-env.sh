#!/usr/bin/env bash
# Compose the integration-test RPC URLs from repo variables plus one
# secret, and export them to later steps through $GITHUB_ENV.
#
# Why a script: the base URLs are not secret (repo variables), but the
# API key is, and the tests read complete URLs. Joining them here keeps
# the key out of the variables and the logic runnable locally:
#
#   GITHUB_ENV=/dev/stdout POS_SDK_TEST_ERPC_API_KEY=... \
#     POS_SDK_TEST_ETHEREUM_RPC_URL=... .github/scripts/compose-rpc-env.sh
#
# When the key is empty (fork PRs, which get no secrets) nothing is
# written, so the tests fall back to their defaults or skip their live
# layers instead of calling an endpoint that would reject them.
#
# Inputs (env):
#   POS_SDK_TEST_ERPC_API_KEY        secret; appended as ?token=<key>
#   POS_SDK_TEST_ETHEREUM_RPC_URL    -> POS_SDK_TEST_MAINNET_PARENT_RPC
#   POS_SDK_TEST_POLYGON_RPC_URL     -> POS_SDK_TEST_MAINNET_CHILD_RPC
#   POS_SDK_TEST_SEPOLIA_RPC_URL     -> POS_SDK_TEST_PARENT_RPC
#   POS_SDK_TEST_AMOY_RPC_URL        -> POS_SDK_TEST_CHILD_RPC
set -euo pipefail

key="${POS_SDK_TEST_ERPC_API_KEY:-}"
if [[ -z "$key" ]]; then
  echo "POS_SDK_TEST_ERPC_API_KEY is not set; leaving the RPC env unset."
  exit 0
fi

: "${GITHUB_ENV:?GITHUB_ENV must point at the step environment file}"

echo "::add-mask::${key}"

compose() {
  local target="$1" base="$2"
  if [[ -z "$base" ]]; then
    echo "${target}: base URL variable is empty; not set."
    return
  fi
  local url="${base}?token=${key}"
  echo "::add-mask::${url}"
  echo "${target}=${url}" >>"$GITHUB_ENV"
  echo "${target}: set."
}

compose POS_SDK_TEST_MAINNET_PARENT_RPC "${POS_SDK_TEST_ETHEREUM_RPC_URL:-}"
compose POS_SDK_TEST_MAINNET_CHILD_RPC "${POS_SDK_TEST_POLYGON_RPC_URL:-}"
compose POS_SDK_TEST_PARENT_RPC "${POS_SDK_TEST_SEPOLIA_RPC_URL:-}"
compose POS_SDK_TEST_CHILD_RPC "${POS_SDK_TEST_AMOY_RPC_URL:-}"
