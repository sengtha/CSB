# Docker deployment

Three compose stacks. For hosting them on Elestio, see [`docs/elestio.md`](elestio.md).

| File | What it runs | When |
|---|---|---|
| `docker-compose.app.yml` | **The real thing**: UIs + contract deployment against the live CSB L1 | Once validators are up |
| `docker-compose.validator.yml` | A ministry validator node of the CSB L1 | Per institution |
| `docker-compose.demo.yml` | UIs + a simulated devnet chain, seeded | Before the L1 exists, offline demos |

## Demo stack (one command)

Full demo — devnet chain, contracts deployed and seeded, gated UIs — on any machine with Docker:

```bash
docker compose -f docker-compose.demo.yml up --build
# open http://localhost:8080  (passcode: csb-demo, or set EXPLORER_PASSCODE)
```

Three services: `chain` (Hardhat EVM devnet, reachable only inside the compose network), `deployer` (one-shot deploy + seed, writes `deployments.json` to a shared volume), `demo` (the gated server on :8080). Tear down with `docker compose -f docker-compose.demo.yml down -v` (`-v` drops the seeded state).

This stack uses a plain EVM devnet for speed and portability — chain-level features (txAllowList at the precompile layer, true zero fees) need the real L1 below.

## Validator node (per ministry)

`docker/Dockerfile.validator` builds AvalancheGo with the Subnet-EVM plugin baked in under the chain's VM ID. Each ministry runs this container; validator identity (staking + BLS keys) and the database live on named volumes, so upgrading the container never touches identity.

```bash
cp .env.validator.example .env      # fill in CSB_SUBNET_ID, CSB_VM_ID, network
docker compose -f docker-compose.validator.yml up -d --build
```

Then send the node's identity to the council for registration through the Validator Manager:

```bash
curl -s -X POST -H 'content-type:application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"info.getNodeID"}' \
  http://127.0.0.1:9650/ext/info
```

Port model: **9651** (consensus) must be publicly reachable by other validators; **9650** (node API/RPC) binds to localhost only — front it with the gated demo server or an authenticated reverse proxy, never expose it raw. This mirrors the access-tier design: chain data is served only through authenticated, auditable channels.

Where the IDs come from: whoever creates the chain (`avalanche blockchain create/deploy`) reads the **Subnet ID** and **VM ID** from `avalanche blockchain describe csb` and distributes them to ministries with this repo. The AvalancheGo/Subnet-EVM version pair is pinned in `.env` — check the compatibility table in the `ava-labs/subnet-evm` README before bumping either.

Ministry ops checklist (production):

1. Key ceremony: generate staking/BLS keys on the ministry's hardware, back them up under the ministry's custody procedure (losing them = registering a new validator; leaking them = impersonation).
2. Host in a Cambodian data center; only 9651 public.
3. Monitoring: `info.isBootstrapped`, `health.health`, disk headroom; alert to the shared NOC during the phase where operations are centralized.
4. Upgrades are coordinated by the council (validator versions must stay within the network's compatibility window).

## App stack against the real CSB L1

`docker-compose.app.yml` runs the wallet/explorer/admin UIs against the **live chain** — no simulated devnet anywhere. One-time contract deployment (profile `deploy`), then the gated app:

```bash
export CSB_RPC_URL='http://<node>:9650/ext/bc/<blockchainID>/rpc'
export CSB_DEPLOYER_KEY='<txAllowList-admin key>'
docker compose -f docker-compose.app.yml --profile deploy run --rm deployer

EXPLORER_PASSCODE='<strong passcode>' docker compose -f docker-compose.app.yml up -d app
```

Run it on (or next to) a validator host and point `CSB_RPC_URL` at the localhost-bound node API — the chain RPC stays private and only the gated app is exposed. Real-chain notes:

- The deployer key must be a **txAllowList admin** (genesis admin or enabled since).
- Institutional role addresses (`COUNCIL_ADDR`, `MOI_ADDR`, `ENFORCER_ADDR`, `ISSUER_ADDR`) should be set to the real multisigs; unset they default to the deployer (pilot mode).
- `CSB_SEED_DEMO=1` also creates the demo cast — accounts must additionally be enabled in the txAllowList precompile before they can transact on the real L1.
