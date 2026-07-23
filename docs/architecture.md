# Cambodia Sovereign Blockchain (CSB) — Architecture v0

**Status:** working draft · **Scope:** consolidates the design decisions behind the v0 prototype in this repository.

## 1. Vision

A sovereign hybrid blockchain for Cambodia: **public within the country, private to the world.**

- Open, composable DeFi and digital-asset activity for anyone inside the perimeter — under strict on-chain KYC.
- Ledger data, infrastructure, and governance under Cambodian sovereign control.
- A single, governed gateway through which only **permitted tokens** route to global public blockchains (Avalanche, Ethereum, Solana, …).
- Free gas for users; the state absorbs infrastructure cost.
- Designed for a future in which AI-driven attacks and quantum computing stress the traditional banking system: multisig-everywhere, tamper-evident audit trails, identity-bound recoverable accounts, and **crypto-agility** as a first-class pillar.

This is not a CBDC. The monetary instrument is a **tokenized riel stablecoin** with a pluggable issuer, and the chain itself is a registry-and-asset layer for the country.

## 2. Platform decision: Avalanche L1

**Decision: Avalanche L1 (Subnet-EVM), permissioned PoA.** The deciding requirement is mature, safe egress: Avalanche ICM/ICTT provides audited, natively maintained interchain transport to the C-Chain and onward to other ecosystems. No other sovereign-capable stack offers a controlled gateway without building or adopting third-party bridge security.

| Alternative | Verdict |
|---|---|
| Hyperledger Besu (QBFT) | **Named fallback.** Fully sovereign, strong government precedent (Brazil Drex, EU EBSI), but no native egress — the killer gap. Both stacks are EVM, so all CSB contracts port unchanged if migration is ever needed. |
| Cosmos SDK + EVM | Maximum sovereignty and flexibility, but high engineering lift, imperfect EVM compatibility, and interop pointed at the wrong ecosystems. |
| Ethereum L2 stacks (OP Stack, Orbit, CDK) | Rejected: data/settlement dependency on Ethereum and single-sequencer designs contradict sovereignty and multi-ministry validation. |
| Enterprise DLT (Fabric, Corda, Canton) | Rejected: no EVM, no DeFi ecosystem. |

### Contained external dependency

An Avalanche L1 retains two dependencies on the Avalanche Primary Network, acknowledged and contained rather than hidden:

1. **Validator-set changes transit the P-Chain.** Day-to-day operation is fully autonomous; only (rare, non-urgent) validator registration touches external infrastructure.
2. **Continuous fees are paid in AVAX** (~1.33 AVAX/month per validator) — immaterial in cost, but documented.

Containment: the chain runs even if the P-Chain is unreachable; validator changes can be batched and scheduled; a documented exit path exists to standalone operation or Besu (Subnet-EVM is open source; contracts are stack-portable).

## 3. Network architecture

- **Validators:** government institutions (ministries), each running a validator in Cambodian data centers under sovereign jurisdiction. PoA via a **Validator Manager contract** owned by the governing council's multisig.
- **Chain parameters** (see `chain/genesis.example.json`): chainId **8555**, zero base fee, and four Subnet-EVM precompiles activated at genesis:
  - `txAllowList` — only KYC-provisioned addresses may transact (chain-wide KYC enforcement below the contract layer);
  - `contractDeployerAllowList` — contract deployment restricted to vetted deployers (tier 3+ process);
  - `feeManager` — fees are zero in normal operation but can be raised under attack (pressure valve);
  - `contractNativeMinter` — administrative control of the native gas token (no speculative token).
- **Multisig clarification:** validators sign blocks automatically with node keys (HSM-protected — no per-block human approval). Multisig lives at the *governance layer*: the Validator Manager, precompile admin addresses, and every administrative contract role are held by institutional multisigs, so **no official below the council can act unilaterally**.
- **Trust model honesty:** with all validators under one government, BFT does not defend against the state itself. What it buys: tamper-evidence *between* ministries, auditability, and no single point of technical failure. Credibility can be strengthened later by seating a minority of validators outside the executive (National Audit Authority, universities, regional partners).

## 4. Governance and separation of powers

Root authority is a **PM-chaired council** established by sub-decree — this is also the legal vehicle that owns the chain, employs the core team, and holds root multisigs. Succession is automatic: authority follows the office. Cabinet reshuffles trigger a routine key-rotation ceremony.

Powers are deliberately split across institutions and enforced in code:

| Power | Holder | Contract |
|---|---|---|
| Identity issuance, suspension, revocation, address quotas | Ministry of Interior (MoI) | `IdentityRegistry` |
| Asset freezing / confiscation (with mandatory order reference) | Judicial / AML authority | `EnforcementRegistry`, `KHRStablecoin.confiscate` |
| KHR issuance (mint/redeem) | Pluggable issuer (NBC / bank consortium / treasury entity) | `KHRStablecoin` ISSUER_ROLE |
| Egress token allowlist, caps, circuit breaker | PM council | `EgressGateway` |
| Validator set, protocol upgrades, precompile admin | PM council | Validator Manager + genesis admin keys |

The point: MoI can stop *new* activity (revoke KYC) but cannot seize assets; the enforcement authority can freeze/confiscate but cannot touch identity or issuance; every enforcement action carries a court/AML order reference on chain. Due process, auditable by construction.

## 5. Identity and on-chain KYC (MoI-issued)

MoI — holder of the civil registry and national ID apparatus — is the sole identity root. CamDigiKey is not used.

