# Grove — a reference architecture for verifiable green finance via digital twins

**Draft. This is a supplement, not a paper.** It accompanies the preprint
*Trees, Not Tonnes: Survival-Linked Settlement for Smallholder Green Finance*,
which makes the argument. This document specifies the architecture that argument
rests on — at the level of individual files and lines, against three pinned
commits — so that every structural claim in the preprint can be checked here
instead of taken on trust. It is not intended for separate publication and makes
no claim to standing on its own.

What follows is a design and its rationale, not an empirical study. Nothing here has been operated at scale, no
part of it has been audited, and the end-to-end path it describes has never been
run on a live chain.

**Nothing in this architecture is a carbon credit.** No token in any of the three
repositories represents CO₂. The unit of account is a tree.

---

## Evidence status legend

Every substantive claim carries one of these markers. They are used without
exception.

**What they are not.** This is a design document and there is no empirical
content in it. Nothing here has been deployed, no grower has used the system, no
verifier has been licensed, and no study of any kind has been conducted. Where a
claim is marked `[EXECUTED]`, a command was run and its output quoted — a test
suite counted, a file measured, a contract call made against a local chain. That
establishes what the code does. It establishes nothing whatever about whether the
architecture works, whether anyone would use it, or whether it would produce the
outcomes it is designed for. Those questions are untouched, and the markers exist
to keep the distinction visible rather than to suggest an evidential footing the
work does not have.

The reason for carrying the apparatus at all is narrow and practical: during
drafting it caught four claims that were false — two taken from documentation
that disagreed with the code, one from reading a single call site, and one that
survived a first review and failed a second. A design paper cannot be
evidence-based. It can still be wrong about its own artefact, and this is the
device for not being.

A fifth was caught by something else, and the distinction matters more than the
count. It was not a claim this apparatus could have tested: the disproving line
was already quoted in this paper, and the error was reasoning past it rather than
missing it. §0.4 records what did catch it, which was a reader disagreeing out
loud. The apparatus is necessary and it is not sufficient.

| Marker | Meaning |
|---|---|
| `[SPECIFIED]` | The design states it. No claim that code implements it. |
| `[IMPLEMENTED]` | Code exists at a pinned commit and its tests pass. |
| `[EXECUTED]` | Observed from a command whose output is quoted. Where a contract behaviour is marked so, it was executed in a local Hardhat environment against the compiled contracts — never on a live chain (§0.3). |
| `[ARGUED]` | Reasoning only. No code and no measurement. |
| `[CITE]` | A claim requiring external literature that has not been sourced. |
| `[OPEN]` | A known gap with no current answer. |

Convention borrowed from `CSB@29baa485:docs/paper-notes.md`.

---

## 0. Reproducibility — the pinned commits

All structural claims in this paper refer to these commits. Later revisions may
differ.

| Repo | Remote | Commit | Date | Files | Licence |
|---|---|---|---|---|---|
| iAny | https://github.com/sengtha/iAny | `ede2e3882f9441acd0b55ac6393b8d1d7759e55a` | 2026-08-12 | 316 | Apache-2.0 |
| CSB | https://github.com/sengtha/CSB | `29baa48567a0084bb0fce6f1dbb41f7bf17dc7bd` | 2026-08-14 | 226 | MIT |
| CamboVerse | https://github.com/camboversecenter/CamboVerse | `0fde2e9ecfc9487db78c5eb81fe720484f709c47` | 2026-08-16 | 912 | Apache-2.0 (data CC-BY-4.0) |

```bash
git clone https://github.com/sengtha/iAny                && git -C iAny       checkout ede2e388
git clone https://github.com/sengtha/CSB                 && git -C CSB        checkout 29baa485
git clone https://github.com/camboversecenter/CamboVerse && git -C CamboVerse checkout 0fde2e9e
```

File counts were regenerated with `git ls-files | wc -l` at each commit.

Commit counts are given with the method stated, because two methods disagree
substantially and the difference is not noise:

| Repo | `rev-list --count HEAD` | `--first-parent` |
|---|---|---|
| iAny | 383 | 364 |
| CSB | 264 | 244 |
| CamboVerse | 244 | 100 |

The 144-commit gap for CamboVerse reflects a merge-heavy history; neither figure
is wrong, and quoting one without the method invites exactly the challenge this
section exists to prevent.

An earlier working note recorded 79 / 56 / 168. Those figures were an artifact of
counting against **shallow clones** — clone depth rather than history — and do
not describe these repositories. They are not carried forward. `[EXECUTED]`

Citation format used throughout: `repo@sha:path:line`.

### 0.1 Regenerated numbers

Every count below is the test runner's own output. Repository markdown contains
stale figures and none of it is quoted.

| Suite | Command | Output |
|---|---|---|
| CSB, whole suite | `npx hardhat test` | `309 passing`, `14 pending`, 0 failing |
| CSB, Grove subset | `npx hardhat test test/grove.test.js` | `53 passing` |
| CamboVerse | `npm test` (vitest 2.1.9) | `Test Files 4 passed (4)`, `Tests 77 passed (77)` |
| CamboVerse, Grove subset | — | 40 (`csb.test.ts` 18, `grove.test.ts` 12, `keccak.test.ts` 10) |
| CamboVerse typecheck | `npm run typecheck` | clean (`tsc -b`, no output) |
| iAny `trace/core/companion.test.ts` | esbuild + node | `✅ ALL PASS: 41 passed, 0 failed` |
| iAny `trace/core/eudr.test.ts` | esbuild + node | `✅ 11 passed, 0 failed` |
| iAny `grove/` | — | **no test files exist** |

`[EXECUTED]`

**Test-count discrepancy, resolved.** `CSB@29baa485:README.md` states 206 tests.
The runner reports 309 passing and 14 pending. (Elapsed time is omitted throughout: it is machine-dependent and independent runs of this suite differ by several seconds.) A line-anchored count of `it(`
across `test/*.js` gives exactly 323 = 309 + 14, so the static count and the
runner agree and the README is simply stale. An earlier note recorded 435 for a
raw count; that figure does not reproduce (a raw count also gives 323). Only the
runner's output is used in this paper. `[EXECUTED]`

**A second discrepancy, with a different cause.**
`CamboVerse@0fde2e9e:GROVE_INTEGRATION.md:203` states 35 Grove tests; `vitest`
reports 40. This one is *not* staleness. A static count of `it(`/`test(` across
the three Grove test files gives 18 / 14 / 3 = 35, matching the document exactly,
while the runner reports 18 / 12 / 10. Static counting is unreliable in both
directions here — parameterised and generated cases are miscounted — which is the
general reason this paper quotes runner output only. `[EXECUTED]`

**A third, unprompted.** `CSB@29baa485:README.md:14` states "29 Solidity files:
19 production contracts, 5 interfaces, 4 test mocks, 1 library".
`find contracts -name "*.sol" | wc -l` gives 39, and the stated sub-counts sum to
neither figure. The same sentence advises the reader to regenerate counts rather
than quote them. `[EXECUTED]`

**A gap worth stating at the outset.** `iAny/grove/` — the origination plane,
which this architecture calls the source of truth — contains no test files at
this commit. The only automated coverage of the Grove record format is the
*vendored copy* inside CamboVerse (40 tests) and the on-chain behaviour in CSB
(53 tests). `[EXECUTED]`

### 0.2 Static sizes

| Component | Files | Lines |
|---|---|---|
| `CSB@29baa485:contracts/grove/` | 5 `.sol` | 1,443 |
| `CSB@29baa485:contracts/` (whole suite) | 39 `.sol` | 6,031 |
| `iAny@ede2e388:grove/` | 18 | 2,357 |
| `iAny@ede2e388:trace/` | 18 | 5,529 |
| `CamboVerse@0fde2e9e:src/grove/` | 11 | 1,889 |

`[EXECUTED]`

### 0.3 What has *not* been run

