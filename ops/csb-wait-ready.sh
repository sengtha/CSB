#!/usr/bin/env bash
# Wait until the CSB L1 is actually serving RPC after a restart.
#
#     bash ops/csb-wait-ready.sh
#
# After `avalanche node local start`, the primary network comes up first and the
# L1 bootstraps behind it. Until that finishes the blockchain's RPC path does not
# exist and the node answers a plain HTTP "404 page not found" — which reads like
# a wrong URL rather than a chain that is still starting.
#
# This distinguishes the three states that all look like failure from a single
# curl: not serving yet, serving, and serving but unhealthy.
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source ops/csb-env.sh >/dev/null 2>&1 || true

RPC="${CSB_RPC_URL:?set CSB_RPC_URL or source ops/csb-env.sh}"
TRIES="${CSB_WAIT_TRIES:-40}"
GAP="${CSB_WAIT_GAP:-10}"
HEALTH_PORT="${CSB_HEALTH_PORT:-9650}"

rpc() {
  curl -s --max-time 10 -X POST -H 'content-type:application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[]}" "$RPC" 2>/dev/null
}

echo "Waiting for $RPC"
for i in $(seq 1 "$TRIES"); do
  resp=$(rpc eth_chainId)
  case "$resp" in
    *0x216b*)
      echo "  [$i] chain serving — chainId 0x216b"
      echo
      height=$(rpc eth_blockNumber)
      echo "Block height: $height"
      pool=$(rpc txpool_status)
      if printf '%s' "$pool" | grep -q '"result"'; then
        echo "txpool API:   live  →  $pool"
        echo
        echo "Ready. The watchdog can now tell an idle chain from a wedged one."
      else
        echo "txpool API:   NOT available  →  $pool"
        echo
        echo "The chain is up, but the txpool setting did not take. Check with:"
        echo "    node ops/csb-patch-chain-config.js --show"
      fi
      exit 0
      ;;
    *404*|"")
      # 404 = the blockchain's RPC route does not exist yet (still bootstrapping).
      # empty = nothing listening at all.
      printf '  [%s/%s] not serving yet…\r' "$i" "$TRIES"
      ;;
    *)
      printf '  [%s/%s] %s\r' "$i" "$TRIES" "$(printf '%s' "$resp" | head -c 60)"
      ;;
  esac
  sleep "$GAP"
done

echo
echo "Still not serving after $((TRIES * GAP))s. Check whether the node is healthy:"
echo "    export PATH=\$PATH:\$HOME/bin"
echo "    avalanche node local status ${CSB_CLUSTER:-csb-local-node-fuji}"
echo "    curl -s 127.0.0.1:$HEALTH_PORT/ext/health | head -c 400; echo"
echo
echo "A node that is healthy but not serving the L1 is still bootstrapping it."
echo "One that reports 'not connected to enough stake' is the wedge this chain"
echo "has hit before — see docs/deployment-status.md."
exit 1