- **No PII on chain.** An attestation binds an address to a **salted commitment hash** referencing a record in MoI's off-chain registry. The identity↔person mapping never leaves MoI systems; access to it is logged and audited (lawful-intercept-style regime).
- **Enrollment:** citizen presents at an MoI office/licensed agent → biometric match against the national ID database → smart account created → MoI signs the attestation → address enters the `txAllowList`.
- **Tiers:** 1 = citizen basic (capped transfers) · 2 = full KYC (unrestricted DeFi) · 3 = business/KYB · 4 = institutional/qualified investor. Other ministries **layer role attestations on top** of an MoI identity (Commerce attests businesses, MEF attests qualified investors) — one root, many endorsements.
- **Addresses per identity:** default **one**; additional address slots are granted by MoI **after a fee payment** (receipt reference recorded on chain). Multiple addresses of one identity are linkable by the state through MoI's registry but not by the public — privacy from neighbors, transparency to the state.
- **Recovery:** accounts are smart accounts (account abstraction) with MoI as recovery agent — lost phone ≠ lost assets; re-verify at any MoI office and rotate the key.
- **Open question (explicitly deferred):** non-citizen tiers via MoI immigration (passport KYC) — economically attractive, AML-sensitive, in or out of v1 by policy decision.

## 6. KHR stablecoin

`KHRStablecoin` (KHRt, 2 decimals) is the settlement asset. Design constraints:

- **Pluggable issuer.** ISSUER_ROLE is a slot, not an institution. The political question of *who* issues (NBC, a licensed bank consortium, a treasury-backed entity) can resolve later without changing the rails. Until a mandate exists, the token circulates only as **test riel in a sandbox** — a KHR-pegged instrument is not launched publicly without the required license.
- **Compliance-gated transfers:** both parties must hold active MoI KYC and not be frozen. Tier-based per-transfer caps for basic accounts.
- **System contracts:** council-vetted contracts (bridge adapters, DEX pools, escrows) may hold KHRt without personal KYC — still freezable. This is what lets standard DeFi protocols deploy unmodified while every *human* counterparty remains KYC'd.
- **Enforcement:** confiscation requires ENFORCER_ROLE plus an order reference and works on frozen accounts.

## 7. Egress gateway — the sovereign boundary

The **single authorized exit** to public blockchains, and the load-bearing requirement of the whole design (`EgressGateway`):

- **Token allowlist:** only council-permitted tokens can leave; each carries a minimum KYC tier and a daily volume cap.
- **Transport/policy separation:** the gateway enforces policy; transport is delegated to per-token `IBridgeAdapter`s. Production adapters wrap **Avalanche ICTT** (TokenHome on CSB, TokenRemote on the C-Chain) — audited, maintained bridge infrastructure rather than bespoke bridge security. v0 ships a mock adapter.
- **Circuit breaker:** council can pause all egress instantly.
- **Explicit boundary:** everything crossing the gateway becomes permanently world-public on external chains. Wallet UX must surface this to users at the moment of egress.
- **Staged rollout:** caps start small and widen with operational confidence.

## 8. Free gas and anti-spam

Zero base fee via `feeConfig`/`feeManager`. Spam defense is the identity layer, not the fee market: every account is KYC-bound, so abuse is rate-limited and revocable at the identity level. Under active attack, `feeManager` can temporarily raise fees. State infrastructure cost is a budget line owned by the council's operating entity.

## 9. Data sovereignty and privacy posture

Decided posture: **full validator transparency, controlled edges.**

- All nodes hosted in Cambodia; ledger data never leaves sovereign infrastructure except through the egress gateway.
- RPC and the explorer are access-tiered behind authentication (whitelisted explorer): citizens see their own history and public aggregates; regulators see more; raw node access is limited to validator institutions.
- Every node operator can read the full ledger — accepted deliberately, mitigated by pseudonymity (addresses on chain, identities only in MoI's audited registry) and the multi-address allowance.
- Selective privacy (ZK/encrypted instruments) is scoped out of v1 with architectural room left to add it.

## 10. Crypto-agility (quantum readiness)

Standard EVM chains depend on ECDSA — broken by a cryptographically relevant quantum computer, with public keys permanently exposed on transparent ledgers. CSB's honest counter is **crypto-agility by governance**, which no public chain and no bank can match:

- Accounts are **smart accounts** whose signature-verification logic is upgradeable: ECDSA today, post-quantum schemes (ML-DSA/Falcon-class) when tooling matures — without users migrating addresses or losing assets.
- The permissioned validator set allows coordinated, fleet-wide protocol upgrades public chains cannot execute.
- Against AI-driven attacks the claim is **resilience, not immunity**: multisig-everywhere (no single compromised official can move funds), tamper-evident cross-ministry audit trails, identity-bound freeze/recovery, deterministic contract logic.

## 11. Roadmap

| Phase | Content |
|---|---|
| **0 — Prototype (this repo)** | Contract suite + tests; genesis config; local devnet. |
| **1 — Devnet demo** | Multi-node local L1; wallet, tiered explorer, and admin-console UIs; scripted end-to-end demo: KYC onboarding → zero-fee transfer → KYC'd DeFi swap → freeze/audit → egress allow/deny. Target audience: leadership. |
| **2 — Pilot** | 3-ministry validator testnet; real ICTT adapter to Fuji C-Chain; one non-monetary asset class in production use (e.g. document/land-title attestation, tokenized bond sandbox). |
| **3 — KHR mandate** | Issuer mandate resolved politically; stablecoin sandbox with licensed participants; DeFi opening. |
| **4 — Expansion** | Full ministry validator set; non-citizen tiers; selective-privacy instruments; PQ signature migration as standards mature. |

## 12. Open questions

1. Non-citizen KYC tiers (in/out of v1).
2. Council composition and the sub-decree text (legal drafting, not engineering).
3. Explorer/RPC access-tier details and the de-anonymization audit regime.
4. Which non-monetary asset class leads Phase 2.
5. MoI fee schedule for additional address slots.
