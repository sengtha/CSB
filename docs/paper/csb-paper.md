# Sovereign Hybrid Blockchains for Regulated DeFi: A Cambodia Design Case

**Sengtha Chay, PhD**
Assistant Professor, National University of Management, Phnom Penh, Cambodia
Correspondence: sengtha@num.edu.kh

> **Draft status.** This is a revision of the initial draft, correcting claims
> that did not match the implementation and adding the operational findings from
> the first working deployment. Items still outstanding before submission are
> listed in `docs/paper/TODO.md`. Verify the affiliation line: the email domain
> `num.edu.kh` is the National University of Management — correct it if the
> intended affiliation differs.

**Article type:** Original Research
**Keywords:** sovereign blockchain, regulated DeFi, hybrid permissioned ledger, digital currency design, emerging markets, Cambodia, Avalanche L1, identity-based compliance, egress gateway

---

## Disclaimer

This paper describes an independent personal research prototype and design
exploration. It is not affiliated with, endorsed by, funded by, or developed for
the Royal Government of Cambodia, any ministry, the National Bank of Cambodia, or
any other institution. All institutional roles named (Identity Authority,
Governing Council, Enforcement Authority, Issuer) are hypothetical placeholders
used only to illustrate possible governance structures. Nothing here promises,
predicts, or implies adoption by any government or institution. All tokens
described (tRIEL, KHRt) are experimental test artifacts with no monetary value,
no peg, and no real issuer. The accompanying code is unaudited prototype software
provided "as is".

---

## Abstract

Pure permissionless decentralized finance (DeFi) has proven difficult to adopt at
scale for institutions and ordinary users in emerging economies, while closed
central bank digital currency (CBDC) pilots often sacrifice composability and
developer openness. We propose a sovereign hybrid blockchain model that remains
public and composable within a national perimeter while staying private and
controlled with respect to the outside world.

Identity is enforced below the contract layer via a transaction allowlist and
on-chain attestations. Monetary instruments follow a two-tier design consisting
of a native settlement asset and convertible tokenized local-currency
stablecoins. All outbound value movement is forced through a single governed
egress gateway enforcing token allowlists, identity-tier requirements, daily
volume caps, and a circuit breaker.

We instantiate the design as a permissioned Avalanche Layer-1 prototype, the
Cambodia Sovereign Blockchain (CSB): 29 Solidity contracts covered by 197
automated tests, a working Avalanche Interchain Token Transfer (ICTT) bridge to
the Fuji C-Chain, and citizen and institutional interfaces.

We then test the design's central claim by deploying **unmodified** Uniswap V2 —
the published upstream artifacts, unrecompiled — against the compliance-gated
stablecoin. It runs. But the perimeter leaks in a way the architecture did not
anticipate: liquidity-provider tokens are ordinary ERC-20s with no compliance
hooks, so a *transferable claim on pooled regulated assets* circulates freely to
addresses holding no identity attestation. Redemption remains blocked, so no
regulated asset escapes; what escapes is the economic exposure. We argue this
generalizes to any composable protocol that wraps a gated asset, and that
base-layer transaction gating is structurally unable to prevent it.

We further report two operational findings. A sovereign chain's fee policy can be
*structurally incompatible* with standard interoperability tooling: Avalanche's
Interchain Messaging deploys via a transaction pre-signed at a fixed 2500 gwei to
obtain a deterministic contract address, so any chain whose minimum base fee
exceeds that value cannot install it without temporarily abandoning its own fee
policy. And an Avalanche L1 under ACP-77 halts *silently* when a validator's
parent-chain fee balance is exhausted — accepting transactions and finalizing
none — a liveness failure mode with no local diagnostic signal, observed here for
approximately fourteen hours.

We argue this hybrid pattern offers a more realistic path to regulated DeFi than
either fully permissionless chains or closed CBDC silos, while showing that
"compliance at the base layer" secures the asset without securing exposure to it.

---

## 1 Introduction

Decentralized finance has demonstrated that programmable money and shared ledgers
can support sophisticated financial activity without traditional intermediaries.
After several years of large-scale experimentation, two structural barriers
remain largely unaddressed for most of the world's population and institutions.

Fully permissionless systems impose compliance, usability, and fraud costs that
ordinary users and regulated entities cannot absorb. Conversely, most CBDC pilots
remain closed or tightly permissioned environments offering limited room for
private innovation or independent developer experimentation. Emerging economies
face an especially sharp version of this dilemma: they require the efficiency and
inclusion benefits of digital assets while retaining monetary sovereignty,
enforcing anti-money-laundering rules, and protecting low-literacy users from
fraud.

This paper explores a third path: a *sovereign hybrid* blockchain, open and
composable inside a national perimeter yet private and controlled with respect to
the rest of the world. The design rests on four principles:

