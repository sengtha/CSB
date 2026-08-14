# Draft — Riel as the reserve asset of domestic dollar creation

A working draft for the successor to
[doi.org/10.2139/ssrn.7204718](https://doi.org/10.2139/ssrn.7204718). Same
discipline as `docs/paper-notes.md`: every claim carries its evidence status, so
nothing reaches a manuscript stronger than the thing it rests on.

- **[MEASURED]** — run on chain 8555 or in the test suite, output recorded
- **[BUILT]** — implemented and tested locally, not yet exercised on chain
- **[ARGUED]** — a claim from reasoning, with no measurement behind it
- **[CITE]** — needs a source before it can be written down
- **[OPEN]** — genuinely undecided; the paper should say so

**Not government-backed.** The National Bank of Cambodia has no involvement in
this and has not been approached. Every institutional reference below is either a
public fact with a citation or an explicit hypothetical. The paper must never
imply otherwise, and the strongest version of the argument does not need to.

---

## Title candidates

1. **Riel as the reserve asset of domestic dollar creation: collateralised
   foreign-currency issuance on a sovereign blockchain**
2. Inverting dollarisation: a mechanism for issuing foreign currency against local
   currency collateral
3. The debt ceiling as an FX quota: programmable exchange controls on a
   permissioned national chain

(1) states the claim. (3) leads with what I think is the strongest and least
obvious contribution, and would suit a policy venue better.

---

## Abstract (draft)

> In a heavily dollarised economy, foreign currency is the reserve asset and the
> domestic currency is derived from it. This paper describes and implements the
> inverse: a mechanism in which the only route to a domestic digital dollar is to
> lock domestic currency as collateral. Synthetic foreign currencies — khUSD,
> khJPY, khEUR — are issued against tokenised riel at a published reference rate,
> over-collateralised, with a hard per-currency issuance ceiling.
>
> The mechanism itself is a collateralised debt position and is not novel; what is
> new is the choice of collateral and the institutional reading that follows from
> it. Three consequences are developed. First, the reserve relation is inverted:
> every unit of domestic dollar exposure requires riel to be immobilised, so
> demand for dollar-denominated assets becomes demand for riel. Second, the
> per-currency debt ceiling is a quantitative exchange control expressed as code —
> automatically enforced, publicly auditable, and adjustable without an
> administrative allocation process. Third, because the issuer is domestic, the
> synthetic currency can sit inside the chain's compliance perimeter, which a
> bridged foreign stablecoin structurally cannot.
>
> We implement the mechanism on a permissioned Avalanche L1 and report what it
> costs and where it leaks. We are equally explicit about what it does not do: it
> creates no foreign exchange, it may deepen rather than reduce dollar exposure,
> and it manufactures currency mismatch on the balance sheet of whoever takes the
> short side. We argue that the last of these identifies the mechanism's central
> policy dial — the stability fee is the domestic price of dollar exposure, and it
> is a lever a monetary authority could set directly.

---

## 1. Introduction

**The puzzle.** Cambodia is one of the most dollarised economies in the world
[CITE — NBC and IMF Article IV; roughly 80–90% of deposits, get the current
figure and its exact definition]. Digital payment infrastructure exists and is
multi-currency: Bakong, operated by the National Bank of Cambodia since 2020,
settles in both riel and US dollars [CITE]. De-dollarisation is stated policy
[CITE]. Yet the direction of travel in tokenised finance runs the other way:
every credible digital dollar available to a domestic user is a claim issued
abroad, on somebody else's balance sheet, under somebody else's rules.

**The move.** Suppose the domestic chain issues the dollar itself, and the only
way to obtain one is to lock riel. Then domestic dollar exposure is manufactured
out of riel rather than imported, and the riel becomes the reserve asset of
domestic dollar creation rather than the residual.

**Contributions.**

1. A mechanism — collateral, ratio, ceiling, liquidation, administered oracle —
   specified and implemented, with the design choices that differ from existing
   synthetic-asset systems stated and defended (§4). **[BUILT]**
2. A monetary reading of the mechanism: the inverted reserve relation, the
   ceiling as an FX quota, the sterilisation effect, and the identification of
   the stability fee as a de-dollarisation lever (§5). **[ARGUED]**
3. A measured implementation on a live permissioned chain, including the
   compliance-perimeter result and its limits (§6). **[MEASURED / BUILT]**
4. An honest account of three ways the mechanism fails or backfires, which we
   believe is the section that determines whether the idea is worth pursuing
   (§7). **[ARGUED]**

**What is not claimed.** No central bank has adopted or evaluated this. No
foreign exchange is created. The implementation is a personal experiment on a
test chain with no economic value at stake, and the empirical content is about
mechanism cost and failure, not about welfare.

---

## 2. Institutional setting

Short, factual, all **[CITE]**:

- Dollarisation in Cambodia: magnitude, history (post-UNTAC), why it persists —
  network effects and the absence of a credible riel-denominated savings asset.
- The riel's exchange-rate regime: a managed float that has been effectively
  stable near 4,000–4,100 KHR/USD for years. This matters more than it looks:
  the mechanism's price risk is *policy* risk, not market risk, and its tail is
  discrete rather than diffuse.
- Bakong: NBC-operated, multi-currency, blockchain-based, retail reach.
- Existing de-dollarisation instruments: reserve requirements differentiated by
  currency, the riel-denominated liquidity-providing collateralised operation
  (LPCO), the requirement on banks to lend a share in riel. **[CITE — get these
  right; the paper's credibility with a policy referee rests on this paragraph.]**

The point of the section is to establish that the tools already used are
*quantitative and administrative*, which is what makes an on-chain ceiling a
recognisable instrument rather than a novelty.

---

## 3. Related work, and what is actually new

Three literatures. The paper must be visibly fluent in all three or it will read
as a DeFi project that discovered economics.

### 3.1 Collateralised synthetic assets

This is where the mechanism already exists, and saying so early is the only way
to be taken seriously.

| System | Collateral | Synth | Oracle | Note |
|---|---|---|---|---|
| MakerDAO | ETH, RWA, others | USD-pegged DAI | market feeds | isolated per-collateral vaults (`ilk`) — the same structure as per-currency positions here |
| Synthetix | SNX | sUSD, sEUR, sJPY, sKRW, … | market feeds | shipped synthetic FX years ago; pooled-debt model |
| Angle | USDC, ETH, others | over-collateralised agEUR | market feeds | closest non-USD analogue |
| Mirror (Terra) | UST | synthetic equities | market feeds | collapsed with its collateral — the cautionary case |
| Terra | LUNA | UST, KRT, SDT, … | market feeds | multi-currency fiat synths, algorithmic, collapsed |
| Celo | diversified reserve | cUSD, cEUR, cREAL | market feeds | reserve-backed rather than CDP |
| **This** | **tokenised domestic fiat (KHRt)** | **khUSD, khJPY, khEUR** | **administered reference rate** | **collateral is a sovereign liability; issuance is capped by policy** |

[CITE — each row needs a primary source: whitepaper or docs, plus a post-mortem
for Terra/Mirror.]

**What is new is the last row's first two columns.** Every prior system
collateralises with an asset that is volatile against everything, so the
liquidation machinery exists to manage market risk. Here the collateral is a
sovereign currency and the risk being managed is a policy decision by the issuer
of that currency. **[ARGUED]** I have not found a system that collateralises
synthetic FX with tokenised domestic fiat, but the search has not been
systematic — this needs a proper survey before the claim is made. **[OPEN]**

### 3.2 Stablecoin and CBDC design

- Two-tier CBDC and synthetic CBDC proposals [CITE — Adrian & Mancini-Griffoli].
- The BIS work on multi-CBDC arrangements and cross-currency settlement (mBridge,
  Project Dunbar) [CITE]. Relevant as the *alternative* answer to the same
  problem: those create genuine FX settlement; this does not.
- Stablecoin runs and redemption design [CITE].

The distinction to draw: this is not a CBDC and not a stablecoin. It is a
**domestically issued FX-denominated instrument with no foreign claim behind it**,
which is a category the CBDC literature does not have a name for and mostly
treats as a failure mode.

### 3.3 Dollarisation, currency mismatch, and exchange controls

The literature that decides whether the idea is good, not merely whether it works.

- Financial dollarisation: causes, persistence, hysteresis [CITE — Ize & Levy
  Yeyati; Reinhart, Rogoff & Savastano].
- "Original sin" and the inability to issue local-currency-denominated external
  debt [CITE — Eichengreen & Hausmann]. The mechanism is an inversion of the
  domestic side of this: it lets residents create FX-denominated *liabilities*
  backed by local currency, which is precisely the currency mismatch the
  liability-dollarisation literature warns about (§7.3).
- Fear of floating and managed exchange-rate regimes [CITE — Calvo & Reinhart].
- Capital-flow-management measures and quantitative FX allocation [CITE — IMF
  institutional view].

---

## 4. The mechanism

Formal but short. The contract is `contracts/currency/CurrencyVault.sol` (36
tests, `test/currency-vault.test.js`). **[BUILT]**

### 4.1 State

For each currency $i$: a synthetic token $S_i$ with its own decimals, a minimum
collateral ratio $r_i$, a liquidation threshold $\ell_i < r_i$, a liquidation
penalty $\pi_i$, and a hard debt ceiling $\bar{D}_i$. For each holder $a$: an
isolated position $(c_{i,a}, d_{i,a})$ — riel collateral and synthetic debt.

Positions are isolated **per currency**, following Maker's `ilk` structure: riel
locked against khUSD does not back khJPY. A rate that moves against one currency
cannot pull the others down with it.

### 4.2 Valuation and the invariant

Debt is valued in riel through the administered rate $p_i$:

$$V_i(d) = \frac{d \cdot p_i \cdot 10^{\delta_{\mathrm{KHR}}}}{10^{\delta_i} \cdot U}$$

where $U$ is the oracle's scale. The invariant enforced on minting and on
withdrawal is $c_{i,a} \cdot 10^4 \geq r_i \cdot V_i(d_{i,a})$, and the system
invariant is $\sum_a d_{i,a} = \mathrm{supply}(S_i) \leq \bar{D}_i$.

The supply identity is asserted in the test suite: total supply of each synthetic
currency equals the sum of the vault's books, by construction, because the vault
is the only minter and has no administrative mint. **[MEASURED — local]**

### 4.3 Operations

`deposit`, `mint`, `repay`, `withdraw`, `liquidate`. Three design choices are
worth defending in the paper because they differ from the standard:

**Repayment never consults the price.** The oracle fails closed — it reverts when
a rate is stale — so minting and withdrawing against live debt halt when nobody
is publishing. Repayment deliberately does not, and a debt-free position can
always withdraw. Reducing your own risk must not be blocked by the thing that
made you risky. The cost is stated in §7.4: liquidation halts too, so an oracle
outage freezes bad debt in place. **[MEASURED — local; both directions tested]**

**No interest and no stability fee.** Deliberate in the implementation, and
§5.4 argues this is the mechanism's most important open parameter rather than a
simplification.

**No close factor.** Aave caps a single liquidation at half the debt; this does
not. With few known participants, a position nobody can fully clear is the more
likely failure. The trade is the wrong way round on a chain with anonymous
searchers, and the paper should say so.

### 4.4 The administered oracle

The synthetic-asset literature optimises oracles for manipulation resistance
because no participant is authoritative. Under a managed float, one is. The
oracle here reports a published reference rate, carries a citation hash for each
publication, bounds any single move, separates the publishing role from the role
that sets the bounds, and stops answering when stale.

This is close to the *opposite* of the property a public DeFi oracle optimises
for, and defending it is one of the paper's more interesting arguments. **[BUILT]**

---

## 5. Monetary interpretation

The core of the paper. All **[ARGUED]** unless marked.

### 5.1 The inverted reserve relation

In a dollarised economy the foreign currency is the reserve asset: domestic money
is convertible into it, and its supply constrains domestic financial depth. Here,
for the subset of dollar exposure created on-chain, the relation inverts. Every
khUSD in existence corresponds to riel immobilised in a contract at a ratio above
one. Demand for domestic dollar exposure becomes demand for riel.

The honest scope condition: this holds only for dollars *created by this
mechanism*. It says nothing about the existing dollar stock, which is the
overwhelming majority. The mechanism is a marginal instrument, and the paper
should size that margin rather than gesture at it. **[OPEN — needs a calibration]**

### 5.2 The debt ceiling as a quantitative exchange control

The strongest contribution, and the one to lead with in a policy venue.

A collateral ratio protects against a rate that *moves*. It does nothing about a
rate that is *wrong* — and an administered rate published by a role against thin
markets can be wrong in ways a market rate cannot. The ceiling is therefore not a
risk parameter but a **policy instrument**: whatever the oracle says, the chain
cannot issue more than a stated quantity of any foreign currency.

Read as monetary policy, this is quantitative FX rationing — an instrument many
EMDEs already use, normally administered through allocation to banks. Expressed
on-chain it acquires three properties the administrative version does not have:
it is **automatically enforced** rather than supervised after the fact; it is
**publicly auditable in real time**, since both the ceiling and the outstanding
stock are readable by anyone; and it is **adjustable in one transaction** without
an allocation process that can be captured.

Against that: it is also *visible to speculators in real time*, and a ceiling
approaching its limit is a public signal. Whether transparency here is stabilising
or destabilising is an open question the paper should pose rather than answer.
**[OPEN]**

### 5.3 Sterilisation and the monetary aggregates

Locking KHRt removes it from circulation for the life of the position. That is a
sterilisation operation performed by private agents rather than by the central
bank, in a quantity the central bank does not choose but can cap.

What it does to measured aggregates is genuinely unclear and worth a subsection:
is locked KHRt still M1? Is khUSD a domestic deposit substitute, and if so does it
belong in broad money? A dollar-denominated liability of a domestic contract,
backed by riel, sits awkwardly in every existing classification. **[OPEN — this
may be a small contribution in its own right.]**

### 5.4 Who takes the short side, and the stability fee as a policy dial

**The critique that most threatens the mechanism, and the extension that most
justifies it.**

Whoever mints khUSD is long riel and short dollars. If the riel depreciates,
their debt grows in riel terms and they are liquidated. With zero interest they
are **uncompensated for bearing that risk**. In a regime that has been stable for
years the risk is small but fat-tailed and discrete: the loss arrives all at once,
on a policy decision.

Two consequences follow. First, positive: there *is* a natural minter — someone
who wants dollar liquidity now without selling their riel, which is an ordinary
liquidity motive rather than a speculative one. Second, negative: absent
compensation, issuance will be thin, and thin issuance means khUSD trades away
from the reference rate with nothing but mint/repay arbitrage to pull it back.

This identifies the missing parameter. A **stability fee** paid by minters is the
domestic price of dollar exposure, and on this design it is a number a monetary
authority sets directly. Raise it and dollar exposure becomes expensive to hold
in riel terms; lower it and the mechanism supplies more. That is a
de-dollarisation instrument with a continuous dial and an immediate,
publicly-observable transmission — which no existing instrument in this space has.

I regard this as the most promising direction in the paper, and it is not
implemented. **[OPEN]**

---

## 6. Implementation and measurement

The differentiator against a purely theoretical treatment: this runs.

- Permissioned Avalanche L1, chain 8555, Subnet-EVM, identity-gated ERC-20 for
  the tokenised riel. Architecture in the companion paper.
- **The compliance perimeter reaches the synthetic currency, and cannot reach a
  bridged one.** A currency the chain issues itself checks the identity registry
  on every transfer *including issuance*; a bridged token arrives with no identity
  hook, no freeze, and no confiscation, because it is another party's contract.
  That acceptance is forced, not chosen — and it is the strongest argument for
  minting foreign currency domestically rather than importing it. **[BUILT;
  perimeter result on the bridged side is MEASURED — see `docs/architecture.md`
  §7.1 and `docs/defi.md`]**
- **Every venue must be individually attested.** A gated currency cannot be held
  by a Uniswap pair or an Aave aToken until the identity authority registers *the
  contract*. This is the composability cost, arriving as an operational
  requirement: each place that will ever custody the currency has to be named, one
  at a time, by a human. An ungated token needs none of it, which is exactly why
  an ungated token cannot be governed. **[BUILT]**
- **The leak relocates rather than closing.** The pair is attested; its LP token
  is not and cannot be. The aToken is attested; the receipt it issues is not. The
  perimeter governs custody; composability governs exposure. This reproduces, one
  layer up, the finding already measured for KHRt in Aave. **[MEASURED for KHRt;
  ARGUED for the synths until run]**
- Costs: gas per operation, cost of listing a currency, cost of standing up a
  market. **[OPEN — capture before submission; `docs/paper-notes.md` records the
  Aave figures already measured]**

---

## 7. Failure modes

The section a referee will turn to first. Nothing here should be softened.

### 7.1 It creates no foreign exchange

khUSD is not a claim on a dollar. An importer cannot pay a foreign supplier with
it. The mechanism cannot substitute for reserves, cannot fund a current-account
deficit, and does nothing for cross-border settlement. It is a **hedging and
unit-of-account instrument for domestic balance sheets**, and any claim beyond
that is false. This should appear in the abstract, not be buried.

### 7.2 It may deepen dollarisation

Making dollar-denominated exposure cheaper and easier to hold domestically is, on
its face, the opposite of de-dollarisation policy. The counter-argument — that
every unit of exposure now locks riel, so aggregate riel demand rises — is
plausible and unproven. Which effect dominates depends on whether the marginal
khUSD holder is switching *out of* physical dollars or *into* dollar exposure they
would not otherwise have taken. That is an empirical question and the paper should
model it rather than assert a direction. **[OPEN — the most important modelling
gap]**

### 7.3 It manufactures currency mismatch

Every position is a currency mismatch on a household or firm balance sheet: riel
assets, dollar liabilities. This is precisely the configuration the
liability-dollarisation literature identifies as the transmission channel from
devaluation to insolvency, and the mechanism creates it deliberately and at scale.

The mitigations are the over-collateralisation ratio and the ceiling, and the
paper should be clear that these bound the *quantity* of mismatch, not its
*correlation*: a devaluation puts every position underwater simultaneously.

### 7.4 It is procyclical, and the oracle is a policy variable

Correlated liquidation into a market that is thin exactly when riel liquidity is
scarce. Worse, the trigger is a rate the authority itself publishes, so the
authority's devaluation decision is also the liquidation trigger — a coupling
between exchange-rate policy and domestic solvency that is direct rather than
transmitted through markets.

And because the oracle fails closed, an outage halts liquidation: bad debt freezes
in place instead of clearing. The mechanism's liveness depends on an
administrative duty being performed. **[MEASURED — local; both the halt and the
repayment carve-out are tested]**

### 7.5 The anchoring is weak

There is no redemption at par into actual dollars, so nothing anchors khUSD's
market price to the reference rate except mint-and-sell / buy-and-repay arbitrage.
That arbitrage is genuinely two-sided as long as open positions exist, but it is
bounded by the ceiling in one direction and by outstanding debt in the other.
Compare Synthetix's pooled-debt socialisation and Angle's redemption module.
**[OPEN — needs a proper treatment]**

---

## 8. What a monetary authority would have to decide

Framed as a checklist, which makes the paper useful to a policy reader:

1. The ceiling per currency, and the rule for changing it.
2. The stability fee — the price of domestic dollar exposure (§5.4).
3. Who publishes the rate, under what obligation, and what happens on outage.
4. Whether the synthetic currency counts in the monetary aggregates.
5. Whether it may be used as collateral elsewhere on the chain. (The
   implementation lists it borrowable but *not* collateral, because accepting a
   riel-backed dollar as collateral to borrow riel closes a leverage loop across
   two mechanisms that cannot see each other.) **[BUILT]**
6. Supervisory treatment of the positions: are they FX derivatives?

---

## 9. Limitations

Test chain, no economic value, no users, no adoption. No calibration against
Cambodian data. The comparison table in §3.1 is a reading of documentation, not of
deployed code. The measurements are of mechanism cost, not of welfare. The claim
that no prior system collateralises synthetic FX with tokenised domestic fiat is
based on an unsystematic search.

---

## 10. Before this can be submitted

| | |
|---|---|
| **Must** | Systematic prior-art search on §3.1's claim — it is the novelty claim and it is currently unverified |
| **Must** | Get the Cambodian institutional facts right and cited: dollarisation figure and its definition, Bakong's scope, the existing de-dollarisation toolkit |
| **Must** | Run the mechanism on 8555 and capture costs, so §6 is MEASURED rather than BUILT |
| **Should** | A simple model of §7.2 — under what parameters does this raise or lower aggregate riel demand |
| **Should** | A devaluation scenario: correlated liquidation with the ceiling binding, sized |
| **Should** | Implement the stability fee, so §5.4 is a mechanism rather than a proposal |
| **Could** | Formalise the ceiling as a quota and derive its welfare properties |

**Venues.** SSRN first, as with the companion paper. Then, roughly in order of
fit: *Journal of Payments Strategy & Systems*; *Digital Finance* (Springer);
*Journal of Banking Regulation*; *Ledger*. For a technical audience, the DeFi
workshop at Financial Cryptography. If §5 becomes the centre of gravity, the
BIS/IMF working-paper format suits it better than any journal.

---

## Reproduction

```bash
source ops/csb-env.sh
npx hardhat test test/currency-vault.test.js          # 36 tests
npx hardhat run scripts/deploy-currency-vault.js --network csbRemote
npx hardhat run scripts/currency-defi.js  --network csbRemote
npx hardhat run scripts/currency-diagnose.js --network csbRemote
```

Contracts: `contracts/currency/CurrencyVault.sol`,
`contracts/currency/SyntheticCurrency.sol`. Mechanism documentation:
`docs/currency.md`. Evidence status for the companion paper's claims:
`docs/paper-notes.md`.
