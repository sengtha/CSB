# Cambodia Sovereign Blockchain (CSB) — Architecture v0

**Status:** working draft · **Scope:** consolidates the design decisions behind the v0 prototype in this repository.

> **This is a personal proposal and thought experiment — see [DISCLAIMER.md](../DISCLAIMER.md).** It is not affiliated with, endorsed by, or developed for any government or institution. All institutional roles below (Identity Authority, Governing Council, enforcement authority, issuer) are hypothetical placeholders describing how such a system *could* be governed; no real body is implied or committed. Nothing here promises or predicts adoption.

## 1. Vision

A sovereign hybrid blockchain for Cambodia: **public within the country, private to the world.**

- Open, composable DeFi and digital-asset activity for anyone inside the perimeter — under strict on-chain KYC.
- Ledger data, infrastructure, and governance under Cambodian sovereign control.
- A single, governed gateway through which only **permitted tokens** route to global public blockchains (Avalanche, Ethereum, Solana, …).
- A token fee — about 1 riel per payment — routed to a public-good fund rather than burned, so the cost of running the chain becomes visible public benefit (§8).
- Designed for a future in which AI-driven attacks and quantum computing stress the traditional banking system: multisig-everywhere, tamper-evident audit trails, identity-bound recoverable accounts, and **crypto-agility** as a first-class pillar. These are design targets for mainnet; §10 and `docs/deployment-status.md` record which of them the current deployment actually implements (few).

This is not a single CBDC. Money is **two-tier**: a native, riel-pegged base coin (**tRIEL**) that also pays gas, and **many tokenized-riel stablecoins** (KHRt is one reference issuer) that all convert to tRIEL 1:1 — like USDT/USDC redeeming to the dollar. The chain itself is a neutral registry-and-asset layer; see §6.

## 2. Platform decision: Avalanche L1

**Decision: Avalanche L1 (Subnet-EVM), permissioned PoA.** The deciding requirement is mature, safe egress: Avalanche ICM/ICTT provides audited, natively maintained interchain transport to the C-Chain and onward to other ecosystems. No other sovereign-capable stack offers a controlled gateway without building or adopting third-party bridge security.

| Alternative | Verdict |
|---|---|
| Hyperledger Besu (QBFT) | **Named fallback.** Fully sovereign, strong government precedent (Brazil Drex, EU EBSI), but no native egress — the killer gap. Both stacks are EVM, so all CSB contracts port unchanged if migration is ever needed. |
| Cosmos SDK + EVM | Maximum sovereignty and flexibility, but high engineering lift, imperfect EVM compatibility, and interop pointed at the wrong ecosystems. |
| Ethereum L2 stacks (OP Stack, Orbit, CDK) | Rejected: data/settlement dependency on Ethereum and single-sequencer designs contradict sovereignty and multi-institution validation. |
| Enterprise DLT (Fabric, Corda, Canton) | Rejected: no EVM, no DeFi ecosystem. |

### Contained external dependency

An Avalanche L1 retains two dependencies on the Avalanche Primary Network, acknowledged and contained rather than hidden:

1. **Validator-set changes transit the P-Chain.** Day-to-day operation is fully autonomous; only (rare, non-urgent) validator registration touches external infrastructure.
2. **Continuous fees are paid in AVAX** (~1.33 AVAX/month per validator) — immaterial in cost, but documented.

Containment: the chain runs even if the P-Chain is unreachable; validator changes can be batched and scheduled; a documented exit path exists to standalone operation or Besu (Subnet-EVM is open source; contracts are stack-portable).

## 3. Network architecture

- **Validators:** public institutions (hypothetically, government bodies such as ministries), each running a validator in in-country data centers under sovereign jurisdiction. PoA via a **Validator Manager contract** owned by the governing council's multisig.
- **Chain parameters** (see `chain/genesis.example.json`): chainId **8555**, a low base fee priced so an ordinary payment costs about 1 riel (§8), and five Subnet-EVM precompiles activated at genesis:
  - `txAllowList` — only KYC-provisioned addresses may transact (chain-wide KYC enforcement below the contract layer);
  - `contractDeployerAllowList` — contract deployment restricted to vetted deployers (tier 3+ process);
  - `feeManager` — sets the fee level; also the pressure valve for raising fees under attack;
  - `contractNativeMinter` — administrative issuance of the native coin **tRIEL**, which is riel-pegged base money (not a speculative token); minted only under reserve discipline (§6), never freely;
  - `rewardManager` — directs gas fees to a public-good fund instead of burning them. **Only settable at genesis**, so it is enabled from the start (§8).
