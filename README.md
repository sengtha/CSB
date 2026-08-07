# Cambodia Sovereign Blockchain (CSB)

> ⚠️ **Personal experiment — read [DISCLAIMER.md](DISCLAIMER.md) first.** This is an independent, personal proposal and working prototype. It is **not** affiliated with, endorsed by, or developed for any government, ministry, central bank, or institution — all institutional roles in this repository are hypothetical placeholders — and nothing here promises or predicts adoption. All tokens are valueless test artifacts.

An exploration of a **sovereign hybrid blockchain** concept — *public within a country, private to the world* — using Cambodia as the design case study. Built as a permissioned Avalanche L1 with identity-authority-issued on-chain KYC, a tokenized-riel test asset (KHRt) with a pluggable issuer slot, gas priced at about 1 riel per
transaction and routed to a public-good fund, and a single governed **egress gateway** through which only permitted tokens route to global public blockchains.

Full design rationale: [`docs/architecture.md`](docs/architecture.md). License: [MIT](LICENSE).

Companion paper on SSRN: [doi.org/10.2139/ssrn.7204718](https://doi.org/10.2139/ssrn.7204718). The repository is the working prototype; where the two disagree, the repository is what actually runs.

## Status

**v0 prototype.** Core contract suite implemented and tested (206 tests at `HEAD`; regenerate with `npx hardhat test` rather than quoting this), including the production **ICTT bridge adapter**. 29 Solidity files: 19 production contracts, 5 interfaces, 4 test mocks, 1 library. The application — citizen wallet, gated explorer, and institutional admin console — runs against the live chain behind an access-gated server (`docker-compose.app.yml`); `docker-compose.validator.yml` is the template for an institution to run a validator, though **none does yet**.

**What the deployment is not.** The prototype runs **one registered validator** on one host, so it has no fault tolerance; **every institutional role — council, Identity Authority, enforcement, KHRt issuer, precompile admin, validator-manager owner — is held by a single deployer key**, so the separation of powers exists in the contracts but not in the deployment; there is **no account abstraction**; **ingress is ungated** (the egress gateway has no inbound counterpart); **revoking a KYC attestation does not remove an address's ability to transact** — `txAllowList` and the `IdentityRegistry` are independent gates and revocation touches only the second (audit with `scripts/audit-allowlist.js`; see `docs/architecture.md` §4); and the suite has had **no security audit, no formal verification, and no performance testing**. Current state is recorded in [`docs/deployment-status.md`](docs/deployment-status.md); the mainnet requirements these fall short of are in [`docs/testnet-to-mainnet.md`](docs/testnet-to-mainnet.md). Cloud-VM tooling stands the whole stack up on a single Ubuntu VM ([`docs/cloud-deployment.md`](docs/cloud-deployment.md)); the real-egress path to Fuji C-Chain is documented in [`docs/fuji-ictt.md`](docs/fuji-ictt.md).

**Unmodified DeFi runs on it.** Uniswap V2 and Aave V3 are deployed from published upstream bytecode, with no source changes and no compliance-aware forks — a liquidity pool and a lending market against KHRt. **Both are deployed and exercised on the live chain (8555).** For Aave, the market and the escaping-receipt finding are live-measured; its other three findings and its deployment cost are still local results — [`docs/defi.md`](docs/defi.md) marks which is which. Both work, and both show the same limit: the perimeter protects the asset, while pool shares and aTokens are unrestricted claims on it that reach addresses holding no identity attestation. [`docs/defi.md`](docs/defi.md) explains how to deploy them and exactly what they prove.

## Repository layout

```
chain/genesis.example.json     Subnet-EVM genesis: txAllowList,
                               deployer allowlist, feeManager, nativeMinter
contracts/
  identity/IdentityRegistry.sol      Identity Authority-issued KYC attestations, tiers,
                                     paid multi-address quotas (no PII on chain)
  enforcement/EnforcementRegistry.sol  Freeze powers, separate authority from Identity Authority
  token/ITokenizedRiel.sol           Standard for riel stablecoins (many issuers)
  token/KHRStablecoin.sol            KHRt: reference tokenized-riel — pluggable
                                     issuer, compliance-gated transfers, tier
                                     caps, confiscation, system-contract allowlist
  token/RielConverter.sol            1:1 convert approved tokenized riel <-> native
                                     tRIEL (lock/mint, burn/release); council-gated
  payments/RielPay.sol               Native-tRIEL payments (usable before KHRt);
                                     optional off-by-default public-good levy to a
                                     council-set public fund, with exemptions
  grove/AttesterRegistry.sol         Licensed field verifiers (commune officer,
                                     agronomist, NGO…) — a licence they can lose
  grove/GroveAnchor.sol              Grove observation hashes, block-timestamped;
                                     confirmations counted only from licensed,
                                     KYC'd, unfrozen verifiers; plots cannot fork
  grove/GroveTitle.sol               One grove as a permissioned token —
                                     one share = one verified living tree
  grove/GroveTitleRegistry.sol       Issues titles; syncSupply() mints AND burns
                                     to the anchored, attested count
  grove/GrovePledge.sol              Survival-based finance: riel released only
                                     against a fresh, licensed-verified record;
                                     the verifier is a named payee
  egress/EgressGateway.sol           The sovereign boundary: token allowlist,
                                     min tiers, daily caps, circuit breaker
  egress/IBridgeAdapter.sol          Transport abstraction (policy/transport split)
  egress/ICTTBridgeAdapter.sol       Production adapter: Avalanche ICTT TokenHome,
                                     council-owned route table
  egress/MockBridgeAdapter.sol       Devnet transport stand-in
app/
  server.js                    Gated app server: static UIs + authenticated RPC proxy
  public/wallet.html           Citizen wallet: ~1-riel payments, egress requests
  public/explorer.html         Whitelisted explorer: stats, decoded events,
                               address inspector, access log
  public/anchor.html           Anchor a garden record: decodes the calldata,
                               checks the three gates, signs with your own wallet
  public/verify.html           Field verifier's page: look a grove up by name,
                               confirm or dispute what you counted. No login.
  public/admin.html            Admin console: Identity Authority / enforcement / council / issuer
Dockerfile                     App image: toolchain + app server
docker-compose.app.yml         UIs + contract deployment against the live CSB L1
docker/Dockerfile.validator    Institution validator: AvalancheGo + Subnet-EVM plugin
docker-compose.validator.yml   Validator node service (identity on volumes)
infra/setup-vm.sh              Cloud VM bootstrap (Ubuntu, any provider)
infra/deploy-l1.sh             Create + deploy the Avalanche L1 on the VM
infra/Caddyfile                Caddy reverse proxy for HTTPS (custom domain)
scripts/deploy.js              Deploys and wires the suite (multisig-aware)
scripts/deploy-grove.js        Adds the Grove suite to a chain that already has
                               CSB on it (idempotent; wires roles + allowlists)
scripts/license-attester.js    Licenses a field verifier and clears all three
                               gates (licence, KYC, txAllowList)
scripts/demo-grove.js          Grove end-to-end: plant, anchor, verify, tokenize,
                               and get paid for survival
scripts/seed-accounts.js       Seeds pilot identities, balances, egress policy
test/                          206 tests: KYC lifecycle, separation of powers,
                               compliance gating, egress policy, ICTT adapter,
                               grove anchoring / licensed attestation / pledges
docs/deployment-status.md      LIVE Fuji testnet: IDs, contract addresses, ops
docs/architecture.md           Architecture v0
docs/grove.md                  Grove: a verified digital twin, and money that
                               only moves when the tree is still alive
docs/chain-config.md           Chain rules reference: genesis, gas/fee settings,
                               precompiles, what Docker does NOT configure
docs/create-testnet.md         Coordinator guide: create the Fuji testnet chain
                               (mints the Subnet/VM/Blockchain IDs)
docs/checklists.md             Launch checklists: testnet (Fuji) and mainnet
docs/validator-manual.md       Operator manual for external testnet validators
docs/cloud-deployment.md       Full-stack deployment on a cloud VM
docs/docker.md                 Validator + app stacks with Docker
docs/elestio.md                Hosting both stacks on Elestio
docs/ssl.md                    Enabling HTTPS (Elestio proxy or Caddy)
docs/fuji-ictt.md              Real egress to Fuji C-Chain via ICTT
docs/testnet-to-mainnet.md     Promotion guide: Fuji testnet -> Avalanche mainnet
```

## Quickstart

Deployables (Docker, see [`docs/docker.md`](docs/docker.md)). Note: joining an existing chain or running the app is Docker-only; **creating** the chain is a one-time avalanche-cli task for the coordinator ([`docs/create-testnet.md`](docs/create-testnet.md)):

```bash
# Institution validator node (AvalancheGo + Subnet-EVM):
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

Role holders (council, Identity Authority issuer, enforcement authority, KHR issuer) default to the deployer for devnet runs; set `COUNCIL_ADDR`, `IDENTITY_ADDR`, `ENFORCER_ADDR`, `ISSUER_ADDR` for real deployments — every administrative role is designed to be held by an institutional multisig.

To stand up the actual L1 devnet (requires [avalanche-cli](https://github.com/ava-labs/avalanche-cli)):

```bash
avalanche blockchain create csb --genesis chain/genesis.example.json
avalanche blockchain deploy csb --local
```

Replace the `0xC0DE...` placeholder admin addresses in the genesis file with real multisig addresses first.

## Design pillars

1. **Sovereignty with a contained dependency** — Avalanche L1 chosen for its native, audited egress path (ICM/ICTT); the P-Chain dependency is documented and containable, with Hyperledger Besu as the named EVM-portable fallback.
2. **KYC below the contract layer** — the `txAllowList` precompile plus the `IdentityRegistry` mean standard DeFi deploys unmodified while every human participant is KYC'd by construction.
3. **Separation of powers in code** — identity, enforcement, issuance, and chain governance (all placeholder authorities) are distinct roles in distinct contracts, so that no institution below the council holds two. The *contracts* enforce this; **the current deployment does not exercise it** — every one of those roles is held by the same deployer key. Assigning them to different holders is a deployment step, not a code change.
4. **Crypto-agility — designed for, not yet implemented.** The design targets smart accounts with upgradeable signature validation so that a governed validator set can coordinate migration of cryptographic primitives, including a post-quantum transition. **The v0 prototype implements no account abstraction**, and native tRIEL has no recovery path. This is a mainnet design commitment, not a current capability.