1. Identity and compliance are enforced below the application layer, so that
   standard DeFi contracts can deploy unmodified while every human participant
   remains known to a designated identity authority.
2. A two-tier monetary model separates a sovereign settlement asset from
   competing tokenized versions of the local currency.
3. A single governed egress gateway constitutes the only path for value to leave
   the perimeter.
4. Institutional powers — identity, enforcement, issuance, and chain governance —
   are separated in smart contracts rather than left solely to off-chain process.

We develop the architecture through a concrete prototype, the Cambodia Sovereign
Blockchain (CSB). Cambodia presents a useful design case: a heavily dollarized
economy, high mobile penetration, a young population, significant MSME activity,
and persistent digital-fraud exposure.

**Contributions.**

(i) An architecture for base-layer compliance that leaves the application layer
unmodified, with a single governed egress boundary, implemented and publicly
available.

(ii) **An empirical test of that architecture's central claim, with a negative
result.** Deploying unmodified Uniswap V2 against the gated stablecoin shows the
protocol runs without source changes, but that pool shares form an unrestricted
derivative of a restricted asset. We characterize the leak precisely: the asset
never leaves the perimeter, the *exposure* does, and no base-layer mechanism can
close it because the derivative is a token that was never told the perimeter
exists (§5.2).

(iii) Two operational findings about sovereign-chain and parent-chain interaction
that we have not found documented elsewhere: a fee policy that forecloses
standard interoperability tooling, and a silent liveness failure driven by
validator fee-balance exhaustion (§6).

The second contribution is, we think, the most useful. Proposals for compliant
chains routinely assert that enforcing identity below the application layer lets
regulated assets meet open DeFi safely. That assertion is testable, and it is
only partly true.

The remainder is organized as follows. §2 reviews related work. §3 states the
design principles. §4 presents the architecture. §5 describes the implementation.
§6 reports operational findings. §7 discusses implications and limitations. §8
concludes.

---

## 2 Related Work

*(To be expanded with full citations — see `docs/paper/TODO.md`.)*

### 2.1 Central Bank Digital Currencies

Most CBDC projects prioritize settlement finality, monetary control, and in some
cases offline resilience [BIS 2018; Auer & Böhme 2020; Auer, Cornelli & Frost
2020]. They typically operate as closed or tightly permissioned systems with
limited programmability. Cambodia's own Bakong system [NBC 2020] is directly
relevant: a Hyperledger Iroha-based national payment backbone that achieved
meaningful adoption while remaining a closed system without a public contract
layer. CSB should be positioned explicitly against Bakong, which is the strongest
argument that Cambodia can operate national ledger infrastructure — and the
clearest illustration of what a closed design forgoes.

### 2.2 Permissioned and Consortium Ledgers

Enterprise platforms — Hyperledger Fabric [Androulaki et al. 2018], Corda [Brown
et al. 2016], Canton — demonstrate strong access control and governance, but many
lack full EVM compatibility, deep DeFi tooling, and mature audited cross-chain
bridges.

### 2.3 Public-Chain DeFi and Institutional Interfaces

Permissionless DeFi has produced sophisticated mechanisms for lending, trading,
and stablecoins [Werner et al. 2022]. Its regulatory posture is contested
[Zetzsche, Arner & Buckley 2020; Aramonte, Huang & Schrimpf 2021]. Institutional
engagement has largely relied on off-chain compliance wrappers, restricted
front-ends, or permissioned pools, leaving the underlying ledger open. Token
standards embedding compliance at the asset layer — notably ERC-3643 / T-REX —
are the closest prior art to CSB's approach, and the distinction is worth drawing
sharply: ERC-3643 enforces compliance *per token*, whereas CSB enforces
participation at the *transaction* layer via `txAllowList`, so that assets which
know nothing about compliance still cannot be touched by unverified addresses.

### 2.4 The Design Gap

Existing work tends to occupy the extremes: closed sovereign systems, or open
public systems with compliance bolted on above the ledger. There is little
published architecture work on hybrid designs that keep the ledger open and
composable *inside* a jurisdiction while enforcing identity at the base layer and
routing all external value flow through a single policy point. This paper
addresses that gap.

---

## 3 Design Principles

**P1 — Sovereignty with a Contained Dependency.**
The chain remains under national institutional control for day-to-day operation,
validator membership, and monetary policy. External dependencies are acceptable
only if explicitly documented, minimal, and accompanied by a credible exit path.
§6.2 reports what happens when such a dependency fails in practice.

**P2 — KYC Below the Contract Layer.**
Identity and basic compliance are enforced before a transaction is accepted by
the network, not inside every application contract. This allows unmodified DeFi
protocols to run while guaranteeing every human participant is known to the
identity authority.

