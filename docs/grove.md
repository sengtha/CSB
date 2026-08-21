# Grove on CSB — a digital twin somebody is accountable for

> **Personal proposal and thought experiment — see [DISCLAIMER.md](../DISCLAIMER.md).**
> Not affiliated with, endorsed by, or developed for any government or
> institution. Every role below (licensing registrar, grove authority, commune
> agriculture officer, sponsor, arbiter) is a hypothetical placeholder. No real
> grove, licence, programme, or payment is represented. Everything runs on a test
> network with valueless tokens, and **nothing here is a carbon credit**.

A farmer records her mangroves on her phone. The record is signed on-device
([Grove](https://github.com/sengtha/iAny/tree/main/grove)). CamboVerse grows a
virtual twin of that grove you can walk through in VR. This document is the third
piece: what CSB adds, why it is narrow, and why the narrowness is the point.

```
 iAny / Grove          CSB                      CamboVerse
 ────────────          ───                      ──────────
 phone signs   ──►  hash anchored        ──►  virtual grove renders
 the record         block-timestamped         the same plot, with a
                    licensed verifier         ✓ from a licensed
                    confirms                  verifier
                    title tracks the
                    verified count            💚 riel released on
                    pledge pays on            proof of survival
                    survival
```

---

## 1. The thing this deliberately does not do

**It does not tokenize carbon.** No contract here mints a tonne, and no token in
this repository represents CO₂.

That is not caution, it is the design. Grove's own specification says the quiet
part out loud: a signature proves *who said something*, never *whether it is
true*, and bridging physical reality into a record has no pure-cryptographic
solution. `co2Kg` in a Grove record is an estimate derived from an allometric
equation applied to a self-reported measurement — a perfectly good number for a
garden diary and a terrible one to make transferable. Wrapping the weakest claim
in the stack (an unverifiable estimate from an anonymous device key) inside the
strongest possible wrapper (a bridgeable asset) is the exact move that
discredited the voluntary carbon market, and doing it on a national chain would
discredit the chain instead.

So CSB records **trees**. A tree is the largest claim this stack can actually
support: a count somebody can walk out and falsify, that a person with a licence
to lose has put their name to.

## 2. What the chain adds that a signature cannot

| | Grove alone | With CSB |
|---|---|---|
| **When** | `observedAt` — the phone's clock, set by the claimant | A block timestamp agreed by a validator set that has never met them |
| **Who vouches** | Attestations from device keys anyone can generate by the thousand | Confirmations from **licensed** verifiers, checked against a live licence, active KYC, and no enforcement freeze |
| **History** | A `prev` chain the holder maintains | A chain that **cannot fork** — a new anchor must extend the plot's current head |
| **Consequence** | None | Money moves, or does not |

Everything else stays where it was. Grove records verify the same way, offline,
with no chain; CamboVerse still verifies every record itself before drawing it.
Anchoring is additive, and an unanchored garden is a normal garden.

## 3. The four contracts

| | |
|---|---|
| Contracts | `AttesterRegistry`, `GroveAnchor`, `GroveTitleRegistry` + `GroveTitle`, `GrovePledge` |
| Demo | `npx hardhat run scripts/demo-grove.js --network csbRemote` |
| Tests | `test/grove.test.js` (53) |
| Read API | `GET /grove?plot=<keccak256(plot)>` — public, CORS-open, no key |
| Public page | **Use cases → 4** on the app server — live state, and two `canX()` checks anyone can run |
| Grower | **`/anchor.html`** — decode the calldata, check the gates, sign with your own wallet |
| Verifier | **`/verify.html`** — look a grove up by name, confirm or dispute it. No login. |
| Registrar | **Admin → Grove verifiers** — issue and withdraw licences, and issue a grove title |
| Grower's shares | **`/assets.html`** (Tokens) — grove titles and the holder's shares |

### 3.1 `AttesterRegistry` — a licence somebody can lose

A licensing registrar records that an address is a commune agriculture officer, an
agronomist, a school, a cooperative, an NGO, or an independent auditor (a
bitmask, so one body can hold several). Licences can be suspended and restored,
and suspension keeps the row — the record of who was licensed *when* is what a
dispute over a past attestation has to be settled against.

It is a licensing layer only. It knows nothing about KYC, freezes, or
observations; `GroveAnchor` combines a licence from here with an active identity
attestation and a clean enforcement record. Same separation as `MerchantRegistry`
vs `SocialProgramRegistry`: one office decides who is an agronomist, a different
one decides what an agronomist's signature is good for.

### 3.2 `GroveAnchor` — the record, and who went to look

`anchor(observationId, plotId, prevId, liveCount, species)` commits a Grove
record's **content hash** and nothing else. No GPS, no photo, no device key, and
no plot name *as text* — `plotId` is `keccak256` of the plot string, computed on
the device. A farmer's fruit trees are worth stealing, and a permissioned
national chain is still readable by everyone on it.

**The plot name is not protected by that hash, and the interface now says so.**
Names have to be short, memorable and speakable, because a verifier types one
into a phone while standing in a field — `home-garden-01` and
`plot/peam-krasop/mangrove-01` are our own examples. A wordlist of plausible
names crossed with a two-digit index is a few million candidates, which is
seconds of hashing against the anchored `plotId`s. Set beside the `liveCount` and
`species` committed in the same anchor, what a reader recovers is an addressable
inventory of a grower's most stealable assets. Hashing in the browser keeps the
name from the app server; it does nothing about a hash published on a ledger
every permitted party can read.

The fix is a **salted commitment** — `plotId = keccak256(plot ‖ salt)`, with the
salt held on the device and disclosed to a verifier on the visit. It is not done:
it changes the derivation in `iAny grove/core/csb.ts`, the name→plot lookup in
every consumer, and the recovery story when a phone is lost, so it is a change
across three repositories rather than a line edit. Until it lands, `/anchor.html`,
`/verify.html` and iAny's `/garden` panel state the limit plainly and advise
choosing a name the grower would not mind a stranger guessing. This is an
interim position, stated deliberately — not an oversight.

Three rules do the work:

- **One history per plot.** A new anchor must name the plot's current head as
  `prev`. Nobody can quietly maintain two histories of one garden and produce
  whichever is more flattering.
- **The plot has a steward.** Whoever anchors first owns the chain and is the
  only address that can extend it (they may appoint additional recorders — a
  spare phone, a cooperative's tablet). Without this, appending to a stranger's
  garden is a way to be paid for their trees.
- **Verification is not self-service.** `attest()` refuses self-attestation,
  refuses an unlicensed address, refuses a suspended licence, refuses a frozen
  account, and refuses a second attestation from the same verifier. **A single
  dispute withholds verification even against a confirmation** — a verifier who
  says "these trees are not there" has staked a licence on it, and the right
  answer is a human going to look, not arithmetic outvoting them.

### 3.3 `GroveTitle` — one share, one verified living tree

A grove becomes an ERC-3643-shaped permissioned token, for the same reason
`LandTitleToken` is one: the standard expects an identity registry deciding who
may hold, and CSB already has an authoritative national one.

The interesting rule is not issuance, it is that **the registrar cannot choose
the supply**. `syncSupply(plotId)` reads the verified living-tree count from
`GroveAnchor` and mints or burns the difference. There is no path in the contract
that mints a share against a tree nobody went to look at — `AGENT_ROLE` belongs
to the registry, not the registrar, and the registry's only mint path reads the
anchor.

Two consequences worth stating:

- **`syncSupply` is open to anyone.** Correcting the ledger toward what was
  verified should never wait on the issuer's convenience, and a sceptic being
  able to force the correction is worth more than a promise that the issuer will.
- **Supply goes down.** Trees die. When a verified record shows fewer standing,
  shares are burned. A green asset that cannot lose value when the green thing
  dies is precisely the instrument that discredited this field.

An unverified new record does **not** zero a grower's holding — `syncSupply`
reverts rather than treating "nobody has confirmed this yet" as "there are no
trees". And shares sold on cannot be burned from here; that reverts too, with
`supplyStatus()` saying so in words rather than the registry quietly taking a
third party's shares.

### 3.4 `GrovePledge` — money that only moves when the tree is still alive

Everyone has met the tree-planting photograph: a hundred people, a hundred
saplings, a press release, and a field of dead sticks eighteen months later that
nobody photographs. The failure is not insincerity. The money arrives on planting
day, so planting is what gets funded.

A sponsor deposits riel against a plot with milestones — *400 trees still
standing at month 12, 350 at month 24*. Each milestone releases only against a
Grove record that is anchored, **anchored after the milestone opened**, confirmed
by a licensed verifier, undisputed, and showing enough living trees. No proof, no
payment; the sponsor reclaims after the deadline.

```
Grower                 600,000.00 KHRt   if 400 are still standing at month 12
Verifier                50,000.00 KHRt   for making the visit
                       ──────────
Sponsor deposits       650,000.00 KHRt   held by the contract, not a promise
```

- **The verifier is a named payee.** Verification is a motorbike ride down a dirt
  road and an afternoon of somebody's life. Unpaid verification is verification
  that does not happen, which is how the whole voluntary market ended up trusting
  spreadsheets.
- **Proof must be newer than the milestone.** `anchoredAt >= notBefore`, checked
  against block time. Otherwise last year's healthy photograph pays out this
  year's survival check, which is exactly the trick this exists to prevent.
- **Compliance is not suspended in here.** A grower or verifier frozen by an
  enforcement order reverts the *whole* settlement — not even the verifier is
  paid. Same ordering `PaymentEscrow` uses, for the same reason.
- **The arbiter cannot name a payee.** They can release a milestone to the
  grower or return it to the sponsor, with a recorded reason. Letting them
  nominate a recipient would turn dispute resolution into a payment instruction.

## 4. The refusals are the demonstration

Run the demo and the interesting output is everything the chain says no to:

```
─── 8. Three ways to get paid without the trees ───
  Last year's healthy photograph, as proof of this year:
    → false: "this record predates the milestone: proof of survival has to be
              newer than the promise"
  Somebody else's 900-tree grove:
    → false: "this observation belongs to a different grove"
  Her own new record, before anyone has been to look:
    → false: "no licensed field verifier has confirmed this record, or it is
              disputed"

─── 9. The officer visits again and confirms ───
  The same record, confirmed by a licensed verifier:
    → true: ""
```

Every one of those is `canClaim()`, a view a wallet calls before anyone signs. A
sponsor deciding whether to fund can read them without a transaction.

## 5. Reading it from outside

```bash
curl "https://<csb-app>/grove?plot=$(keccak256 'plot/peam-krasop/mangrove-01')"
```

Public, read-only, CORS-open, no key. It returns the plot's anchored head, whether
a licensed verifier stands behind it and which licence, the title token and
whether its supply is in sync, and every pledge riding on the plot with each
milestone's status.

It is a convenience, not an authority: every field is an `eth_call` a reader could
make against the RPC node directly. That matters, because a "verified" badge in a
virtual grove is worth nothing if the only way to check it is to ask the project
that drew the badge.

CamboVerse consumes exactly this ([`src/grove/csb.ts`](https://github.com/camboversecenter/CamboVerse/blob/main/src/grove/csb.ts)),
computing `keccak256(plot)` locally, so the name is never sent as text and this
endpoint only ever receives the hash. That bounds what is transmitted and is not
a privacy guarantee — §3.2 says why, and the same paragraph applies here: a short
name is recoverable from an anchored `plotId`. Verification does not need the
name at all, and `/verify.html` now prefers a record id
(`/grove?observation=<id>`), which resolves the plot through `anchorOf` and keeps
the name out of the page, the URL and this server's log.

## 6. Deploying it onto a chain that already exists

**Do not run `scripts/deploy.js`.** That builds the whole suite from nothing and
would redeploy `IdentityRegistry` and `KHRStablecoin` with it — abandoning every
KYC attestation and balance already on the chain. The Grove suite has its own
additive deployer:

```bash
cd /opt/csb
git fetch origin && git checkout <branch> && npm install
source ops/csb-env.sh          # RPC, chain id, gas price, deployer key
npx hardhat compile
npx hardhat run scripts/deploy-grove.js --network csbRemote
```

It deploys only what is missing, wires the three permissions below, writes the
addresses into `app/deployments.json` beside the existing ones, and is safe to
re-run — a half-finished run is fixed by running it again.

Role holders default to the deployer. For anything beyond a pilot, give each its
own multisig, because the separation is the argument:

| Env var | Holds |
|---|---|
| `COUNCIL_ADDR` | verification threshold, minimum tier |
| `ATTESTER_REGISTRAR_ADDR` | licenses and suspends field verifiers |
| `GROVE_AUTHORITY_ADDR` | registers groves, issues titles |
| `PLEDGE_ARBITER_ADDR` | resolves disputed milestones |

### The three wirings, and what breaks without each

| Wiring | If missing |
|---|---|
| `AttesterRegistry.grantRole(RECORDER_ROLE, GroveAnchor)` | Verification still works; verifier **reputation silently stops accruing**. `GroveAnchor` swallows the failure on purpose — a registry misconfiguration must not block confirmation of real work in the field. |
| `GroveTitleRegistry` on the **`contractDeployerAllowList`** | `registerGrove` reverts **with no reason string at all** — the registry deploys a `GroveTitle` per grove, and that create is performed by the registry's own address. The least debuggable failure on this chain. |
| `KHRStablecoin.setSystemContract(GrovePledge, true)` | Every `fund()` reverts: the pledge custodies KHRt and has no personal identity to KYC, so it needs vetting exactly as the escrow and bridge adapter do. |

The script performs all three when the deployer holds the necessary role, and
prints an explicit `! COUNCIL ACTION NEEDED:` line with the exact call when it
does not — which is what you want once the roles are real multisigs.

### Then license a verifier, or nothing can ever be verified

An empty `AttesterRegistry` means every record anchors fine and none of them ever
becomes verified — no title can be issued, and no pledge can ever pay out. This
is the step that is easy to forget and looks like a bug:

Either from the **Admin console → Grove verifiers** tab, or from the command
line:

```bash
ATTESTER_ADDR=0x… ATTESTER_CLASSES=commune \
ATTESTER_LABEL="Commune agriculture officer, Sangkat Example" \
  npx hardhat run scripts/license-attester.js --network csbRemote
```

The licensed verifier then works at **`/verify.html`** — no login, because a
commune officer standing in a field does not hold the operator's passcode. They
look the grove up by name, and confirm or dispute with their own wallet.

A verifier has to pass **three independent gates**, and a licence alone satisfies
only one of them:

| Gate | Failure |
|---|---|
| Licence (`AttesterRegistry`) | `NotLicensedAttester` |
| Active KYC (`IdentityRegistry`) | `NotVerifiedIdentity` |
| `txAllowList` (the chain itself) | rejected before any contract runs — a bare `execution reverted` with no data to decode |

The script does all three and reports each, because handing someone a licence and
stopping there produces an officer who is licensed on paper and cannot attest to
anything — the worst of the three to debug. Re-running updates their classes and
label. To withdraw a licence use `setSuspended(addr, true)`, never
`removeAttester`: the record of who was licensed *when* is what a dispute over a
past attestation has to be settled against.

Label the **role**, not the person. This is a ledger a whole country can read.

### Restart the app server

`/grove` reads `app/deployments.json` at request time, but the server caches it;
restart so the new addresses are picked up.

```bash
sudo systemctl restart csb-app     # or however the app is supervised
curl -s "https://<host>/grove" | jq   # headline stats, no passcode
```

`/grove` is deliberately **public and CORS-open**, sitting above the passcode
gate with `/use-cases`. That is the point: a "verified" badge in a virtual grove
is worth nothing if the only way to check it is to ask the project that drew it.
It exposes nothing a reader could not obtain from an `eth_call`, and the demo
casts' private keys — which live in the same `deployments.json` — are kept out by
building every response field by field, asserted in `test/grove-endpoint.test.js`.

## 7. Running the demo

```bash
cd /opt/csb && source ops/csb-env.sh
npx hardhat run scripts/demo-grove.js --network csbRemote
```

It self-deploys anything missing, creates and KYCs its cast, licenses the
officer, and plays the whole story through. `CSB_PLEDGE_WINDOW` (default 60s)
compresses the survival year so the demo finishes in one sitting — nothing in the
contracts knows the difference between a minute and a year. `CSB_PLOT_REF` names
the plot if you want a fresh one.

One thing worth knowing before it confuses you:

- **Chain time is not wall-clock time.** Subnet-EVM produces a block when there
  is something to put in it, so a quiet chain's `block.timestamp` stops
  advancing and a script waiting on it waits forever. The demo sends a
  zero-value transaction on each poll, because milestone windows are checked
  against block time and that is the clock that matters.

## 8. What is still honest to say about it

The oracle problem is not solved here and cannot be. A licensed officer can be
lied to, can be lazy, or can be paid off; a photograph can be of a different
grove. What changes is the cost and the accountability: cheating now requires a
licensed professional to put their registration behind a false statement, on a
record with a timestamp they cannot backdate, for a payment that is visible to
the sponsor. That is not proof. It is a much worse deal for the fraudster than a
spreadsheet, which is the honest claim.

Registry-grade certification still requires an accredited methodology and an
accredited verifier. This is the cheap, open measurement and accountability
substrate underneath — and it pays for the trees that are still standing.