- **Multisig clarification:** validators sign blocks automatically with node keys (HSM-protected — no per-block human approval). Multisig lives at the *governance layer*: the Validator Manager, precompile admin addresses, and every administrative contract role are held by institutional multisigs, so **no official below the council can act unilaterally**.
  - *Current deployment:* the automatic block signing is true, but the rest is not. **No multisignature wallet is deployed anywhere**, every role named above is held by a single deployer key, and the staking keys are files on the node's disk rather than in an HSM.
- **Trust model honesty:** with all validators under one government, BFT does not defend against the state itself. What it buys: tamper-evidence *between* institutions, auditability, and no single point of technical failure. Credibility can be strengthened later by seating a minority of validators outside the executive (audit bodies, universities, regional partners).
  - *Current deployment:* none of that is realised. There is **one registered validator**, on **one host**, run by one party — so there is a single point of technical failure, no tamper-evidence between institutions, and no fault tolerance. This is a property of the prototype's scale, not of the design; it is the first thing mainnet must change.

## 4. Governance and separation of powers

Root authority is a **Governing Council** established by an appropriate legal instrument (hypothetical) — this is also the legal vehicle that owns the chain, employs the core team, and holds root multisigs. Succession is automatic: authority follows the office. Changes of officeholders trigger a routine key-rotation ceremony.

Powers are deliberately split across institutions and enforced in code:

> **Status in the current deployment: not exercised.** The table below is the
> role structure the contracts implement and the assignment mainnet requires.
> On the testnet **every row is held by the same deployer key**, and no
> multisignature wallet is deployed anywhere. The separation is real in code —
> the roles are distinct and independently grantable — but it buys nothing
> against a compromise of that one key today. See `docs/testnet-to-mainnet.md`.

| Power | Holder | Contract |
|---|---|---|
| Identity issuance, suspension, revocation, address quotas | Identity Authority (placeholder) | `IdentityRegistry` |
| Asset freezing / confiscation (with mandatory order reference) | Judicial / AML authority | `EnforcementRegistry`, `KHRStablecoin.confiscate` |
| tRIEL base issuance (reserve-backed) | Sovereign / treasury reserve (placeholder — the anchor of the whole system) | Native Minter, under reserve discipline |
| Tokenized-riel issuance (mint/redeem) + issuer approval | Government-authorized issuers, not limited to the central bank (treasury / licensed bank consortium / payments authority — placeholders); council approves reserve-backed issuers | `ITokenizedRiel` ISSUER_ROLE; `RielConverter` |
| Egress token allowlist, caps, circuit breaker | Governing Council | `EgressGateway` |
| Validator set, protocol upgrades, precompile admin | Governing Council | Validator Manager + genesis admin keys |

> **Revocation does not remove the ability to transact.** The two gates are
> independent and nothing connects them: `IdentityRegistry.revoke()` and
> `suspend()` change only the attestation, while `txAllowList` (precompile
> `0x…02`) decides who may send a transaction and is granted and removed by hand
> (`scripts/allow-dev.js`). A revoked address therefore keeps its allow-list entry
> until an operator explicitly calls `setNone`.
>
> KHRt itself is safe — its transfer hook checks the registry, so a revoked
> address cannot hold the asset. What a revoked address *can* still do is send
> transactions, receive **uncompliant receipt tokens** (Aave aTokens, Uniswap LP
> shares — see `docs/defi.md`), and call `pool.withdraw(asset, amount, attested)`
> to convert such a claim into real KHRt in an attested party's hands. So the
> receipt-composability leak documented for DeFi becomes *realisable* exactly for
> this class of address, where for a genuinely unlisted address it is inert.
>
> Audit the current state with `npx hardhat run scripts/audit-allowlist.js`, which
> compares both gates and lists every address that can transact without an active
> attestation.
>
> **A second, related decoupling: a redeploy forks the perimeter.** Every gated
> token binds its registry immutably —
> `IdentityRegistry public immutable identity` (`KHRStablecoin.sol:28`,
> `LandTitleToken.sol:42`). Redeploying the suite therefore does not replace the
> compliance perimeter, it partitions it: the previous tokens keep obeying the
> previous registry, with their own attestations, and the current authority holds no
> role on it. Revocation, freezing and confiscation are all inoperative against
> those assets, and the current registry — the state's own view of who is verified —
> does not cover their holders.
>
> This is not hypothetical. Measured on chain 8555 on 2026-07-30: three live tokens
> (one reporting symbol `KHRt`, two `LAND1`) obey registry
> `0x446BE7b3…a101` while the chain's registry is `0xa33a4C89…`, and addresses
> transacting on them read as unattested against the current registry while being
> `Active` in the old one. Assess an orphan with
> `CSB_TOKEN=0x… npx hardhat run scripts/orphan-check.js`.
>
> The design fix is to stop binding it immutably — a registry behind a proxy at a
> fixed address, or a council-settable reference — so a later authority inherits the
> assets rather than forking away from them. That trades immutability for
> governability, and the trade should be made deliberately rather than by default.
>
> Two ways to close the revocation gap, and the choice is a real trade:
>
> 1. **Operator procedure** — revocation includes `txAllowList.setNone(addr)`.
>    Cheap and changes no code, but it is a manual step, and manual steps are what
>    produced this gap.
> 2. **Give `IdentityRegistry` allow-list admin** so `revoke()` removes access
>    atomically. Correct behaviour, but it makes that one contract able to gate
>    every transaction on the chain — a genuine concentration of power to weigh
>    against the separation-of-powers design above.