**P3 — Separation of Powers in Code.**
Identity issuance, asset freezing and confiscation, token issuance, and chain
governance are held by distinct roles with non-overlapping capabilities. No
single institution below the root council can both create identities and seize
assets, or both issue money and control the validator set.

**P4 — Crypto-Agility and Recoverability (design intent, not yet implemented).**
Accounts *should* become smart accounts with upgradeable signature validation, to
support coordinated migration of cryptographic primitives including a future
post-quantum transition [NIST FIPS 203/204/205]. The current prototype does not
implement account abstraction; §4.2 states precisely what recovery does and does
not exist today.

---

## 4 Architecture

### 4.1 Network Model and Platform Choice

The prototype is a permissioned Avalanche Layer-1 (Subnet-EVM) using
Proof-of-Authority, chain identifier 8555. Five Subnet-EVM precompiles are
activated at genesis:

- `txAllowList` — only KYC-provisioned addresses may transact;
- `contractDeployerAllowList` — deployment restricted to vetted deployers;
- `feeManager` — sets the fee level; also the pressure valve under attack;
- `contractNativeMinter` — administrative issuance of the native coin tRIEL;
- `rewardManager` — directs gas fees to a public-good fund rather than burning
  them (settable only at genesis).

Avalanche was selected primarily for its mature, audited interchain messaging and
token-transfer protocols (ICM/ICTT), providing a controlled egress path without
designing a new bridge. Hyperledger Besu (QBFT) is retained as a named fallback
should full sovereignty without any parent-chain dependency become a hard
requirement; because both stacks are EVM, the contract suite ports unchanged.

Two dependencies on the Avalanche Primary Network are acknowledged: validator-set
changes transit the P-Chain, and each L1 validator pays a continuous fee from a
P-Chain balance under ACP-77. We initially characterized these as rare and
non-urgent. §6.2 reports why the second is neither.

**Trust model.** With all validators under one government, classical Byzantine
fault-tolerance assumptions do not protect against the state itself. What the
design provides is tamper-evidence between institutions, clear audit trails, and
the absence of a single technical point of failure. Credibility could be
strengthened by seating a minority of validators outside the executive — audit
bodies, universities, or regional partners. We state plainly that this is a
design intention: **the deployment reported here runs a single registered
validator**, which provides no fault tolerance whatsoever and exists to
demonstrate function, not resilience.

### 4.2 Identity and On-Chain KYC

A single Identity Authority (placeholder for the body holding the civil registry)
is the sole identity root. No personally identifiable information is stored on
chain: an attestation binds an address to a salted commitment hash referencing a
record in the Authority's off-chain registry. The identity-to-person mapping
never leaves Authority systems.

Enrollment: the citizen presents at an Authority office or licensed agent, a
biometric match is performed against the national ID database, an account is
created, the Authority signs the attestation, and the address is admitted to the
transaction allowlist.

Tiers: Tier 1 (basic citizen, capped transfers), Tier 2 (full KYC, unrestricted
DeFi), Tier 3 (business/KYB), Tier 4 (institutional). Other authorities can layer
role attestations atop a root identity. The default is one address per identity;
additional slots require a fee whose receipt is recorded on chain. Multiple
addresses of one identity remain linkable by the state but not by the public.

**Recovery, stated precisely.** An earlier draft of this paper claimed that "a
lost phone does not imply lost assets." That is not true of the implementation
and we correct it here, because the distinction matters for the paper's thesis.

The prototype implements no account abstraction. Recovery is therefore not a
user-facing convenience but an **enforcement action subject to due process**:

- `LandTitleToken.recoveryAddress(lost, replacement, orderRef)` reissues a land
  title to a replacement address, restricted to the agent role and requiring an
  order reference recorded on chain.
- `KHRStablecoin.confiscate(from, to, amount, orderRef)` can move balances from a
  lost address, requiring the enforcement role, a frozen account, and an order
  reference.
- Native tRIEL has **no** recovery path.

We consider this more defensible than the convenience framing. In a system whose
central claim is separation of powers, the ability to move another person's
assets should be exactly as hard as seizing them, should sit with the enforcement
authority rather than the identity authority, and should leave an auditable
order reference. Making recovery easy would mean making confiscation easy. The
cost is that a citizen who loses a key must go through a process, and that native
tRIEL is genuinely unrecoverable — a gap that should be closed by smart accounts
(P4), not by widening confiscation powers.

### 4.3 Two-Tier Monetary Model

| Tier | Instrument | Analogue |
|---|---|---|
| Base / settlement | tRIEL (native coin) | Central-bank reserves / CBDC |
| Tokenized riel | KHRt and others (pluggable) | USDT / USDC → USD |

