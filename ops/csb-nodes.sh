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
# One avalanchego process is one node, so the count of distinct PIDs IS the
# number of running nodes. Every other listening port those processes hold is an
# internal listener, which is why counting ports gives a much bigger, wrong
# number.
#
# pgrep -c prints 0 AND exits non-zero when there is no match, so `|| echo 0`
# would append a second zero. Take the first line and default it instead.
n_proc=$(pgrep -c -f '[a]valanchego' 2>/dev/null | head -1)
echo "RUNNING NODES (distinct avalanchego processes): ${n_proc:-0}"
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
seen=""
for p in $ports; do
  id=$(curl -s -m 2 -X POST -H 'content-type:application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"info.getNodeID"}' \
        "http://127.0.0.1:$p/ext/info" 2>/dev/null \
        | grep -oE 'NodeID-[1-9A-HJ-NP-Za-km-z]+' | head -1)
  [ -z "$id" ] && continue
  # A node answers on more than one port, so count each NodeID once.
  case " $seen " in *" $id "*) continue ;; esac
  seen="$seen $id"
  found=$((found + 1))
  # Which process owns this port, so the node can be matched to a PID in
  # section 1 and stopped or inspected individually.
  pid=$( { ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null; } \
         | grep -E "[:.]$p[[:space:]]" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)

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
  echo "port $p  ${pid:+pid $pid  }$id  $state${pc:+  percentConnected $pc}"
done
echo "nodes answering: $found"

if [ -d "$CL" ]; then
  dirs=$(find "$CL" -maxdepth 1 -name 'NodeID-*' -type d 2>/dev/null | wc -l)
  echo "node dirs on disk: $dirs in $CLUSTER"
  if [ "$found" -lt "$dirs" ]; then
    echo "*** $((dirs - found)) node(s) have a directory but are NOT running. Which ones:"
    for dir in "$CL"/NodeID-*/; do
      [ -d "$dir" ] || continue
      nid=$(basename "$dir")
      case " $seen " in *" $nid "*) ;; *) echo "    $nid — no API port answered" ;; esac
    done
  fi
else
  echo "No cluster dir at $CL — clusters present:"
  ls -1 "$HOME/.avalanche-cli/local" 2>/dev/null | sed 's/^/  /' || echo "  (none)"
fi

echo
echo "=============== 3. registered L1 validators ==============="
# The authoritative answer, and the one that matters for whether the chain can
# finalise. Asked of the P-Chain, not of any node's opinion of itself.
first_port="${CSB_API_PORT:-9650}"
# The Fuji P-Chain is PUBLIC, and this validator is registered on it. Asking the
# local node first is right when it is up — but the moment you most need this
# number is when the chain is down, and a down node cannot tell you why. Falling
# back to Fuji's own API means the balance stays readable in exactly the
# situation the check exists for. Discovered the hard way on 2026-09-08, when
# the cluster was stopped AND the balance was zero and this section printed
# nothing but "P-Chain did not answer".
PUBLIC_P="${CSB_PUBLIC_PCHAIN:-https://api.avax-test.network/ext/bc/P}"

ask_p() {
  curl -s -m 15 -X POST -H 'content-type:application/json' --data "{
    \"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"platform.getCurrentValidators\",
    \"params\":{\"subnetID\":\"$SUBNET_ID\"}
  }" "$1" 2>/dev/null
}

source_used="local node on port $first_port"
vals=$(ask_p "http://127.0.0.1:$first_port/ext/bc/P")
case "$vals" in
  *'"validators"'*) ;;
  *)
    echo "Local P-Chain on port $first_port did not answer — asking Fuji directly."
    vals=$(ask_p "$PUBLIC_P")
    source_used="$PUBLIC_P"
    ;;
esac
echo "source: $source_used"

if [ -z "$vals" ]; then
  echo "Neither the local node nor $PUBLIC_P answered. Check outbound network."
else
  # nodeID and balance are what matter: a validator with balance 0 has been
  # deactivated under ACP-77 and contributes no stake while still being listed.
  # Double quotes INSIDE, single quotes OUTSIDE, and no backslash escapes at all.
  # The previous version escaped its quotes as \" inside an f-string expression,
  # which Python only permits from 3.12; on the 3.11 this VM runs it is a
  # SyntaxError, so the parser never executed and the `||` fallback quietly
  # dumped raw JSON instead — during the one incident it was written for. Every
  # value is hoisted into a plain variable first so no f-string ever needs a
  # quote of its own.
  #
  # A heredoc would avoid escaping entirely but cannot be used here: `python3 -`
  # reads the SCRIPT from stdin, so there is no stdin left to pipe the JSON in on.
  printf '%s' "$vals" | python3 -c '
import json, sys

try:
    r = json.load(sys.stdin).get("result", {})
except Exception:
    print("unparseable reply from the P-Chain")
    sys.exit(1)

vs = r.get("validators", [])
print("registered validators: %d" % len(vs))
for v in vs:
    raw = v.get("balance")
    node = v.get("nodeID", "?")
    weight = v.get("weight", "?")
    # Absent is NOT zero. Conflating the two is what made the July outage look
    # like a mempool problem, and the distinction is kept wherever it appears.
    if raw is None:
        print("  %s  weight %s  balance not reported" % (node, weight))
        continue
    avax = int(raw) / 1e9
    if avax <= 0:
        flag = "  <-- ZERO: DEACTIVATED, contributes no stake"
    elif avax < 0.6:
        flag = "  <-- LOW: about %.0f days left at the measured drain" % (avax / 0.042)
    else:
        flag = ""
    print("  %s  weight %s  balance %.4f AVAX%s" % (node, weight, avax, flag))
    if avax < 0.6:
        vid = v.get("validationID", "<validationID>")
        print("        avalanche validator increaseBalance --fuji --key csb-deployer \\")
        print("          --validation-id %s --balance 2" % vid)
' || { echo "could not parse the reply:"; printf '%s\n' "$vals" | head -c 600; }
fi

echo
echo "Reminder: only the validators in section 3 secure the chain. Nodes in"
echo "section 2 that are not listed there track the chain and serve RPC, which"
echo "is useful load relief but contributes nothing to finalisation."