The point, once the roles are held by different institutions: the Identity Authority can stop *new* activity (revoke KYC) but cannot seize assets; the enforcement authority can freeze/confiscate but cannot touch identity or issuance. Due process, auditable by construction.

Of that, the order reference is the part in force today: every enforcement action carries a court/AML reference on chain, and the contracts revert without one (`EnforcementRegistry`, `KHRStablecoin.confiscate`, `LandTitleToken.forcedTransfer`/`recoveryAddress`). The mutual-exclusion property is not, because one key holds both roles.

## 5. Identity and on-chain KYC (Identity-Authority-issued)

A single national Identity Authority (placeholder: the body holding a civil registry and national ID apparatus) is the sole identity root. No existing digital-ID product is assumed.

- **No PII on chain.** An attestation binds an address to a **salted commitment hash** referencing a record in the Identity Authority's off-chain registry. The identity↔person mapping never leaves Identity Authority systems; access to it is logged and audited (lawful-intercept-style regime).
- **Enrollment:** citizen presents at an Identity Authority office/licensed agent → biometric match against the national ID database → smart account created → the Identity Authority signs the attestation → address enters the `txAllowList`.
- **Tiers:** 1 = citizen basic (capped transfers) · 2 = full KYC (unrestricted DeFi) · 3 = business/KYB · 4 = institutional/qualified investor. Other authorities **layer role attestations on top** of an Identity Authority identity (a commerce-registry body attests businesses, a finance authority attests qualified investors — all placeholders) — one root, many endorsements.
- **Addresses per identity:** default **one**; additional address slots are granted by the Identity Authority **after a fee payment** (receipt reference recorded on chain). Multiple addresses of one identity are linkable by the state through the Identity Authority's registry but not by the public — privacy from neighbors, transparency to the state.
- **Recovery:** accounts are smart accounts (account abstraction) with the Identity Authority as recovery agent — lost phone ≠ lost assets; re-verify at any Identity Authority office and rotate the key.
- **Open question (explicitly deferred):** non-citizen tiers via the Identity Authority's immigration arm (passport KYC) — economically attractive, AML-sensitive, in or out of v1 by policy decision.

## 6. Money model: base tRIEL + tokenized riel (two tiers)

CSB uses a **two-tier monetary model**, mirroring how real money works — base money plus private stablecoins — with everything denominated in riel.

| Tier | Instrument | Analogue |
|---|---|---|
| **Base / settlement** | **tRIEL** — the native coin. Pays gas *and* is the common unit every riel token converts through. 1 tRIEL = 1 riel. | Central-bank reserves / CBDC |
| **Tokenized riel** | **KHRt and others** — many issuers, each a KYC-gated riel stablecoin, all convertible to tRIEL 1:1. `KHRStablecoin` is the *reference* implementation, not "the" riel. | USDT / USDC / PYUSD → all redeem to USD |

