# CSB use cases — programmable money and tokenized land

> **Personal proposal and thought experiment — see [DISCLAIMER.md](../DISCLAIMER.md).**
> Not affiliated with, endorsed by, or developed for any government or
> institution. Every role below (licensing registrar, social-policy authority,
> land authority, lender) is a hypothetical placeholder. No real programme,
> ministry, cadastre, parcel, or beneficiary is represented, and nothing here
> promises or predicts adoption. Everything runs on a test network with
> valueless tokens.

Three worked examples of things a permissioned chain with a national identity
layer can do that a public chain structurally cannot.

**Try them.** The `use-cases.html` page carries a *Try it* panel per case, open
to anyone with no login and no wallet. Each one calls the contract's own
`canSpend` / `canTransfer` / `canRelease` view — the same check a wallet makes
before it lets you sign — against a real address you choose, including your own.
Nothing moves and nothing is spent. The **refusals** are the demonstration:
"this assistance cannot be paid to a moneylender, and here is the reason the
chain gives" is more convincing than any description of it, and it is the answer
the chain itself returns rather than a claim this page makes.

Run `scripts/demo-idpoor.js`, `demo-land.js` and `demo-escrow.js` to set them up
on a chain; the page says which are missing when they are not there.

---

## 1. Targeted social assistance — "money that can only buy food"

**The problem.** A government transfers cash to households in need. The intent is
food on the table. Some of it goes to a moneylender the day it arrives, and the
programme finds out months later from a survey, if at all. Conditions are written
in a policy document, checked by paperwork, and enforced retrospectively or not
at all.

**What CSB does instead.** The condition moves into the money. Assistance is
issued as an *earmarked* balance of ordinary KHRt: real riel, with a rule
attached that the chain checks on every payment.

| | |
|---|---|
| Contracts | `MerchantRegistry`, `SocialProgramRegistry`, `KHRStablecoin` (extended) |
| Demo | `npx hardhat run scripts/demo-idpoor.js --network csbRemote` |
| Tests | `test/idpoor.test.js` (18) |

### How it works

1. A **licensing registrar** records that an address is a licensed food merchant
   (`MerchantRegistry`). Categories are a bitmask, so one shop can hold several
   licences and a programme can permit several at once.
2. A **social-policy authority** creates a programme saying which categories its
   money may reach (`SocialProgramRegistry`) — food only, food + medicine, school
   fees, with an optional expiry.
3. The **issuer** disburses with `issueRestricted(household, amount, programId)`.
4. On every transfer, KHRt asks the policy whether this recipient is permitted.

Two properties make it mean something rather than merely suggest:

- **Earmarked funds are spent first** at a permitted merchant, so assistance is
  used for its purpose before the household's own money is touched.
- **A payment to a non-permitted recipient can only draw on the unrestricted
  balance**, and reverts if that is not enough. This is the line that stops aid
  reaching a moneylender.

### What it deliberately does not do

- **The earmark does not follow the money.** The grocer receives ordinary KHRt.
  A restriction that propagated forever would make the token unbankable and turn
  everyone downstream into a second-class holder.
- **It does not restrict the person.** Money the household earns is ordinary
  money they can spend anywhere — including on repaying a loan, which is their
  decision to make. Only the assistance carries the condition.
- **It does not put beneficiaries on chain.** The registry holds programme rules,
  not a list of who is poor. Eligibility stays in the administering agency's own
  records. For a programme where the recipient list is itself sensitive, that
  distinction matters.
- **Aid is not taxed.** The public-good levy is waived on assistance spending —
  taking a fee out of a food transfer would be taking it out of the food.
- **Clawback reaches only the earmark**, never money the household earned. The
  power to attach a condition must not become a general power to take.

### The uncomfortable part, stated plainly

This is a mechanism for controlling how someone spends money, and that deserves
to be said out loud rather than buried under the word "programmable". It is
defensible for *assistance* — a grant given for a stated purpose, where the
alternative is either no programme or in-kind distribution, which is worse for
recipients in almost every way. The same machinery pointed at wages, savings, or
an entire population would be something else entirely, and nothing in the code
prevents that; only governance does. Anyone deploying this should be able to
answer why the restriction ends where it does.

