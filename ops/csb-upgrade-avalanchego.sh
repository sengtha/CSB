#!/usr/bin/env bash
#
# Move a local avalanche-cli cluster onto a new avalanchego release, in place,
# without destroying it.
#
#     bash ops/csb-upgrade-avalanchego.sh            # print the plan, change nothing
#     APPLY=1 bash ops/csb-upgrade-avalanchego.sh    # do it
#
# WHY THIS EXISTS AND THE CLI CANNOT DO IT.
#
# Fuji enforces a version floor. avalanchego v1.15.0-fuji set
# MinimumCompatibleVersion to 1.15.0 and gave every Fuji node until 11 AM ET on
# 28 July 2026 to upgrade. Nodes below the floor are not slow or partitioned —
# their peers refuse the handshake, so the whole Primary Network validator set
# lands in the P-Chain health check's disconnectedValidators, the P-Chain never
# bootstraps, and an L1 that tracks Fuji can never learn its own validator set.
# CSB went dark on 28 July 2026 for exactly this reason, five days before anyone
# looked. See docs/architecture.md §2.
#
# `avalanche node local start --custom-avalanchego-version` does not fix it. Once
# the cluster directory exists, that command takes the RESUME path — it relaunches
# from the runtime config stored inside the cluster, and the version flag is parsed
# and then ignored. The stored path is what has to change, and that is what this
# script changes.
#
# Two binaries move together, not one. v1.15.0 raised RPCChainVMProtocol from 44
# to 46, so the old subnet-evm plugin will not load against it: upgrade avalanchego
# alone and the node comes up healthy with CSB dead underneath it. Since
# ava-labs/subnet-evm was archived on 16 December 2025 at v0.8.0 / protocol 44,
# there is no newer standalone release to fetch — subnet-evm now lives inside
# avalanchego at graft/subnet-evm and ships as an asset of the SAME release. So
# both halves come from one tag and are version-locked by construction.
#
# And avalanche-cli entered maintenance mode in December 2025 at v1.9.6, which is
# the last version there will be. It still models subnet-evm as a separately
# versioned download and its compatibility cache tops out at v1.14.0, so it cannot
# resolve this stack at all. Hence a script instead of a command.
#
# WHAT IT DOES NOT DO. It never calls `avalanche node local destroy`, never writes
# under db/ or chainData/, and never deletes the old install — the previous version
# directory is left intact. It takes a one-time pristine backup of every config file
# it edits and refuses to overwrite that backup on later runs, so the original is
# always recoverable no matter how many times this is run.
#
# ONE-WAY DOOR. A new avalanchego opening old databases may migrate them, after
# which the old binary can no longer read them. When the network has already forked
# past you there is nothing to roll back TO, so this is usually academic — but it is
# the reason the plan is printed before anything is applied.
#
# Environment, all optional:
#   CSB_AVAGO_VERSION  release tag to install            (default v1.15.0-fuji)
#   CSB_CLUSTER        cluster name                (default csb-local-node-fuji)
#   CSB_CLI_HOME       avalanche-cli home              (default ~/.avalanche-cli)
#   CSB_UPGRADE_SRC    where the tarballs were downloaded  (default /tmp/csb-upgrade)
#   APPLY=1            actually make the changes

set -euo pipefail

VER="${CSB_AVAGO_VERSION:-v1.15.0-fuji}"
CLUSTER="${CSB_CLUSTER:-csb-local-node-fuji}"
CLI_HOME="${CSB_CLI_HOME:-$HOME/.avalanche-cli}"
SRC="${CSB_UPGRADE_SRC:-/tmp/csb-upgrade}"
APPLY="${APPLY:-0}"

NET_DIR="$CLI_HOME/local/$CLUSTER"
NEW_DIR="$CLI_HOME/bin/avalanchego/avalanchego-$VER"
NEW_BIN="$NEW_DIR/avalanchego"
NEW_PLUGINS="$NEW_DIR/plugins"

say() { printf '%s\n' "$*"; }
die() { printf 'csb-upgrade: %s\n' "$*" >&2; exit 1; }

