# Deploying CSB on a cloud VM

Runs the full stack — Avalanche L1 devnet, contract suite, and the gated app server — on a single cloud VM (any provider: AWS, GCP, Azure, DigitalOcean, a Cambodian government data center, …).

**VM requirements:** Ubuntu 22.04/24.04, 4+ vCPU, 8+ GB RAM, 100 GB SSD, ports **22** and **8080** reachable (nothing else needs to be public).

## 1. Bootstrap

```bash
git clone <repo-url> csb && cd csb
bash infra/setup-vm.sh
```

Installs Node 22, avalanche-cli, project dependencies, and configures ufw (SSH + 8080 only — the node RPC on 9650 stays private; the app server proxies chain access behind its passcode gate).

## 2. Stand up the Avalanche L1

```bash
bash infra/deploy-l1.sh
```

Creates the `csb` blockchain from `chain/genesis.example.json` (zero fees, txAllowList/deployer-allowlist/feeManager/nativeMinter precompiles) and deploys a multi-node local Avalanche network on the VM. The CLI prints the RPC URL and the funded devnet key for the genesis admin address.

Two genesis notes before creating:

- Replace the `0xC0DE...` placeholder admin/alloc addresses with the key you will actually deploy from (for a quick devnet, use the ewoq test key avalanche-cli offers, adding its address to the allowlist admins and `alloc`).
- On this chain **only txAllowList-admitted addresses can transact at all**. The deployer must be a txAllowList admin; pilot accounts created by the seed script must be enabled through the precompile (`0x0200000000000000000000000000000000000002`) before they can transact — avalanche-cli's default genesis tooling and the precompile's `setEnabled(address)` handle this.

## 3. Deploy and seed the contracts

```bash
export CSB_RPC_URL='http://127.0.0.1:9650/ext/bc/<blockchainID>/rpc'
export CSB_DEPLOYER_KEY='<devnet admin key>'
npx hardhat run scripts/deploy.js --network csbRemote
npx hardhat run scripts/seed-accounts.js --network csbRemote
```

Writes `app/deployments.json` (contract addresses; the optional seed step adds pilot account keys — devnet only, never reuse).

## 4. Start the app server

```bash
EXPLORER_PASSCODE='<choose-a-passcode>' CSB_RPC_URL="$CSB_RPC_URL" node app/server.js
```

Open `http://<vm-ip>:8080` — Wallet, Explorer, and Admin console, all behind the access gate. To keep it running: `nohup … &`, or a systemd unit:

```ini
# /etc/systemd/system/csb-app.service
[Unit]
Description=CSB app server
After=network.target
[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/csb
Environment=CSB_RPC_URL=http://127.0.0.1:9650/ext/bc/<blockchainID>/rpc
Environment=EXPLORER_PASSCODE=change-me
ExecStart=/usr/bin/node app/server.js
Restart=on-failure
[Install]
WantedBy=multi-user.target
```

## 5. Quick smoke test without an Avalanche node

To exercise contracts + UIs with plain Hardhat (no avalanche-cli, no precompiles):

```bash
npx hardhat node &                                     # local EVM on :8545
npx hardhat run scripts/deploy.js --network localhost
npx hardhat run scripts/seed-accounts.js --network localhost
EXPLORER_PASSCODE=csb-demo node app/server.js         # defaults to :8545 upstream
```

Same UIs, same flows; only the chain-level allowlist/zero-fee behavior needs the real L1.

## Security posture (pilot vs production)

| Concern | Pilot | Production |
|---|---|---|
| Explorer access | shared passcode + cookie | national digital-ID login, per-user audit |
| RPC exposure | private, proxied by app server | authenticated RPC tier per institution |
| Keys | env vars / JSON on VM | HSMs + institutional multisigs |
| TLS | none (add Caddy/nginx for internet access) | mandatory, government PKI |
| Node topology | all nodes on one VM | one validator per ministry, separate data centers |
