#!/usr/bin/env bash
# Redeploy the CSB contract suite WITHOUT needing a node restart.
#
#     bash ops/csb-redeploy.sh
#
# Why this exists: the node caps a transaction's total fee (rpc-tx-fee-cap,
# default 100 native units). With gas priced at 1 riel per transfer, a contract
# deployment (~2.1M gas) costs slightly more than 100 tRIEL and is refused. The
# durable fix is chain config + restart (ops/csb-chain-config.sh), but restarting
# this cluster is not something to do casually and the config path can vary by
# avalanche-cli version.
#
# So: drop the gas price for the duration of the deployment, deploy, put it back.
# Nothing about the fee POLICY changes — only what the chain charges during these
# few minutes, and it is restored at the end (including if a step fails).
#
# Order matters in a way that is easy to get wrong, which is the main reason this
# is a script rather than a list of commands:
#   * lower the FLOOR first, while the old high gasPrice is still valid
#   * only then lower the gasPrice the scripts submit at
#   * on the way back, raise the gasPrice BEFORE raising the floor, or the
#     restoring transaction is itself under-priced and never mines
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source ops/csb-env.sh

HIGH_PRICE="${CSB_GAS_PRICE_WEI:-55000000000000}"   # ~55,000 gwei, the normal setting
NORMAL_TRIEL="${CSB_GAS_TRIEL_NORMAL:-1}"           # the policy to restore

# Only a MODEST reduction. Lowering minBaseFee moves the floor, but the fee
# actually charged decays toward it a few percent per block — and blocks are only
# produced when transactions arrive. Ask for a 95% cut and the base fee needs
# ~100 blocks to get there while nothing is producing them, so every deployment
# hangs under-priced forever. A 10% cut needs a handful of blocks, which the
# settle step below produces deliberately.
CHEAP_TRIEL="${CSB_CHEAP_TRIEL:-0.9}"               # 0.9 riel → floor ~42,857 gwei
CHEAP_PRICE="${CSB_CHEAP_PRICE_WEI:-44000000000000}" # 44,000 gwei: above that floor,
                                                     # and 2.1M gas = 92.7 tRIEL < 100 cap
SETTLE_GWEI="${CSB_SETTLE_GWEI:-44000}"

restore() {
  echo
  echo "─── Restoring the ${NORMAL_TRIEL} riel gas policy ───"
  # gasPrice first: the transaction that raises the floor must be priced for the
  # floor it is about to create.
  export CSB_GAS_PRICE_WEI="$HIGH_PRICE"
  CSB_GAS_TRIEL="$NORMAL_TRIEL" npx hardhat run scripts/set-gas-price.js --network csbRemote || {
    echo "!! FAILED to restore the gas price. The chain is left cheap." >&2
    echo "   Fix manually:" >&2
    echo "     export CSB_GAS_PRICE_WEI=$HIGH_PRICE" >&2
    echo "     CSB_GAS_TRIEL=$NORMAL_TRIEL npx hardhat run scripts/set-gas-price.js --network csbRemote" >&2
    return 1
  }
}
trap restore EXIT

echo "─── Temporarily lowering gas so deployments fit under the node's fee cap ───"
CSB_GAS_TRIEL="$CHEAP_TRIEL" npx hardhat run scripts/set-gas-price.js --network csbRemote

# Lowering the floor is not enough: the CURRENT base fee has to come down too,
# and it only decays as blocks are produced. Make some.
echo
echo "─── Letting the current base fee decay to the new floor ───"
if ! CSB_TARGET_GWEI="$SETTLE_GWEI" npx hardhat run scripts/settle-base-fee.js --network csbRemote; then
  cat >&2 <<'WHY'

The base fee did not come down to the target, so this whole approach cannot work
on this chain: deployments would be submitted under-priced and hang forever.

Observed on CSB: the base fee stays pinned at its original value no matter what
minBaseFee is lowered to, and no matter how many blocks are produced. Lowering
the fee therefore does NOT make a deployment cheaper here, which is the entire
premise of this script.

Use the node-config route instead — it lifts the cap directly and leaves the
1-riel policy alone:

    ps -eo args= | grep -o -- '--chain-config-dir[= ][^ ]*'   # find the real path
    CSB_CHAIN_CONFIG_DIR=<that path> bash ops/csb-chain-config.sh --restart

WHY
  exit 1
fi

export CSB_GAS_PRICE_WEI="$CHEAP_PRICE"

echo
echo "─── Deploying the contract suite ───"
npx hardhat run scripts/deploy.js --network csbRemote

echo
echo "─── Seeding pilot accounts ───"
npx hardhat run scripts/seed-accounts.js --network csbRemote

echo
echo "─── Re-enabling the public-good levy ───"
npx hardhat run scripts/enable-charity-levy.js --network csbRemote

if [ "${CSB_WITH_DEMOS:-1}" = "1" ]; then
  echo
  echo "─── Use-case contracts (ID Poor, land title) ───"
  npx hardhat run scripts/demo-idpoor.js --network csbRemote || echo "  (ID Poor demo failed — see above)"
  npx hardhat run scripts/demo-land.js --network csbRemote || echo "  (land demo failed — see above)"
fi

# restore() runs here via the EXIT trap
echo
echo "Done. Verify with:"
echo "    npx hardhat run scripts/verify-policy.js --network csbRemote"
echo "    npx hardhat run scripts/fund-report.js   --network csbRemote"
