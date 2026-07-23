#!/usr/bin/env bash
#
# Creates the CSB blockchain from chain/genesis.example.json and deploys it as
# a local multi-node Avalanche network on this VM, then prints the RPC URL.
#
# avalanche-cli is interactive for some choices depending on version; accept
# the defaults for a devnet (PoA, local deploy). For a Fuji testnet deployment
# see docs/fuji-ictt.md.
#
set -euo pipefail
export PATH="$PATH:$HOME/bin"

NAME="${CSB_CHAIN_NAME:-csb}"
GENESIS="${CSB_GENESIS:-chain/genesis.example.json}"

if avalanche blockchain list 2>/dev/null | grep -q "\b${NAME}\b"; then
  echo "==> Blockchain '${NAME}' already exists, skipping create"
else
  echo "==> Creating blockchain '${NAME}' from ${GENESIS}"
  avalanche blockchain create "${NAME}" --genesis "${GENESIS}" --evm --proof-of-authority
fi

echo "==> Deploying '${NAME}' to a local network on this VM"
avalanche blockchain deploy "${NAME}" --local

echo
echo "==> Look for the RPC URL in the output above (http://127.0.0.1:9650/ext/bc/<blockchainID>/rpc)."
echo "    Export it for the contract deployment and the app server:"
echo "      export CSB_RPC_URL='http://127.0.0.1:9650/ext/bc/<blockchainID>/rpc'"
echo "      export CSB_DEPLOYER_KEY='<key of a txAllowList-admin funded account>'"
echo "    Then: npx hardhat run scripts/deploy.js --network csbRemote"
echo "          npx hardhat run scripts/seed-accounts.js --network csbRemote"
echo "          EXPLORER_PASSCODE=<passcode> node app/server.js"
