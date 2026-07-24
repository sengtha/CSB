# Deploying CSB on Elestio

[Elestio](https://elest.io) provisions managed VMs (on Hetzner, DigitalOcean, AWS, Vultr, Scaleway, …) with Docker preinstalled, a TLS-terminating reverse proxy, firewall management, and Git-based CI/CD. Two deployables, two paths:

| Stack | Path | Why |
|---|---|---|
| Validator node | **VM + SSH**, `docker-compose.validator.yml` | Needs raw public TCP 9651 and long-lived identity volumes — pin it to one VM, don't put it in a rebuild pipeline |
| App (UIs vs the live chain) | **VM + SSH** co-located with a validator, `docker-compose.app.yml`; or a CI/CD pipeline once `CSB_RPC_URL` points at a reachable node | The app needs the chain's private RPC; Elestio's proxy gives the gated UI HTTPS |

Dashboard labels drift between Elestio versions; if a menu name differs slightly, look for the equivalent.

## A. Validator node via VM + SSH

1. **Provision a VM.** Dashboard → create a VM/custom service: Ubuntu, **4 vCPU / 8 GB RAM / 100+ GB SSD**. Elestio images ship with Docker + Compose. Pick a region close to Cambodia (Singapore).
2. **SSH in** (keys are under the service's *Access/SSH* tab), then:

   ```bash
   git clone <repo-url> csb && cd csb
   cp .env.validator.example .env
   # fill in: CSB_SUBNET_ID, CSB_VM_ID (from `avalanche blockchain describe csb`),
   #          AVAGO_NETWORK_ID (fuji for the testnet phase)
   docker compose -f docker-compose.validator.yml up -d --build
   ```

3. **Firewall:** in the Elestio service's *Security → Firewall* panel, open **9651/tcp to the world** (validator consensus — other validators must reach it). Do **not** open 9650; it stays localhost-only by the compose port binding.
4. **Register the validator.** Get the node identity and send it to the council for Validator Manager registration:

   ```bash
   curl -s -X POST -H 'content-type:application/json' \
     --data '{"jsonrpc":"2.0","id":1,"method":"info.getNodeID"}' \
     http://127.0.0.1:9650/ext/info
   ```

5. **Verify bootstrap** after registration:

   ```bash
   curl -s -X POST -H 'content-type:application/json' \
     --data '{"jsonrpc":"2.0","id":1,"method":"info.isBootstrapped","params":{"chain":"<blockchainID>"}}' \
     http://127.0.0.1:9650/ext/info
   ```

**Identity persistence:** staking/BLS keys and the database live in named Docker volumes (`avalanchego-staking`, `avalanchego-db`). `docker compose down` and image upgrades keep them; **never** run `down -v` on a validator. Back up the staking volume under the operator's key-custody procedure:

```bash
docker run --rm -v csb_avalanchego-staking:/s -v $(pwd):/backup debian \
  tar -czf /backup/staking-backup.tar.gz -C /s .
```

Store that archive offline (HSM-custody procedure in production); losing it means registering a new validator, leaking it means impersonation.

**Upgrades:** bump `AVALANCHEGO_VERSION`/`SUBNET_EVM_VERSION` in `.env` (check the subnet-evm compatibility table), then `docker compose -f docker-compose.validator.yml up -d --build`. Coordinate with the council — validator versions must stay within the network's compatibility window.

## B. App on the same (or an adjacent) VM

Simplest layout: run the app on a validator VM, pointing at that node's localhost RPC.

```bash
export CSB_RPC_URL='http://127.0.0.1:9650/ext/bc/<blockchainID>/rpc'
export CSB_DEPLOYER_KEY='<txAllowList-admin key>'
docker compose -f docker-compose.app.yml --profile deploy run --rm deployer   # one-time
EXPLORER_PASSCODE='<strong passcode>' docker compose -f docker-compose.app.yml up -d app
```

Note on networking: inside the app container, "localhost" is the container — reach the host's node API via the Docker bridge gateway (`http://172.17.0.1:9650/…`) or run the app service with `network_mode: host`.

Then expose the app: in Elestio, map the reverse proxy to port **8080** of this service — Elestio terminates TLS on 443 and gives you an `https://….elestio.app` URL (custom domains under *Custom domain* settings). Set a strong `EXPLORER_PASSCODE`. Never map the chain RPC (9650) through the proxy.

Alternatively, run the app as a CI/CD pipeline (source: GitHub → build method docker-compose → `docker-compose.app.yml`, expose service `app` port 8080, set `CSB_RPC_URL`/`EXPLORER_PASSCODE` as pipeline env vars) — useful once the chain RPC is reachable from the pipeline's VM over a private network.

## C. Testnet and mainnet validators on one VM

Both can share a single Elestio VM — the compose file parameterizes ports precisely for this. Size up: **8 vCPU / 16 GB RAM / 250+ GB SSD** (two nodes, two databases). Use two separate clones so volumes and `.env` files never collide (Docker namespaces volumes by directory name):

```bash
git clone <repo-url> csb-fuji && cd csb-fuji
cp .env.validator.example .env
# .env: AVAGO_NETWORK_ID=fuji, testnet CSB_SUBNET_ID/CSB_VM_ID,
#       VALIDATOR_API_PORT=9650, VALIDATOR_P2P_PORT=9651
docker compose -f docker-compose.validator.yml up -d --build

cd .. && git clone <repo-url> csb-mainnet && cd csb-mainnet
cp .env.validator.example .env
# .env: AVAGO_NETWORK_ID=mainnet, mainnet CSB_SUBNET_ID/CSB_VM_ID,
#       VALIDATOR_API_PORT=9652, VALIDATOR_P2P_PORT=9653
docker compose -f docker-compose.validator.yml up -d --build
```

Open **both** P2P ports (9651 and 9653) in the Elestio firewall; both API ports stay localhost-only. The app stack can run twice the same way (two clones, different `PORT`/host port mappings and `CSB_RPC_URL`s), or run one app per chain phase.

Honest caution: co-hosting is fine for the testnet phase and for an early mainnet where you operate the coordinator node. It is **not** the end-state for a production mainnet validator — one machine is one failure domain, and a compromise of the shared VM touches both networks. When mainnet carries real registrations, move its validator to a dedicated machine (the staking-volume backup makes the move a 10-minute job).

## Sovereignty note

Elestio VMs run on foreign cloud providers. That's fine for the Fuji testnet phase; it is **not** the production posture — the architecture requires institution validators in in-country data centers under sovereign jurisdiction (`docs/architecture.md` §9). Treat Elestio as the rehearsal environment; the migration path is trivial by design: the same compose files run on any Docker host, and the staking-volume backup moves the validator identity.
