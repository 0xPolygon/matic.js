#!/usr/bin/env bash
#
# Bring up the devnet the e2e tier runs against, then wait until it is ready.
#
#   bash .github/scripts/e2e-setup.sh          # bring up (mode from E2E_USE_SNAPSHOT)
#   bash .github/scripts/e2e-setup.sh dump     # collect devnet logs into /tmp/devnet-dump
#
# Two modes, picked by E2E_USE_SNAPSHOT:
#
#   - Cold start (0, the CI default): install the kurtosis CLI, start the
#     engine (the harness refuses to auto-start one) and boot the enclave from
#     kurtosis-pos source with an anvil L1.
#   - Snapshot (1, opt-in): extract the published kurtosis-pos snapshot image
#     and restore it with docker compose. No kurtosis engine is involved: the
#     harness reads the restored devnet through E2E_SNAPSHOT_ADDRESSES_JSON
#     and fixed host ports (see packages/e2e/src/kurtosis.ts). Its geth +
#     lighthouse L1 only produces blocks when the image is minutes old: the
#     beacon chain's genesis time is baked into the restored state, and once
#     the wall-clock slot is far past the snapshot's head slot, a lone
#     lighthouse with no peers never counts itself synced, so it never
#     proposes. A published image is hours old by the time CI pulls it.
#
# Idempotent: a devnet that is already up is reused, so a re-run after a
# partial failure, or locally, does not start a second one.
#
# Environment:
#   E2E_USE_SNAPSHOT     "1" snapshot mode, anything else cold start (default 0).
#   E2E_SNAPSHOT_IMAGE   snapshot image, pinned by digest in the workflow.
#   KURTOSIS_POS_REF     kurtosis-pos commit to check out; supplies
#                        scripts/snapshot/ in snapshot mode and the source in
#                        cold-start mode. A full 40-hex SHA (the default, the
#                        v1.4.8 commit) is verified after checkout; a tag or
#                        branch is accepted for a manual dispatch but is mutable.
#   WORK_DIR             scratch dir for the kurtosis-pos clone.
#   REPO_ROOT            matic.js checkout (default: $GITHUB_WORKSPACE, else $PWD).
#   DUMP_DIR             where `dump` writes (default: /tmp/devnet-dump).
#
# When it boots a devnet (rather than reusing one that is already up) it
# exports E2E_DEVNET_CREATED_BY_HARNESS=1 through $GITHUB_ENV, and the harness
# records that next to what `down` may remove (packages/e2e/src/kurtosis.ts).

set -euo pipefail

E2E_USE_SNAPSHOT="${E2E_USE_SNAPSHOT:-0}"
E2E_SNAPSHOT_IMAGE="${E2E_SNAPSHOT_IMAGE:-}"
# kurtosis-pos v1.4.8. Pinned by commit because a tag can be moved.
KURTOSIS_POS_REF="${KURTOSIS_POS_REF:-b2f5b7a8ce6569cc32b48240862dda63e9ad340a}"
# The kurtosis CLI kurtosis-pos v1.4.8 itself pins in its CI, installed from
# the release .deb and checked against the sha256 in that release's
# checksums.txt (github.com/kurtosis-tech/kurtosis-cli-release-artifacts).
KURTOSIS_CLI_VERSION="1.22.2"
KURTOSIS_CLI_DEB_SHA256="aa9c42723c10af7961cd376cc48ba30c2660855d56a291ba962933a96d5d9969"
WORK_DIR="${WORK_DIR:-/tmp/kurtosis-pos}"
REPO_ROOT="${REPO_ROOT:-${GITHUB_WORKSPACE:-$PWD}}"
DUMP_DIR="${DUMP_DIR:-/tmp/devnet-dump}"
# Outside the checkout on a runner; locally under the gitignored tmp/.
OUT_DIR="${RUNNER_TEMP:-$REPO_ROOT/tmp}/e2e-snapshot"

log() { echo "[e2e-setup] $*"; }

# Tell the harness this run booted the devnet it is about to read.
mark_created() {
  if [ -n "${GITHUB_ENV:-}" ] && [ -w "${GITHUB_ENV}" ]; then
    echo "E2E_DEVNET_CREATED_BY_HARNESS=1" >> "$GITHUB_ENV"
  else
    log "booted the devnet; export E2E_DEVNET_CREATED_BY_HARNESS=1 to record that"
  fi
}

clone_kurtosis_pos() {
  if [ -d "$WORK_DIR/.git" ]; then
    log "kurtosis-pos already cloned at $WORK_DIR"
    return
  fi
  log "fetching kurtosis-pos@${KURTOSIS_POS_REF} into $WORK_DIR"
  git init -q "$WORK_DIR"
  git -C "$WORK_DIR" remote add origin https://github.com/0xPolygon/kurtosis-pos.git
  git -C "$WORK_DIR" fetch -q --depth 1 origin "$KURTOSIS_POS_REF"
  git -C "$WORK_DIR" checkout -q --detach FETCH_HEAD
  if [[ "$KURTOSIS_POS_REF" =~ ^[0-9a-f]{40}$ ]]; then
    local head
    head=$(git -C "$WORK_DIR" rev-parse HEAD)
    if [ "$head" != "$KURTOSIS_POS_REF" ]; then
      echo "[e2e-setup] ERROR: kurtosis-pos HEAD is $head, expected $KURTOSIS_POS_REF" >&2
      exit 1
    fi
  fi
  log "kurtosis-pos at $(git -C "$WORK_DIR" rev-parse HEAD)"
}

