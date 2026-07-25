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
#
# If you ever suspect the watchdog itself, turn it off before debugging the node:
#   systemctl stop csb-watchdog.timer
# It has taken a healthy cluster down before (see the notes on locking and on
# node_unhealthy below), so rule it out first rather than last.
set -uo pipefail

RPC="${CSB_RPC_URL:-http://127.0.0.1:9650/ext/bc/299jCTH4ErmwFMB3ZKa18Ck9EDzc99DMD48zkszxcArpaUfTqW/rpc}"
CLUSTER="${CSB_CLUSTER:-csb-local-node-fuji}"
AVALANCHE="${AVALANCHE_BIN:-$HOME/bin/avalanche}"
HEALTH_PORT="${CSB_HEALTH_PORT:-9650}"  # node API port serving /ext/health
STALL_CHECKS="${CSB_STALL_CHECKS:-3}"   # consecutive frozen probes before acting
PROBE_GAP="${CSB_PROBE_GAP:-20}"        # seconds between probes
RESTART="${CSB_WATCHDOG_RESTART:-1}"    # 0 = alert only, never restart

log() { echo "[$(date -u +%FT%TZ)] $*"; }

# avalanche-cli writes progress with ANSI escapes and other non-printable bytes.
# Piped into the journal those become "[8B blob data]" lines that hide whatever
# the CLI actually said — exactly when something has gone wrong and you need it.
clean() { tr -cd '\11\12\15\40-\176'; }

# Only one run at a time. The timer fires every 5 minutes; a node that is
# bootstrapping takes longer than that, so without a lock each firing launches
# ANOTHER `avalanche node local start` against a cluster that is already
# starting. Competing starts are how a cluster ends up Stopped and staying
# Stopped — the failure this watchdog exists to prevent, caused by the watchdog.
exec 9>/run/csb-watchdog.lock
if ! flock -n 9; then
  log "another watchdog run is still in progress — skipping this firing."
  exit 0
fi

# Is the cluster already up? Starting one that is running fails with
# "node is already running", and starting one that is mid-bootstrap is worse.
cluster_running() {
  [ -x "$AVALANCHE" ] || return 1
  "$AVALANCHE" node local status "$CLUSTER" 2>/dev/null | clean | grep -q 'Running'
}

# Bring the cluster up and WAIT for it, instead of firing a start and reporting
# failure while it boots.
start_and_wait() {
  if cluster_running; then
    log "cluster reports Running already — not issuing a second start."
  else
    log "starting cluster $CLUSTER"
    "$AVALANCHE" node local start "$CLUSTER" 2>&1 | clean | sed 's/^/    /'
  fi
  local i h
  for i in $(seq 1 "${CSB_START_WAIT_PROBES:-20}"); do
    sleep 15
    h=$(height)
    if [ -n "$h" ]; then
      log "RPC answering again at height $h after $((i * 15))s."
      return 0
    fi
  done
  log "still no RPC after $(( ${CSB_START_WAIT_PROBES:-20} * 15 ))s — a bootstrapping L1 can"
  log "legitimately take longer than this; the next firing will check again rather than restart."
  return 1
}

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
  if [ -n "$p" ] || [ -n "$q" ]; then
    echo $(( $(printf '%d' "${p:-0x0}") + $(printf '%d' "${q:-0x0}") ))
    return
  fi
  pending_txs_via_block   # txpool API not exposed — fall back
}

# Fallback when txpool_status is unavailable: count transactions in the "pending"
# block, which the default eth-apis set does expose.
#
# The catch: on some builds the "pending" tag simply aliases the latest block. If
# it did and we trusted it, a chain that had just mined a busy block would look
# like it had a backlog, and the watchdog would restart a perfectly healthy
# cluster. So we only trust the answer when the pending block's number is
# actually ahead of the latest block; otherwise we report unknown and stay put.
pending_txs_via_block() {
  local body num pend_h latest_h count
  body=$(rpc eth_getBlockByNumber '["pending",false]')
  num=$(printf '%s' "$body" | grep -o '"number":"0x[0-9a-fA-F]*"' | head -1 | grep -o '0x[0-9a-fA-F]*')
  if [ -z "$num" ]; then echo unknown; return; fi
  pend_h=$(printf '%d' "$num")
  latest_h=$(height)
  if [ -z "$latest_h" ] || [ "$pend_h" -le "$latest_h" ]; then
    echo unknown   # "pending" is aliasing latest — tells us nothing about the mempool
    return
  fi
  # Count tx hashes in the pending block's transactions array.
  count=$(printf '%s' "$body" \
    | sed 's/.*"transactions":\[//; s/\].*//' \
    | grep -o '0x[0-9a-fA-F]\{64\}' | wc -l)
  echo "$count"
}

# Is every node in the cluster reporting healthy? The health endpoint catches
# problems a height probe cannot distinguish from an idle chain — notably
# "not connected to enough stake", which is what a wedged L1 looks like.
#
# RETRIED, because this decides whether to stop a running cluster. A single
# curl timeout under load used to be enough to report "unhealthy" and trigger a
# stop/start of a node that was fine — the watchdog causing the outage it was
# installed to catch. Three failures in a row is a signal; one is noise.
node_unhealthy() {
  local i body
  for i in 1 2 3; do
    body=$(curl -s --max-time 10 "http://127.0.0.1:${1}/ext/health")
    printf '%s' "$body" | grep -q '"healthy":true' && return 1
    [ "$i" -lt 3 ] && sleep 5
  done
  log "health endpoint did not report healthy in 3 attempts"
  return 0
}

first=$(height)
if [ -z "$first" ]; then
  log "RPC not answering at $RPC — chain down, not merely stalled."
  if [ ! -x "$AVALANCHE" ]; then
    log "avalanche CLI not found at $AVALANCHE (set AVALANCHE_BIN) — cannot restart."
    exit 1
  fi
  if [ "$RESTART" != "1" ]; then
    log "CSB_WATCHDOG_RESTART=0 — alerting only."
    exit 1
  fi
  # Exit 0 when the recovery WORKED. The old code exited 1 unconditionally, so
  # a successful recovery was still recorded as a service failure — which made
  # the journal useless for telling "it fixed itself" from "it is still broken".
  if start_and_wait; then exit 0; fi
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
      log "height flat at $last across $frozen probes; node healthy, but neither the txpool"
      log "API nor a usable 'pending' block is available, so idle cannot be told from stuck."
      log "Treating as idle — the watchdog still covers RPC-down and unhealthy-node, but NOT"
      log "a wedged chain. Closing that gap needs a txpool API this Subnet-EVM build does"
      log "not expose under the name tried so far; see ops/csb-apply-l1-config.sh."
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
  "$AVALANCHE" node local list 2>&1 | clean | sed 's/^/    /'
else
  log "note: avalanche CLI not found at $AVALANCHE (set AVALANCHE_BIN) — cannot inspect or restart."
  exit 1
fi

if [ "$RESTART" != "1" ]; then
  log "CSB_WATCHDOG_RESTART=0 — alerting only, leaving the cluster alone."
  exit 1
fi

log "restarting cluster $CLUSTER"
"$AVALANCHE" node local stop "$CLUSTER"  2>&1 | clean | sed 's/^/    /'
sleep 5
start_and_wait || true

after=$(height)
if [ -n "$after" ] && [ "$after" -gt "$last" ]; then
  log "recovered — height now $after"
  exit 0
fi

log "STILL STUCK at ${after:-unreachable} after restart. A wedged CSB chain has never"
log "recovered from a restart before; expect to redeploy with >=3 validators."
log "See the 'Block height frozen' section of docs/deployment-status.md."
exit 1