`CSB@29baa485:docs/deployment-status.md` is the running record of the CSB
testnet. It records the wallet, the KHRt transfer, the Fuji ICTT bridge in both
directions, and unmodified Uniswap V2 and Aave V3 as verified working
end-to-end. **It contains no mention of Grove.** A case-insensitive search for
`grove|GroveAnchor|GrovePledge|GroveTitle` across that file returns nothing.

Therefore the end-to-end path this paper describes — phone → anchor → licensed
confirmation → settlement → twin — is `[IMPLEMENTED]`, never `[EXECUTED]`. No
transaction hashes are offered because none exist. `[EXECUTED]`

### 0.4 What has been checked, and by whom

This paper's claims do not all rest on the same footing, and the difference is
not visible from the evidence markers alone. Recorded here so that no reader has
to reconstruct it.

**Checked twice, by two readers, one of whom executed them against the compiled
contracts:** the role-graph defect and its consequence for `syncSupply` (§4.2);
both arbiter paths and their exact checks (§7.3); the permanence and scope of the
dispute veto (§4.8); the absence of on-chain `plotId` derivation (§8.1); the
stale counts in `README.md` and `GROVE_INTEGRATION.md` (§0.1); and the absence of
tests under `iAny/grove/` (§0.1).

**Checked once, by reading the code:** the plane table (§3), the escalation
property on both sides (§3.2), invariants I2, I5, I6 and I7 (§4), the τ inputs
(§5.3), the viewer's verify-and-drop behaviour (§5.4), and the GPS-coarsening
conflict (§5.4).

**Argued, not demonstrated by anyone:** the plot-name enumeration attack (§7.1
and §8.1) — the reasoning about preimage space is straightforward but no one has
executed it; and the sponsor round-tripping hole (§7.1), which is a structural
observation about who funds a pledge, not a tested path.

**Corrected during review, and worth recording as a caution about method:** an
earlier draft asserted that the viewer renders three distinct provenance states
identically. That was wrong — `provenanceLabel` distinguishes them at
`CamboVerse@0fde2e9e:src/components/GroveGardenView.tsx:394` — and the error came
from reading one call site rather than all of them. §5.4 now states the narrower
true claim. The same class of error produced an earlier mis-description of
`refundByArbiter`, taken from its doc comment rather than its body.

**One correction is of a different kind, and is the reason this subsection
exists.** Asked whether losing a plot salt would mean losing payment, the author
answered that in general it would not: `claimMilestone` takes an observation id
rather than a plot name, so a record already anchored stays claimable without the
salt. That is true of exactly one case — a milestone whose window is already open,
whose qualifying record is already anchored, verified and unclaimed — and false of
a pledge.

`GrovePledge.sol:253` refuses any proof anchored before the milestone's
`notBefore`, with the reason in the comment immediately above it (`:251-252`):
*"The proof has to be NEWER than the milestone, or an old healthy record pays out
every future survival check."* And `:186` requires each milestone's
`notBefore` to be at or after the previous milestone's `deadline`, so a record
anchored in time for milestone N is by construction too old for milestone N+1. One
anchor can never serve two milestones. Every milestone therefore needs its own
fresh anchor, and so its own `plotId`, and so the salt, for the whole life of a
pledge. **A lost salt is a lost payment** — which was the claim being contradicted.

What makes this one worth separating: the other four errors came from trusting a
doc comment, or from reading too few call sites. Here the disproving line was in
output that had just been read, quoted in the same document, in the section
(§4.4) that exists to explain that very check. The failure was not missing
evidence but reasoning past it — noticing that the function signature takes an
observation id, and stopping before asking which observation ids the function
will accept. A method that catches the first four does not catch this one, and
nothing in this paper's apparatus would have caught it either; a reader
disagreeing out loud did.

**Not verified at all:** the citations in §2 — four `[CITE]` markers there, nine
across the paper excluding the legend row. No reference has been invented in
their place. (Two of the four have since been sourced; see §0.5.)

### 0.5 What has changed since this supplement was written

The supplement is pinned to the commits in §0 and every claim above remains
accurate about them. Work continued afterwards, and a reader comparing the
repositories against this document will find differences. They are listed here
rather than folded in, so the pinning stays honest.

**The plot-name claim was corrected at seven sites, not three.** §8.1 credits
`CSB@4fae96c` and `iAny@ec91c77` (21 August 2026) with removing the claim that the
chain cannot learn a grove's name. Those two commits fixed the three surfaces they
touched; five more instances were still live when that sentence was written —
CamboVerse `src/grove/csb.ts` and two test comments, iAny `grove/core/csb.ts`'s
module header and `grove/BRIDGE.md:136`, and CSB's own `docs/grove.md:237` and
`app/public/anchor.html:174`. All are now fixed, in `CSB@3245244`,
`CamboVerse@ecf97f4`, `iAny@96b506d` and `CSB@261cfc1`.

Two of those deserve recording as method, not housekeeping. `iAny`'s
`grove/core/csb.ts` asserted the guarantee in its module header and denied it in
the `plotKey` comment forty lines below, because `ec91c77` corrected one and did
not read upward to the other — a file that contradicted itself for a month.
`app/public/anchor.html` did the same: `4fae96c` rewrote its lead paragraph and
left the calldata decoder labelling the plot row *"a hash; the chain never learns
its name"*, on the screen a grower reads immediately before signing. **Fixing half
a file is worse than fixing none of it**, because the reader who finds the header
has no reason to scroll to the correction. The general lesson, which the sequence
paid for six times over: when a claim is wrong, grep every repository for its
shape before fixing the first instance, not after.

**Verification no longer requires the plot name.** `CSB@3245244` added
`/grove?observation=<id>`, resolving an observation id to its plot through
`anchorOf`, and made a record id the primary route in `verify.html`. The page had
been reading `?plot=<name>` straight out of the query string, which put the name
into browser history, referrer headers and every server log that saw the request.
`?plot=` in a deep link is now refused rather than redirected: a fallback that
still accepted a name would be the path every existing QR code kept using.

**The salted commitment is no longer described as "the fix".** §8.1 recommends it
as the immediate answer to enumeration. `docs/grove-plot-identity.md` supersedes
that recommendation, on a fact §8.1 does not state: iAny's publish worker serves
`plot` **verbatim** in the public feed and takes it in a URL path, so salting the
on-chain `plotId` protects only growers who never publish — and publishing is what
the federation is for. The note separates the on-chain problem (A) from the
record-format problem (B), recommends B, and shows that A alone would switch off
CamboVerse's entire provenance layer, because the viewer derives the plot key from
the name in two places and can hold no salt. Recovery is unresolved and is the
decision both turn on: after either change, a lost salt makes a plot permanently
unextendable while `plotSteward` still names the grower, and `GrovePledge.claim`
requires a matching `plotId`, so it is a lost payment against standing trees.

**The role-graph defect of §4.2 is fixed.** `_deployTitle` now seeds each title's
`DEFAULT_ADMIN_ROLE` from a council-held, council-settable `titleAdmin` rather
than `_msgSender()`. §4.2, §7.1 and §10 remain accurate about `29baa48` and should
be read as describing that commit. The escalation was also **wider than §4.2
states**: `AGENT_ROLE` gates `burn`, `setAddressFrozen` and `setPaused` as well as
`mint`, so the self-grant yielded control of the asset, not only its supply.

**What the fix buys is separation, not removal, and a revision must not say
otherwise.** §4.2 recommends passing the council "so that token governance and
grove registration are not the same office", and that is exactly what was done —
two offices where there was one. The powers themselves are unchanged: the council
holds `DEFAULT_ADMIN_ROLE` on every title and can grant itself `AGENT_ROLE`, mint
against no anchored count, burn, freeze and pause, and wedge `syncSupply` on
`SupplyDriftUnresolved` in precisely the way the original defect did. That is the
design — the council is the trusted root — but I1 does not become absolute, and a
revised §4.2 that reads as though it does would replace a disclosed defect with an
undisclosed assumption. The relocation is now asserted in the test suite rather
than left implicit, so a future change to the council's powers fails a test.

