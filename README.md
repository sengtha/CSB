# Cambodia Sovereign Blockchain (CSB)

A sovereign hybrid blockchain for Cambodia — **public within the country, private to the world.** Built as a permissioned Avalanche L1 with MoI-issued on-chain KYC, a tokenized riel (KHRt) with a pluggable issuer, free gas, and a single governed **egress gateway** through which only permitted tokens route to global public blockchains.

Full design rationale: [`docs/architecture.md`](docs/architecture.md).

## Status

**v0 prototype.** Core contract suite implemented and tested (24 tests), including the production **ICTT bridge adapter**. The application — citizen wallet, gated explorer, and institutional admin console — runs against the live chain behind an access-gated server (`docker-compose.app.yml`); ministries run validators via `docker-compose.validator.yml`. Cloud-VM tooling stands the whole stack up on a single Ubuntu VM ([`docs/cloud-deployment.md`](docs/cloud-deployment.md)); the real-egress path to Fuji C-Chain is documented in [`docs/fuji-ictt.md`](docs/fuji-ictt.md).

## Repository layout

```
chain/genesis.example.json     Subnet-EVM genesis: zero fees, txAllowList,
                               deployer allowlist, feeManager, nativeMinter
contracts/
  identity/IdentityRegistry.sol      MoI-issued KYC attestations, tiers,
                                     paid multi-address quotas (no PII on chain)
  enforcement/EnforcementRegistry.sol  Freeze powers, separate authority from MoI
  token/KHRStablecoin.sol            KHRt: pluggable issuer, compliance-gated
                                     transfers, tier caps, confiscation with
                                     order refs, system-contract allowlist
  egress/EgressGateway.sol           The sovereign boundary: token allowlist,
                                     min tiers, daily caps, circuit breaker
  egress/IBridgeAdapter.sol          Transport abstraction (policy/transport split)
  egress/ICTTBridgeAdapter.sol       Production adapter: Avalanche ICTT TokenHome,
                                     council-owned route table
  egress/MockBridgeAdapter.sol       Devnet transport stand-in
app/
  server.js                    Gated app server: static UIs + authenticated RPC proxy
  public/wallet.html           Citizen wallet: zero-fee payments, egress requests
  public/explorer.html         Whitelisted explorer: stats, decoded events,
                               address inspector, access log
  public/admin.html            Admin console: MoI / enforcement / council / issuer
Dockerfile                     App image: toolchain + app server
docker-compose.app.yml         UIs + contract deployment against the live CSB L1
docker/Dockerfile.validator    Ministry validator: AvalancheGo + Subnet-EVM plugin
docker-compose.validator.yml   Validator node service (identity on volumes)
infra/setup-vm.sh              Cloud VM bootstrap (Ubuntu, any provider)
infra/deploy-l1.sh             Create + deploy the Avalanche L1 on the VM
scripts/deploy.js              Deploys and wires the suite (multisig-aware)
scripts/seed-accounts.js       Seeds pilot identities, balances, egress policy
test/                          24 tests: KYC lifecycle, separation of powers,
                               compliance gating, egress policy, ICTT adapter
docs/architecture.md           Architecture v0
docs/chain-config.md           Chain rules reference: genesis, gas/fee settings,
                               precompiles, what Docker does NOT configure
docs/cloud-deployment.md       Full-stack deployment on a cloud VM
docs/docker.md                 Validator + app stacks with Docker
docs/elestio.md                Hosting both stacks on Elestio
docs/fuji-ictt.md              Real egress to Fuji C-Chain via ICTT
docs/testnet-to-mainnet.md     Promotion guide: Fuji testnet -> Avalanche mainnet
```

## Quickstart

Deployables (Docker, see [`docs/docker.md`](docs/docker.md)):

```bash
# Ministry validator node (AvalancheGo + Subnet-EVM):
docker compose -f docker-compose.validator.yml up -d --build

# Application (contracts + gated UIs) against the live CSB chain:
docker compose -f docker-compose.app.yml --profile deploy run --rm deployer   # one-time
docker compose -f docker-compose.app.yml up -d app
```

Development without Docker:

```bash
npm install && npm test

# local devnet stand-in for the chain (development only):
npx hardhat node &
npx hardhat run scripts/deploy.js --network localhost
npx hardhat run scripts/seed-accounts.js --network localhost
node app/server.js   # http://localhost:8080, passcode csb-demo
```

To stand up the real Avalanche L1 on a cloud VM, follow [`docs/cloud-deployment.md`](docs/cloud-deployment.md).

Role holders (council, MoI issuer, enforcement authority, KHR issuer) default to the deployer for devnet runs; set `COUNCIL_ADDR`, `MOI_ADDR`, `ENFORCER_ADDR`, `ISSUER_ADDR` for real deployments — every administrative role is designed to be held by an institutional multisig.

To stand up the actual L1 devnet (requires [avalanche-cli](https://github.com/ava-labs/avalanche-cli)):

```bash
avalanche blockchain create csb --genesis chain/genesis.example.json
avalanche blockchain deploy csb --local
```

Replace the `0xC0DE...` placeholder admin addresses in the genesis file with real multisig addresses first.

## Design pillars

1. **Sovereignty with a contained dependency** — Avalanche L1 chosen for its native, audited egress path (ICM/ICTT); the P-Chain dependency is documented and containable, with Hyperledger Besu as the named EVM-portable fallback.
2. **KYC below the contract layer** — the `txAllowList` precompile plus the `IdentityRegistry` mean standard DeFi deploys unmodified while every human participant is KYC'd by construction.
3. **Separation of powers in code** — identity (MoI), enforcement (judiciary/AML), issuance (pluggable), and chain governance (PM council) are distinct roles in distinct contracts; no institution below the council holds two.
4. **Crypto-agility** — smart accounts with upgradeable signature validation and a governed validator set give a coordinated post-quantum migration path no public chain or bank can match.
