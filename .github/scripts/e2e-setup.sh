#!/usr/bin/env bash
#
# Bring up the devnet the e2e tier runs against, then wait until it is ready.
#
#   bash .github/scripts/e2e-setup.sh          # bring up (mode from E2E_USE_SNAPSHOT)
#   bash .github/scripts/e2e-setup.sh dump     # collect devnet logs into /tmp/devnet-dump
#
# Two modes, picked by E2E_USE_SNAPSHOT:
#
#   - Snapshot (1, the CI default): extract the published kurtosis-pos
#     snapshot image and restore it with docker compose. No kurtosis engine
#     is involved: the harness reads the restored devnet through
#     E2E_SNAPSHOT_ADDRESSES_JSON and fixed host ports (see
#     packages/e2e/src/kurtosis.ts), so starting an engine here would only
#     add images to pull and leftover containers.
#   - Cold start (0): install the kurtosis CLI, start the engine (the
#     harness refuses to auto-start one) and boot the enclave from
#     kurtosis-pos source. Slower; the fallback when the snapshot is unusable.
#
# Idempotent: a devnet that is already up is reused, so a re-run after a
# partial failure, or locally, does not start a second one.
#
# Environment:
#   E2E_USE_SNAPSHOT     "1" snapshot mode, anything else cold start (default 1).
#   E2E_SNAPSHOT_IMAGE   snapshot image, pinned by digest in the workflow.
#   KURTOSIS_POS_REF     kurtosis-pos ref; supplies scripts/snapshot/ in
#                        snapshot mode and the source in cold-start mode.
#   WORK_DIR             scratch dir for the kurtosis-pos clone.
#   REPO_ROOT            matic.js checkout (default: $GITHUB_WORKSPACE, else $PWD).
#   DUMP_DIR             where `dump` writes (default: /tmp/devnet-dump).

set -euo pipefail

E2E_USE_SNAPSHOT="${E2E_USE_SNAPSHOT:-1}"
E2E_SNAPSHOT_IMAGE="${E2E_SNAPSHOT_IMAGE:-}"
KURTOSIS_POS_REF="${KURTOSIS_POS_REF:-v1.4.8}"
WORK_DIR="${WORK_DIR:-/tmp/kurtosis-pos}"
REPO_ROOT="${REPO_ROOT:-${GITHUB_WORKSPACE:-$PWD}}"
DUMP_DIR="${DUMP_DIR:-/tmp/devnet-dump}"
OUT_DIR="${REPO_ROOT}/tmp/e2e-snapshot"

log() { echo "[e2e-setup] $*"; }

clone_kurtosis_pos() {
  if [ -d "$WORK_DIR/.git" ]; then
    log "kurtosis-pos already cloned at $WORK_DIR"
    return
  fi
  log "cloning kurtosis-pos@${KURTOSIS_POS_REF} into $WORK_DIR"
  git clone --depth 1 --branch "$KURTOSIS_POS_REF" \
    https://github.com/0xPolygon/kurtosis-pos.git "$WORK_DIR"
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
  log "installing kurtosis-cli via apt"
  echo "deb [trusted=yes] https://apt.fury.io/kurtosis-tech/ /" \
    | sudo tee /etc/apt/sources.list.d/kurtosis.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends kurtosis-cli
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