One bound survives and was found by writing that assertion rather than by reading
the contract: `GroveTitle` gates the recipient on the identity registry, so a mint
reverts `NotVerified` for an unregistered address. An escalation cannot end in a
stranger's wallet. That is a weak limit — any registered address will do — but it
is real and was not stated anywhere.

**§7.1's adversary table has no council row, and the capability moved into it.**
The table models a "Grove authority" whose powers this fix removes. It does not
model the council at all, in a system where the council is `DEFAULT_ADMIN_ROLE`
on the identity registry, the enforcement registry, the anchor, the title
registry and now every title. A threat model that omits its own root of trust is
incomplete in the direction that matters least under a single-key deployment,
where every role is one key anyway, and most under the separated deployment the
architecture is written for. A revision should add the row and state plainly what
constrains that party: nothing on chain, and the identity gate on recipients.

**Two of §2's four citation gaps have been sourced** — §2.1 (Chave et al. 2014)
and §2.3 (Probst et al. 2024; West et al. 2023). §2.2 (digital twins) and §2.4
(EUDR) remain genuinely unsourced.

---

## 1. Introduction

### 1.1 The puzzle

Verification cost, not instrument design, is what excludes smallholder-scale
green action from finance. An audit regime priced for a plantation cannot be
run over a half-hectare mixed garden, and the fixed cost of establishing that a
tree is still standing exceeds the value of the claim being established. What
fills the resulting vacuum is unverified planting: money that arrives on
planting day, a photograph, and no one funded to return. `[ARGUED]` `[CITE]`

### 1.2 Thesis

> The binding constraint on green finance at smallholder scale is the unit cost
> of a credible claim, not the design of the financial instrument. This paper
> specifies an architecture that attacks that cost, and states what it refuses
> to do in order to stay honest.

### 1.3 The escalation model, in one paragraph

Grove is a stack of seven planes. Each adds exactly one property, costs more
than the plane below it, and is invoked only when the stakes justify it. A
garden diary needs plane 1 — a content-addressed, device-signed record that
verifies offline with no server and no directory. A payment needs planes 4
through 6 — an independent clock, a licensed human witness, a unit whose supply
the issuer cannot choose, and an escrow that settles only against a fresh
confirmation. The visual twin, plane 7, is a consumer of the same records and
authoritative over none of them. Crucially the escalation is *optional in both
directions*: an unanchored record is exactly as valid as an anchored one, and a
consumer with no chain configured renders the same garden.

### 1.4 Grove is the architecture; CSB is one plane

A natural misreading of this work is that it is a blockchain project with a
phone application attached. That reading is wrong and the code says so.

The phone is the source of truth. A record is valid because it verifies, not
because a server or a chain vouches for it —
`iAny@ede2e388:grove/SPEC.md:25-26`, and in code at
`iAny@ede2e388:grove/core/csb.ts:4-8`:

> *"Grove's contract with the world is that THE PHONE IS THE SOURCE OF TRUTH: a
> record is valid because it verifies, not because a server or a chain vouches
> for it. Nothing in this file changes that. A Grove record that was never
> anchored is exactly as valid as one that was."*

`[IMPLEMENTED]`

### 1.5 What this supplement covers

1. **The layered escalation reference model** (§3): seven planes, each with a
   stated addition, cost, and refusal, and each traced to implementing code.
2. **The seven architectural invariants** (§4), each with a named enforcing
   component, a line citation, and the adversary it defeats — including an
   honest account of where the strongest of them does not hold absolutely.
3. **The twin-staleness formulation** (§5) that turns "digital twin" from a label
   into a design parameter τ with a cost curve, and poses the question of how
   stale a twin may be before its economic shadow must stop paying.
4. **The design rationale** (§6–§8), including three ways the architecture fails
   and seven open architectural problems, each with a recommendation.

---

## 2. Background and related work

Four literatures bear on this design. **None of the citations below has been
sourced for this draft**; each is marked `[CITE]` and must be filled with real
references before the paper is circulated. No reference has been invented.

### 2.1 Digital MRV

What measurement, reporting and verification has automated — remote sensing for
canopy extent and change detection, sensor networks for continuous variables —
and what still requires a person on the ground. Species-level counts in a mixed
smallholding are the hard case: the thing being counted is neither large enough
nor uniform enough for the automated methods that work at plantation scale.
`[CITE]`

### 2.2 Digital twins

The engineering definition — maintained correspondence, stated fidelity,
synchronisation — as developed in the built-environment and precision-agriculture
literatures. §5 depends on this: the argument there is that the literature's
emphasis on fidelity and integration under-weights staleness, and that for an
economic twin staleness is the governing parameter. `[CITE]`

### 2.3 Tokenised nature and ReFi

Proposals to tokenise environmental claims, and the documented post-mortems of
the voluntary carbon market. Primary post-mortems only; not blog posts. The
architectural reading offered here is that the failures were not caused by
insufficiently liquid instruments, and that adding liquidity to a weak claim
makes the failure larger rather than smaller. `[CITE]`

### 2.4 Mandatory traceability regimes

EUDR is the strongest landing point available, because it is mandatory, is about
origin and geolocation rather than counterfactual quantification, and is already
the target of the sibling module `iAny@ede2e388:trace/` — whose EUDR geometry
tests pass (`11 passed, 0 failed`, §0.1). §8.7 develops this. `[CITE]`

---

## 3. The reference model

### 3.1 The seven planes

| # | Plane | Adds | Costs | Refuses | Implemented at |
|---|---|---|---|---|---|
| 1 | Origination | Content-addressed, device-signed claim; verifies offline; no directory needed — the public key travels inside the record | A phone | To be a server; to require connectivity | `iAny@ede2e388:grove/core/grove.ts:275-306`; `grove/web/store.ts:65-78` |
| 2 | Federation | Availability and re-sharing, with verify-on-ingest | A node anyone can run | To be authoritative | `iAny@ede2e388:grove/worker/handlers.ts:118-144` |
| 3 | Peer attestation | Cheap corroboration; a legible score | Another phone | To let anonymous co-signatures count as accountability | `iAny@ede2e388:grove/SPEC.md:100-118`; `grove/core/grove.ts:348-360` |
| 4 | Notarisation | An independent clock; a non-forking plot history; licensed witnesses | A chain, KYC, gas | To store GPS, photo or device key; to verify truth | `CSB@29baa485:contracts/grove/GroveAnchor.sol:158-195`, `AttesterRegistry.sol` |
| 5 | Representation | A unit whose supply the issuer cannot choose | A registrar | To denominate CO₂; to let supply only rise | `CSB@29baa485:contracts/grove/GroveTitleRegistry.sol:183-213`, `GroveTitle.sol` |
| 6 | Settlement | Payment conditioned on survival; the verifier as a named payee | A sponsor | To pay on planting day | `CSB@29baa485:contracts/grove/GrovePledge.sol:245-262, 333-343` |
| 7 | Twin surface | Legibility, and independent re-verification by non-experts | A renderer | To trust the server it read from | `CamboVerse@0fde2e9e:src/grove/client.ts:181-191`, `src/grove/csb.ts` |

`[IMPLEMENTED]` for every row.

### 3.2 The escalation rule, implemented on both sides

The rule is that **each plane is additive and optional, and no plane may
invalidate a record produced without it.** It is asserted in the design and
enforced in code on both the producer and consumer sides — which is what
distinguishes it from a slogan.

**Producer side.** `iAny@ede2e388:grove/ANCHORING.md:3-7`:

> *"An unanchored record is exactly as valid as an anchored one, and every
> consumer — a dashboard, CamboVerse, a ministry — verifies both the same way,
> offline, with no chain involved."*

The anchoring module cannot transmit; it returns calldata only, and a wallet the
grower controls sends it — `iAny@ede2e388:grove/core/csb.ts:174-176, 195`.

**Consumer side.** `CamboVerse@0fde2e9e:src/grove/csb.ts:19-22`:

> *"This module is strictly additive and strictly optional. If no CSB node is
> configured, or it is unreachable, or the grove was never anchored, the garden
> renders exactly as it does today from the signed records alone."*