So KHRt is **one issuer's product**, not a monopoly: multiple institutions can each issue their own tokenized riel (competing on trust and features), and **tRIEL is the neutral denominator** they all convert into — which makes every riel token mutually fungible through the base (KHRt → tRIEL → OtherRiel).

**Issuance is a government function, but not a single institution's monopoly.** Authority to issue a tokenized riel would come from the state, and deliberately is *not* tied to any one body — the central bank is one possible issuer among several (a treasury, a licensed bank consortium, a designated payments authority). The design keeps the issuer slot pluggable so the monetary question stays a policy decision rather than something the code has already settled. *(As throughout: hypothetical placeholders. No real institution is implied, approached, or committed.)*

**At least one tokenized riel must exist from day 1.** A launch with only tRIEL and no tokenized riel would leave the two-tier model theoretical — nothing to convert, and the RielConverter idle. So the chain launches with a reference tokenized riel deployed and approved in the converter (in this pilot, KHRt, approved at deploy time in `scripts/deploy.js`), and conversion working in both directions on the first day rather than as a later phase.

**tRIEL is backed money, not a free utility token.** Because 1 tRIEL = 1 riel, it must be reserve-backed exactly like a stablecoin, and minted **only** via conversion or reserve-backed issuance — never freely. Two consequences:
- The genesis allocation and any Native-Minter use represent **issuing real money**, under the same reserve discipline as KHRt.
- **Gas is priced, not free.** An early draft of this design used a zero fee floor and described it as *subsidized* gas — a budget line the state absorbs. That was replaced: gas now costs about 1 riel per payment and is routed to a public-good fund (§8), so the cost of running the chain is paid by its users and visibly returned to them, rather than absorbed invisibly by a treasury.

**Convertibility — both backing tiers supported** (`RielConverter`, planned):
- **A. Trustless (tRIEL-collateralized).** To mint the token, the issuer locks tRIEL 1:1 in the contract; redemption is contract-enforced and instant. No issuer-solvency risk. All backing concentrates in tRIEL (which is the system anchor).
- **B. Reserve-backed issuer.** A **council-approved** issuer holds its own fiat riel reserves (like USDT) and commits to 1:1 convertibility, subject to reserve attestation/audit. Backing is diversified across issuers; convertibility depends on issuer solvency, so issuer admission is governed (allowlist + audits).

Both coexist: trustless wrappers are the safe default; vetted reserve-backed issuers are permitted where real reserves and licenses exist. The Governing Council governs *which* issuers and tokens are approved (the same allowlist muscle used elsewhere).

**Convertibility is exposed, not just implemented.** A converter nobody can reach is a claim rather than a feature, so the swap is in the product: the wallet page carries a **Swap — KHRt ⇄ tRIEL** card (wrap locks KHRt and mints tRIEL; unwrap burns tRIEL and releases the KHRt), and the *public* Tokens & NFTs page publishes the converter's **locked collateral** alongside the 1:1 rate. That figure is the backing claim itself — anyone can check that the KHRt sitting in the contract matches the tRIEL it has minted, without an account and without taking anyone's word for it.

**Whoever anchors tRIEL anchors everything.** Since all riel tokens redeem to tRIEL, the foundational trust question is *who guarantees 1 tRIEL = 1 riel* — most plausibly a sovereign/treasury reserve (the CBDC-like base). Every tokenized riel inherits its credibility from that answer.

**Compliance carries across every riel token** (an `ITokenizedRiel` standard; `KHRStablecoin` implements it):
- **Compliance-gated transfers:** both parties must hold an active KYC attestation and not be frozen. Tier-based per-transfer caps for basic accounts.
- **System contracts:** council-vetted contracts (bridge adapters, DEX pools, escrows) may hold the token without personal KYC — still freezable — so standard DeFi deploys unmodified while every *human* counterparty stays KYC'd.
- **Enforcement:** confiscation requires ENFORCER_ROLE plus an order reference and works on frozen accounts.

Until a monetary mandate exists, all of this circulates only as **test riel in a sandbox** — no riel-pegged instrument is launched publicly without the required license.

## 7. Egress gateway — the sovereign boundary

The **single authorized exit** to public blockchains, and the load-bearing requirement of the whole design (`EgressGateway`):

