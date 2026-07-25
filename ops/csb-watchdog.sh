#!/usr/bin/env bash
# CSB chain watchdog.
#
# Earlier CSB deployments stopped producing blocks silently: the RPC kept
# answering, but eth_blockNumber never advanced and no transaction ever mined.
# Nothing surfaced that until someone tried to use the wallet. This checks
# liveness on a timer and restarts the validator cluster when the chain is
# genuinely stuck.
#
# "Stuck" here means: the height did not move across STALL_CHECKS consecutive
# probes SPACED apart, *and* there is pending work. A quiet chain with an empty
# mempool legitimately produces no blocks — Subnet-EVM only builds a block when
# there is something to include — so height alone would false-positive every
# idle night. We only act when transactions are waiting and still nothing moves.
#
# Install (on the VM, as root):
#   install -m 755 ops/csb-watchdog.sh /usr/local/bin/csb-watchdog
#   cp ops/csb-watchdog.service ops/csb-watchdog.timer /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now csb-watchdog.timer
#
# Check on it:
#   systemctl list-timers csb-watchdog.timer
#   journalctl -u csb-watchdog -n 50
set -uo pipefail

RPC="${CSB_RPC_URL:-http://127.0.0.1:9650/ext/bc/299jCTH4ErmwFMB3ZKa18Ck9EDzc99DMD48zkszxcArpaUfTqW/rpc}"
CLUSTER="${CSB_CLUSTER:-csb-local-node-fuji}"
AVALANCHE="${AVALANCHE_BIN:-$HOME/bin/avalanche}"
HEALTH_PORT="${CSB_HEALTH_PORT:-9650}"  # node API port serving /ext/health
STALL_CHECKS="${CSB_STALL_CHECKS:-3}"   # consecutive frozen probes before acting
PROBE_GAP="${CSB_PROBE_GAP:-20}"        # seconds between probes
RESTART="${CSB_WATCHDOG_RESTART:-1}"    # 0 = alert only, never restart

log() { echo "[$(date -u +%FT%TZ)] $*"; }

rpc() {
  curl -s --max-time 10 -X POST -H 'content-type:application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC"
}

# Hex quantity out of a JSON-RPC result, as decimal. Empty on failure.
hexnum() {
  local raw
  raw=$(printf '%s' "$1" | grep -o '"result":"0x[0-9a-fA-F]*"' | grep -o '0x[0-9a-fA-F]*')
  [ -n "$raw" ] && printf '%d' "$raw"
}

height() { hexnum "$(rpc eth_blockNumber)"; }

# Transactions waiting in the mempool (pending + queued), or "unknown" if the
# txpool API is not exposed on this RPC — Subnet-EVM does not enable it unless
# "internal-txpool" is in eth-apis. Distinguishing unknown from zero matters: if
# we collapsed them, a node without the txpool API would look permanently idle
# and the watchdog would never restart anything.
pending_txs() {
  local body p q
  body=$(rpc txpool_status)
  p=$(printf '%s' "$body" | grep -o '"pending":"0x[0-9a-fA-F]*"' | grep -o '0x[0-9a-fA-F]*')
  q=$(printf '%s' "$body" | grep -o '"queued":"0x[0-9a-fA-F]*"'  | grep -o '0x[0-9a-fA-F]*')
  if [ -z "$p" ] && [ -z "$q" ]; then
    echo unknown
    return
  fi
  echo $(( $(printf '%d' "${p:-0x0}") + $(printf '%d' "${q:-0x0}") ))
}

# Is every node in the cluster reporting healthy? The health endpoint catches
# problems a height probe cannot distinguish from an idle chain — notably
# "not connected to enough stake", which is what a wedged L1 looks like.
node_unhealthy() {
  local body
  body=$(curl -s --max-time 10 "http://127.0.0.1:${1}/ext/health")
  [ -z "$body" ] && return 0                                  # no answer = unhealthy
  printf '%s' "$body" | grep -q '"healthy":true' && return 1
  return 0
}

first=$(height)
if [ -z "$first" ]; then
  log "RPC not answering at $RPC — chain down, not merely stalled."
  if [ "$RESTART" = "1" ] && [ -x "$AVALANCHE" ]; then
    log "starting cluster $CLUSTER"
    "$AVALANCHE" node local start "$CLUSTER" 2>&1 | sed 's/^/    /'
  elif [ ! -x "$AVALANCHE" ]; then
    log "avalanche CLI not found at $AVALANCHE (set AVALANCHE_BIN) — cannot restart."
  fi
  exit 1
fi

frozen=0
last=$first
for _ in $(seq 1 "$STALL_CHECKS"); do
  sleep "$PROBE_GAP"
  now=$(height)
  if [ -z "$now" ]; then
    log "RPC stopped answering mid-probe (was at height $last)"
    frozen=$STALL_CHECKS
    break
  fi
  if [ "$now" -gt "$last" ]; then
    log "healthy — height $first → $now"
    exit 0
  fi
  frozen=$((frozen + 1))
  last=$now
done

# Height being flat is not proof of a stall: Subnet-EVM only builds a block when
# there is something to include, so an idle chain legitimately sits still. Decide
# using the two signals that CAN tell idle from wedged.
waiting=$(pending_txs)
unhealthy=0
if node_unhealthy "$HEALTH_PORT"; then unhealthy=1; fi

if [ "$unhealthy" -eq 0 ]; then
  case "$waiting" in
    unknown)
      log "height flat at $last across $frozen probes; node healthy but the txpool API is"
      log "not exposed, so idle-vs-stuck cannot be told apart. Treating as idle."
      log "To make this check meaningful, add 'internal-txpool' to eth-apis on the node."
      exit 0
      ;;
    0)
      log "height flat at $last across $frozen probes, node healthy, mempool empty — idle, not stuck."
      exit 0
      ;;
  esac
fi

log "STALLED: height flat at $last across $frozen probes" \
    "(mempool: $waiting; node: $([ "$unhealthy" -eq 1 ] && echo UNHEALTHY || echo healthy))."
if [ -x "$AVALANCHE" ]; then
  "$AVALANCHE" node local list 2>&1 | sed 's/^/    /'
else
  log "note: avalanche CLI not found at $AVALANCHE (set AVALANCHE_BIN) — cannot inspect or restart."
  exit 1
fi

if [ "$RESTART" != "1" ]; then
  log "CSB_WATCHDOG_RESTART=0 — alerting only, leaving the cluster alone."
  exit 1
fi

log "restarting cluster $CLUSTER"
"$AVALANCHE" node local stop "$CLUSTER"  2>&1 | sed 's/^/    /'
sleep 5
"$AVALANCHE" node local start "$CLUSTER" 2>&1 | sed 's/^/    /'

sleep 30
after=$(height)
if [ -n "$after" ] && [ "$after" -gt "$last" ]; then
  log "recovered — height now $after"
  exit 0
fi

log "STILL STUCK at ${after:-unreachable} after restart. A wedged CSB chain has never"
log "recovered from a restart before; expect to redeploy with >=3 validators."
log "See the 'Block height frozen' section of docs/deployment-status.md."
exit 1
