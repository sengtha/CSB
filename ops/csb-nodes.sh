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
# pgrep -c prints 0 AND exits non-zero when there is no match, so `|| echo 0`
# would append a second zero. Take the first line and default it instead.
n_proc=$(pgrep -c -f '[a]valanchego' 2>/dev/null | head -1)
echo "avalanchego processes: ${n_proc:-0}"
ps -eo pid,etime,args= 2>/dev/null | grep '[a]valanchego' \
  | sed -E 's/(--[a-z-]*(key|secret)[^ ]*)/\1=REDACTED/g' \
  | cut -c1-160

echo
echo "=============== 2. nodes actually answering ==============="
# Do NOT try to map node directories to ports by parsing config files. That was
# the first version of this script and it printed UNKNOWN, because the layout
# avalanche-cli writes is not guaranteed to contain a readable flags.json.
#
# Ask the nodes instead. Collect every port something is LISTENING on, ask each
# one `info.getNodeID`, and whatever answers is a running node — no assumption
# about file layout, port numbers, or how the node was started.
ports=$( { ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null; } \
  | grep -oE '(127\.0\.0\.1|0\.0\.0\.0|\*|\[::\]):[0-9]+' \
  | grep -oE '[0-9]+$' | sort -un )
# Include the well-known default even if nothing appeared to be listening on it,
# so a broken `ss` cannot make a running node invisible.
ports=$(printf '%s\n9650\n' "$ports" | sort -un)

found=0
for p in $ports; do
  id=$(curl -s -m 2 -X POST -H 'content-type:application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"info.getNodeID"}' \
        "http://127.0.0.1:$p/ext/info" 2>/dev/null \
        | grep -oE 'NodeID-[1-9A-HJ-NP-Za-km-z]+' | head -1)
  [ -z "$id" ] && continue
  found=$((found + 1))

  health=$(curl -s -m 5 "http://127.0.0.1:$p/ext/health" 2>/dev/null)
  if [ -z "$health" ]; then
    state="no health reply"
  elif printf '%s' "$health" | grep -q '"healthy"[[:space:]]*:[[:space:]]*true'; then
    state="healthy"
  else
    state="UNHEALTHY"
  fi
  # percentConnected is the number that decides whether the chain can finalise.
  pc=$(printf '%s' "$health" | grep -oE '"percentConnected"[[:space:]]*:[[:space:]]*[0-9.]+' \
       | grep -oE '[0-9.]+$' | head -1)
  echo "port $p  $id  $state${pc:+  percentConnected $pc}"
done
echo "nodes answering: $found"

if [ -d "$CL" ]; then
  echo "node dirs on disk: $(find "$CL" -maxdepth 1 -name 'NodeID-*' -type d 2>/dev/null | wc -l) in $CLUSTER"
  echo "(a dir with no answering port above is a node that is NOT running)"
else
  echo "No cluster dir at $CL — clusters present:"
  ls -1 "$HOME/.avalanche-cli/local" 2>/dev/null | sed 's/^/  /' || echo "  (none)"
fi

echo
echo "=============== 3. registered L1 validators ==============="
# The authoritative answer, and the one that matters for whether the chain can
# finalise. Asked of the P-Chain, not of any node's opinion of itself.
first_port="${CSB_API_PORT:-9650}"

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
