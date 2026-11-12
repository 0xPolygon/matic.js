#!/usr/bin/env bash
#
# Wait until the devnet answers and has advanced past the point the tier
# needs, so the tests never start against a devnet that is still booting.
#
# L2 must reach block 256: pre-Rio state-sync receipts are not visible to
# eth_getLogs and the Rio and Madhugiri forks activate at block 128, so
# waiting for 256 keeps every burn block past the forks. Both snapshot and
# cold-start devnets start below that.
#
# Environment:
#   E2E_USE_SNAPSHOT   "1" reads the snapshot's fixed host ports; anything
#                      else (default 0) resolves them from the kurtosis enclave.
#   KURTOSIS_ENCLAVE   enclave name for cold start (default: pos); the same
#                      variable the harness reads.

set -euo pipefail

E2E_USE_SNAPSHOT="${E2E_USE_SNAPSHOT:-0}"
ENCLAVE="${KURTOSIS_ENCLAVE:-pos}"
L1_CHAIN_ID_HEX="0x301824"
L2_CHAIN_ID_HEX="0x133f"
MIN_L2_BLOCK=256
TIMEOUT_S=900
# Both L1s mint a block a second (anvil block_time and the snapshot's
# seconds_per_slot are 1 in kurtosis-pos), so 30 s without one is a stall,
# not an unlucky sample.
L1_ADVANCE_WINDOW_S=30

log() { echo "[e2e-wait-ready] $*"; }

if [ "$E2E_USE_SNAPSHOT" = "1" ]; then
  L1_RPC="http://127.0.0.1:8545"
  L2_RPC="http://127.0.0.1:9545"
else
  inspect=$(kurtosis enclave inspect "$ENCLAVE")
  # Validator 1's node, the one the harness reads (packages/e2e/src/kurtosis.ts).
  bor=$(grep -oE 'l2-el-1-bor-heimdall-v2-validator(-archive)?' <<< "$inspect" | head -n1)
  L1_RPC=$(kurtosis port print "$ENCLAVE" anvil rpc)
  L2_RPC=$(kurtosis port print "$ENCLAVE" "$bor" rpc)
fi
log "L1 ${L1_RPC}  L2 ${L2_RPC}"

# rpc <url> <method>: print the JSON-RPC result string, empty on any failure.
rpc() {
  curl --silent --show-error --max-time 5 \
    --header 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":[]}" \
    "$1" 2>/dev/null | jq -r '.result // empty' 2>/dev/null || true
}

block_number() {
  local hex
  hex=$(rpc "$1" eth_blockNumber)
  if [ -n "$hex" ]; then echo $((hex)); else echo -1; fi
}

# Wait up to L1_ADVANCE_WINDOW_S for L1 to mint one block. On a stall, report
# how old the head block is: a head hours old means the L1 was restored from a
# snapshot it cannot resume, not that it is slow.
require_l1_progress() {
  local start l1 stop ts age
  start=$(block_number "$L1_RPC")
  stop=$((SECONDS + L1_ADVANCE_WINDOW_S))
  while [ "$SECONDS" -lt "$stop" ]; do
    sleep 2
    l1=$(block_number "$L1_RPC")
    # -1 is an RPC failure, not a block: take the first real read as the start.
    if [ "$start" -lt 0 ]; then start=$l1; continue; fi
    if [ "$l1" -gt "$start" ]; then return 0; fi
  done
  ts=$(curl --silent --max-time 5 --header 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",false]}' \
    "$L1_RPC" 2>/dev/null | jq -r '.result.timestamp // empty' 2>/dev/null || true)
  if [ -n "$ts" ]; then age="$(($(date +%s) - ts))s"; else age="unknown"; fi
  echo "[e2e-wait-ready] ERROR: L1 stalled at block ${start}: no new block in ${L1_ADVANCE_WINDOW_S}s, head block age ${age} ($1)" >&2
  exit 1
}

deadline=$((SECONDS + TIMEOUT_S))

until [ "$(rpc "$L1_RPC" eth_chainId)" = "$L1_CHAIN_ID_HEX" ] \
  && [ "$(rpc "$L2_RPC" eth_chainId)" = "$L2_CHAIN_ID_HEX" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "[e2e-wait-ready] ERROR: RPC endpoints did not report chain ids ${L1_CHAIN_ID_HEX} / ${L2_CHAIN_ID_HEX} in ${TIMEOUT_S}s" >&2
    exit 1
  fi
  sleep 3
done
log "chain ids confirmed"

# Checkpoints, deposits and the SDK's default 'safe' L1 reads all need a live
# L1, so check it before spending minutes waiting on L2.
require_l1_progress "before the L2 wait"
log "L1 is producing blocks"

next_log=$SECONDS
l2=$(block_number "$L2_RPC")
while [ "$l2" -lt "$MIN_L2_BLOCK" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "[e2e-wait-ready] ERROR: L2 block ${l2} below ${MIN_L2_BLOCK} after ${TIMEOUT_S}s" >&2
    exit 1
  fi
  if [ "$SECONDS" -ge "$next_log" ]; then
    log "waiting: l2=${l2} (need ${MIN_L2_BLOCK})"
    next_log=$((SECONDS + 15))
  fi
  sleep 3
  l2=$(block_number "$L2_RPC")
done

# Reaching a block number once does not show the chain is still producing.
l2_before=$(block_number "$L2_RPC")
sleep 10
l2=$(block_number "$L2_RPC")
if [ "$((l2 - l2_before))" -lt 3 ]; then
  echo "[e2e-wait-ready] ERROR: L2 advanced $((l2 - l2_before)) blocks in 10s (need 3)" >&2
  exit 1
fi
require_l1_progress "after the L2 wait"
echo "ready: l2=${l2} l1=$(block_number "$L1_RPC")"
