# Cambodia Sovereign Blockchain (CSB)

A sovereign hybrid blockchain for Cambodia — **public within the country, private to the world.** Built as a permissioned Avalanche L1 with MoI-issued on-chain KYC, a tokenized riel (KHRt) with a pluggable issuer, free gas, and a single governed **egress gateway** through which only permitted tokens route to global public blockchains.

Full design rationale: [`docs/architecture.md`](docs/architecture.md).

## Status

**v0 prototype.** The core contract suite is implemented and tested. The Avalanche L1 genesis config is drafted. Devnet UIs (wallet, tiered explorer, admin console) and the production ICTT bridge adapter are next (see roadmap in the architecture doc).

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
  egress/IBridgeAdapter.sol          Transport abstraction (production: Avalanche ICTT)
  egress/MockBridgeAdapter.sol       Devnet transport stand-in
scripts/deploy.js              Deploys and wires the suite (multisig-aware)
test/                          20 tests covering KYC lifecycle, separation of
                               powers, compliance gating, and egress policy
docs/architecture.md           Architecture v0
```

## Quickstart

```bash
npm install
npm run compile
npm test
```

Deploy against a local Hardhat network:

```bash
npm run deploy:local
```

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