---

## 2. Tokenized land title (ERC-3643) — issued by a regulated registrar

**The problem.** A land title is a paper deed and a row in a ministry database.
Proving ownership, selling a share, or borrowing against it all route through
manual processes. There is no way for a lender to verify a title, take a partial
claim, and release it on repayment without bilateral integration with the
registry.

**What CSB does instead.** A parcel becomes an ERC-3643 permissioned token —
10,000 shares to a parcel, so a holder with 2,500 owns a quarter. Fractional
ownership is what makes it useful as collateral: a lender can take a partial
claim without the parcel being sold or subdivided in the cadastre.

| | |
|---|---|
| Contracts | `LandTitleRegistry`, `LandTitleToken`, `LandCollateralVault` |
| Demo | `npx hardhat run scripts/demo-land.js --network csbRemote` |
| Tests | `test/land-title.test.js` (18) |

### Why ERC-3643 specifically

ERC-3643 (T-REX) is the permissioned security-token standard: a token that
checks an identity registry before it will settle. Its usual burden is that each
issuer must stand up and maintain its own identity infrastructure.

On CSB that burden is already carried. The chain has a national identity
registry, so `LandTitleToken` plugs into `IdentityRegistry` rather than building
a parallel allowlist — and compliance comes from the layer that is already
authoritative. **This is the strongest argument in the whole project for a
sovereign chain over a public one**: on a public chain, the identity layer is the
hard part and every issuer rebuilds it badly.

### Regulated issuance

Only `LAND_AUTHORITY_ROLE` can tokenize a parcel. One parcel maps to exactly one
token, recorded in `LandTitleRegistry`. The gate is the point — anyone can deploy
an ERC-20 and call it a land title; what makes a token meaningful is that a
regulated registrar issued it and stands behind the mapping to a real parcel.

The registrar keeps the agent powers, because land is subject to courts:

| Power | Why it has to exist |
|---|---|
| `forcedTransfer` (needs an order reference) | Execute a judgment, including against a frozen holder |
| `recoveryAddress` | Reissue to a replacement address when a key is lost — **only to the same registered identity**, or recovery would be a back door for transferring title to anyone the agent chose |
| `freezeShares` | Lock a pledged or disputed portion without freezing the whole holding |
| `setAddressFrozen`, `setPaused` | Enforcement and circuit breaker |

A title system that could not execute a judgment, or recover a title whose owner
lost their key, would not be usable for real property no matter how clean the
cryptography was.

### The composability payoff

`LandCollateralVault` is the point of the exercise: a lending contract that takes
tokenized land as collateral, verifying through the registry that it is a
genuinely registered title rather than a lookalike. Nothing about it required
cooperation from the registrar who issued the title — it just reads the registry.
That is the argument for a shared ledger over a ministry database: a credit
market can form around titles without the registrar building one.

**One honest qualification.** A contract has no national identity, so it cannot
hold a title unless the registrar approves it as a custodian
(`setApprovedCustodian`). So *writing* a lending protocol against these titles is
permissionless; *custodying land* is not. For real property that is the honest
arrangement — "permissionless custody of land title" is not something any
cadastre would recognise — but it does mean this is not DeFi composability in the
Ethereum sense, and it would be misleading to present it as such.

**What the vault is not.** It models the mechanism only: collateral in, credit
out, released on repayment, seizable after default. A real lender needs a price
oracle, liquidation auctions, interest accrual, and a legal route to enforce
against the underlying parcel. Valuation is set by the lender per loan rather
than discovered, because a land price oracle is a genuinely hard problem and
pretending otherwise would be the dishonest part.

---

## 3. Delivery escrow — one payment, many payees

**The problem.** A customer pays 20,000 riel for a food delivery. That single
payment is really three: the restaurant, the rider, and the platform's
commission. Today the platform collects everything and pays the others later, so
the rider is an unsecured creditor of the platform, and the customer has no idea
what share reaches whom.