tRIEL is both the gas token and the common settlement asset, intended to be
reserve-backed and minted only under disciplined issuance rules. Tokenized riel
instruments (KHRt is the reference implementation) are KYC-gated stablecoins
converting 1:1 to tRIEL through a governed converter. Issuance authority is
pluggable so that policy, not code, decides which institutions may issue.

Compliance carries across every riel token: both parties must hold an active KYC
attestation and must not be frozen; tier-based per-transfer caps apply to basic
accounts; system contracts (bridges, DEX pools, escrows) may be allowlisted to
hold tokens without personal KYC while remaining subject to freeze powers.

**Fees are low but explicitly non-zero.** An earlier draft described "near-zero"
and "subsidized" gas. The design has since moved to a deliberately priced fee:
`minBaseFee` is set to 47,619 gwei, so a 21,000-gas transfer costs approximately
**one riel**, and a contract deployment on the order of 100 tRIEL. The `feeManager`
precompile sets this at runtime and can raise it as a pressure valve under attack;
`rewardManager` routes proceeds to a public-good fund rather than burning them.

We think the non-zero choice is the more honest and more robust one. Free gas
makes the operating cost invisible rather than absent, and removes the fee market
as a defense entirely. Priced at roughly one riel, the fee is immaterial to a
citizen, meaningful in aggregate as public-good funding, and available as a
control surface. Spam defense nonetheless rests primarily on identity — every
account is KYC-bound, so abuse is rate-limited and revocable at the identity
layer — with the fee as a secondary instrument.

### 4.4 Egress Gateway — The Sovereign Boundary

All outbound value movement is forced through a single `EgressGateway` contract,
which maintains, per token: an allowlist flag, a minimum identity tier, a daily
volume cap, and a bridge adapter; plus a global circuit breaker held by the
governing council.

```
requestEgress(token, amount, destinationChain, recipient)
  ├── token allowed?                  else TokenNotPermitted
  ├── sender KYC-active?              else NotKycActive
  ├── sender not frozen?              else AccountFrozen
  ├── sender tier >= minTier?         else TierTooLow
  ├── daily volume + amount <= cap?   else DailyCapExceeded
  ├── not paused?                     else Pausable revert
  └── adapter.bridge(...)             → transport
```

Transport is abstracted behind `IBridgeAdapter`. The production adapter wraps
Avalanche ICTT; a mock adapter supports local testing. Policy (what may leave) is
separated from transport (how it leaves).

**Ingress is not symmetric, and this is a limitation rather than a design
choice.** There is no ingress gateway: no tier requirement, no daily cap, no
pause on the way in. The only inbound control is KHRt's own KYC rule, which keeps
returning funds inside the verified perimeter but does not let the council
throttle or halt inbound flow the way it can outbound. An `IngressGateway` escrow
is future work.

### 4.5 Separation of Powers

| Power | Holder (placeholder) | Contract(s) |
|---|---|---|
| Identity issuance / revocation | Identity Authority | `IdentityRegistry` |
| Asset freeze / confiscation | Judicial / AML authority | `EnforcementRegistry`, token contracts |
| Base-asset (tRIEL) issuance | Sovereign / treasury reserve | Native Minter precompile |
| Tokenized-riel issuance | Licensed, council-approved issuers | `ITokenizedRiel` implementations, `RielConverter` |
| Egress policy & circuit breaker | Governing Council | `EgressGateway` |
| Validator set & protocol upgrades | Governing Council | Validator Manager + genesis admin keys |

The Identity Authority can stop new activity by revoking KYC but cannot seize
assets. The enforcement authority can freeze or confiscate but cannot touch
identity or issuance. Every enforcement action carries an order reference on
chain. Due process is auditable by construction.

### 4.6 Illustrative Applications

The prototype includes domain applications that rely on the base identity,
licensing, and freeze machinery without re-implementing KYC:

**Grove** — a verified digital twin of living trees supporting survival-linked
finance. `AttesterRegistry` manages field-verifier licenses; `GroveAnchor`
anchors observation hashes; `GroveTitle` issues tokens where one share equals one
verified living tree; `GrovePledge` releases sponsor funds only against a fresh,
licensed-verified record. Flow: plant → anchor → licensed verification →
tokenize → claim.

**Land titles** — `LandTitleToken` and `LandCollateralVault` implement
ERC-3643-style permissioned titles with collateralization and the recovery path
described in §4.2.

**Payments** — `RielPay` and `PaymentEscrow` implement a fixed per-payment levy
at the contract layer, which is how a genuinely flat per-payment charge is
achieved; the gas fee alone cannot deliver this, since the EVM charges per unit
of gas.

---

## 5 Implementation and Experiment

### 5.1 Implementation

29 Solidity contracts, covered by 197 automated tests exercising the KYC
lifecycle, separation-of-powers invariants, compliance-gated transfers and
confiscation, egress policy (allowlist, tiers, caps, circuit breaker), the ICTT
bridge adapter, and the Grove and land-title flows.

