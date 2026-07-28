#!/usr/bin/env bash
# CSB chain watchdog — REPORTS, never restarts.
#
# Install (on the VM, as root):
#   install -m 755 ops/csb-watchdog.sh /usr/local/bin/csb-watchdog
#   cp ops/csb-watchdog.service ops/csb-watchdog.timer /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now csb-watchdog.timer
#
# Read it:
#   journalctl -u csb-watchdog -n 60
#   systemctl list-timers csb-watchdog.timer
#
# WHY THIS NO LONGER RESTARTS ANYTHING
#
# Every earlier version could stop and start the cluster, and every CSB outage
# to date was either caused by it doing so or prolonged by it. The last one is
# worth writing down in full, because the bug was subtle and the damage was not.
#
# The L1's single validator ran out of P-Chain balance. Under ACP-77 a validator
# pays a continuous fee from a balance held on the P-Chain, and at zero it is
# deactivated: still listed in the validator set, contributing no stake. The
# chain then reported "not connected to enough stake: connected to 0.000000%",
# never finished bootstrapping, and answered every RPC call with
#
#     API call rejected because chain is not done bootstrapping
#
# That is a well-formed HTTP 200 with an error body. The old height() looked for
# '"result":"0x..."', found none, and returned empty — which this script read as
# "the RPC is not answering at all", its one restart-worthy condition. So it
# stopped and started a node that was alive, answering, and completely unable to
# benefit from a restart, roughly every fifteen minutes, for hours. The node's
# own log recorded it honestly: shutting down node {"exitCode": 0}.
#
# Two lessons are baked in below:
#
#   1. A REPLY IS NOT A RESULT, AND NEITHER IS SILENCE A DIAGNOSIS. An error
#      body means the node is up and telling you what is wrong. It is the most
#      useful thing the node can say, and it must never be flattened into the
#      same bucket as an unreachable socket.
#   2. RESTARTS DO NOT FIX ROOT CAUSES, AND THIS ONE HAD A CLEAN SIGNAL DAYS IN
#      ADVANCE. The validator's balance falls monotonically and visibly. Nothing
#      about a stop/start puts AVAX on the P-Chain. An operator reading "3 days
#      of validator runway left" fixes it in a minute; an automatic restarter
#      converts it into a mystery outage.
#
# So: this script diagnoses and exits. Exit 1 means "a human should look",
# which systemd records as a service failure and any journal alerting will pick
# up. It never touches the cluster.
set -uo pipefail

RPC="${CSB_RPC_URL:-http://127.0.0.1:9650/ext/bc/299jCTH4ErmwFMB3ZKa18Ck9EDzc99DMD48zkszxcArpaUfTqW/rpc}"
HEALTH_PORT="${CSB_HEALTH_PORT:-9650}"
PCHAIN="${CSB_PCHAIN_URL:-http://127.0.0.1:${HEALTH_PORT}/ext/bc/P}"
SUBNET_ID="${CSB_SUBNET_ID:-fgNiKVRTRJFZbCzSUPJMix6YdG2HfpXGf1LP9rQ58b5TU9mJL}"
CHAIN_ID="${CSB_CHAIN_ALIAS:-299jCTH4ErmwFMB3ZKa18Ck9EDzc99DMD48zkszxcArpaUfTqW}"

# Warn below this many AVAX of validator balance. The fee accrues per second per
# validator, so this is runway, not a cliff — the point is to be told while
# topping up is still a one-line command.
MIN_BALANCE="${CSB_MIN_VALIDATOR_BALANCE:-0.25}"

log() { echo "[$(date -u +%FT%TZ)] $*"; }

problems=0
note() { log "!! $*"; problems=$((problems + 1)); }

