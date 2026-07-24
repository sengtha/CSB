# CSB deployment status — Fuji testnet

**Status:** LIVE on Avalanche Fuji · first deployed 2026-07-24.

This is the running record of the CSB testnet: what exists, where, and how to operate it. Public identifiers and contract addresses only — **no private keys or passcodes live in this file** (those are in `~/.avalanche-cli/key/`, `app/deployments.json`, and the operator's env, all off-repo).

## Chain identity

| | |
|---|---|
| Network | Avalanche **Fuji** (testnet) |
| EVM Chain ID | **8555** (`0x216b`) |
| Subnet ID | `xreFEw7ZXFxZT2LbRDAJYYegp5HUA4NQoPJN5DYHT1v9tzsBr` |
| Blockchain ID | `2s8QnZT5RNuoN4hvZDcmD787kcApP7tH97QtDUVN9atkxh3VSv` |
| VM ID | `koLRzStcoE4fZ6V1DtXJCYMVWctdrdfpR6Y5egzFbURXRSvVv` |
| Validator Manager | V2 PoA, owned by the deployer key (Governing-Council slot in production) |
| Native token | **tRIEL** (1,000,000 allocated to the deployer at genesis) |
| Gas | **free** — `minBaseFee` set to 0 post-launch via the feeManager precompile |
| Version pair | AvalancheGo **v1.14.1** / Subnet-EVM **v0.8.0** |
| Local RPC | `http://127.0.0.1:9650/ext/bc/2s8QnZT5RNuoN4hvZDcmD787kcApP7tH97QtDUVN9atkxh3VSv/rpc` |

## Infrastructure

| | |
|---|---|
| Host | Elestio VM `csb-u70984.vm.elestio.app` (Ubuntu, Docker) |
| Bootstrap validator | avalanche-cli local node, `NodeID-M7ag4B7H1C4eFodbi4TwpAoqJh7LEux2s`, ports 9650 (API, localhost) / 9651 (P2P) |
| Docker validator (node #2) | planned — `docker-compose.validator.yml`, ports 9652/9653, not yet registered |
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
| ICM Registry | `0x5553a322AEe46c699d209515888EC46d9d29C520` |

Roles at deploy time all point to the deployer (pilot mode): council, identity authority, enforcer, issuer. In production these become distinct institutional multisigs.

## Pilot accounts (seeded — keys in `app/deployments.json`, DEV ONLY)

| Name | Address | Tier | txAllowList |
|---|---|---|---|
| Sokha | `0xA6a811005546ca065D2d7e36ce0f1DFC0cc4Ed87` | 2 (full KYC) | enabled |
| Dara | `0x38db7a65068bC779a7BfAC16E634e8052b910676` | 1 (capped) | enabled |
| Vanna | `0x4Cd4aC34879BD48f134aa4C59fcdC9076171ed0f` | none | not enabled (rejection cases) |

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
export RPC=http://127.0.0.1:9650/ext/bc/2s8QnZT5RNuoN4hvZDcmD787kcApP7tH97QtDUVN9atkxh3VSv/rpc

# chain alive?
curl -s -X POST -H 'content-type:application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' $RPC

# (re)start the app server
pkill -f 'app/server.js'; cd ~/csb
EXPLORER_PASSCODE=<your-passcode> CSB_RPC_URL=$RPC nohup node app/server.js > /tmp/app.log 2>&1 &

# after a VM reboot, the bootstrap node must be restarted:
avalanche node local start csb-local-node-fuji   # (name may vary; see `avalanche node local list`)
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
- (validator identity) `csb_avalanchego-staking` Docker volume, once node #2 exists.

## Single-validator caveat

The chain currently has one validator (the CLI bootstrap node). If the VM reboots, the chain pauses until that node is restarted — data persists. Registering the Docker validator (step 1 above) removes this single point of failure.
