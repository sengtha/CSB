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

for n in "${nodes[@]}"; do
  dir="$n/configs/chains/$BC"
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
