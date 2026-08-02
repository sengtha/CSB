#!/usr/bin/env bash
# Restart the app server (app/server.js) without changing how it was configured.
#
#     bash ops/csb-restart-app.sh
#
# WHY NOT JUST pkill AND node app/server.js. Two things go wrong when the restart
# is retyped from memory, and both fail quietly.
#
# THE PASSCODE. EXPLORER_PASSCODE has no persistent home — it is passed on the
# command line, and when it is omitted the server falls back to "csb-demo". So a
# restart that forgets it does not error; it silently republishes the site under
# the default passcode, and the first sign is somebody getting in who should not.
# This reads the value out of the running process instead of asking anyone to
# remember it, and never prints it.
#
# THE DIRECTORY. The server may be running from a different checkout than the one
# you just pulled — docs/deployment-status.md says /opt/csb while day-to-day work
# happens in ~/csb. Pulling in one and restarting the other is the worst kind of
# failure: everything reports success and the change is simply absent. So this
# restarts the server from ITS OWN working directory, and says which one that is.
#
# Environment, all optional:
#   CSB_APP_LOG    where to send output          (default /tmp/app.log)
#   CSB_APP_WAIT   seconds to wait for a reply             (default 15)

set -uo pipefail

LOG="${CSB_APP_LOG:-/tmp/app.log}"
WAIT="${CSB_APP_WAIT:-15}"

# Find the server by what it IS, not by what its command line says.
#
# `pgrep -f app/server.js` matches any process with that string on its command
# line: an editor holding the file open, a tail -f on it, a shell one-liner that
# mentions it. The bracket trick ([a]pp) only stops pgrep matching itself and
# does nothing about the rest — it killed the test harness that was written to
# check this script, which is a fair warning about what it would do on a VM. So
# candidates are filtered to processes whose executable really is node.
app_pids() {
  local p exe
  for p in $(pgrep -f 'app/server\.js' 2>/dev/null); do
    [ "$p" = "$$" ] && continue
    exe=$(readlink -f "/proc/$p/exe" 2>/dev/null)
    case "${exe##*/}" in node|nodejs) echo "$p" ;; esac
  done
}

ALL=$(app_pids)
COUNT=$(printf '%s\n' "$ALL" | grep -c . || true)
PID=$(printf '%s\n' "$ALL" | head -1)

# More than one means an earlier restart left something behind, and they are
# fighting over the port. Say so — silently inheriting the settings of whichever
# happens to have the lowest pid is how a restart quietly changes the passcode.
if [ "${COUNT:-0}" -gt 1 ]; then
  echo "WARNING: $COUNT app servers are running (pids: $(echo $ALL))."
  echo "         All will be stopped; settings are taken from pid $PID."
fi

# Carried forward from the running process rather than re-supplied. Anything not
# listed here goes back to its default on restart, which is only safe because
# these are the settings whose defaults are wrong rather than merely different.
CARRY="EXPLORER_PASSCODE CSB_RPC_URL PORT DEMO_PORT COOKIE_SECURE SCOPED_RPC_SECRET
       CSB_DEPLOYMENTS_FILE CSB_RPC_TOKENS_FILE CSB_RPC_REVOKED_FILE"

declare -a ENVARGS=()
if [ -n "$PID" ]; then
  DIR=$(readlink "/proc/$PID/cwd" 2>/dev/null)
  echo "Running server: pid $PID"
  echo "Its directory:  ${DIR:-unknown}"
  for v in $CARRY; do
    # sed rather than grep|cut: a value containing '=' must survive intact.
    val=$(tr '\0' '\n' < "/proc/$PID/environ" 2>/dev/null | sed -n "s/^$v=//p" | head -1)
    [ -n "$val" ] && ENVARGS+=("$v=$val")
  done
  # Names only. Printing EXPLORER_PASSCODE to a terminal is how a shared secret
  # ends up in a scrollback, a screenshot, or a pasted bug report.
  echo "Carrying over:  ${ENVARGS[*]%%=*}"
  [ -n "${DIR:-}" ] && [ -d "$DIR" ] && cd "$DIR"
else
  echo "No app server running — starting a fresh one from $PWD."
  echo "It will use default settings, INCLUDING the default passcode."
fi

# Only fill in the RPC URL if the old process had none to give.
if ! printf '%s\n' "${ENVARGS[@]:-}" | grep -q '^CSB_RPC_URL='; then
  # shellcheck disable=SC1091
  source ops/csb-env.sh >/dev/null 2>&1 || true
  [ -n "${CSB_RPC_URL:-}" ] && ENVARGS+=("CSB_RPC_URL=$CSB_RPC_URL")
fi

echo "Serving from:   $PWD"
echo "Commit:         $(git -C "$PWD" log --oneline -1 2>/dev/null || echo 'not a git checkout')"

for p in $(app_pids); do kill "$p" 2>/dev/null; done
for _ in 1 2 3 4 5; do [ -z "$(app_pids)" ] && break; sleep 1; done
# Anything still alive after five seconds of SIGTERM is not going to stop politely.
for p in $(app_pids); do kill -9 "$p" 2>/dev/null; done

nohup env "${ENVARGS[@]}" node app/server.js > "$LOG" 2>&1 &
NEW=$!
echo "Started pid $NEW, logging to $LOG"

# Report on the port it actually chose, not the one we assume.
PORT_USED=$(printf '%s\n' "${ENVARGS[@]}" | sed -n 's/^\(PORT\|DEMO_PORT\)=//p' | head -1)
PORT_USED="${PORT_USED:-8080}"
for i in $(seq 1 "$WAIT"); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT_USED/" 2>/dev/null)
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    echo "App server answering on :$PORT_USED (HTTP $code)"
    exit 0
  fi
  sleep 1
done

echo "No reply on :$PORT_USED after ${WAIT}s. Last lines of $LOG:" >&2
tail -20 "$LOG" >&2
exit 1
