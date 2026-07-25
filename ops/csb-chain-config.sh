#!/usr/bin/env bash
# Write the CSB chain config to every validator in the local cluster.
#
#     bash ops/csb-chain-config.sh          # write config, show what changed
#     bash ops/csb-chain-config.sh --restart # write, then restart the cluster
#
# Two settings, both of which need a node restart to take effect:
#
#   rpc-tx-fee-cap — Subnet-EVM refuses to accept a transaction whose total fee
#       exceeds this, default 100. It is a safety rail against a fat-fingered
#       gas price on a chain where the native token is worth real money. On CSB
#       the native token is 1 riel, so 100 tRIEL is about 2.5 US cents, and the
#       "1 riel per transfer" fee policy makes an ordinary contract deployment
#       (~2.1M gas) cost slightly MORE than the cap. Deployments then fail with
#       "tx fee exceeds the configured cap" even though the amount is trivial.
#       Setting it to 0 removes the cap.
#
#   eth-apis — adds internal-txpool, so the watchdog can tell an idle chain from
#       a wedged one. Without it a flat block height is ambiguous and the
#       watchdog cannot detect the failure it exists to catch.
#       NEVER expose the txpool API on a public RPC: mempool contents leak
#       pending transactions. Port 9650 must stay on localhost.
set -euo pipefail

CLUSTER="${CSB_CLUSTER:-csb-local-node-fuji}"
BC="${CSB_BLOCKCHAIN_ID:-299jCTH4ErmwFMB3ZKa18Ck9EDzc99DMD48zkszxcArpaUfTqW}"
ROOT="${CSB_CLUSTER_ROOT:-$HOME/.avalanche-cli/local/$CLUSTER}"
RESTART=0
[ "${1:-}" = "--restart" ] && RESTART=1

if [ ! -d "$ROOT" ]; then
  echo "No cluster at $ROOT" >&2
  echo "Set CSB_CLUSTER_ROOT, or check: avalanche node local list" >&2
  exit 1
fi

shopt -s nullglob
nodes=("$ROOT"/NodeID-*)
if [ ${#nodes[@]} -eq 0 ]; then
  echo "No NodeID-* directories under $ROOT" >&2
  exit 1
fi

echo "Cluster:    $CLUSTER"
echo "Blockchain: $BC"
echo "Nodes:      ${#nodes[@]}"
echo

# Where does this node actually read chain config from? Guessing the layout is
# how a config gets written to a path nothing reads, which looks exactly like the
# setting not working. Ask the running process first, fall back to the
# conventional location, and print what was chosen so it can be checked.
detect_chain_config_dir() {
  local node_dir="$1" found=""
  # 0. explicit override always wins — detection is a convenience, not a rule
  if [ -n "${CSB_CHAIN_CONFIG_DIR:-}" ]; then echo "$CSB_CHAIN_CONFIG_DIR"; return; fi
  # 1. the running avalanchego process for this node
  found=$(ps -eo args= 2>/dev/null \
    | grep -F "$(basename "$node_dir")" \
    | grep -o -- '--chain-config-dir[= ][^ ]*' \
    | head -1 | sed 's/--chain-config-dir[= ]//')
  if [ -n "$found" ]; then echo "$found"; return; fi
  # 2. any avalanchego process (single-cluster VM)
  found=$(ps -eo args= 2>/dev/null \
    | grep -o -- '--chain-config-dir[= ][^ ]*' \
    | head -1 | sed 's/--chain-config-dir[= ]//')
  if [ -n "$found" ] && [ "${#nodes[@]}" -eq 1 ]; then echo "$found"; return; fi
  # 3. the node's own config file
  if [ -f "$node_dir/config.json" ]; then
    found=$(grep -o '"chain-config-dir"[^,}]*' "$node_dir/config.json" 2>/dev/null \
      | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//')
    if [ -n "$found" ]; then echo "$found"; return; fi
  fi
  # 4. conventional layout
  echo "$node_dir/configs/chains"
}

for n in "${nodes[@]}"; do
  ccd="$(detect_chain_config_dir "$n")"
  dir="$ccd/$BC"
  mkdir -p "$dir"
  cat > "$dir/config.json" <<'JSON'
{
  "rpc-tx-fee-cap": 0,
  "eth-apis": [
    "eth",
    "eth-filter",
    "net",
    "web3",
    "internal-eth",
    "internal-blockchain",
    "internal-transaction",
    "internal-txpool"
  ]
}
JSON
  echo "  wrote $dir/config.json"
done

echo
if [ "$RESTART" = "1" ]; then
  export PATH="$PATH:$HOME/bin"
  echo "Restarting the cluster (config only applies on restart)…"
  avalanche node local stop "$CLUSTER"
  avalanche node local start "$CLUSTER"
  echo
  echo "Give the nodes a moment, then verify:"
else
  echo "Config written. It only takes effect after a restart:"
  echo "    export PATH=\$PATH:\$HOME/bin"
  echo "    avalanche node local stop $CLUSTER && avalanche node local start $CLUSTER"
  echo
  echo "Then verify:"
fi
cat <<VERIFY
    source /opt/csb/ops/csb-env.sh
    # txpool API should now answer instead of erroring:
    curl -s -X POST -H 'content-type:application/json' \\
      --data '{"jsonrpc":"2.0","id":1,"method":"txpool_status","params":[]}' \$CSB_RPC_URL; echo
    # and a contract deployment should no longer hit the fee cap:
    npx hardhat run scripts/deploy.js --network csbRemote
VERIFY

# --- did it actually take? ---------------------------------------------------
# Both settings live in the SAME file, so txpool_status is a canary for the whole
# config: if it answers, the node read this file and rpc-tx-fee-cap is live too.
# If it still errors, the config was written somewhere the node does not read.
RPC="${CSB_RPC_URL:-http://127.0.0.1:9650/ext/bc/$BC/rpc}"
echo
echo "Checking whether the node picked the config up…"
resp=$(curl -s --max-time 10 -X POST -H 'content-type:application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"txpool_status","params":[]}' "$RPC" 2>/dev/null || true)
if printf '%s' "$resp" | grep -q '"result"'; then
  echo "  ✓ txpool API is live — the node read this config, so the fee cap is lifted too."
elif printf '%s' "$resp" | grep -q 'method not found\|does not exist'; then
  echo "  ✗ txpool API still absent — the node did NOT read the file just written."
  echo "    Find where it actually looks:"
  echo "      ps -eo args= | grep -o -- '--chain-config-dir[= ][^ ]*'"
  echo "    then re-run with CSB_CLUSTER_ROOT / the correct path, or use the"
  echo "    no-restart workaround in ops/csb-redeploy.sh."
elif [ -z "$resp" ]; then
  echo "  ? no response from $RPC — is the cluster finished restarting?"
else
  echo "  ? unexpected response: $(printf '%s' "$resp" | head -c 200)"
fi