restore_from_snapshot() {
  if [ -z "$E2E_SNAPSHOT_IMAGE" ]; then
    echo "[e2e-setup] ERROR: E2E_SNAPSHOT_IMAGE is not set" >&2
    exit 1
  fi
  local compose_file="$OUT_DIR/docker-compose.yaml"
  if [ -f "$compose_file" ] && [ -n "$(docker compose --file "$compose_file" ps --quiet 2>/dev/null)" ]; then
    # restore.sh refuses to run over volumes a previous devnet left behind.
    log "snapshot devnet already running from $compose_file"
  else
    log "restoring ${E2E_SNAPSHOT_IMAGE}"
    clone_kurtosis_pos
    ( cd "$WORK_DIR" \
      && ./scripts/snapshot/extract.sh "$E2E_SNAPSHOT_IMAGE" "$OUT_DIR" \
      && ./scripts/snapshot/restore.sh "$OUT_DIR" )
    mark_created
  fi

  # The harness picks its snapshot reader from this variable. $GITHUB_ENV
  # carries it to the later `pnpm run e2e` step.
  local addresses_json="$OUT_DIR/contractAddresses.json"
  if [ -n "${GITHUB_ENV:-}" ] && [ -w "${GITHUB_ENV}" ]; then
    echo "E2E_SNAPSHOT_ADDRESSES_JSON=${addresses_json}" >> "$GITHUB_ENV"
    log "exported E2E_SNAPSHOT_ADDRESSES_JSON to GITHUB_ENV"
  else
    log "set E2E_SNAPSHOT_ADDRESSES_JSON=${addresses_json} before running the tests"
  fi
}

install_kurtosis() {
  if command -v kurtosis >/dev/null 2>&1; then
    log "kurtosis already installed: $(kurtosis version | head -n1)"
    return
  fi
  local deb="kurtosis-cli_${KURTOSIS_CLI_VERSION}_linux_amd64.deb"
  local tmp
  tmp=$(mktemp -d)
  log "installing kurtosis-cli ${KURTOSIS_CLI_VERSION} from its release .deb"
  curl -fsSL -o "$tmp/$deb" \
    "https://github.com/kurtosis-tech/kurtosis-cli-release-artifacts/releases/download/${KURTOSIS_CLI_VERSION}/${deb}"
  echo "${KURTOSIS_CLI_DEB_SHA256}  $tmp/$deb" | sha256sum --check --strict
  sudo apt-get install -y --no-install-recommends "$tmp/$deb"
  rm -rf "$tmp"
  # The first run asks for analytics consent; a non-TTY shell would block on it.
  kurtosis analytics disable
}

start_enclave() {
  if kurtosis enclave inspect pos 2>/dev/null | grep -q RUNNING; then
    log "enclave 'pos' already running"
    return
  fi
  clone_kurtosis_pos
  # kurtosis-pos caps each EL service at 4 vCPU / 16 GB, more than the public
  # 4-vCPU / 16 GB runner can give one service next to the rest of the
  # enclave. Lower the caps in place so the enclave schedules.
  local shared_star="$WORK_DIR/src/el/shared.star"
  if [ -f "$shared_star" ]; then
    sed -i.bak -E \
      -e 's/^MAX_CPU = [0-9]+.*/MAX_CPU = 2500  # CI override/' \
      -e 's/^MAX_MEM = [0-9]+.*/MAX_MEM = 6144  # CI override/' \
      "$shared_star"
    rm -f "${shared_star}.bak"
  fi
  log "running enclave 'pos'"
  ( cd "$WORK_DIR" && kurtosis run --enclave pos --args-file "$REPO_ROOT/packages/e2e/kurtosis-params.yml" . )
  mark_created
}

dump() {
  mkdir -p "$DUMP_DIR"
  local compose_file="$OUT_DIR/docker-compose.yaml"
  if [ -f "$compose_file" ]; then
    docker compose --file "$compose_file" ps > "$DUMP_DIR/compose-ps.txt" 2>&1 || true
    docker compose --file "$compose_file" logs --no-color > "$DUMP_DIR/compose-logs.txt" 2>&1 || true
    cp "$compose_file" "$DUMP_DIR/docker-compose.yaml" || true
  fi
  if command -v kurtosis >/dev/null 2>&1; then
    kurtosis enclave dump pos "$DUMP_DIR/pos" > "$DUMP_DIR/kurtosis-dump.txt" 2>&1 || true
  fi
  docker ps --all > "$DUMP_DIR/docker-ps.txt" 2>&1 || true
}

main() {
  if [ "$E2E_USE_SNAPSHOT" = "1" ]; then
    restore_from_snapshot
  else
    install_kurtosis
    log "starting kurtosis engine"
    kurtosis engine start
    start_enclave
  fi
  bash "$(dirname "${BASH_SOURCE[0]}")/e2e-wait-ready.sh"
  log "ready"
}

case "${1:-up}" in
  up) main ;;
  dump) dump ;;
  *) echo "usage: e2e-setup.sh [up|dump]" >&2; exit 2 ;;
esac
