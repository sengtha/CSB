#!/usr/bin/env bash
# Start the CSB validator cluster if it is not already running. Idempotent.
#
# Install (on the VM, as root):
#   install -m 755 ops/csb-cluster-start.sh /usr/local/bin/csb-cluster-start
#   cp ops/csb-cluster.service /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now csb-cluster.service
#
# WHY THIS EXISTS. A reboot has taken CSB down twice — 2026-08 and again on
# 2026-09-08 — because nothing starts the cluster at boot. Both times the
# diagnosis burned an hour looking at the validator's P-Chain balance, which had
# also run out, before anyone checked whether the processes were alive at all.
# Two independent clocks failing together is not a coincidence: a VM that has
# been up long enough to reboot has also been up long enough to drain the
# balance.
#
# WHAT IT DELIBERATELY DOES NOT DO.
#
# It does not restart a running cluster, ever. `ops/csb-watchdog.sh` documents at
# length why automatic restarts made every previous outage worse: a node that is
# up and answering with an error is telling you the cause, and stopping it throws
# that away. This script only covers the one case a restart genuinely fixes —
# nothing is running.
#
# It never calls `avalanche node local destroy`. That deletes the cluster and
# every contract on it, with no undo and no backup of chain state.
#
# It does not top up the validator. Nothing about starting a process puts AVAX on
# the P-Chain, and a cluster started against a deactivated validator will run,
# answer, and never finalise — which looks like a different problem entirely. So
# it reports the balance and says so rather than leaving that to be discovered.
set -uo pipefail

CLUSTER="${CSB_CLUSTER:-csb-local-node-fuji}"
SUBNET_ID="${CSB_SUBNET_ID:-fgNiKVRTRJFZbCzSUPJMix6YdG2HfpXGf1LP9rQ58b5TU9mJL}"
PUBLIC_P="${CSB_PUBLIC_PCHAIN:-https://api.avax-test.network/ext/bc/P}"

# systemd gives a minimal PATH and avalanche-cli installs to ~/bin.
export PATH="$PATH:${HOME:-/root}/bin:/usr/local/bin"

log() { echo "[$(date -u +%FT%TZ)] csb-cluster-start: $*"; }

# The bracket keeps pgrep from matching its own command line. Counting ports
# instead would give a much larger, wrong number — each node holds several
# internal listeners.
running=$(pgrep -c -f '[a]valanchego' 2>/dev/null | head -1)
running=${running:-0}

if [ "$running" -gt 0 ]; then
  log "$running avalanchego process(es) already running — leaving them alone."
  exit 0
fi

if ! command -v avalanche >/dev/null 2>&1; then
  log "avalanche CLI not on PATH ($PATH) — cannot start the cluster."
  exit 1
fi

log "no avalanchego process found; starting cluster $CLUSTER"
if ! avalanche node local start "$CLUSTER"; then
  log "avalanche node local start failed. Do NOT run 'destroy' to clean up —"
  log "it deletes the cluster and every contract on it. Read the error above."
  exit 1
fi

log "started. Waiting for the chain to answer…"
if [ -x "$(dirname "$0")/csb-wait-ready.sh" ]; then
  bash "$(dirname "$0")/csb-wait-ready.sh" || log "chain did not become ready in time"
fi

# --- the other clock --------------------------------------------------------
# Asked of Fuji rather than of the local node: at this point the local node may
# still be bootstrapping, and a validator on zero balance is exactly why it might
# never finish. Reporting it here turns "the chain is up but stuck" into a
# sentence instead of an investigation.
vals=$(curl -s -m 15 -X POST -H 'content-type:application/json' --data "{
  \"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"platform.getCurrentValidators\",
  \"params\":{\"subnetID\":\"$SUBNET_ID\"}
}" "$PUBLIC_P" 2>/dev/null)

printf '%s' "$vals" | python3 -c '
import json, sys

try:
    vs = json.load(sys.stdin).get("result", {}).get("validators", [])
except Exception:
    print("could not read the validator set from Fuji")
    sys.exit(0)

for v in vs:
    raw = v.get("balance")
    node = v.get("nodeID", "?")
    if raw is None:
        print("  %s  balance not reported" % node)
        continue
    avax = int(raw) / 1e9
    if avax <= 0:
        print("  %s  balance 0 — DEACTIVATED. The cluster is running but cannot" % node)
        print("     finalise. Starting processes does not fix this:")
        print("       avalanche validator increaseBalance --fuji --key csb-deployer \\")
        print("         --validation-id %s --balance 2" % v.get("validationID", "<id>"))
    elif avax < 0.6:
        print("  %s  balance %.4f AVAX — about %.0f days left." % (node, avax, avax / 0.042))
    else:
        print("  %s  balance %.4f AVAX" % (node, avax))
' 2>/dev/null || log "validator balance check skipped (no reply from $PUBLIC_P)"

log "done."