Enforced at four independent points: the endpoint defaults to empty
(`CamboVerse@0fde2e9e:src/grove/csb.ts:140`); the effect never fires when it is
empty (`src/components/GroveGardenView.tsx:171`); network and HTTP failures
degrade to `{available:false}` rather than throwing
(`src/grove/csb.ts:165-172`); and the tier helpers accept `undefined` and return
`"unanchored"` (`src/grove/csb.ts:246-252, 264-269`). Tests assert the
behaviour: `src/grove/csb.test.ts:113-121` *"degrades to unavailable when the
chain is unreachable"* and `:173-177` *"never claims verification from a chain it
could not reach"*. `[IMPLEMENTED]`

This bidirectional property is the reference model's load-bearing claim. A stack
in which the chain is optional to write but mandatory to read is not
chain-optional.

---

## 4. Invariants

### 4.1 The invariant table

| ID | Invariant | Enforced at | Adversary defeated | Status |
|---|---|---|---|---|
| I1 | Supply is downstream of verification | `GroveTitleRegistry.sol:192-193, 199-200` | An issuer minting shares against uninspected trees | **Does not hold — §4.2** `[EXECUTED]` |
| I2 | The ledger corrects downward | `GroveTitleRegistry.sol:201-210`; `GroveTitle.sol:126-130, 186-189` | A green asset that cannot lose value when the green thing dies | `[IMPLEMENTED]` |
| I3 | Anyone may force the correction | `GroveTitleRegistry.sol:183` | An issuer who defers an inconvenient write-down | **Conditional on I1; bricked when I1 is broken — §4.2** `[EXECUTED]` |
| I4 | Freshness is a payment precondition | `GrovePledge.sol:253`; `GroveAnchor.sol:182` | Last year's photograph offered as this year's proof | Holds on the claim path; **bypassed by `releaseByArbiter` — §7.3** `[EXECUTED]` |
| I5 | The verifier is a paid, named payee | `GrovePledge.sol:257-258, 262, 342-343` | Unpaid verification, which is verification that does not happen | `[IMPLEMENTED]` |
| I6 | No on-chain object denominates CO₂ | all five contracts | Wrapping the weakest claim in the strongest instrument | `[IMPLEMENTED]` |
| I7 | Verification needs no privileged access | ~40 public views; `GroveAnchor.sol:263-315` | A badge checkable only by asking whoever issued it | `[IMPLEMENTED]` |

### 4.2 I1 and I3 — the pair, and where I1 stops

Lead with the pair, because together they state something unusual: **the issuer
cannot choose the supply, and anyone can force it back to the verified count.**

`syncSupply` reads the verified live count at the plot head and mints or burns
the difference — `CSB@29baa485:contracts/grove/GroveTitleRegistry.sol:192-193`:

```solidity
verified = anchorRegistry.verifiedCountOf(plotId);
if (verified == 0) revert NoVerifiedRecord(plotId);
```

and the count is read from the plot head only, returning zero unless that head is
verified — `GroveAnchor.sol:286-291`. The function carries **no modifier, no
role, and no access control** — `GroveTitleRegistry.sol:183`. A sceptic can
therefore push the token back to reality without the issuer's cooperation.

That is the design, and it is written down as intent at
`GroveTitleRegistry.sol:151-153`:

> *"Agent powers go to the registry itself, because supply is a mechanical
> function of the anchored record and must not be a discretionary power anyone
> holds."*

**The role graph does not enforce it, and the two invariants fail together.**

`GroveTitle.sol` never calls `_setRoleAdmin` — nothing in `contracts/` does — so
`getRoleAdmin(AGENT_ROLE)` returns `DEFAULT_ADMIN_ROLE`, which
`GroveTitleRegistry.sol:166` hands to `_msgSender()`: the grove authority calling
`registerGrove`. `AGENT_ROLE` itself goes to the registry
(`:167`, `agent: address(this)`), which is correct and insufficient.

Executed against the compiled contracts in a local Hardhat environment:

```
admin of AGENT_ROLE: 0x0000…0000 (DEFAULT_ADMIN_ROLE)
groveAuthority holds DEFAULT_ADMIN_ROLE: true
PASS  direct mint by groveAuthority reverts (what the suite tests)
PASS  groveAuthority granted ITSELF AGENT_ROLE
supply after self-granted mint: 1000500   verified count: 500
```

Two transactions — `grantRole(AGENT_ROLE, self)`, then `mint` — and the grove
authority issues unlimited unverified shares. I1 holds only against a holder who
declines to use a power it already has. `[EXECUTED]` (local execution; nothing in
this paper has run on a live chain — §0.3)

**I3 does not survive I1, and this is the more serious half.** `_sync` burns only
from the steward (`GroveTitleRegistry.sol:209`). Once shares exist at another
address, `held < shortfall`, and the correction reverts — permanently:

```
supplyStatus -> inSync=false reason="shares have been sold on and cannot be burned from here"
PASS  syncSupply now REVERTS (SupplyDriftUnresolved) — correction is bricked
```

So the property this paper called its strongest governance guarantee is
*conditional on the role graph being right*, and an actor who breaks I1 disables
the mechanism that was supposed to police them. `supplyStatus` additionally
mis-reports the cause — it says shares were sold on, when they were minted from
nothing. `[EXECUTED]`

**The second mint call site is benign.** `GroveTitleRegistry.sol:242-246` reads
`balance` once, then burns and mints exactly that amount, so `setSteward` is
balance-neutral in every path (measured: `supply 500 -> 500`), is guarded by the
same-identity check at `:236-239`, and re-enters `_requireCanHold` on the mint
leg. The comment at `:146-147` claiming "exactly one place in this contract where
shares come into existence" is true of *net supply* and false of *`mint` call
sites*. `[EXECUTED]`

**A test asserts the wrong thing.** `CSB@29baa485:test/grove.test.js:414-425`,
"keeps supply authority with the mechanism, not with the registrar", asserts that
`hasRole(AGENT_ROLE, groveAuthority)` is false and that a direct `mint` reverts.
Both are true; neither is the question. It checks that a door is locked in a room
where the same person holds the key cabinet. We record it because a test of that
shape reads as assurance and supplies none, and because the pattern is worth
grepping for elsewhere. `[EXECUTED]`

**Recommendation.** The narrow fix is `_setRoleAdmin(AGENT_ROLE, <role nobody
holds>)` in the `GroveTitle` constructor. The better one is to pass the council
rather than `_msgSender()` as `authorityAdmin` at `GroveTitleRegistry.sol:166`,
so that token governance and grove registration are not the same office. Under
the current single-key deployment neither changes anything, because one key holds
every role already — but separation is precisely the configuration the invariant
exists for, and precisely the one in which it fails. `[OPEN]`

### 4.3 I2 — the ledger corrects downward

`GroveTitleRegistry.sol:201-210` burns the shortfall when the verified count
falls. The burn deliberately bypasses freeze and consent checks via an
`_inForcedBurn` flag — `GroveTitle.sol:126-130, 186-189` — so that a compliance
hold cannot prevent the ledger telling the truth about dead trees.

Two refusals bound it, both confirmed in code. A fresh unattested head cannot
drive supply to zero: the revert at `GroveTitleRegistry.sol:193` precedes all
arithmetic, so "nobody has confirmed this yet" never becomes "there are no
trees". And shares sold on cannot be burned from here —
`GroveTitleRegistry.sol:209` reverts `SupplyDriftUnresolved`. Human-readable
equivalents live in the `supplyStatus` view (`:275-297`), e.g. `:293` *"shares
have been sold on and cannot be burned from here"*. `[IMPLEMENTED]`

A consequence worth recording: because `_sync` reverts on `verified == 0`,
`g.lastSyncedCount` can never be written as zero after registration, so a grove
whose head is unverified silently retains its last-good supply until a verifier
acts. `[IMPLEMENTED]`

### 4.4 I4 — freshness

`CSB@29baa485:contracts/grove/GrovePledge.sol:253`:

