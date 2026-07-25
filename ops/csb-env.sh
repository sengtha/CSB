# CSB operator environment — SOURCE this, don't run it:
#
#     source ~/csb/ops/csb-env.sh
#
# Sets everything the hardhat admin scripts need, so commands become just:
#
#     npx hardhat run scripts/set-reward-address.js --network csbRemote
#
# The deployer key is read from the avalanche-cli keystore on this machine and
# never typed, pasted, or echoed. Keep it that way: it is the chain's root
# authority (precompile admin, KHRt issuer, validator-manager owner), so
# anywhere it gets pasted — a chat window, a shell history, a log, a commit —
# is somewhere it has to be rotated from.

# Refuse to run as a script: exports would vanish with the subshell and the
# caller would be left wondering why nothing was set.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "This file must be SOURCED, not executed:" >&2
  echo "    source ${BASH_SOURCE[0]}" >&2
  exit 1
fi

export PATH="$PATH:$HOME/bin"

# Repo root, derived from this file's own location rather than assumed — the
# checkout lives at /opt/csb on the Elestio VM but ~/csb elsewhere.
CSB_HOME="${CSB_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export CSB_HOME

# --- chain -----------------------------------------------------------------
CSB_BLOCKCHAIN_ID="${CSB_BLOCKCHAIN_ID:-299jCTH4ErmwFMB3ZKa18Ck9EDzc99DMD48zkszxcArpaUfTqW}"
export CSB_RPC_URL="${CSB_RPC_URL:-http://127.0.0.1:9650/ext/bc/$CSB_BLOCKCHAIN_ID/rpc}"
export CSB_CHAIN_ID="${CSB_CHAIN_ID:-8555}"

# Must stay ABOVE the chain's minBaseFee or scripts submit transactions that
# never mine — which looks exactly like the chain being wedged. Under the
# ~1 tRIEL-per-payment policy the floor is ~47,619 gwei; this is ~15% above.
export CSB_GAS_PRICE_WEI="${CSB_GAS_PRICE_WEI:-55000000000000}"

# --- deployer key ----------------------------------------------------------
CSB_KEY_FILE="${CSB_KEY_FILE:-$HOME/.avalanche-cli/key/csb-deployer.pk}"
CSB_EXPECT_ADDR="${CSB_EXPECT_ADDR:-0x8f6aE9fB0993C8691D7FCDFBFC79fbcF5A7BFa8b}"

if [ ! -r "$CSB_KEY_FILE" ]; then
  echo "csb-env: cannot read $CSB_KEY_FILE" >&2
  echo "csb-env: set CSB_KEY_FILE to the deployer key, or run 'avalanche key list' to find it." >&2
else
  _csb_key=$(tr -d ' \t\n\r' < "$CSB_KEY_FILE" | sed 's/^0[xX]//')
  if ! printf '%s' "$_csb_key" | grep -qE '^[0-9a-fA-F]{64}$'; then
    echo "csb-env: $CSB_KEY_FILE does not contain a 32-byte hex private key — not exporting." >&2
  else
    export CSB_DEPLOYER_KEY="0x$_csb_key"
  fi
  unset _csb_key
fi

# --- confirm we loaded the key we think we did -----------------------------
# Deriving the address catches a wrong or stale keystore file BEFORE it is used
# to send an admin transaction, which is the cheap moment to catch it.
if [ -n "${CSB_DEPLOYER_KEY:-}" ] && [ -d "$CSB_HOME/node_modules/ethers" ]; then
  _csb_addr=$(cd "$CSB_HOME" && node -e '
    const { Wallet } = require("ethers");
    process.stdout.write(new Wallet(process.env.CSB_DEPLOYER_KEY).address);
  ' 2>/dev/null)
  if [ -n "$_csb_addr" ]; then
    if [ "${_csb_addr,,}" = "${CSB_EXPECT_ADDR,,}" ]; then
      echo "csb-env: deployer $_csb_addr ✓"
    else
      echo "csb-env: ⚠ key in $CSB_KEY_FILE derives $_csb_addr," >&2
      echo "csb-env:   but the recorded deployer is $CSB_EXPECT_ADDR." >&2
      echo "csb-env:   Admin calls will fail on permission checks. Check the keystore." >&2
    fi
  fi
  unset _csb_addr
fi

echo "csb-env: RPC $CSB_RPC_URL"
echo "csb-env: chain $CSB_CHAIN_ID · gasPrice $CSB_GAS_PRICE_WEI wei"