- **Token allowlist:** only council-permitted tokens can leave; each carries a minimum KYC tier and a daily volume cap.
- **Transport/policy separation:** the gateway enforces policy; transport is delegated to per-token `IBridgeAdapter`s. Production adapters wrap **Avalanche ICTT** (TokenHome on CSB, TokenRemote on the C-Chain) — audited, maintained bridge infrastructure rather than bespoke bridge security. v0 ships a mock adapter.
- **Circuit breaker:** council can pause all egress instantly.
- **Explicit boundary:** everything crossing the gateway becomes permanently world-public on external chains. Wallet UX must surface this to users at the moment of egress.
- **Staged rollout:** caps start small and widen with operational confidence.

### 7.1 Ingress — the boundary does not exist in the other direction

The gateway governs value **leaving**. Nothing governs value **arriving**, and the
first asset bridged *in* makes that concrete rather than theoretical.

Avalanche ICTT delivers by deploying an `ERC20TokenRemote` on the destination chain
and minting to whatever recipient the sender named. That contract is a plain ERC-20:
no identity check, no freeze, no confiscate. Inside a chain whose entire claim is that
every holder is known, a bridged asset is therefore a **bearer instrument**, and none
of §4's separation of powers reaches it — the enforcement authority has no function to
call.

**Decision (2026-08-01): accept it.** The bridged token stays the stock contract. Two
things make that defensible, and they are worth stating precisely because the second
is weaker than it looks:

1. **Holding without transacting is inert.** `send()` and `transfer()` take the holder
   as `msg.sender`, and delegating requires an `approve()` that is itself a
   transaction. So an address absent from `txAllowList` can receive the asset and do
   nothing else with it — it cannot spend, bridge out, or authorise anyone else to.
   The perimeter does not govern the asset, but the chain still governs the actor.
2. **Admission to `txAllowList` is an act of the authority.** Entries are granted
   deliberately, and every transfer is permanently on chain. Visibility and
   traceability survive even where control does not.

**What is given up, and it is not nothing.** Control. There is no freeze, no
confiscate, no forced transfer, no tier limit and no daily cap — every instrument §7
provides for KHRt is unavailable for an asset issued elsewhere. A judicial order that
works against the sovereign currency has nothing to act on against a bridged one. The
honest analogy is cash: traceable through records, seizable only through courts and
physical action, never by the ledger itself.

Two consequences follow and should be treated as operating constraints:

- **The traceability argument is a property of procedure, not of the system.** Nothing
  on chain links an allow-list entry to an attestation; the allow list and
  `IdentityRegistry` are separate stores maintained separately (§4, and item 2 in
  `docs/todo.md` is the same gap seen from the other side). "Whoever can move it was
  admitted knowingly" holds only while admission is recorded against an identity —
  which makes `scripts/audit-allowlist.js` a routine control rather than an occasional
  check.
- **The only available lever is chain-wide.** Removing an address from `txAllowList`
  stops it transacting in *everything*, sovereign currency included. The perimeter can
  exclude a person; it cannot restrain an asset. There is nothing in between.

**Why the obvious fixes were rejected.** A compliant `TokenRemote` overriding
`_update` would close this completely and was designed in full — it is the same single
hook that gates the ERC-4626 share — but it requires vendoring Ava Labs' bridge code,
which is licensed under the Ecosystem License rather than MIT and would freeze a copy
of the one component where a defect is stolen collateral (`docs/todo.md` item 3a).
Wrapping is *not* a middle option: a wrapper offers a gated alternative nobody is
compelled to use, while the bridge mints the raw token to the recipient regardless.
**The hole cannot be closed without controlling the mint.**

**The general result.** A sovereign perimeter cannot govern an asset whose issuance it
does not control. Bridging value in cedes exactly that, and the remaining lever
excludes the person rather than the asset. This is the second structural limit found
here — the first being that the perimeter governs custody while composability governs
exposure (`docs/defi.md`) — and unlike that one it admits no fix at this layer, only a
choice.

### 7.2 Sovereign-to-sovereign: the case that is *easier*, not harder

If another country runs its own Avalanche L1, CSB can exchange value with it
**directly** — no routing through the C-Chain, no public intermediary. Verified in
`avalanchego/vms/platformvm/warp/validator.go`: the signing set is derived from the
**source chain's subnet ID**, so a message from another sovereign L1 is signed by
*that* country's validators and nobody else's.

**And this is the easy case, which is worth stating clearly because the failure on
this chain suggests the opposite.** The obstacle to bridging with the C-Chain is that
its validator set is enormous, anonymous and public: reaching two-thirds of it needs a
well-connected host and a lot of luck. Two sovereign L1s have the opposite shape.