```solidity
if (a.anchoredAt < m.notBefore) revert ProofTooOld(observationId, a.anchoredAt, m.notBefore);
```

`anchoredAt` is block time, not the phone's clock —
`GroveAnchor.sol:182`: `anchoredAt = uint64(block.timestamp);`. The device's own
`observedAt` is described in the record type as *"WHEN — device clock, an
unverified claim"* (`iAny@ede2e388:grove/core/grove.ts:55-56`), which is
precisely why settlement does not use it. `[IMPLEMENTED]`

### 4.5 I5 — the verifier is paid

`GrovePledge.sol:257-258` binds the payee to the record's first confirmer and
refuses to settle a milestone that carries a verifier fee with no verifier
recorded; `:342-343` transfers to grower and verifier in the same transaction;
`:262` records `m.paidVerifier`. `[IMPLEMENTED]`

The argument for this being an invariant rather than a policy choice: unpaid
verification does not happen, and a field that does not fund the visit ends up
trusting whatever document arrives instead. `[ARGUED]`

### 4.6 I6 — no CO₂ on chain

An exhaustive case-insensitive search for `co2|carbon|tonne|tco2` across all five
Grove contracts returns exactly four hits, **all inside comments** —
`GroveAnchor.sol:19`, `GroveTitle.sol:14`, `GroveTitle.sol:34`,
`AttesterRegistry.sol:151`. Zero occurrences in any variable, struct field,
event, error, function signature or string literal. `[EXECUTED]`

The estimate exists — `iAny@ede2e388:grove/core/grove.ts:51-52` defines `co2Kg`
on the record — and is deliberately left on the device and in the viewer, where
nothing acts on it. It does not cross onto the chain:
`iAny@ede2e388:grove/core/csb.ts:187-193` assembles calldata from exactly five
values and `obs.co2Kg` is never referenced. `[IMPLEMENTED]`

### 4.7 I7 — verification needs no privileged access

Unauthenticated public and external views across the suite include
`anchorOf`, `isAnchored`, `isVerified`, `verifiedCountOf`, `headOf`, `canAnchor`,
`canAttest` (`GroveAnchor.sol:263-315`), `supplyStatus` and `groveOf`
(`GroveTitleRegistry.sol:252-297`), `canClaim` (`GrovePledge.sol:402`), and the
licence views on `AttesterRegistry.sol:131-162`. On the consumer side the read
endpoint is a single unauthenticated GET —
`CamboVerse@0fde2e9e:src/grove/csb.ts:166`. `[IMPLEMENTED]`

### 4.8 An eighth property the code has and the design did not claim

`attest()` refuses six conditions, each at a named line —
`CSB@29baa485:contracts/grove/GroveAnchor.sol:227-233`: unknown observation,
self-attestation, duplicate verifier, unlicensed or suspended attester (folded
into one check via `AttesterRegistry.sol:146`), enforcement freeze, and inactive
KYC.

But the rule that *a single dispute withholds verification* is **not** in
`attest()`. `attest` only increments `a.disputes` (`:240`). The withholding lives
in the view — `GroveAnchor.sol:280`:

```solidity
return a.disputes == 0 && a.confirms >= requiredConfirmations;
```

`a.disputes` is written in exactly two places — initialised to zero at `:191`,
incremented at `:240`. There is no decrement, no clear, and no admin override;
`hasAttested` (`:235`) is never reset, so even the disputer cannot re-attest.
Executed: `isVerified` false after one dispute, `verifiedCountOf` zero, and
re-attestation reverts `AlreadyAttested`. `[EXECUTED]`

**The scope is per observation id, not per plot**, and this matters. Because
`verifiedCountOf` reads only the plot head (`:286-291`), a fresh anchor extending
the head restores the plot at once — measured, `verifiedCountOf(plot) = 500`
after a new record. The disputed id stays unverified forever; the grove does not.

The cost still falls on the grower, and falls hard while the disputed record is
head: `syncSupply` reverts `NoVerifiedRecord`, and pledge claims fail, until a
new record is anchored *and* a verifier confirms it. The rule itself is reasoned
at `GroveAnchor.sol:273-275` and we think it is right — a licensed verifier
staking a registration on "these trees are not there" should not be outvoted
arithmetically. What is undocumented is that it is *irreversible*: a mistaken or
malicious dispute cannot be withdrawn by anyone, including the person who filed
it. `[EXECUTED]`

---

## 5. The digital twin, defined properly

### 5.1 Three twins, distinguished

The word "twin" is doing three jobs in this system and they should be separated.

| Twin | The object | Where |
|---|---|---|
| **Data twin** | The signed observation chain for a plot — species, count, measure, `prev` | `iAny@ede2e388:grove/core/grove.ts:36-66` |
| **Economic twin** | The title token whose supply tracks the verified live count | `CSB@29baa485:contracts/grove/GroveTitle.sol` |
| **Visual twin** | The rendered scene a person walks through | `CamboVerse@0fde2e9e:src/components/GroveGardenView.tsx` |

### 5.2 The missing piece

> **A twin is a maintained correspondence with a stated fidelity and a stated
> staleness. What makes an economic twin sound is not its resolution but its
> staleness bound.**

The digital-twin literature grades correspondence largely by fidelity and
synchronisation `[CITE]`. For a twin that money depends on, neither is the
binding property. A high-fidelity model refreshed once a decade is worthless as
a basis for payment; a single integer refreshed monthly by an accountable
witness is not.

### 5.3 τ — staleness as a design parameter

Define **τ(p)** for a plot *p* as the elapsed time since the last
licensed-confirmed observation at that plot's head — that is, since the most
recent record for which `isVerified` returns true.

τ is computable today from public state: `anchoredAt` on the head
(`GroveAnchor.sol:182`, exposed via `anchorOf` at `:263`) and `isVerified`
(`:277`). No contract currently references it. `[IMPLEMENTED]` for the inputs;
`[OPEN]` for the parameter.

**Three observations.**

**(a) τ is presently unbounded.** Refresh happens when the grower chooses to
anchor and a verifier chooses to visit. Nothing in the architecture requires
either. Divergence — the trees died last month — is undetectable until the next
record, and the title's supply meanwhile retains its last-good value
(§4.3). `[IMPLEMENTED]`

**(b) A local τ bound already exists at the settlement plane.**
`GrovePledge.notBefore` is exactly a freshness window: proof must be newer than
the promise (`GrovePledge.sol:253`), and the milestone is additionally bounded
above by a deadline (`:245-246`). So the design already contains the idea of
τ — it simply applies it once, per milestone, at one plane. `[IMPLEMENTED]`

**(c) The generalisation.** Make token validity, discount, or payment
eligibility an explicit function of τ, applied at every plane rather than at
settlement alone. Candidate forms, in increasing order of intrusiveness:

1. **Disclosure.** `supplyStatus` returns τ alongside its existing reasons, so
   any reader can see how old the backing observation is. Costs nothing;
   changes no behaviour. Recommended as the immediate step.
2. **Discount.** A view returns an effective count `f(verified, τ)` that decays
   with staleness, leaving supply untouched but giving downstream instruments a
   principled haircut.
3. **Expiry.** `isVerified` gains a τ ceiling above which a head is no longer
   treated as verified, so supply must be re-synced downward. This is the
   strongest and the most dangerous: it converts a grower's inability to obtain
   a visit into an automatic write-down of their asset.
4. **Eligibility.** Pledges refuse to settle when τ exceeds a bound at claim
   time, independently of `notBefore`.

**The cost curve.** Keeping τ small is not free, and the cost differs per plane:
plane 1 costs a few minutes of the grower's time; plane 3 costs another
smallholder's attention; plane 4 costs a licensed officer's visit — a motorbike
ride and an afternoon, which is the dominant term; planes 5 and 6 cost only gas
once a visit exists. The architecture's economics are therefore driven almost
entirely by the frequency of the plane-4 visit, which is precisely why I5 makes
that visit a paid line item rather than an externality. `[ARGUED]`