Supporting infrastructure: Docker Compose stacks for validators and the gated
application layer (citizen wallet, explorer, field-verifier page, institutional
admin console); deployment and seeding scripts respecting multisig role holders;
cloud-VM bootstrap tooling.

**Deployment status.** The chain runs as an Avalanche L1 tracking Fuji, with one
registered validator. A working ICTT bridge to the Fuji C-Chain was established
and exercised in both directions: `ERC20TokenHome` on CSB, `ERC20TokenRemote` on
Fuji C-Chain, with an ICM relayer delivering messages. Transfers out of the
perimeter appear in public Fuji explorers, which is the intended demonstration —
this is the boundary where sovereign-private becomes world-public.

Source code, tests, and documentation are available under MIT licence at
https://github.com/sengtha/CSB.

**What has not been done.** Formal verification, independent security audit,
performance measurement under load, and any real institutional pilot.

### 5.2 Experiment: an unmodified AMM against a compliance-gated asset

P2 claims that enforcing identity below the contract layer lets standard DeFi
protocols deploy unmodified while every human participant stays known. We tested
it directly. Method and results are reproducible as
`test/defi-unmodified.test.js`.

**Method.** We deploy Uniswap V2 from the **published upstream artifacts**
(`@uniswap/v2-core@1.0.1`, `@uniswap/v2-periphery@1.1.0-beta.0`) with no
recompilation and no source modification. The pair init-code hash of the
published core equals the value hardcoded in the published router
(`0x96e8ac42…845f`), confirming the two halves are the genuine upstream pair
rather than a locally rebuilt approximation. We pair KHRt against a plain
compliance-free ERC-20, isolating KHRt's rules as the only variable, and drive
the pool through creation, liquidity provision, swaps, and redemption with both
KYC-verified and unverified counterparties.

The experiment was run twice: against a local instance of the contract suite
(`test/defi-unmodified.test.js`), and **on the live chain**
(`scripts/defi-experiment.js`), where the `txAllowList` and
`contractDeployerAllowList` precompiles are genuinely in the loop rather than
mocked. All results below are from the live run, chain ID 8555, at the 1-riel
fee policy (`minBaseFee` 47,619 gwei). The unverified counterparty was a freshly
generated address with no prior state, whose allow-list role the chain reports
as **`none` — it is not permitted to submit any transaction at all**.

**Result 1 — it runs.** The factory, pair, and router deploy unchanged. No source
modification was required at any point. To this extent P2 holds.

**Result 2 — the pool must be whitelisted, and cannot be whitelisted in
advance.** `createPair()` succeeds because it moves no tokens and therefore
triggers no compliance check. The *first transfer into the pool* reverts with
`NotKycActive`: the pool holds no attestation and cannot hold KHRt. The council
must mark the pool address a system contract, which is only possible after
creation, since the address is determined by CREATE2 at `createPair()` time.

This is a governance step in the middle of what a DeFi front-end presents as a
single user action. Between pool creation and council approval the pool exists
and is unusable, and an ordinary interface would report an unexplained failure.
Any real deployment needs either a permissioned factory or an automated approval
path — and an automated path is a standing delegation of a council power, which
the separation-of-powers design (P3) exists to avoid.

**Result 3 — compliance holds at the pool edge.** A swap directing KHRt to an
address without an active attestation reverts. The AMM knows nothing about KYC;
KHRt's own transfer hook stops it. Regulated value cannot be swapped out of the
perimeter.

**Result 4 — but LP tokens are an unrestricted derivative of a restricted
asset.** `UniswapV2ERC20`, the pool share, is a plain ERC-20 with no compliance
hooks. A liquidity provider can transfer pool shares to an address that holds no
identity attestation and could not receive one riel of KHRt directly. That
transfer succeeds. The recipient then holds a transferable, divisible claim on
pooled KHRt.

On the live chain the recipient's position is starker than the local test could
show. The same address, in the same block:

| Property of the holding address | Value |
|---|---|
| KYC attestation | **none** |
| `txAllowList` role | **`none` — cannot submit any transaction** |
| KHRt balance | 0 (a direct transfer of 1 unit reverts) |
| **LP balance** | **0.001 — a claim on the pooled KHRt** |

An address the chain will not accept a transaction from nonetheless holds a
transferable claim on regulated assets. It cannot move that claim itself while
un-allowlisted, but it did not need to act to acquire it, the holder bears the
full price exposure, and a single allow-list grant — a far weaker act than a KYC
attestation, and one that carries no tier and no freeze status — makes the claim
liquid.