| | Validators to reach for a quorum | Who they are |
|---|---|---|
| CSB ↔ Avalanche C-Chain | two-thirds of ~1,000+ | anonymous, public, permissionless |
| CSB ↔ another national L1 | two-thirds of perhaps 5 | named institutions, fixed endpoints, under agreement |

Reaching four known machines whose operators you have a treaty with is an ordinary
networking arrangement. It resembles a correspondent-banking or RTGS link far more
than it resembles peering with a public blockchain — and the infrastructure problem
that stopped ingress here does not arise.

**What each pair needs**

- an ICTT Home/Remote pair per asset per direction
- a relayer able to reach both validator sets — either state can run it, and both
  should, for redundancy
- each chain sets its own `quorumNumerator` for what it accepts inbound
- keep `requirePrimaryNetworkSigners` at its default (`false`), or messages would
  additionally need Primary Network signatures and the easy case becomes the hard one

Run **one relayer process per pair**. A single relayer serving several sources dies
entirely if any one source is unreachable — demonstrated here, where an unreachable
C-Chain took down the working CSB→Fuji direction with it.

**The compliance design that was rejected becomes available again.** §7.1 rejected a
gated `TokenRemote` partly on licensing: vendoring Ava Labs' contracts under the
Ecosystem License is awkward for an unaffiliated project. Between two states with an
agreement, both operating on Avalanche and therefore inside the licence's permitted
scope, that calculus differs — and each side can deploy a remote gated by *its own*
identity registry. KHRt arriving in the partner country would then be subject to the
partner's KYC rules, enforced in contract rather than promised in a memorandum. That
is mutual recognition, implemented.

**Which moves the hard problem from transport to identity.** `IdentityRegistry` knows
Cambodian attestations. It has no view of another country's citizens, and no basis to
trust its own registry's answers about them. Cross-border payment therefore needs
either mutual recognition of attestations, or an agreed mapping at the boundary — a
question of law and policy, with the technical layer waiting on the answer rather than
constraining it. That is the more comfortable place for the difficulty to sit.

## 8. Gas: about 1 riel per transaction, funding public good

**Decision: a transaction costs about 1 tRIEL (= 1 riel), and every riel of it goes to a public-good fund.**

Gas is paid in **tRIEL**, which is real riel-pegged money (§6), so gas was never going to be costless — the choice is only who pays and where it lands. Rather than have the state absorb the cost invisibly, the fee is set at roughly **1 riel per payment**: small enough to be irrelevant to a citizen (a fraction of a US cent), real enough to price the resource, and — routed to a public fund — it turns the cost of running the chain into visible public benefit.

**Why "about" and not exactly 1 riel.** The EVM charges `gasPrice × gasUsed`, so a chain cannot price every transaction at a flat amount; it can only fix the price *per unit of gas*. CSB sets that price so a plain transfer costs 1 tRIEL, which means heavier work costs proportionally more (a contract call a few riel, a deployment more). This is honest pricing — complex transactions consume more of the shared resource — but it is not a flat fee, and anything advertised as "1 riel per transaction" should be understood as the price of an ordinary payment. Where a genuinely flat charge is wanted, it belongs at the contract layer (`KHRStablecoin.transferLevy`, `RielPay`), not the fee config. Set with `scripts/set-gas-price.js`.

**Gas fees are NOT burned — they fund public good.** The chain enables the Subnet-EVM **RewardManager precompile** (`0x…04`, admin = council) *at genesis*, which controls where gas fees go. `setRewardAddress(fund)` routes every transaction's fee to a chosen address instead of the default **burn**. This had to be decided at genesis — it cannot be added by upgrade — so it was switched on from the start. Set with `scripts/set-reward-address.js`; reversible to burning or to paying block producers.

**Two mechanisms, deliberately different in reach.** They are complementary, not duplicates:

| | Gas fee → fund (RewardManager) | Transfer levy → fund (`transferLevy`, `RielPay`) |
|---|---|---|
| Applies to | **Every transaction on the chain** — transfers, contract calls, mints, deployments | Only payments through that specific contract |
| Charged in | tRIEL (native) | The token being sent (e.g. KHRt) |
| Amount | Proportional to work done (~1 tRIEL for a transfer) | Flat per payment |
| Enforced by | The chain itself, at block production | Contract code |
| Avoidable? | No — nothing transacts without paying gas | Yes — exempt addresses, or use another contract |