**The research question, plainly:** *how stale may a twin be before its economic
shadow must stop paying?* We do not answer it. We note that the answer is
domain-specific — a mangrove seedling's survival is far more informative at
month 12 than a mature stand's — and that the architecture currently leaves it
entirely to the sponsor's choice of `notBefore`. `[OPEN]`

### 5.4 The visual plane is an audit surface, not decoration

The visual twin is usually dismissed as presentation. Here it is an
accountability property, for one reason: it is the only surface on which a
person who cannot read a contract can check the claim.

The renderer re-verifies every record itself before drawing it —
`CamboVerse@0fde2e9e:src/grove/client.ts:185`:

```ts
if (!(await verifyObservation(obs)).ok) return null;
```

Records that fail are dropped and **counted**, and the count is displayed:
`src/components/GroveGardenView.tsx:146-150` renders
`` `${page.records.length} verified from node` `` plus
`` ` · ${page.dropped} dropped` `` when non-zero. The footer states the property
outright (`:304-307`): *"Every record is verified on this device — nothing here
is trusted from a server."* `[IMPLEMENTED]`

This is a refusal in the same sense as the contract refusals: a failing record
is not drawn faintly or flagged, it is not drawn at all, and the viewer says how
many were discarded.

**Two honest qualifications.** First, the feed cannot be verified as served,
because the node coarsens coordinates to two decimal places (~1 km) for privacy
— `iAny@ede2e388:grove/worker/handlers.ts:246-248` — which changes the signed
bytes. The client therefore re-fetches each record's exact signed form from
`/observation/:id` (`grove/worker/handlers.ts:272-283`;
`CamboVerse@0fde2e9e:src/grove/client.ts:137-147`) and verifies that. Privacy
coarsening and signature verification are in direct conflict, and the resolution
is to serve two representations and pay for the round trips. `[IMPLEMENTED]`

Second, **plant solidity conflates licensed confirmation with anonymous
co-signature.** Opacity is driven by `trustOpacity`
(`CamboVerse@0fde2e9e:src/grove/garden.ts:184`, `0.4 + 0.6·trust/100`) fed by
`trustScore` (`src/grove/grove.ts:348-353`), which awards +18 per distinct
co-signing device and −25 per dispute. None of those devices need hold a licence,
and device keys can be generated in any number. So a plot made solid by twenty
self-generated signatures and a plot made solid by a licensed field verifier
render identically in the geometry. `[IMPLEMENTED]`

What corrects this, and what an earlier draft of this paper got wrong: the
plot-level label *does* distinguish the states, in words. `provenanceLabel`
(`src/grove/csb.ts:246-253`) returns one of "Signed on a device", "Signed on a
device · not anchored on CSB", "Anchored on CSB · awaiting a licensed verifier",
"Anchored on CSB · disputed by a licensed verifier", or "Verified by a licensed
field verifier", and it is rendered with its tier glyph at
`src/components/GroveGardenView.tsx:394`. The audit surface therefore carries
the distinction the geometry loses.

One inconsistency remains between the two surfaces. The per-plant tag suppresses
the glyph for unanchored plots — `GroveGardenView.tsx:758`, `tier !== "unanchored"`
— while the plot label at `:394` shows it. The comment above the guard explains
the intent ("a green tick means somebody with a licence went and looked"), so
silence at the plant level is a deliberate refusal to make a claim rather than a
defect. We record it because the two surfaces answer the same question
differently. `[IMPLEMENTED]`

**The honest summary of the audit surface**: strong for record integrity, which
is checked and counted on the reader's own device; weaker for witness
accountability, which is stated at the plot label and lost in the geometry.

## 6. Design rationale

Each choice, its rejected alternative, and its cost.

### 6.1 Chain-optional rather than chain-first

**Alternative:** make the chain the system of record. **Rejected because** it
makes connectivity a precondition for a farmer seeing her own garden —
`iAny@ede2e388:grove/core/csb.ts:287-289`: *"an offline-first app must never
make a chain a prerequisite for showing somebody their own garden."*
**Cost:** two verification paths to maintain, and a consumer that must handle
"anchored", "unanchored" and "chain unreachable" as distinct states.

### 6.2 Trees as the unit rather than tonnes

**Alternative:** denominate the token in CO₂. **Rejected because** `co2Kg` is an
allometric estimate over a self-reported measurement — the weakest claim in the
stack — and a transferable credit is the strongest available wrapper. Putting
one inside the other is the move that discredited voluntary carbon markets.
A tree is the largest claim this stack supports: falsifiable by walking there.
**Cost:** the unit does not connect to any existing carbon market price, so
valuation is bilateral (§8.5). `[ARGUED]`

### 6.3 Licensed human witnesses rather than anonymous stake

**Alternative:** a staking or reputation game among anonymous attesters.
**Rejected because** the design's own documentation states the problem:
attestations come from *"device keys anybody can generate by the thousand"*
(`iAny@ede2e388:grove/ANCHORING.md:26`), and `trustScore` is explicitly *"NOT
authority — just a legible signal"* (`grove/core/grove.ts:344-347`). A licence
that a registrar can suspend is a stake that cannot be bought back cheaply.
**Cost:** the architecture inherits an institution it does not control, and
cannot function where no licensing body exists (§10).

### 6.4 ERC-3643 shape rather than an issuer allowlist

**Alternative:** the issuer maintains its own list of permitted holders.
**Rejected because** the chain already has an authoritative identity registry,
and compliance drawn from a layer that is already true is cheaper and harder to
subvert than a list a token contract maintains for itself. **Cost:** the token
is unusable outside a chain that has such a registry.

### 6.5 Hash-only on chain

Exactly five values are sent: `observationId`, `plotId`, `prevId`, `liveCount`,
`species` — `iAny@ede2e388:grove/core/csb.ts:187-193`. **No GPS, no photo, no
photo hash, no device key, no plot name, no note** —
`grove/ANCHORING.md:45`. Confirmed by absence: `obs.gps`, `obs.photoHash` and
`obs.device` are never referenced in `anchorCall`. And confirmed on the contract
side: a search for `pubkey|publicKey|deviceKey|signature|ecrecover` across the
five contracts returns only comment hits, and the `Anchor` struct
(`GroveAnchor.sol:52-62`) stores hashes, an address, a timestamp and counts.
**Rejected alternative:** publishing coordinates for auditability.
**Rejected because** a farmer's fruit trees are worth stealing and a national
chain is readable by everyone permitted onto it. **Cost:** an auditor cannot
locate a plot from chain data alone; §8.1 is the price of this choice.
`[IMPLEMENTED]`

### 6.6 Permissionless `syncSupply` rather than issuer-triggered

**Alternative:** the registrar calls `syncSupply` on a schedule.
**Rejected because** correcting a ledger toward what was verified should never
wait on the issuer's convenience, and a sceptic able to force the correction is
worth more than a promise that the issuer will (§4.2). **Cost:** anyone can pay
gas to trigger a write-down at a moment of their choosing, which is a mild
griefing surface and a large honesty gain.

---

## 7. Threat model and failure analysis

This section replaces an evaluation. All rows are `[ARGUED]` from
`[IMPLEMENTED]` code unless marked otherwise.

### 7.1 Adversaries

| Adversary | Can do | Stopped by | Cost to them |
|---|---|---|---|
| **Dishonest grower** | Sign any record; anchor it; publish a fabricated garden | Nothing at planes 1–3. Payment requires a licensed confirmation newer than the promise — `GrovePledge.sol:253`, `:425-427` | Must recruit a licensed officer; the record is dated by block time they cannot backdate |
| **Captured verifier** | Confirm trees that are not there | Nothing automatic. A rival licensed verifier may dispute, and one dispute withholds verification permanently — `GroveAnchor.sol:280` | Their licence, which `AttesterRegistry` can suspend while keeping the historical row |
| **Colluding sponsor** | Fund a pledge against a plot they control and settle it to themselves | Not stopped. The architecture assumes the sponsor wants the trees to exist | Nothing — this is round-tripping, and it is a real hole `[OPEN]` |
| **Grove authority** | Grant itself `AGENT_ROLE` and mint unverified shares, which additionally bricks `syncSupply` forever (§4.2) | Not stopped by any code in the suite | Nothing on chain; reputational only `[EXECUTED]` `[OPEN]` |
| **Hostile chain operator** | Censor anchors and attestations; halt the chain | Nothing on chain. Plane 1 survives: records remain valid and verifiable offline | The system degrades to an unanchored garden rather than failing |
| **Network observer** | Enumerate plot names from `plotId` and read counts and species | Not stopped — §8.1 | Trivial: seconds of hashing against a guessable naming convention `[OPEN]` |
| **Griefer** | Dispute every observation on a plot they dislike | Requires a live licence, active KYC and no freeze — `GroveAnchor.sol:231-233` | Their licence. But there is no un-dispute, so each attack costs the grower a fresh observation |

