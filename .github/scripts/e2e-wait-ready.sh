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
#   E2E_USE_SNAPSHOT   "1" (default) reads the snapshot's fixed host ports;
#                      anything else resolves them from the kurtosis enclave.
#   E2E_ENCLAVE        enclave name for cold start (default: pos).

set -euo pipefail

E2E_USE_SNAPSHOT="${E2E_USE_SNAPSHOT:-1}"
ENCLAVE="${E2E_ENCLAVE:-pos}"
L1_CHAIN_ID_HEX="0x301824"
L2_CHAIN_ID_HEX="0x133f"
MIN_L2_BLOCK=256
TIMEOUT_S=900

log() { echo "[e2e-wait-ready] $*"; }

if [ "$E2E_USE_SNAPSHOT" = "1" ]; then
  L1_RPC="http://127.0.0.1:8545"
  L2_RPC="http://127.0.0.1:9545"
else
  inspect=$(kurtosis enclave inspect "$ENCLAVE")
  bor=$(grep -oE 'l2-el-[0-9]+-bor-heimdall-v2-validator(-archive)?' <<< "$inspect" | head -n1)
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
l1_before=$(block_number "$L1_RPC")
sleep 10
l2=$(block_number "$L2_RPC")
l1=$(block_number "$L1_RPC")
if [ "$((l2 - l2_before))" -lt 3 ]; then
  echo "[e2e-wait-ready] ERROR: L2 advanced $((l2 - l2_before)) blocks in 10s (need 3)" >&2
  exit 1
fi
if [ "$((l1 - l1_before))" -lt 1 ]; then
  echo "[e2e-wait-ready] ERROR: L1 advanced $((l1 - l1_before)) blocks in 10s (need 1)" >&2
  exit 1
fi
echo "ready: l2=${l2} l1=${l1}"