Redemption is still blocked — burning to an unverified address reverts, because
that is a KHRt transfer — so no regulated asset leaves the perimeter. What leaves
is *economic exposure to it*: the holder bears the price risk, can sell the claim
onward, and can realize value through any counterparty willing to buy it, without
ever appearing in the identity registry.

**Why base-layer gating cannot fix this.** `txAllowList` governs who may submit a
transaction, not who may hold a claim. Even if every address touching the pool
share is allowlisted, allowlisting is a far weaker condition than an active,
tiered, unfrozen KYC attestation — and the pool share is indifferent to tier and
to freezes, because it is a contract that was never told the identity registry
exists. The perimeter is enforced by the *asset*, and a composable protocol's
output is a new asset that inherits none of it.

We expect this to generalize to any protocol that issues a claim against a gated
asset — lending receipts, vault shares, wrapped positions, derivatives — and to
be sharper, not milder, in protocols with more expressive outputs. The mitigation
space is uncomfortable: permissioned factories (which forfeit composability, the
property the design was purchased for), compliance-aware forks (which forfeit
"unmodified", the property P2 asserts), or accepting that the perimeter governs
assets rather than exposure and regulating the derivative layer separately.

**Interpretation.** P2 is half right, and the half that fails is the half that
matters for regulators. "Standard DeFi runs unmodified" is true. "Every human
participant remains known" is true of anyone touching the *asset* and false of
anyone touching a *claim on* the asset. We think proposals for compliant chains
should state which of the two they mean.

### 5.3 What DeFi costs when gas is fiscal policy

CSB prices gas so that an ordinary 21,000-gas payment costs about one riel
(§4.3). That is a policy decision rather than a market outcome, and it makes the
cost of deploying financial infrastructure a directly quoted figure rather than
something inferred. We have not found this measured elsewhere, so we report it.

Measured on the live chain; gas is as executed, cost is stated at the policy
floor of 47,619 gwei. USD at roughly 4,000 riel to the dollar.

| Operation | Gas | tRIEL | USD | × an ordinary payment |
|---|---:|---:|---:|---:|
| `UniswapV2Factory` deploy | 3,051,511 | 145.31 | $0.036 | 145× |
| Test ERC-20 deploy | 716,193 | 34.10 | $0.009 | 34× |
| `createPair` (deploys a pool) | 2,524,114 | 120.20 | $0.030 | 120× |
| `setSystemContract` (council) | 48,091 | 2.29 | $0.0006 | 2× |
| Add liquidity (`mint`) | 154,978 | 7.38 | $0.002 | 7× |
| Swap | 143,980 | 6.86 | $0.002 | 7× |
| **Whole experiment** | | **316.14** | **$0.079** | **316×** |

Three observations.

**Deploying a complete AMM cost about eight US cents.** At this fee level the
capital barrier to building financial infrastructure on the national chain is
negligible, which is the intended effect of pricing gas for inclusion rather
than for congestion control.

**A swap costs about seven riel and a payment costs one.** The fee is charged per
unit of gas, so it tracks the work done. A chain wanting a genuinely flat
per-payment charge must implement it at the contract layer, which CSB does
separately through `RielPay`'s levy.

**The fee is a policy instrument with real reach.** The same `feeManager` call
that sets one riel per payment sets 145 riel per contract deployment. Raising the
floor under attack (§4.1) raises both proportionally; so does lowering it, which
is what made ICM installable at all (§6.1). A sovereign chain that treats gas as
fiscal policy should expect that policy to bind on deployment economics, not only
on user-facing payments.

---

## 6 Operational Findings

The two findings below emerged from bringing the bridge up and are, to our
knowledge, undocumented. Both concern the interaction between a sovereign chain's
own policy choices and infrastructure it does not control. We report them because
§3's "contained dependency" is easy to assert and harder to live with.

### 6.1 A sovereign fee policy can be structurally incompatible with interoperability tooling

Avalanche's Interchain Messaging contracts are installed via a **pre-signed
transaction**, so that the messenger occupies an identical address on every
chain. Its gas price is fixed at **2500 gwei** inside the signature; changing it
changes the signature and therefore the derived deployer address, defeating the
determinism the mechanism exists to provide.

CSB prices gas at `minBaseFee` = 47,619 gwei to make an ordinary payment cost
about one riel. The pre-signed transaction is therefore **permanently unmineable**
on CSB:

```
transaction underpriced: address 0x618FEdD9…DfaC
have gas fee cap (2500000000000) < pool minimum fee cap (47619047619047)
```

Installing ICM required lowering the fee floor to ~2381 gwei via the `feeManager`
precompile, deploying, and restoring the policy — a window during which the
chain's stated economics did not hold. A second subtlety: lowering a floor does
not lower the *live* base fee, which decays only as blocks are produced, and
Subnet-EVM produces no blocks when idle. The chain must be driven with filler
transactions before the deployment can succeed.

