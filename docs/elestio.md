# Deploying CSB on Elestio

[Elestio](https://elest.io) provisions managed VMs (on Hetzner, DigitalOcean, AWS, Vultr, Scaleway, …) with Docker preinstalled, a TLS-terminating reverse proxy, firewall management, and Git-based CI/CD. Two deployment paths, matching the two stacks:

| Stack | Path | Why |
|---|---|---|
| Demo (chain + UIs) | **CI/CD pipeline** from GitHub, `docker-compose.demo.yml` | HTTPS out of the box, redeploys on push |
| Validator node | **VM + SSH**, `docker-compose.validator.yml` | Needs raw public TCP 9651 and long-lived identity volumes — keep it pinned to one VM, not a rebuild pipeline |

Dashboard labels drift between Elestio versions; if a menu name differs slightly, look for the equivalent.

## A. Demo stack via CI/CD

1. **Create the pipeline.** Dashboard → **CI/CD** → *Create pipeline* → source **GitHub** → authorize Elestio's GitHub app for `sengtha/csb` (it's private, so grant access explicitly) → pick the repo and branch.
2. **Build method: docker-compose**, compose file `docker-compose.demo.yml`.
3. **Target:** create a new VM. 2 vCPU / 4 GB is enough for the demo; pick a region close to your audience (Singapore is the usual choice for Cambodia).
4. **Exposed port:** point Elestio's reverse proxy at the `demo` service, container port **8080**. Elestio terminates TLS on 443 and gives you an `https://….elestio.app` URL (custom domains can be added later under the service's *Custom domain* settings).
5. **Environment variables:** set `EXPLORER_PASSCODE` to a strong value — the default `csb-demo` must not survive on a public URL.
6. **Deploy.** Build takes a few minutes (three images from one Dockerfile — layer cache makes rebuilds fast). Every push to the branch redeploys.

Two operational notes:

- **The demo chain is ephemeral by design.** The Hardhat devnet keeps state in memory. A full pipeline redeploy re-runs the one-shot `deployer` service, so you always get a freshly seeded demo. If the stack ever gets into a half-restarted state (chain reset but stale `deployments.json`), redeploy the pipeline, or on the VM: `docker compose -f docker-compose.demo.yml down -v && docker compose -f docker-compose.demo.yml up -d`.
- **Do not expose the `chain` service.** Only the `demo` service (8080) goes behind the proxy; the compose file already keeps the chain internal — don't add a port mapping for it in Elestio.

## B. Validator node via VM + SSH

1. **Provision a VM.** Dashboard → create a VM/custom service: Ubuntu, **4 vCPU / 8 GB RAM / 100+ GB SSD**. Elestio images ship with Docker + Compose.
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

## Sovereignty note

Elestio VMs run on foreign cloud providers. That's fine for the demo and the Fuji testnet phase; it is **not** the production posture — the architecture requires ministry validators in Cambodian data centers under sovereign jurisdiction (`docs/architecture.md` §9). Treat Elestio as the rehearsal environment, and the migration path is trivial by design: the same compose files run on any Docker host, and the staking-volume backup moves the validator identity.
