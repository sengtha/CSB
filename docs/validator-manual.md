# CSB Testnet Validator — Operator Manual

A self-contained guide for anyone invited to run a validator on the **CSB testnet** (anchored to Avalanche Fuji). No blockchain experience is assumed; if you can operate a Linux server with Docker, you can run a validator.

> **Note:** CSB is a personal, independent experiment — not a government project (see [DISCLAIMER.md](../DISCLAIMER.md)). Running a testnet validator means participating in a research prototype, nothing more.

## 1. What you are running, and what it costs

A validator is a server that holds a copy of the CSB ledger and participates in confirming its blocks. During the testnet phase:

- **It costs you a server, not money.** No stake, no tokens to buy. The chain's registration fees on Fuji are paid by the coordinator with free test AVAX.
- **It carries no financial risk.** Everything on the testnet is test data and test riel.
- **What's expected of you:** keep the node running (aim for 24/7, but testnet downtime is not a crisis), apply upgrades when the coordinator announces them, and tell the coordinator if you stop.

**If you are the coordinator** (the person creating the chain), these IDs don't exist until you create it — follow [`docs/create-testnet.md`](create-testnet.md) first. Everyone else receives them from the coordinator (do not guess these):

| Item | Example shape |
|---|---|
| Subnet ID | `2b175hLJ…` |
| VM ID | `srEXiWa…` |
| Blockchain ID | `2oYMBNV…` |
| Version pair (AvalancheGo / Subnet-EVM) | `v1.14.1` / `0.8.0` |
| Coordinator contact | email / Telegram |

## 2. Server requirements

- Ubuntu 22.04 or 24.04 (other Linux distros work; commands below assume Ubuntu)
- 4+ vCPU, 8+ GB RAM, 100+ GB SSD
- Public IPv4 address with **TCP port 9651 open to the world** (this is how validators talk to each other)
- Docker with the compose plugin (`docker compose version` should work)

Any provider is fine — your own data center, or a cloud VM. On **Elestio**: create a VM service (Ubuntu, 4 vCPU/8 GB/100 GB; Docker comes preinstalled), then open port 9651/tcp in the service's *Security → Firewall* panel. Keep 9650 closed — the setup below already restricts it to the machine itself.

## 3. Setup (about 10 minutes of work)

```bash
# 1. Get the code
git clone <repo-url> csb && cd csb

# 2. Configure — open .env in any editor and paste the values from the coordinator
cp .env.validator.example .env
#    set: CSB_SUBNET_ID=…   CSB_VM_ID=…   AVAGO_NETWORK_ID=fuji
#    leave ports and versions at their defaults unless the coordinator says otherwise

# 3. Start the node
docker compose -f docker-compose.validator.yml up -d --build
```

The node now downloads the Fuji network state ("bootstrapping"). This takes **from ~1 hour up to a day** depending on bandwidth — this is normal. Check progress:

```bash
curl -s -X POST -H 'content-type:application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"info.isBootstrapped","params":{"chain":"P"}}' \
  http://127.0.0.1:9650/ext/info
```

`"isBootstrapped": true` means it's done.

## 4. Register your validator

Your node has a unique identity. Retrieve it:

```bash
curl -s -X POST -H 'content-type:application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"info.getNodeID"}' \
  http://127.0.0.1:9650/ext/info
```

Send the **entire JSON response** (it contains your `nodeID` and the BLS `nodePOP` proof) to the coordinator. The coordinator registers you through the chain's Validator Manager and confirms. From that point your node is validating — nothing more to do on your side.

Verify you're following the CSB chain (use the Blockchain ID you were given):

```bash
curl -s -X POST -H 'content-type:application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"info.isBootstrapped","params":{"chain":"<BlockchainID>"}}' \
  http://127.0.0.1:9650/ext/info
```

## 5. Day-to-day operation

**Health check** (bookmark this; run it if you ever wonder whether things are fine):

```bash
curl -s http://127.0.0.1:9650/ext/health | head -c 400   # "healthy":true is what you want
docker compose -f docker-compose.validator.yml logs --tail 50
df -h .                                                   # keep >20% disk free
```

**Upgrades** — only when the coordinator announces a new version pair:

```bash
cd csb && git pull
# edit .env: set the announced AVALANCHEGO_VERSION and SUBNET_EVM_VERSION
docker compose -f docker-compose.validator.yml up -d --build
```

Your validator identity and data are untouched by upgrades — they live in Docker volumes, not in the container.

**Backup your identity** (do this once after setup, keep the file somewhere safe):

```bash
docker run --rm -v csb_avalanchego-staking:/s -v $(pwd):/backup debian \
  tar -czf /backup/staking-backup.tar.gz -C /s .
```

**The two rules:**

1. **Never run `docker compose down -v`** on this machine. The `-v` deletes the volumes — that's your validator's identity. Plain `down` (without `-v`) and `up -d` are always safe.
2. **Never copy the staking keys to a second machine and run both.** Two nodes with the same identity get the validator penalized/ignored. Restore the backup only onto a *replacement* machine, after the old one is off.

## 6. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `isBootstrapped` stays `false` for many hours | Normal on first start (Fuji sync). If >24 h: check disk space and that the container is running (`docker ps`) |
| Coordinator says you're unreachable | Port 9651/tcp not open to the internet — fix the provider firewall (and `ufw` if enabled). Test from outside: `nc -vz <your-ip> 9651` |
| Build fails with `curl: (22) … 404` downloading subnet-evm | The pinned `SUBNET_EVM_VERSION` has no release asset. Pick a real version: check https://github.com/ava-labs/subnet-evm/releases and its `compatibility.json`, match it to the AvalancheGo version via avalanchego's `version/compatibility.json`, set both in `.env`, rebuild |
| Container restarts in a loop | Almost always a wrong `CSB_VM_ID` (plugin filename mismatch) or a version pair the network doesn't accept — re-check `.env` against the coordinator's values, then `up -d --build` |
| `health` shows unhealthy after an upgrade | Version mismatch with the network — confirm the announced pair, rebuild |
| Machine died / provider lost the VM | Provision a new server, do Setup steps 1–2, restore the staking backup into the volume **before** first start, then `up -d --build`, and tell the coordinator |

Restore procedure for the last case:

```bash
docker volume create csb_avalanchego-staking
docker run --rm -v csb_avalanchego-staking:/s -v $(pwd):/backup debian \
  tar -xzf /backup/staking-backup.tar.gz -C /s
docker compose -f docker-compose.validator.yml up -d --build
```

## 7. Leaving the testnet

Tell the coordinator so your validator is deregistered, then `docker compose -f docker-compose.validator.yml down` (no `-v` unless you truly want to erase the identity). Thank you for helping test this experimental chain.

---
*Coordinator contact: __________________ (filled in by the coordinator before distributing this manual).*