command -v python3 >/dev/null || die "python3 is needed to edit the JSON safely."
[ -d "$NET_DIR" ] || die "no cluster at $NET_DIR"

# A running node holds the old binary and would be restarted from the old config
# halfway through the edit. Stop it properly rather than racing it.
if pgrep -x avalanchego >/dev/null 2>&1; then
  die "avalanchego is running. Stop it first:  avalanche node local stop $CLUSTER"
fi

case "$(uname -m)" in
  x86_64)        ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *)             die "unsupported architecture $(uname -m)" ;;
esac

AVAGO_TGZ="$SRC/avalanchego-linux-$ARCH-$VER.tar.gz"
SEVM_TGZ="$SRC/subnet-evm-linux-$ARCH-$VER.tar.gz"
base="https://github.com/ava-labs/avalanchego/releases/download/$VER"
for f in "$AVAGO_TGZ" "$SEVM_TGZ"; do
  [ -f "$f" ] || die "missing $f — download both halves from the same tag:
    mkdir -p $SRC && cd $SRC
    curl -fLO $base/avalanchego-linux-$ARCH-$VER.tar.gz
    curl -fLO $base/subnet-evm-linux-$ARCH-$VER.tar.gz"
done

# ---------------------------------------------------------------------------
# 1. Find what the cluster is pinned to right now.
#
# The pin is discovered rather than assumed. avalanche-cli has changed this
# layout more than once, and a hardcoded path that is subtly wrong produces a
# cluster that will not start with no useful message about why.
# ---------------------------------------------------------------------------
CONFIGS=$(find "$NET_DIR" -maxdepth 2 -name '*.json' \
            ! -path '*/db/*' ! -path '*/chainData/*' ! -path '*/logs/*' | sort)
[ -n "$CONFIGS" ] || die "no config files under $NET_DIR"

PINS=$(python3 - $CONFIGS <<'PY'
import json, os, sys

# Walk every string in every config and classify it by what it points AT, not by
# the key it sits under: the key names differ between avalanche-cli versions but
# a path ending in /avalanchego is unambiguous either way.
bins, plugs = set(), set()

def walk(v):
    if isinstance(v, dict):
        for x in v.values(): walk(x)
    elif isinstance(v, list):
        for x in v: walk(x)
    elif isinstance(v, str):
        if os.path.basename(v) == "avalanchego" and "/" in v:
            bins.add(v)
        elif v.rstrip("/").endswith("plugins"):
            plugs.add(v.rstrip("/"))

for path in sys.argv[1:]:
    try:
        with open(path) as fh: walk(json.load(fh))
    except (ValueError, OSError):
        pass

# More than one distinct value means the nodes disagree, which this script is not
# equipped to reconcile — better to stop than to guess which one is authoritative.
for name, s in (("avalanchego binary", bins), ("plugin dir", plugs)):
    if len(s) > 1:
        sys.exit(f"csb-upgrade: conflicting {name} pins: {sorted(s)}")

print(bins.pop() if bins else "-", plugs.pop() if plugs else "-")
PY
) || die "could not read the cluster config."
read -r OLD_BIN OLD_PLUGINS <<<"$PINS"

[ "${OLD_BIN:-}" != "-" ] && [ -n "${OLD_BIN:-}" ] \
  || die "could not find an avalanchego binary path in the cluster config."
OLD_DIR=$(dirname "$OLD_BIN")
# When no explicit plugin dir is configured, avalanchego defaults to plugins/
# beside the binary — mirror that so the new install gets one too.
[ "$OLD_PLUGINS" != "-" ] || OLD_PLUGINS="$OLD_DIR/plugins"

say "cluster      $CLUSTER"
say "currently    $OLD_BIN"
say "plugins      $OLD_PLUGINS"
say "installing   $NEW_BIN"
say ""

# ---------------------------------------------------------------------------
# 2. Install the new pair beside the old one.
#
# Plugin files are named by VM ID, not by VM name, so the new binary is written
# under whatever filenames the old plugin dir already used. Inventing a name here
# would leave avalanchego unable to find a VM for CSB's blockchain.
# ---------------------------------------------------------------------------
STAGE="$SRC/extract-$VER"
rm -rf "$STAGE"; mkdir -p "$STAGE/avago" "$STAGE/sevm"
tar -xzf "$AVAGO_TGZ" -C "$STAGE/avago"
tar -xzf "$SEVM_TGZ"  -C "$STAGE/sevm"