The gas route is universal and unavoidable; the levy is targeted and flat. Together they let policy fund public services from *all* chain activity while keeping a recognisable "1 riel of this payment helps a hospital" story for ordinary users.

**Spam defense is the identity layer, not the fee market.** Every account is KYC-bound, so abuse is rate-limited and revocable at the identity level. The fee is set for fairness and funding, not as the primary anti-spam mechanism — which is why it can stay near-zero-cost to citizens. Under active attack, `feeManager` can temporarily raise fees as a pressure valve.

**Reversibility.** None of this is locked in. Fees can go back to zero (`scripts/set-gas-free.js`), fees can be burned instead of routed (`CSB_REWARD_MODE=burn`), and the recipient can change by council decision. What genesis fixed is only that the *option* to not burn exists.

## 9. Data sovereignty and privacy posture

Decided posture: **full validator transparency, controlled edges.**

- All nodes hosted in Cambodia; ledger data never leaves sovereign infrastructure except through the egress gateway.
- RPC and the explorer are access-tiered behind authentication (whitelisted explorer): citizens see their own history and public aggregates; regulators see more; raw node access is limited to validator institutions.
- Every node operator can read the full ledger — accepted deliberately, mitigated by pseudonymity (addresses on chain, identities only in the Identity Authority's audited registry) and the multi-address allowance.
- Selective privacy (ZK/encrypted instruments) is scoped out of v1 with architectural room left to add it.

## 10. Crypto-agility (quantum readiness)

Standard EVM chains depend on ECDSA — broken by a cryptographically relevant quantum computer, with public keys permanently exposed on transparent ledgers. CSB's counter is **crypto-agility by governance**.

> **Status: design commitment, not implemented.** The v0 prototype has **no account abstraction**. Accounts are ordinary externally-owned ECDSA keys, exactly as on any EVM chain, and native tRIEL has no recovery path. The bullets below describe what mainnet is designed to provide; only the governance property and the non-public ledger are true of the deployment today.

- *(Designed, not built.)* Accounts become **smart accounts** whose signature-verification logic is upgradeable: ECDSA today, post-quantum schemes (ML-DSA/Falcon-class) when tooling matures — without users migrating addresses or losing assets.
- The permissioned validator set allows coordinated, fleet-wide protocol upgrades public chains cannot execute.
- Against AI-driven attacks the claim is **resilience, not immunity**: multisig-everywhere (no single compromised official can move funds), tamper-evident cross-institution audit trails, identity-bound freeze/recovery, deterministic contract logic. *(Of these, only the deterministic contract logic and the order-referenced freeze/recovery are in force today — the testnet holds every role on one key and runs one validator, so neither the multisig property nor the cross-institution property exists yet.)*
- **"Private to the world" also blunts harvest-now-decrypt-later.** A public ledger publishes every account's public key permanently, so an adversary can collect them today and break them once a quantum computer exists. CSB's ledger is not world-readable, so there is far less material to harvest in the first place — a privacy property doing double duty as a cryptographic one.

## 11. Roadmap

| Phase | Content |
|---|---|
| **0 — Prototype (this repo)** | Contract suite + tests; genesis config; local devnet. |
| **1 — Devnet demo** | Multi-node local L1; wallet, tiered explorer, and admin-console UIs; scripted end-to-end demo: KYC onboarding → ~1-riel transfer → KYC'd DeFi swap → freeze/audit → egress allow/deny. Target audience: decision-makers (hypothetical). |
| **2 — Pilot** | 3-institution validator testnet; real ICTT adapter to Fuji C-Chain; one non-monetary asset class in production use (e.g. document/land-title attestation, tokenized bond sandbox). |
| **3 — KHR mandate** | Issuer mandate resolved politically; stablecoin sandbox with licensed participants; DeFi opening. |
| **4 — Expansion** | Full institution validator set; non-citizen tiers; selective-privacy instruments; PQ signature migration as standards mature. |

## 12. Open questions

1. Non-citizen KYC tiers (in/out of v1).
2. Council composition and the legal instrument text (legal drafting, not engineering).
3. Explorer/RPC access-tier details and the de-anonymization audit regime.
4. Which non-monetary asset class leads Phase 2.
5. Identity Authority fee schedule for additional address slots.