**What CSB does instead.** The split is declared *when the order is created*,
before the buyer parts with any money, and settles atomically on release.

| | |
|---|---|
| Contracts | `PaymentEscrow` |
| Demo | `npx hardhat run scripts/demo-escrow.js --network csbRemote` |
| Tests | `test/escrow.test.js` (17) |

```
Restaurant              15,000.00 KHRt
Delivery rider           3,500.00 KHRt
Platform commission      1,500.00 KHRt
                        ──────────
Customer pays           20,000.00 KHRt      ← agreed before paying
```

Two consequences worth naming:

- **The buyer sees the rider's fare before paying.** That is a different
  relationship from "the platform will sort it out afterwards".
- **Nobody is trusted to forward anything.** Either every payee is paid in the
  same transaction or none is, so a platform that fails mid-delivery cannot take
  the rider's fare with it. The money is held by the contract, not the platform.

### Who can end an order

| Route | Who | When |
|---|---|---|
| `confirmAndRelease` | the buyer | the job is done |
| `releaseByArbiter` | arbiter, with a recorded reason | delivered, buyer unresponsive |
| `refundByArbiter` | arbiter, with a recorded reason | order failed, or a payee can no longer be paid |
| `reclaimAfterDeadline` | the buyer | the deadline passed and nothing happened |

A dispute — raised by the buyer *or any payee* — blocks the deadline reclaim, so
a buyer cannot receive the goods, stall, and take the money back. It leaves both
of the arbiter's routes open.

### Compliance is not suspended inside the escrow

This is the part that only works on a chain like this one. If a payee is frozen
by an enforcement order, or their KYC is revoked, **the entire release reverts** —
not just their share:

```
─── And if a payee is frozen by an enforcement order ───
  ✓ the whole settlement is refused — not even the restaurant is paid.
  ✓ arbiter refunded the customer
```

That ordering is deliberate. Paying the other two and stranding the rider's share
would leave money in escrow with no owner and an order that is neither settled
nor refundable. An enforcement freeze should outrank a commercial obligation
rather than be routed around, and the arbiter's remaining move is to return the
buyer's money.

### Known interaction, stated rather than hidden

The escrow must be a **council-vetted system contract** to custody KHRt without a
personal KYC attestation — the same treatment the bridge adapter and collateral
vault get. System contracts are exempt from the public-good transfer levy, so an
escrowed payment does not contribute the 1 KHRt levy that a direct payment would.
The gas fee still funds the public good on every escrow transaction, but the levy
does not apply. Whether that is correct is a policy question — it is noted here
because it is the kind of thing that should be a decision rather than a surprise.

## Running them

```bash
cd /opt/csb && source ops/csb-env.sh
npx hardhat run scripts/demo-idpoor.js --network csbRemote
npx hardhat run scripts/demo-land.js   --network csbRemote
npx hardhat run scripts/demo-escrow.js --network csbRemote
```

Each deploys its contracts on first run, records them in `app/deployments.json`,
creates its cast of KYC'd demo accounts, and funds them with gas. Re-running is
safe — accounts and contracts are reused and topped up.

### If a demo reverts with no reason

```bash
npx hardhat run scripts/check-demo-ready.js --network csbRemote
```

CSB is permissioned *below* the contract layer, so Subnet-EVM's allow-list
precompiles reject a transaction before any contract runs — the provider reports
a bare `execution reverted` with no data to decode. Two cases account for almost
all of it:

- **A generated demo account is not on the `txAllowList`.** KYC decides who may
  hold KHRt; the txAllowList decides who may send a transaction at all. Both are
  required, and the second failing looks nothing like a permissions problem.
- **`LandTitleRegistry` is not on the `contractDeployerAllowList`.** It deploys a
  token per parcel, and that create is performed *by the registry's own address*,
  so the factory itself needs deploy rights. This one reverts with no reason
  string whatsoever.

Both demo scripts now enable these on every run, so re-running the demo is
usually the fix. The preflight above names which one is missing.
