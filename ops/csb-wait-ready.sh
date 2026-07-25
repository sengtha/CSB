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

hexnum() {
  local raw
  raw=$(printf '%s' "$1" | grep -o '"result":"0x[0-9a-fA-F]*"' | grep -o '0x[0-9a-fA-F]*')
  [ -n "$raw" ] && printf '%d' "$raw"
}

rpc() {
  curl -s --max-time 10 -X POST -H 'content-type:application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[]}" "$RPC" 2>/dev/null
}

# Is anything even running? A stopped cluster answers exactly like one that is
# still bootstrapping — HTTP 404 on the chain's path — so waiting on it is
# waiting forever. Check first and say so.
if ! pgrep -f avalanchego >/dev/null 2>&1; then
  echo "No avalanchego process is running — the cluster is stopped, not starting."
  echo
  echo "    export PATH=\$PATH:\$HOME/bin"
  echo "    avalanche node local start ${CSB_CLUSTER:-csb-local-node-fuji}"
  echo
  echo "then re-run this. (A 'stop' whose matching 'start' never ran looks"
  echo "identical to a chain still bootstrapping.)"
  exit 1
fi

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
      else
        # Expected. The API is deliberately NOT enabled: the name tried for it
        # was invalid for this Subnet-EVM build and took the chain's whole HTTP
        # surface offline. See ops/csb-apply-l1-config.sh.
        echo "txpool API:   not enabled (deliberate — watchdog runs without the mempool signal)"
      fi
      echo

      # A chain that has just started can report height 0 while it replays state.
      # Height that STAYS at 0 on a chain which had blocks is a different matter,
      # so confirm it is moving rather than reporting the first number seen.
      h1=$(hexnum "$(rpc eth_blockNumber)")
      sleep 5
      h2=$(hexnum "$(rpc eth_blockNumber)")
      if [ "${h2:-0}" -gt 0 ]; then
        echo "Ready — height $h2."
      elif [ "${h1:-0}" = "0" ] && [ "${h2:-0}" = "0" ]; then
        echo "Chain serving but height is still 0 after a few seconds."
        echo "If this chain previously had blocks, give it a minute to replay and re-check:"
        echo "    curl -s -X POST -H 'content-type:application/json' \\"
        echo "      --data '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}' \$CSB_RPC_URL"
        echo "Height staying at 0 would mean the chain came up without its state."
      else
        echo "Ready — height $h2."
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
