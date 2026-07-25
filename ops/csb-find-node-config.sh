#!/usr/bin/env bash
# Report where this node ACTUALLY reads configuration from — read-only.
#
#     bash ops/csb-find-node-config.sh
#
# Written after several rounds of guessing the layout. A chain config written to
# a path the node does not read behaves exactly like a setting that has no
# effect, so the only way to stop guessing is to look at the running process and
# the directories it was given.
#
# Nothing here changes anything. Paste the output and the config can be placed
# correctly the first time.
set -uo pipefail

echo "=============== avalanchego processes ==============="
if ! ps -eo pid,args= 2>/dev/null | grep -i '[a]valanchego' | head -5; then
  echo "(none found by name — trying a broader match)"
  ps -eo pid,args= 2>/dev/null | grep -iE '[a]valanche|[s]ubnet-evm' | head -5
fi

echo
echo "=============== flags that matter ==============="
# --data-dir usually implies the chain-config location; --config-file may set it.
for flag in chain-config-dir data-dir config-file db-dir plugin-dir; do
  hits=$(ps -eo args= 2>/dev/null | grep -o -- "--$flag[= ][^ ]*" | sort -u)
  if [ -n "$hits" ]; then printf '%s\n' "$hits"; else echo "--$flag  (not passed)"; fi
done

echo
echo "=============== avalanche-cli cluster dirs ==============="
for root in "$HOME/.avalanche-cli/local"/*; do
  [ -d "$root" ] || continue
  echo "$root"
  for n in "$root"/NodeID-*; do
    [ -d "$n" ] || continue
    echo "  $(basename "$n")"
    # Top-level layout of one node, which is where config would live.
    find "$n" -maxdepth 1 -mindepth 1 -printf "    %f%s\n" 2>/dev/null | sed 's/[0-9]*$//' | head -12
  done
done

echo
echo "=============== every config.json under the cluster ==============="
# If avalanche-cli already writes chain configs anywhere, the pattern shows here
# and is far more trustworthy than any assumption about the layout.
find "$HOME/.avalanche-cli/local" -name 'config.json' -o -name 'chain.json' 2>/dev/null \
  | head -30 | while read -r f; do
      echo "--- $f"
      head -c 400 "$f" 2>/dev/null; echo
    done

echo
echo "=============== default location, if unset ==============="
echo "AvalancheGo defaults chain config to <data-dir>/configs/chains,"
echo "and <data-dir> defaults to \$HOME/.avalanchego"
echo "so the fallback path would be: $HOME/.avalanchego/configs/chains/<blockchainID>/config.json"
ls -la "$HOME/.avalanchego/configs/chains" 2>/dev/null || echo "(no $HOME/.avalanchego/configs/chains)"
