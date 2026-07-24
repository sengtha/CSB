# CSB deployment status — Fuji testnet

**Status:** LIVE on Avalanche Fuji · redeployed 2026-07-24 on a fresh VM (the previous chain was retired after a single-validator restart wedged it). **Wallet KHRt transfer verified working end-to-end.**

This is the running record of the CSB testnet: what exists, where, and how to operate it. Public identifiers and contract addresses only — **no private keys or passcodes live in this file** (those are in `~/.avalanche-cli/key/`, `app/deployments.json`, and the operator's env, all off-repo).

## Chain identity

| | |
|---|---|
| Network | Avalanche **Fuji** (testnet) |
| EVM Chain ID | **8555** (`0x216b`) |
| Subnet ID | `FWHGBo9oxEN6HEsFp6Ajm5BMGihoKMfXk81t7zFirhAUybJxw` |
| Blockchain ID | `mHu6H4FQ3K6fCmmHsingG2t8y5wiVvvrEZXpS25ZhodU8gdz3` |
| VM ID | `koLRzStcoE4fZ6V1DtXJCYMVWctdrdfpR6Y5egzFbURXRSvVv` |
| Validator Manager | V2 PoA, owned by the deployer key (Governing-Council slot in production) |
| Native token | **tRIEL** (1,000,000 allocated to the deployer at genesis) |
| Gas | constant, non-zero price; pilot accounts are funded with tRIEL at seed time so they can pay it. Set gas free later via the feeManager precompile (`minBaseFee` → 0) if the free-gas model is wanted. |
| Version pair | AvalancheGo **v1.14.1** / Subnet-EVM **v0.8.0** (both plugin protocol 44 — the only released working pair; see `docs/create-testnet.md`) |
| Local RPC | `http://127.0.0.1:9650/ext/bc/mHu6H4FQ3K6fCmmHsingG2t8y5wiVvvrEZXpS25ZhodU8gdz3/rpc` |

## Infrastructure

| | |
|---|---|
| Host | Elestio VM (host `cicd-upecy-u70984`; repo at `/opt/csb`, Ubuntu, Docker) |
| Bootstrap validator | avalanche-cli local node **cluster `csb-local-node-fuji`**, `NodeID-HtEKUn7oq7ArkzRFW9km6j5Fgm4pcMrLU`, ports 9650 (API, localhost) / 9651 (P2P). **This is the chain's only registered L1 validator — always operate this cluster; never create a second one.** |
| Staking key backup | `~/csb-backup.tgz` (staker.key/crt + BLS signer + deployer key) — pulled off the VM. Losing this key = losing the only validator. |
| Docker validator (node #2) | not yet deployed on this VM (`docker-compose.validator.yml`, ports 9652/9653) — register it to remove the single-validator risk |
| App server | `app/server.js` on port **8080** (gated wallet/explorer/admin), passcode via `EXPLORER_PASSCODE` env |
| Deployer / admin key | `csb-deployer` → **`0x8f6aE9fB0993C8691D7FCDFBFC79fbcF5A7BFa8b`** — precompile admin, contract deployer, KHRt issuer, validator-manager owner. **TESTNET ONLY — never reuse on mainnet.** |

## Precompiles (all admin = deployer address)

| Precompile | Address | Purpose |
|---|---|---|
| Transaction Allow List | `0x0200000000000000000000000000000000000002` | Chain-level KYC gate — only enabled addresses transact |
| Contract Deployer Allow List | `0x0200000000000000000000000000000000000000` | Only vetted addresses deploy contracts |
| Fee Manager | `0x0200000000000000000000000000000000000003` | Live fee config; used to set gas free |
| Native Minter | `0x0200000000000000000000000000000000000001` | Administrative tRIEL minting |
| Warp | (activates ICM) | Interchain messaging / ACP-77 L1 |

## Deployed contracts (CSB suite)

Recorded in `app/deployments.json`. Addresses on the CSB chain:

| Contract | Address |
|---|---|
| IdentityRegistry | `0xcefED86aEA46cb5d772365D98a9980a36040A4AD` |
| EnforcementRegistry | `0x501B9BEcC2cAE831C547F961e5D84D832793BDb7` |
| KHRStablecoin (KHRt) | `0xE3Fa15A625Ba66D69A683E42b78a993770320799` |
| EgressGateway | `0x8c6bB6291214210eba9387befF03E725323df925` |
| MockBridgeAdapter | `0x067322daE120a142c37B2CC36868Ae71F306721F` |

Interop (deployed by avalanche-cli):

| | Address |
|---|---|
| ICM Messenger (Teleporter) | `0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf` |
| ICM Registry | `0xD1760194F90e8265e4F269Ab19725A338484eE80` |

Roles at deploy time all point to the deployer (pilot mode): council, identity authority, enforcer, issuer. In production these become distinct institutional multisigs.

## Pilot accounts (seeded — keys in `app/deployments.json`, DEV ONLY)

| Name | Address | Tier | txAllowList |
|---|---|---|---|
| Sokha | `0xF0c9A393d750dB423a2a055944Ea54f692107Ad2` | 2 (full KYC) | enabled |
| Dara | `0xAF391010ad7c4628ab06C11296efE03350E830b9` | 1 (capped) | enabled |
| Vanna | `0xa78cB3F68aD3A91A2960688c3cD93e9aD0bE679e` | none | not enabled (rejection cases) |

## What works today

- Chain producing blocks; RPC answers `eth_chainId` = `0x216b`.
- Free gas (minBaseFee 0) — a governance action through feeManager.
- Full contract suite live; Sokha/Dara KYC-active and txAllowList-enabled.
- Gated app UI (explorer/wallet/admin) serving the live chain on :8080.
- ICM + relayer running (relayer funded ~0.25 AVAX on C-Chain for CSB→C-Chain delivery).

## Operate it

```bash
# --- on the VM ---
export PATH=$PATH:$HOME/bin
export RPC=http://127.0.0.1:9650/ext/bc/mHu6H4FQ3K6fCmmHsingG2t8y5wiVvvrEZXpS25ZhodU8gdz3/rpc

# chain alive?
curl -s -X POST -H 'content-type:application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' $RPC

# (re)start the app server
pkill -f 'app/server.js'; cd ~/csb
EXPLORER_PASSCODE=<your-passcode> CSB_RPC_URL=$RPC nohup node app/server.js > /tmp/app.log 2>&1 &

# fund pilot accounts with native tRIEL so the wallet "Send payment" works
# (they hold KHRt but need tRIEL to pay gas — see Troubleshooting below):
CSB_RPC_URL=$RPC CSB_CHAIN_ID=8555 CSB_DEPLOYER_KEY=<deployer-key> \
  npx hardhat run scripts/fund-native.js --network csbRemote

# after a VM reboot, the bootstrap node must be restarted.
# IMPORTANT: the correct cluster is 'csb-local-node-fuji' (NodeID-HtEKUn7…, the
# registered L1 validator, port 9650). Do NOT start/track the 'csb' cluster —
# it is a decoy with a different NodeID that can never bootstrap the L1.
avalanche node local status csb-local-node-fuji
avalanche node local start csb-local-node-fuji
```

Browser access: `https://csb-u70984.vm.elestio.app` (passcode-gated). **Easiest login: visit the page with the passcode in the URL once** — `https://csb-u70984.vm.elestio.app/explorer.html?pw=<passcode>` — it sets the session cookie and redirects (no form field). The passcode box also works. For a shared HTTPS link, front port 8080 with a TLS reverse proxy — see `docs/ssl.md` (Elestio proxy or Caddy), then relaunch the app with `COOKIE_SECURE=1`.

## Next steps (testnet checklist continues)

1. Register the Docker validator as node #2 — redundancy + "validator added" rehearsal. Open 9653/tcp in Elestio firewall, `docker compose -f docker-compose.validator.yml up -d --build`, then `avalanche blockchain addValidator csb --fuji` with its NodeID.
2. Real ICTT egress to Fuji C-Chain (`docs/fuji-ictt.md`) — first token across the governed gateway onto a public chain.
3. Remaining rehearsals: freeze/confiscate, validator remove, fee raise/lower (partly done), backup restore, coordinated upgrade.
4. Invite an external validator operator using `docs/validator-manual.md`.

## Backups (keep off the VM)

- `~/.avalanche-cli/key/csb-deployer.pk` — chain root authority.
- `app/deployments.json` — contract addresses + pilot keys.
- **Bootstrap validator staking identity** — `~/.avalanche-cli/local/csb-local-node-fuji/NodeID-HtEKUn7…/staking/staker.key` + `staker.crt`. This key **is** the L1's single validator; lose it and the chain cannot reach quorum to bootstrap or to register a replacement. Back it up off the VM. (This is exactly what went wrong once: a stop/start landed on a *different* cluster with a new NodeID, and the L1 sat at "0% stake connected / context deadline exceeded" until the original cluster was restarted.)
- (validator identity) `csb_avalanchego-staking` Docker volume, once node #2 is registered.

## Troubleshooting

**Wallet "Send payment" does nothing / fails with an insufficient-funds error.**
The pilot accounts (Sokha/Dara) were seeded with KHRt but no native **tRIEL**.
Every EVM transaction — including a KHRt transfer — makes the node reserve
`maxFeePerGas × gasLimit` from the sender's *native* balance up front, and the
effective gas price on this chain is not actually zero (setting the fee floor to
0 does not force the node's fee suggestion to 0). With 0 tRIEL the transfer
reverts before it runs. Fix: give the accounts a little tRIEL with the Native
Minter (deployer is admin):

```bash
export PATH=$PATH:$HOME/bin
export RPC=http://127.0.0.1:9650/ext/bc/mHu6H4FQ3K6fCmmHsingG2t8y5wiVvvrEZXpS25ZhodU8gdz3/rpc
cd ~/csb
CSB_RPC_URL=$RPC CSB_CHAIN_ID=8555 CSB_DEPLOYER_KEY=<deployer-key> \
  npx hardhat run scripts/fund-native.js --network csbRemote
```

Then reload the wallet and send again. (`scripts/seed-accounts.js` now funds
native gas at seed time too, so future deployments won't hit this.)

**A transaction (or `fund-native.js`) hangs and never confirms.** After the fee
floor is set to 0, this chain's *effective* base fee still jumps well above it
(Subnet-EVM block gas cost — ~170 gwei observed), and ethers' automatic fee
estimate can under-price a tx so it sits unmined in the mempool and `wait()`
hangs forever. Both `fund-native.js` and the wallet now price transactions
explicitly, far above the current base fee (harmless — the node only charges the
real base fee), and `fund-native.js` times out after 90s instead of hanging. If
a tx is reported stuck, just re-run the script.

**Chain won't bootstrap after a restart: "context deadline exceeded" / health shows
`not connected to enough stake: connected to 0.000000%`.** The node that came up is
not the L1's registered validator (`NodeID-HtEKUn7…`). Almost always this means the
wrong avalanche-cli cluster was started — the decoy `csb` cluster (`NodeID-LSmkHG1…`,
port 9654) instead of `csb-local-node-fuji` (port 9650). Check with:

```bash
curl -s 127.0.0.1:<port>/ext/health | head -c 400   # look for disconnectedValidators / percentConnected
avalanche node local status csb-local-node-fuji
```

Fix: stop the decoy and start the real cluster.

```bash
avalanche node local stop csb                    # stop the wrong node
avalanche node local start csb-local-node-fuji   # start the real validator (9650)
```

The Docker validator container `csb-validator-1` (ports 9652/9653, auto-restart) is
harmless here and unrelated — don't kill its process (Docker just respawns it); use
`docker compose -f docker-compose.validator.yml down` if you want it stopped.

## Single-validator caveat

The chain currently has one validator (the CLI bootstrap node). If the VM reboots, the chain pauses until that node is restarted — data persists. Registering the Docker validator (step 1 above) removes this single point of failure.