### 7.2 Concrete failure: the trees die and nobody reports it

The grower stops anchoring. τ grows without bound. `verifiedCountOf` still
returns the last verified count, `syncSupply` still reverts on nothing, and the
title's supply retains its last-good value (§4.3). No milestone pays, because
`notBefore` requires a fresh record — so the *payment* path fails safe while the
*representation* path silently does not. This asymmetry is the strongest
argument for §5.3's τ disclosure. `[IMPLEMENTED]`

### 7.3 Concrete failure: the arbiter, unbounded

Both arbiter paths check exactly four things and no more: the `ARBITER_ROLE`, a
non-zero reason, pledge status `Funded`, milestone status `Pending`. Neither
checks `notBefore`, `deadline`, or any proof. The normal claim path enforces both
edges of the window — `GrovePledge.sol:245-246`, `WindowNotOpen` and
`WindowClosed`.

Executed:

```
PASS  claimMilestone reverts before notBefore (line 245)
grower paid 65000000 (2dp) on DAY 1 for a 12-MONTH survival milestone
PASS  releaseByArbiter pays before notBefore — no window check, no proof
PASS  refundByArbiter succeeds AFTER the deadline
```

`[EXECUTED]` (local execution)

**The two mismatches are not equally serious and should not be reported as one
finding.**

`releaseByArbiter` (`:290-302`) is the real defect. It settles the *entire*
milestone — the grower's share plus the verifier's, because `_settle` folds
`verifierAmount` into `growerAmount` when `verifier == address(0)`
(`:333-336`) — on day one, for a milestone whose whole content is twelve months
of survival. 650,000.00 KHRt, in the measurement above. That is I4 not merely
qualified but unenforceable, and no comment or document claims the power exists.
Adding a `notBefore` check alone would preserve every documented use case: the
licence lapsed, the phone was lost, a flood took the road — all occur *inside*
the window.

`refundByArbiter` (`:306-317`) is close to harmless. Its doc comment says it
returns a milestone *"before its deadline"* and the code does not check one, so
the comment is wrong — but after the deadline the sponsor may already call
`reclaimExpired` (`:269-277`) for the same outcome. The only new behaviour is a
race while the milestone is `Pending` past its deadline, first caller wins. This
is a comment fix, not a contract fix.

What the arbiter cannot do is equally precise and worth stating: it cannot name a
payee — the destination is hardcoded to `p.grower` (`:301`) or `p.sponsor`
(`:353`) — cannot pay a verifier, cannot act without a recorded reason (`:295`,
`:311`), and cannot touch a Paid or Reclaimed milestone (`:299`, `:315`). The
design thought carefully about *who* may receive and not at all about *when*.
`[OPEN]`

### 7.4 Concrete failure: the plot is squatted

Stewardship is first-anchor-wins — `GroveAnchor.sol:169-174` — and
`plotSteward` is never reassigned in that contract (no setter exists). A party
who anchors a plot string before the grower holds that chain, and the grower's
only recourse is a different plot string. On a KYC-gated chain the squatter is
at least identifiable. `[IMPLEMENTED]` `[OPEN]` for the remedy.

A related inconsistency: registry-side steward rotation exists
(`GroveTitleRegistry.sol:233-248`, identity-checked at `:236-239`) but changes
only the *registry's* steward, not `GroveAnchor.plotSteward`. After a recovery,
`registerGrove`'s equality check at `:122-125` would no longer hold for that
plot. `[OPEN]`

### 7.5 Concrete failure: the registry is redeployed

Redeploying the contract suite partitions the compliance perimeter rather than
replacing it, because each asset binds its regulatory authority by immutable
reference at deployment. The architectural lesson — not the incident, which
belongs to the companion CSB paper — is in §8.6.

---

## 8. Open architectural problems

Design gaps, not measurement gaps. Each carries a recommendation.

### 8.1 Asset identity — the largest hole

**The problem.** `plotId` is `keccak256` of a plot string computed on the device
— `iAny@ede2e388:grove/core/csb.ts:125-126`, `plotKey = keccak256`, with the
comment *"The plot STRING never goes on chain."* On chain it is an opaque
caller-supplied `bytes32` validated only as non-zero
(`GroveAnchor.sol:163`); **no `keccak256` of a plot identifier is computed in
any contract.** Stewardship is first-anchor-wins, and no on-chain link binds the
P-256 device key to the CSB account, because `GroveAnchor` deliberately stores no
device key (§6.5).

One weak constraint does exist and is worth recording, because it is not
derivation: `registerGrove` requires the plot to already carry a steward and a
verified record (`GroveTitleRegistry.sol:122-127`), so a title can only be issued
over a plotId that already has an anchor chain behind it. Nothing anywhere
constrains the *value* — anchoring under an arbitrary `0xabab…abab` succeeds,
measured. `[EXECUTED]`

Nothing therefore binds *this twin* to *that grove* uniquely and
non-transferably. Two further consequences: a plot name short enough for a
verifier to type is short enough to enumerate offline against the chain, so the
privacy promise the interface made was conditional on an unguessable name --- a
claim it no longer makes, since `CSB@4fae96c` and `iAny@ec91c77` (21 August 2026)
corrected the anchoring, verification and garden pages to state what the hash
protects and to advise choosing a plot name the grower would not mind a stranger
guessing. The defect below is the derivation, which is unchanged; and
the same physical land may carry two plot strings (§8.2).

**Candidates.** (a) *Geospatial commitment* — `plotId = H(boundary_polygon ‖
salt)`, salt revealed to a verifier on the visit. (b) *Registrar-issued plot ids*
bound to a land parcel in the same suite's land-title registry. (c)
*Device-key registration* alongside the licence, binding the signing key to a
KYC'd account.

**Recommendation:** (a) immediately and (b) as the durable answer. The salted
commitment costs one field in the share/QR path and makes the interface's
privacy claim unconditionally true; the parcel binding is the only candidate
that also addresses §8.2. (c) is worth doing but solves a different problem —
authorship, not identity of the thing. `[OPEN]`

### 8.2 Double-financing

**The problem.** One plot has one non-forking chain
(`GroveAnchor.sol:179`), but nothing prevents two plot strings over the same
physical land, nor two sponsors pledging against one plot. This is the classic
green-finance failure and the first place a referee will look.

**The unusually good answer available.** The same contract suite already
contains a land-title registry with tokenised parcels. Binding a grove plot to a
parcel makes double-registration detectable by construction, because the parcel
is the unique key and the cadastre — not a string a grower chose — decides
identity.

**Recommendation:** bind `plotId` to a land-parcel identifier where a parcel
exists, and fall back to a salted geospatial commitment where it does not.
Accept that this couples Grove to a cadastre and that most smallholders in the
target setting do not have a registered parcel — which is itself the reason the
fallback must exist. `[OPEN]`

### 8.3 No corroboration plane

**The problem.** All confirmation is human and terrestrial. `GroveAnchor`
already counts confirmations and its registry classifies attesters by class
(`AttesterRegistry`, bitmask classes), so the mechanism for weighting different
kinds of witness is present and unused for non-human evidence.

