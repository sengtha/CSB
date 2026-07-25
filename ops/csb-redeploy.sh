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
CHEAP_TRIEL="${CSB_CHEAP_TRIEL:-0.05}"              # temporary: 0.05 riel per transfer
CHEAP_PRICE="${CSB_CHEAP_PRICE_WEI:-3000000000000}" # ~3,000 gwei, above the cheap floor
NORMAL_TRIEL="${CSB_GAS_TRIEL_NORMAL:-1}"           # the policy to restore

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