NEW_AVAGO_SRC=$(find "$STAGE/avago" -type f -name avalanchego  | head -1)
NEW_SEVM_SRC=$( find "$STAGE/sevm"  -type f -name 'subnet-evm*' | head -1)
[ -n "$NEW_AVAGO_SRC" ] || die "no avalanchego binary inside $AVAGO_TGZ"
[ -n "$NEW_SEVM_SRC" ]  || die "no subnet-evm binary inside $SEVM_TGZ"

VMIDS=$(find "$OLD_PLUGINS" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null || true)
[ -n "$VMIDS" ] || die "no plugin files in $OLD_PLUGINS — cannot tell which VM IDs to install under."

say "plugin files to replace with subnet-evm $VER:"
printf '  %s\n' $VMIDS
say ""

if [ "$APPLY" != "1" ]; then
  say "DRY RUN. Nothing has been changed. What APPLY=1 would do:"
  say "  1. install $NEW_BIN"
  say "  2. install the above VM IDs into $NEW_PLUGINS"
  say "  3. back up each cluster config once, to <file>.pristine"
  say "  4. rewrite $OLD_BIN -> $NEW_BIN"
  say "     and     $OLD_PLUGINS -> $NEW_PLUGINS"
  say "  The old install at $OLD_DIR is left untouched."
  say ""
  say "Re-run with:  APPLY=1 bash ops/csb-upgrade-avalanchego.sh"
  exit 0
fi

mkdir -p "$NEW_DIR" "$NEW_PLUGINS"
install -m 0755 "$NEW_AVAGO_SRC" "$NEW_BIN"
for id in $VMIDS; do
  install -m 0755 "$NEW_SEVM_SRC" "$NEW_PLUGINS/$id"
done
say "installed $("$NEW_BIN" --version 2>&1 | head -1)"

# ---------------------------------------------------------------------------
# 3. Repoint the cluster.
#
# The backup is taken once and never overwritten. A second run that clobbered
# .pristine with an already-edited file would quietly destroy the only copy of
# the original, which is the one thing worth protecting here.
# ---------------------------------------------------------------------------
for f in $CONFIGS; do
  [ -f "$f.pristine" ] || cp -p "$f" "$f.pristine"
done

python3 - "$OLD_BIN" "$NEW_BIN" "$OLD_PLUGINS" "$NEW_PLUGINS" $CONFIGS <<'PY'
import json, sys

old_bin, new_bin, old_plug, new_plug = sys.argv[1:5]

def sub(v):
    if isinstance(v, dict):  return {k: sub(x) for k, x in v.items()}
    if isinstance(v, list):  return [sub(x) for x in v]
    if isinstance(v, str):
        # Substring rather than equality: plugin dirs turn up embedded in
        # --plugin-dir=... style flag strings as well as on their own.
        return v.replace(old_bin, new_bin).replace(old_plug, new_plug)
    return v

for path in sys.argv[5:]:
    try:
        with open(path) as fh: doc = json.load(fh)
    except (ValueError, OSError):
        continue
    new = sub(doc)
    if new != doc:
        with open(path, "w") as fh:
            json.dump(new, fh, indent=2)
            fh.write("\n")
        print(f"  rewrote {path}")
PY

# The CLI's cached release list is what makes plain restarts resolve back to an
# old version. It is a pure cache; deleting it costs a refetch and nothing else.
rm -f "$CLI_HOME/download-cache/latest.json"

say ""
say "Done. Start it and watch the P-Chain come back:"
say "  avalanche node local start $CLUSTER"
say "  bash ops/csb-nodes.sh"
say ""
say "To undo the config change (the old binaries were never removed):"
say "  for f in \$(find $NET_DIR -maxdepth 2 -name '*.json.pristine'); do cp -p \"\$f\" \"\${f%.pristine}\"; done"