**Recommendation:** introduce a **machine attester class** with distinct weight —
satellite canopy index, aerial survey — entering as *claims, not truths*, and
never sufficient alone for settlement. iAny's on-device vision models belong in
the same class for the same reason. The design rule is that a machine attester
may raise confidence and may trigger a visit, but may not substitute for the
licensed confirmation that I5 pays for; otherwise the architecture reintroduces
the unaccountable automated feed it was built to avoid. `[OPEN]`

### 8.4 Permanence and reversal

**The problem.** Burning shares (I2) is elegant about the *stock* and silent
about *flows already paid*. A milestone paid at month 12 is not clawed back when
the trees die at month 18.

**Candidates.** Buffer pools (withhold a fraction of each settlement against
future loss); clawback (recover from the grower, which requires a claim on a
smallholder and is likely both unenforceable and unjust); or an explicit
position that the instrument pays for *survival observed*, not *permanence
promised*.

**Recommendation:** the third, argued rather than assumed. It is defensible —
each milestone is a discrete purchase of a verified observation, and nothing in
the instrument claims otherwise — but the paper must say so, because a reader
arriving from carbon markets will assume permanence semantics that this design
deliberately does not offer. A buffer pool is the compatible addition if a
sponsor wants loss coverage; clawback should be rejected explicitly. `[OPEN]`

### 8.5 Valuation

**The problem.** `GroveTitle` is a count. Green finance needs count → money, and
the only route in the architecture today is bilateral: a sponsor decides what a
surviving tree is worth to them and writes it into a milestone.

**Recommendation:** name the empty plane rather than filling it badly. What may
legitimately occupy it: results-based payment schedules agreed ex ante;
biodiversity or adaptation instruments that price outcomes other than carbon;
and insurance, for which a verified survival series is exactly the loss history
an underwriter needs. What may not: a carbon price, because the unit is not a
tonne and converting it into one reintroduces every weakness §6.2 removed.
`[OPEN]`

### 8.6 Upgrade governance

**The problem, stated as architecture rather than incident.** Binding a
regulatory authority immutably into each asset at deployment makes the
compliance perimeter *per-asset*. Upgrading the authority therefore does not
replace the perimeter; it **forks** it, leaving previously deployed assets
governed by an authority the operator believes they have retired.

This is a general lesson about putting governance in contracts: immutability
that is correct for a *rule* is dangerous for a *reference to whoever
administers the rule*.

**Recommendation:** hold the authority behind a fixed-address indirection — a
registry at a stable address, or a settable reference under council control —
so that assets name a location rather than an incumbent. **Cost:** immutability
is traded for governability, and the fixed address becomes a target requiring
the same separation-of-powers treatment as every other role. `[ARGUED]`

### 8.7 Regime interoperability — EUDR, not voluntary carbon

**The problem.** Anchoring this architecture to voluntary carbon markets
inherits their credibility problem and their weakest claim structure.

**The stronger bridge.** EUDR is mandatory, concerns origin and geolocation
rather than counterfactual quantification, and is already the target of the
sibling module `iAny@ede2e388:trace/` — whose EUDR geometry tests pass
(§0.1). Trace and Grove are the same architectural shape: content-addressed,
offline-first, device-signed, with the consumer re-verifying. They differ only
in what the record asserts and which plane carries the consequence.

**Recommendation:** present Grove and Trace as two instances of one reference
model, and use EUDR as the compliance landing point. `[ARGUED]` `[CITE]` for the
regulation itself.

---

## 9. Generalisation — a second domain

A reference architecture must survive a second case. Take **improved cookstoves**,
which shares the structural problem (many small units, high verification cost,
a history of overstated claims) and differs in every physical particular.

| Plane | Grove | Cookstoves | Changes? |
|---|---|---|---|
| 1 Origination | Signed observation: species, count, DBH, photo hash | Signed observation: stove id, household, in-use evidence, photo hash | **No** — same record shape, different payload |
| 2 Federation | Node re-verifies on ingest | Identical | **No** |
| 3 Peer attestation | Neighbouring grower co-signs | Neighbouring household or community health worker co-signs | **No** |
| 4 Notarisation | Licensed commune agriculture officer confirms a count | Licensed technician confirms the stove exists and is in use | **No** — only the licence class changes |
| 5 Representation | One share per verified living tree | One share per verified stove in use | **No** |
| 6 Settlement | Payment on survival at month 12 / 24 | Payment on continued use at month 6 / 12 | **No** |
| 7 Twin surface | Rendered grove | Rendered village with per-household state | **No** |

What changes is **the unit, the licence class, and τ**. The unit changes from a
tree to a stove-in-use. The licence class changes from agronomist to technician.
And τ changes character: a tree's survival is slowly varying and a monthly τ is
generous, whereas *stove use* can lapse in a week, so the same architecture
demands a far tighter staleness bound at the same cost per visit — which is
exactly the economics §5.3 predicts, and exactly why cookstove programmes have
historically substituted surveys for visits.

What does **not** change is the whole of planes 1–3 and the invariant set. That
is the claim to being a reference architecture rather than one project.
`[ARGUED]`

---

## 10. Limitations

- **Test network, valueless tokens.** All tokens are experimental test artifacts
  with no monetary value, no peg and no issuer.
- **No users, no adoption, no pilot.** No grower has used this system, no
  officer has been licensed, and no sponsorship has settled against a real
  grove.
- **No security audit and no formal verification** of any contract.
- **The end-to-end path has never been run.** §0.3: `deployment-status.md`
  records Uniswap V2 and Aave V3 as verified end-to-end and does not mention
  Grove at all.
- **Single-operator deployment.** Every institutional role is held by one key,
  so the separation of powers this paper describes exists in the contracts and
  in a deployment procedure, not in any running instance.
- **The origination plane is untested.** `iAny/grove/` contains no test files
  (§0.1); its logic is covered only by a vendored copy in a different
  repository.
- **Two invariants do not hold as stated.** I1 is defeated by the token's role
  hierarchy, and I3 is disabled as a consequence (§4.2). Both were measured, not
  inferred. The architecture's supply guarantee should be read as a claim about
  the registry's logic, not about a deployment, until the role graph is fixed.
- **I4 is bypassable by the arbiter** (§7.3), measured.
- **No institutions exist.** The licensing registrar, grove authority, arbiter
  and identity registry are hypothetical placeholders. The architecture presumes
  offices that no one currently operates.
- **The heritage material in CamboVerse is not a capture.** Every model at the
  pinned commit is procedurally authored from Three.js primitives, and
  `angkor-wat.splat` is explicitly synthetic —
  `CamboVerse@0fde2e9e:scripts/generate-splat.mjs:5`: *"in the mobile web viewer
  (the real thing will be an actual 3DGS capture —"*. If CamboVerse is described
  as a heritage archive anywhere, this must be said in the same breath.
- **No government backing of any kind.** Every ministry and authority named in
  the repositories is a placeholder or an outreach target. The one documented
  institutional fact is the provenance of the CamboVerse Center itself,
  established within the National University of Management by Prakas of the
  Ministry of Education, Youth and Sport, signed 11 July 2024 —
  `CamboVerse@0fde2e9e:README.md:218`. That is a fact about the Center's
  founding and about nothing else in this paper: no ministry has evaluated,
  endorsed, adopted or piloted this architecture.

---

## 11. Reproducibility

The commit table is §0; the regeneration commands and their output are §0.1;
static sizes are §0.2; what has not been run is §0.3.

Licences: iAny Apache-2.0; CSB MIT; CamboVerse Apache-2.0 with data under
CC-BY-4.0.

```bash
# CSB
cd CSB && npm ci && npx hardhat test && npx hardhat test test/grove.test.js
# CamboVerse
cd CamboVerse && npm ci && npm test && npm run typecheck
# iAny — note: `npm test` covers trace/ only; grove/ has no tests.
cd iAny && npm ci && npm test
```

At the pinned commit, `iAny`'s `npm ci` requires `esbuild` on `PATH`; it is not
declared in `devDependencies` and the two test scripts invoke it directly
(`iAny@ede2e388:package.json`, `test:companion` and `test:eudr`).
