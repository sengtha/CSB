#!/usr/bin/env bash
# Apply the CSB L1 chain config through avalanche-cli, so it SURVIVES a restart.
#
#     bash ops/csb-apply-l1-config.sh
#
# RUN THIS BEFORE STARTING THE CLUSTER. It only writes a file; the node reads it
# at startup. Applying it to an already-running cluster leaves the setting
# written but NOT in effect, and the only way to activate it is another
# stop/start — so the recovery order is:
#
#     bash ops/csb-apply-l1-config.sh          # write it first
#     avalanche node local start <cluster>     # then start
#     bash ops/csb-wait-ready.sh
#     node ops/csb-patch-chain-config.js --show   # confirm it took
#
# Why not edit the node's config.json directly (ops/csb-patch-chain-config.js):
# avalanche-cli regenerates the L1's chain config from the blockchain's stored
# settings every time the cluster starts. A per-node edit to the L1 entry is
# silently discarded on the next restart — verified on this cluster, where the
# patch survived for the C-Chain and vanished for the L1, and the regenerated
# eth-apis list came back longer than the one that was written. So the setting
# has to be stored where avalanche-cli regenerates it FROM.
#
# What it sets (ops/csb-l1-chain-config.json):
#   rpc-tx-fee-cap: 0  — lifts the 100-native-unit cap on a single transaction's
#       fee. With gas at 1 riel per transfer a contract deployment costs 100.35
#       tRIEL (about 2.5 US cents) and is refused by a rail meant for tokens
#       worth real money.
#
#   skip-upgrade-check: true — lets the chain start after it slept through a
#       fork. CSB missed Fuji's Helicon activation at 2026-07-28T15:00:00Z
#       because its nodes were below the version floor (docs/architecture.md §2).
#       It kept producing blocks for a while under pre-Helicon rules, so when the
#       Helicon-aware Subnet-EVM finally started it found blocks past a fork the
#       database had never heard of, and refused:
#
#         mismatching Helicon fork block timestamp in database
#         (have timestamp nil, want timestamp 1785250800,
#          rewindto timestamp 1785250799)
#
#       In the installed Subnet-EVM the flag is documented as "disables checking
#       that upgrades must take place before the last accepted block", which is
#       precisely this situation.
#
#       WHAT IT COSTS, because it is not free. Those blocks were built under the
#       old rules and are now kept under a config that says Helicon was already
#       active when they were made. Re-verifying the chain from genesis could
#       therefore diverge at that seam. The alternative was to override
#       heliconTimestamp (networkUpgradeOverrides) to a future date and fork on
#       CSB's own schedule, which keeps history consistent — chosen against
#       because it routes through the same avalanche-cli config regeneration
#       that has already silently discarded L1 settings on this cluster. The
#       decision is one-way: once the node starts, the database records Helicon
#       at the Fuji timestamp.
#
# What it deliberately does NOT set: eth-apis.
#
# An earlier version added "internal-txpool" to that list to give the watchdog a
# mempool signal. That is not a valid API name in Subnet-EVM v0.8.0, and the
# consequence was worse than a setting that does nothing — the node started, the
# chain was created, and then:
#
#   ERROR failed to create path route handlers
#     error: "failed to create inner VM handlers: API service internal-txpool not found"
#
# The chain's HTTP handlers failed to build, so no route was registered and the
# L1 RPC answered 404 while the node itself looked perfectly healthy. Overriding
# eth-apis at all means restating a list avalanche-cli generates and may change
# between versions, so this now leaves it alone entirely: one wrong entry takes
# the whole chain's API offline.
#
# If the txpool signal is wanted later, find the correct name for the installed
# Subnet-EVM version first — check its source rather than guessing, since a bad
# value is not rejected at config time — and change it while nothing depends on
# the chain.

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$PATH:$HOME/bin"

BLOCKCHAIN="${CSB_BLOCKCHAIN_NAME:-csb}"
CLUSTER="${CSB_CLUSTER:-csb-local-node-fuji}"
CFG="$PWD/ops/csb-l1-chain-config.json"

if ! command -v avalanche >/dev/null 2>&1; then
  echo "avalanche CLI not on PATH. Try: export PATH=\$PATH:\$HOME/bin" >&2
  exit 1
fi

echo "Blockchain: $BLOCKCHAIN"
echo "Config:     $CFG"
cat "$CFG"
echo

# The flag name has moved between avalanche-cli versions, so show what this
# build actually accepts rather than assuming.
echo "=== avalanche blockchain configure --help ==="
avalanche blockchain configure --help 2>&1 | sed -n '1,40p' || true
echo

echo "=== applying ==="
if avalanche blockchain configure "$BLOCKCHAIN" --chain-config "$CFG"; then
  echo "Applied via --chain-config."
else
  echo
  echo "That flag was not accepted. Run it interactively and choose"
  echo "\"Chain config\" when prompted, pointing at:"
  echo "    $CFG"
  echo
  echo "    avalanche blockchain configure $BLOCKCHAIN"
  exit 1
fi

echo
echo "Restart for it to take effect:"
echo "    avalanche node local stop $CLUSTER && avalanche node local start $CLUSTER"
echo
echo "Then confirm it SURVIVED the restart (this is the part that failed before):"
echo "    node ops/csb-patch-chain-config.js --show    # L1 must show rpc-tx-fee-cap 0"
echo "    source ops/csb-env.sh"
echo "    curl -s -X POST -H 'content-type:application/json' \\"
echo "      --data '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"txpool_status\",\"params\":[]}' \$CSB_RPC_URL; echo"