The general statement: **any permissioned chain whose fee floor exceeds the fixed
price of a deterministic-address deployment cannot install that infrastructure
while its own policy is in force.** A sovereign chain that sets fees as a policy
instrument, as ours does deliberately, inherits a class of incompatibilities with
tooling that assumes fee floors are low. This is not an Avalanche-specific issue;
deterministic deployment via pre-signed transactions is a common pattern.

### 6.2 ACP-77 validator balance exhaustion is a silent liveness failure

Under ACP-77, each L1 validator pays a continuous fee from a balance held on the
Avalanche P-Chain. When that balance reaches zero the validator is **deactivated**
— it remains listed in the validator set and contributes no stake.

For an L1 whose validator set is small, the consequence is severe and quiet. Our
chain reached 0% connected stake against an 80% threshold, and thereafter:

- **accepted** transactions into the mempool and finalized none;
- answered every RPC call with `API call rejected because chain is not done
  bootstrapping` — a well-formed response, not an error condition a liveness
  probe recognizes;
- reported the P-Chain and the primary network as fully healthy;
- showed no resource exhaustion, database fault, or process failure.

The observed outage lasted approximately fourteen hours. Recovery was a single
`increaseBalance` call and required no restart; the queued transactions drained
unaided.

Three properties make this worth reporting. **(i) The failure is economic, not
technical** — every local diagnostic is green, because nothing local is wrong.
**(ii) The chain fails open rather than closed** — accepting transactions it
cannot finalize is worse than refusing them, because every client reports a
pending queue and the operator investigates the mempool. **(iii) Automated
liveness remediation makes it worse.** Our watchdog interpreted the
still-bootstrapping RPC reply as an unreachable node and restarted the cluster
every fifteen minutes for hours, destroying evidence and adding a spurious
failure mode. We have since rewritten it to monitor validator balance and to
report rather than act.

The design lesson generalizes beyond Avalanche: **when a sovereign chain's
liveness depends on a balance held on a chain it does not control, that balance
is a critical operational parameter and belongs in monitoring alongside disk and
memory.** Papers proposing L1s with "contained" parent-chain dependencies —
including this one, in its first draft — tend to characterize such dependencies
as rare and non-urgent. A per-second fee that silently halts the chain when
exhausted is neither.

---

## 7 Discussion

### 7.1 Trust model

With all validators operated under a single sovereign, the design optimizes for
tamper-evidence between institutions, on-chain audit trails for identity,
enforcement, and monetary actions, and the absence of a single technical point of
failure — not for resistance to the state. Expanding the validator set to include
minority external parties is the available credibility mechanism, and the
single-validator deployment reported here realizes none of it.

### 7.2 Contained external dependency, reconsidered

§6.2 is the honest version of what "contained" means. The dependency did not
compromise sovereignty in the sense the design worried about — nobody censored or
seized anything — but it stopped the chain completely, through an economic
mechanism, with no local signal. The portable EVM contract suite and the named
Besu fallback preserve an exit option, and the case for exercising that option is
stronger than it appeared before deployment.

### 7.3 Fees as policy

Pricing a transaction at about one riel makes the operating cost visible, funds a
public good, and preserves the fee market as a control surface, at the cost of
incompatibility with tooling that assumes low floors (§6.1). We regard that
trade-off as favourable, but it is a trade-off, and a chain choosing free gas
would not have spent a day installing a bridge.

### 7.4 Generalizability

Although developed around Cambodia's constraints — dollarization, mobile-first
population, fraud exposure, MSME needs — the pattern of base-layer identity,
two-tier local-currency money, single governed egress, and coded separation of
powers applies to other emerging economies facing the same tension between
inclusion, innovation, and regulatory control.

### 7.5 What the perimeter actually secures

§5.2 forces a narrower statement of the design's guarantee than P2 implies. The
architecture secures **custody of the asset**: KHRt cannot rest in an address
without an active attestation, cannot leave except through the governed gateway,
and can be frozen or confiscated with an order reference. It does not secure
**exposure to the asset**: any composable protocol can mint a claim that carries
the economics and none of the rules.

This is not a bug in the implementation and we could not find a base-layer fix.
It follows from combining two properties the design deliberately wants — assets
that enforce their own rules, and a contract layer open enough to run unmodified
protocols. A chain that closes the leak by permissioning deployment has given up
the openness that distinguishes it from a CBDC; a chain that closes it by
requiring compliance-aware forks has given up "unmodified".

The honest framing for a regulator is therefore: this design makes the regulated
instrument controllable and auditable, and it makes derivative exposure *visible*
— every pool, every share, every transfer is on a ledger the state can read — but
it does not make derivative exposure *permissioned*. Visibility without control
may be the right trade; it is not the trade the architecture originally claimed.

