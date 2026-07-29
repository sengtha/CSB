#!/usr/bin/env bash
# How many nodes are running, and which of them actually validate — read-only.
#
#     bash ops/csb-nodes.sh
#
# "How many nodes are running" has three different answers and they can disagree.
# That disagreement is not a curiosity: this project spent weeks believing the
# chain ran three validators because three nodes were running. It runs three
# nodes and one validator. So this script reports all three layers separately and
# never collapses them into a single number:
#
#   1. PROCESSES   — avalanchego processes alive on this host.
#   2. RESPONDING  — of those, which answer their API port and are bootstrapped.
#                    A process can be up and the chain still unusable.
#   3. VALIDATORS  — which are registered on the P-Chain for this L1. Only these
#                    contribute stake. A node that merely tracks the chain
#                    contributes nothing to finalisation, however healthy it is.
#
# Nothing here writes, restarts, or changes anything.
set -uo pipefail

CLUSTER="${CSB_CLUSTER:-csb-local-node-fuji}"
CL="$HOME/.avalanche-cli/local/$CLUSTER"
SUBNET_ID="${CSB_SUBNET_ID:-fgNiKVRTRJFZbCzSUPJMix6YdG2HfpXGf1LP9rQ58b5TU9mJL}"

echo "=============== 1. processes ==============="
n_proc=$(pgrep -c -f '[a]valanchego' 2>/dev/null || echo 0)
echo "avalanchego processes: $n_proc"
ps -eo pid,etime,args= 2>/dev/null | grep '[a]valanchego' \
  | sed -E 's/(--[a-z-]*(key|secret)[^ ]*)/\1=REDACTED/g' \
  | cut -c1-160

echo
echo "=============== 2. node dirs and API ports ==============="
if [ ! -d "$CL" ]; then
  echo "No cluster dir at $CL"
  echo "Clusters present:"; ls -1 "$HOME/.avalanche-cli/local" 2>/dev/null || echo "  (none)"
  exit 0
fi

# Ports are assigned by avalanche-cli, not fixed, so discover them rather than
# assuming. flags.json is the node's own record of what it was started with.
for dir in "$CL"/NodeID-*/; do
  [ -d "$dir" ] || continue
  nodeid=$(basename "$dir")
  port=$(grep -oE '"http-port"[[:space:]]*:[[:space:]]*"?[0-9]+' "$dir/flags.json" 2>/dev/null \
         | grep -oE '[0-9]+$' | head -1)
  [ -z "$port" ] && port=$(grep -rhoE '"http-port"[[:space:]]*:[[:space:]]*"?[0-9]+' "$dir" 2>/dev/null \
         | grep -oE '[0-9]+$' | head -1)

  if [ -z "$port" ]; then
    echo "$nodeid  http-port: UNKNOWN (no flags.json — check ops/csb-find-node-config.sh)"
    continue
  fi

  health=$(curl -s -m 5 "http://127.0.0.1:$port/ext/health" 2>/dev/null)
  if [ -z "$health" ]; then
    state="NOT ANSWERING"
  elif printf '%s' "$health" | grep -q '"healthy"[[:space:]]*:[[:space:]]*true'; then
    state="healthy"
  else
    state="answering but UNHEALTHY"
  fi
  echo "$nodeid  port $port  $state"
done

echo
echo "=============== 3. registered L1 validators ==============="
# The authoritative answer, and the one that matters for whether the chain can
# finalise. Asked of the P-Chain, not of any node's opinion of itself.
first_port=$(grep -rhoE '"http-port"[[:space:]]*:[[:space:]]*"?[0-9]+' "$CL"/NodeID-*/flags.json 2>/dev/null \
             | grep -oE '[0-9]+$' | head -1)
first_port="${first_port:-9650}"

vals=$(curl -s -m 10 -X POST -H 'content-type:application/json' --data "{
  \"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"platform.getCurrentValidators\",
  \"params\":{\"subnetID\":\"$SUBNET_ID\"}
}" "http://127.0.0.1:$first_port/ext/bc/P" 2>/dev/null)

if [ -z "$vals" ]; then
  echo "P-Chain did not answer on port $first_port."
else
  # nodeID and balance are what matter: a validator with balance 0 has been
  # deactivated under ACP-77 and contributes no stake while still being listed.
  printf '%s' "$vals" | python3 -c '
import json,sys
try: r = json.load(sys.stdin).get("result", {})
except Exception: print("unparseable reply:", sys.stdin.read()[:200]); sys.exit()
vs = r.get("validators", [])
print(f"registered validators: {len(vs)}")
for v in vs:
    bal = v.get("balance")
    try: bal = f"{int(bal)/1e9:.4f} AVAX"
    except Exception: bal = str(bal)
    flag = "  <-- ZERO BALANCE: deactivated, contributes no stake" if v.get("balance") in ("0",0) else ""
    print(f"  {v.get(\"nodeID\")}  weight {v.get(\"weight\")}  balance {bal}{flag}")
' 2>/dev/null || printf '%s\n' "$vals" | head -c 600
fi

echo
echo "Reminder: only the validators in section 3 secure the chain. Nodes in"
echo "section 2 that are not listed there track the chain and serve RPC, which"
echo "is useful load relief but contributes nothing to finalisation."