# --- validator balance ------------------------------------------------------
# Checked FIRST and unconditionally, because it is the only signal here that
# leads the failure rather than trailing it. Everything else in this script
# tells you the chain is already down.
check_validators() {
  local body
  body=$(curl -s --max-time 15 -X POST -H 'content-type:application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"platform.getCurrentValidators\",\"params\":{\"subnetID\":\"$SUBNET_ID\"}}" \
    "$PCHAIN")

  if [ -z "$body" ]; then
    note "P-Chain did not answer at $PCHAIN — cannot check validator balances."
    return
  fi

  MIN_BALANCE="$MIN_BALANCE" python3 - "$body" <<'PY'
import json, os, sys

min_balance = float(os.environ["MIN_BALANCE"])
try:
    vals = json.loads(sys.argv[1])["result"]["validators"]
except Exception as e:
    print(f"!! could not parse the P-Chain validator response: {e}")
    sys.exit(2)

if not vals:
    print("!! the L1 has NO registered validators. It cannot finalise anything.")
    sys.exit(2)

bad = []
for v in vals:
    # nAVAX. Absent means the P-Chain did not report one, which is not zero —
    # conflating the two is the same mistake that caused the outage this script
    # was rewritten after.
    raw = v.get("balance")
    node = v.get("nodeID", "?")
    if raw is None:
        print(f"   {node}  balance: not reported by this node")
        continue
    avax = int(raw) / 1e9
    if avax <= 0:
        print(f"!! {node}  balance: 0 — DEACTIVATED. This validator contributes no stake.")
        bad.append(v)
    elif avax < min_balance:
        print(f"!! {node}  balance: {avax:.4f} AVAX — below {min_balance} AVAX, top up soon.")
        bad.append(v)
    else:
        print(f"   {node}  balance: {avax:.4f} AVAX  weight {v.get('weight','?')}")

for v in bad:
    print("   fix: avalanche validator increaseBalance --fuji --key csb-deployer \\")
    print(f"          --validation-id {v.get('validationID','<validationID>')} --balance 1")

sys.exit(2 if bad else 0)
PY
  [ $? -eq 0 ] || problems=$((problems + 1))
}

# --- RPC --------------------------------------------------------------------
# Returns one of: HEIGHT:<n> | ERROR:<message> | UNREACHABLE
# These are three different situations and the old script had only two.
probe_rpc() {
  local body rc
  body=$(curl -s --max-time 10 -X POST -H 'content-type:application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$RPC")
  rc=$?
  if [ $rc -ne 0 ] || [ -z "$body" ]; then
    echo "UNREACHABLE"
    return
  fi
  # Whitespace-tolerant on purpose. A pattern that demanded '"result":"0x..'
  # with no space read a perfectly good height as an error the first time this
  # was tested against pretty-printed JSON. Nothing guarantees a node's
  # formatting, and the cost of being strict here is a false alarm about a
  # healthy chain.
  local hex
  hex=$(printf '%s' "$body" \
    | grep -oE '"result"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]+"' \
    | grep -oE '0x[0-9a-fA-F]+')
  if [ -n "$hex" ]; then
    echo "HEIGHT:$(printf '%d' "$hex")"
    return
  fi
  # A reply we could not read a height from. Pass the node's own words through
  # rather than inventing a diagnosis — "chain is not done bootstrapping" names
  # the problem far better than anything this script could infer.
  echo "ERROR:$(printf '%s' "$body" | tr -d '\n' | cut -c1-200)"
}

# --- health -----------------------------------------------------------------
check_health() {
  local body
  body=$(curl -s --max-time 10 "http://127.0.0.1:${HEALTH_PORT}/ext/health")
  if [ -z "$body" ]; then
    note "health endpoint at :${HEALTH_PORT} did not answer."
    return
  fi
  CHAIN_ID="$CHAIN_ID" python3 - "$body" <<'PY'
import json, os, sys
try:
    h = json.loads(sys.argv[1])
except Exception:
    print("!! health endpoint returned something that is not JSON")
    sys.exit(2)
checks = h.get("checks", {})
failed = [(n, c.get("error")) for n, c in checks.items() if c.get("error")]
if not failed:
    print("   node health: all checks passing")
    sys.exit(0)
for name, err in failed:
    print(f"!! health check {name[:28]}: {str(err)[:140]}")
sys.exit(2)
PY
  [ $? -eq 0 ] || problems=$((problems + 1))
}

# ---------------------------------------------------------------------------
log "checking CSB"

check_validators
check_health

state=$(probe_rpc)
case "$state" in
  HEIGHT:*)
    log "   RPC height ${state#HEIGHT:}"
    ;;
  ERROR:*)
    note "the RPC answered but returned no height. The node is UP and reporting a problem:"
    log "      ${state#ERROR:}"
    log "      This is not a restart. Read the message above and the validator balances."
    ;;
  UNREACHABLE)
    note "no reply at all from $RPC — the node process or its API is down."
    log "      Check: pgrep -af avalanchego ; avalanche node local status \${CSB_CLUSTER:-csb-local-node-fuji}"
    ;;
esac

if [ "$problems" -eq 0 ]; then
  log "OK"
  exit 0
fi

log "$problems problem(s) reported. This watchdog does not restart anything —"
log "every CSB outage so far was caused or prolonged by automatic restarts."
exit 1