### 7.6 Limitations

Non-citizen access tiers are an unresolved policy question. Post-quantum
migration requires the smart accounts that P4 describes and the prototype does
not implement. Native tRIEL has no recovery path. Ingress is ungated. The system
has not been formally verified or audited, has no performance data under load,
and has never carried a real transaction. The AMM experiment used a single
protocol on a local instance of the contract suite; testing lending, vaults, and
derivative protocols against the same perimeter is future work, and we expect the
leak to widen rather than close. Institutional adoption depends on legal
instruments, operational capacity, and political will entirely outside the
technical design.

---

## 8 Conclusion

Regulated DeFi at national scale is more likely to emerge from hybrid
architectures that keep the ledger open and composable inside a jurisdiction
while enforcing identity and monetary boundaries at the base layer and routing
external connectivity through a single governed policy point. The CSB prototype
demonstrates one realization of this idea, and testing it produced a result we
did not expect to have to report.

Enforcing compliance beneath the contract layer does let unmodified DeFi run.
It does not keep every participant known. An unmodified automated market maker
turns a compliance-gated asset into an unrestricted claim on that asset, and no
base-layer mechanism closes the gap, because the claim is a contract that was
never told the perimeter exists. The perimeter governs custody; composability
governs exposure. Designs in this family should say which one they are promising.

We also report two operational failure modes the architecture literature does not
discuss: a sovereign fee policy that forecloses standard interoperability
tooling, and a parent-chain fee balance whose exhaustion halts the chain
invisibly while every local signal reads healthy. We suggest that proposals for
sovereign L1s treat the operational economics of their external dependencies as a
first-class part of the design rather than a deployment detail.

None of this argues against the approach. It argues for describing it accurately,
which is the only basis on which a regulator could reasonably adopt it.

---

## Conflict of Interest

The author declares that the research was conducted in the absence of any
commercial or financial relationships that could be construed as a potential
conflict of interest.

## Author Contributions

The author is solely responsible for the conception, design, implementation,
analysis, and writing of this work.

## Funding

This research received no external funding.

## Data Availability Statement

Source code, tests, documentation, and deployment scripts are available at
https://github.com/sengtha/CSB under the MIT licence.

## Appendix A — Deployed artifacts

Everything below is on CSB (chain ID 8555) or the Avalanche Fuji C-Chain and can
be inspected independently. Addresses are specific to this deployment and change
if the chain is rebuilt.

**The DeFi experiment (§5.2, §5.3), on CSB:**

| What | Address |
|---|---|
| `UniswapV2Factory`, unmodified upstream bytecode | `0x00472802F4417c6cDAC8b689Be9166965Ea83A00` |
| KHRt / test-token pool | `0xeA263bb4334d256B92081685103AeB0cB2694A14` |
| Test ERC-20 (compliance-free counterparty asset) | `0x2EC38A65D8C6f4fA4CBedA36165E7Dd6589267df` |
| The unverified LP-token holder | `0x05aC5e237e28B310f27BF5072dAc8eFb4643f45b` |

The last address is the finding of §5.2 in one line: no KYC attestation, an
allow-list role of `none`, a KHRt balance of zero, and a non-zero claim on the
pool's KHRt.

**The bridge (§5.1):**

| What | Chain | Address |
|---|---|---|
| `ERC20TokenHome` | CSB | `0x0f2E03fFcb14874413a2dd0F132a248eb3b9E6E1` |
| `ERC20TokenRemote` | Fuji C-Chain | `0xB0a67c27B31ed58a28dBce75aD8E441216257594` |
| ICM registry | CSB | `0x22C75bE6Cbe94050c16D5944a08144a81a54ED35` |
| ICM messenger | both | `0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf` |
| ICM deterministic deployer (§6.1) | CSB | `0x618FEdD9A45a8C456812ecAAE70C671c6249DfaC` |

**Chain identifiers**, CB58 and 32-byte hex:

| Chain | CB58 | hex |
|---|---|---|
| CSB | `299jCTH4ErmwFMB3ZKa18Ck9EDzc99DMD48zkszxcArpaUfTqW` | `0x9633e7227257f4de7dcd8e595bfafdd8cf6f88918926dd1d4e2ddfff46978a61` |
| Fuji C-Chain | `yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp` | `0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5` |

**The L1 validator whose fee-balance exhaustion is described in §6.2:**
`NodeID-BoRS383b4Z9ZdsJSVUcnrXNCXh5Qj93ux`, validation ID
`2rrjPnaiB3PnatWdkZH37yJqFHBePUupuC5cFPsLXXZja6EBrh`.

**Reproducing the experiments.** `test/defi-unmodified.test.js` runs §5.2 against
a local instance; `scripts/defi-experiment.js` runs it against a live chain and
prints the cost table of §5.3.
