# Grove plot identity — what a plot name leaks, and what it would cost to stop

**Status: a design note, not a decision.** Nothing here is implemented. One
related change has shipped and is described under "What the verifier needs".

A Grove plot is identified by a string the grower chooses. That string, or a hash
of it, reaches three different places with three different exposures, and a fix
aimed at one of them does nothing about the others. This note separates them,
because an earlier plan called the salted commitment "the fix" for the
enumeration defect, and it is not: salting `plotId` while iAny's publish worker
serves `plot` verbatim would let us claim the name is protected while `curl`
returns it. That is the sentence shape two commits in August were spent removing.

Line references are to the pinned commits: CSB `29baa48`, iAny `ede2e388`,
CamboVerse `0fde2e9e`.

---

## The exposure is asymmetric, and that matters

| Where | What it receives | Leak |
|---|---|---|
| **CSB (the chain)** | `keccak256(name)` only — `verify.html` sends `ethers.id(plotName)`, CamboVerse sends `plotKey(plot)` | The hash is public, and a short name is recoverable from it |
| **iAny publish worker** | The **name in clear** | It serves the name back to anyone, no guessing needed |
| **An unpublished garden** | Nothing leaves the phone | None |

CSB genuinely never receives the name. The node does. **So the leak follows
publication, and publication is optional** — which is the single most useful fact
in this note, because it means the two problems below have different populations
and only one of them is helped by cryptography.

---

## A — on-chain guessability

`plotId = keccak256(plot)` is computed on the device (`iAny:grove/core/csb.ts`,
`plotKey`) and validated on chain only as non-zero
(`CSB:contracts/grove/GroveAnchor.sol:163`). Plot names must be short, memorable
and speakable, because a verifier types one standing in a field. A wordlist of
plausible names crossed with a small index is a few million candidates — seconds
of hashing against the anchored `plotId`s. Beside the `liveCount` and `species`
committed in the same anchor, what that recovers is an addressable inventory of a
grower's most stealable assets.

A salted commitment — `plotId = keccak256(plot ‖ salt)`, salt held on the device —
closes it. The candidate space stops being a wordlist and becomes 2¹²⁸.

**Its scope, in the words we would have to put on the anchor page:**

> Salting the plot key protects growers who anchor and never publish. If you
> publish your records to a Grove node, that node serves your plot's name in
> clear, and this changes nothing for you.

That sentence is the argument against shipping A on its own. Publishing is not an
edge case — it is what the federation is for, what CamboVerse consumes, and what
the fixtures demonstrate. A protects the population that opted out of the point of
the system.

---

## B — the record and the API serve the name

`plot` is a **signed field**. `buildObservation` returns it alongside `v: 1`,
`canonicalize` sorts it into the preimage, `id = sha256(canonicalize(unsigned))`,
and the ECDSA signature covers that id. Changing it is a record-format break, not
a parameter change. `v: 1` is already the first field, so the format anticipates
the break.

### Every site

| # | Site | What it does with `plot` |
|---|---|---|
| 1 | `iAny:grove/core/grove.ts` — `ObservationInput.plot` | The signed field itself. Its doc comment already reads *"WHERE (logical) — a stable plot **id** grouping a garden's observations over time."* |
| 2 | `iAny:grove/worker/handlers.ts:131-136` | Ingest writes it to the `plot` column, truncated to 40 chars |
| 3 | `iAny:grove/worker/handlers.ts:229` | **The feed `SELECT` emits it verbatim** into `items`; only `lat`/`lng` pass through `fuzz()` |
| 4 | `iAny:grove/worker/handlers.ts:252-256`, `PLOT_RE` at `:42` | `grovePlot` takes **the name in the URL path** |
| 5 | `iAny:grove/worker/handlers.ts:209` | `COUNT(DISTINCT plot)` for stats — works unchanged on an opaque value |
| 6 | `iAny:src/views/GardenView.tsx` | The grower types the name |
| 7 | `iAny:grove/core/csb.ts` | `plotKey = keccak256` — the derivation A would change |
| 8 | `CamboVerse:src/grove/garden.ts:103-108` | Groups records by `r.observation.plot` as a `Map` key — and names the loop variable `id` |
| 9 | `CamboVerse:src/grove/csb.ts` | `plotStatus(plot)` hashes the name locally before querying CSB |
| 10 | `CSB:app/public/verify.html` | Name box (secondary since `3245244`) |
| 11 | `CSB:app/grove.js`, `app/server.js` | `?plot=` is a 32-byte key, never a name. **No change needed** |
| 12 | `iAny:grove/fixtures/` | `plot.json`, and `GET /api/grove/plot/home-garden-01` in the README |

### Should `plot` become the commitment, with an optional `label`?

Evaluated, not assumed — and the answer is yes, with one caveat that decides
whether it works.

**For.** The field's own doc comment already calls it *a stable plot id*, and
CamboVerse already treats it as an opaque grouping key rather than a name
(site 8). The code's contract is already "id"; only the humans read it as a name.
Making it a commitment aligns the field with what it says it is, which makes this
less of a semantic break than the format-version bump suggests. Sites 5 and 8 need
no logic change at all.

**Against, and this is real.** If the public feed shows opaque identifiers, a
browsing stranger cannot tell one grove from another, and the commons stops being
browsable. CamboVerse would render hex where it renders a plot label today. For a
project whose case is an open, walkable archive, that is a genuine loss and not a
rounding error.

An optional `label` carrying the human name resolves it by making legibility a
choice: opaque by default, legible if the grower says so. Sites 3 and 4 then serve
`label` where it exists and the commitment where it does not.

**The caveat that decides it.** `label` must default to **absent**, never to the
plot name. If the client fills it in for continuity, B protects nobody and we have
bought a format break for nothing. B's effectiveness rests entirely on that
default — it is a UX decision, not a cryptographic one, and it is the part most
likely to be quietly reversed later for convenience.

**No bare-name lookups survive B.** Site 4's `/plot/:name` becomes
`/plot/:commitment`, and `verify.html`'s secondary name box goes. A compatibility
path that still accepts a name is the path every existing QR code and bookmark
would keep using, which leaves the leak in place under a new name.

---

## A breaks CamboVerse's chain status, and the fix is the same one

Not an aside. It is the second half of the recovery problem wearing different
clothes, and it settles what the record and the QR code have to carry.

CamboVerse derives the plot key from the name, in **two** places, not one:

| Site | Path | What it does |
|---|---|---|
| `csb.ts` `plotStatus` — `:160` pinned, `:165` after `ecf97f4` | read | `const key = plotKey(plot)` → `GET /grove?plot=<key>` |
| `csb.ts` `anchorCall` — `:210` pinned, `:215` after `ecf97f4` | write | `const plotId = plotKey(obs.plot)` → the anchor calldata it hands the grower |

(Both in `CamboVerse:src/grove/csb.ts`. The note's line numbers are to the pinned
`0fde2e9`; the copy fix in `ecf97f4` added a comment above `plotStatus` and moved
both down five lines. Cited by function name so the reference survives the next
one.)

Under A, neither has the salt, and neither can get it: the viewer holds published
records, and the salt is deliberately not in them. So the read path computes a key
no plot was ever filed under and CSB answers `{ available: false }` for **every
published plot** — no anchored badge, no block timestamp, no verified state, no
licensed confirmer, no pledge status. The garden still renders, because the
signed records carry it and the chain is additive by design; it renders with its
entire provenance layer silently switched off. The write path is worse in kind:
`anchorCall` would produce calldata for a *different plot*, opening a second
chain for a garden that already has one, with `plotSteward` frozen on each.

**This is a consequence of the design, not a defect in anything today**, and it
does not argue against A on its own. What it does is force a decision A cannot
avoid: **if the plot key is secret, every consumer that today derives it must be
given it instead.**

That is the same sentence as the recovery answer, and the same fix serves both:

> The `plotId` travels — in the record, and in the grower's QR code — while the
> salt stays on the phone.

A consumer that receives the `plotId` needs no salt and no name: it can query the
chain, render the badge, and build anchor calldata. A grower restoring from a
backup that contains the `plotId` can extend her chain even if the salt is gone,
because `GroveAnchor` never sees the preimage — it only ever compares 32-byte
keys. And item 0's verifier flow already works this way.

Two consequences to carry into the design rather than discover later:

- **Publishing the `plotId` is publishing a commitment, not a name** — which is
  the entire point of B, and is why A and B want the same record-format change.
  A alone would have to add a `plotId` field to the record for consumers, at
  which point the format has broken anyway and B is the cheaper destination.
- **The salt then protects only the preimage**, which nothing needs after
  creation. That is a good place to be: the secret stops being load-bearing for
  daily operation, which is what makes losing it survivable.

## Recovery — the section the decision turns on

This applies to A and B **equally**, so it is not a reason to prefer one.

**Today, the name is the recovery mechanism.** Anyone who remembers it recomputes
the id. The other two secrets are already survivable: the CSB account has its own
backup path (a seed phrase growers are already told to keep), and the Grove device
key is not bound to the plot at all — SPEC §2 says a plot may be observed by
several devices, so a new phone can continue a chain.

**After either change, that stops being true.** A salt is high-entropy and
unmemorable by construction — that is the whole point. Lose it and the `plotId`
is uncomputable, so the chain is unreachable. It cannot be taken over either:
`plotSteward[plotId]` still names the grower's address and there is no setter in
`GroveAnchor`. The plot is permanently frozen while the trees keep growing.

**And it is not only a lost record — it is lost money.** `GrovePledge.claim`
requires `anchorOf(observationId).plotId == p.plotId`
(`CSB:contracts/grove/GrovePledge.sol:250`) and refuses after the deadline
(`:246`). No plotId → no anchor → no proof → the milestone lapses and the funds
return to the sponsor. **A lost salt is a lost payment**, for the grower whose
trees are standing.

So we would be trading an enumeration risk for a permanent-loss risk, and the
second lands on the same person the first was meant to protect. Note also that the
first is *already mitigable today by her own choice* — the interim copy tells her
to pick an unguessable name, and `PLOT_RE`'s 40 characters of `[\w -]` permit one —
whereas the second would not be.

### What has to be specified

- **Export bundle.** `grove-bundle.json` carries the salt. It is the grower's own
  export and is never published, so this is safe and is the primary path.
- **Pack backup.** Same, and for the same reason.
- **Mandatory before the first anchor: yes.** Anchoring is the moment a plot
  acquires a consequence; before it, a lost plot costs a diary. Gate the anchor
  action on having exported at least once, or show the salt as a one-time recovery
  phrase at plot creation and require acknowledgement. Anything softer will be
  skipped by exactly the growers who can least afford it.
- **What a grower who has lost both is told.** Plainly: this plot cannot be
  continued, start a new one, and any funded pledge against the old plot cannot be
  claimed and will return to the sponsor at its deadline. If that sentence is not
  acceptable to say, A and B are not acceptable to ship in this form.

### A candidate that changes the trade, and its unresolved risk

Derive the salt from the CSB wallet instead of storing it:
`salt = H(sign(wallet, "grove-plot-salt-v1" ‖ plot))`. The wallet already has a
backup path growers are already told to keep, so recovery becomes "restore your
seed phrase", with nothing new to lose.

Two costs, and the first is a blocker until checked:

1. **It depends on signature determinism.** RFC 6979 makes ECDSA deterministic in
   principle, but whether every wallet a grower actually uses produces a
   byte-identical `personal_sign` for the same message is an implementation
   question. If it is not deterministic, the scheme fails *silently* — the grower
   gets a different plotId and believes she has lost her plot. **I could not
   resolve this**, and it must be tested against real wallets before this option is
   costed against the others.
2. **It requires a wallet at plot-creation time.** Grove's stated contract is that
   the phone is the source of truth with no account and no network (SPEC §1). Tying
   plot identity to a chain account contradicts that for every grower, including
   those who never anchor.

---

## What the verifier needs

**Nothing.** `GroveAnchor.anchorOf(observationId)` returns the `Anchor` struct
whose first field is `plotId` (`contracts/grove/GroveAnchor.sol:53`, `:263-265`),
so a record id — a content hash already public on chain and in every feed —
answers the verifier's question without the name or the salt.

This shipped as CSB `3245244`: `/grove?observation=<id>`, a record-id box as the
primary route in `verify.html`, and `?obs=` as the only accepted deep link.
`?plot=<name>` in a query string is refused rather than redirected, because a
fallback is the path every existing QR code would keep using.

Flows that would still need the salt after A or B:

- **The grower's own device**, recomputing `plotId` to anchor the next record.
  Unavoidable, and it is the reason recovery is the hard part.
- **CamboVerse `plotStatus(plot)`** takes a name and hashes it today (site 9).
  Under B it takes the commitment directly and needs no salt.
- **`verify.html`'s secondary name box**, which B removes.

So: the salt never has to leave the grower's phone. That is settled.

---

## Parameters, if A proceeds

- **128 bits**, base64url in the record and in the bundle.
- **One salt per plot**, generated at plot creation.
- **Stable across the plot's whole chain.** A per-observation salt is not merely
  wasteful, it breaks the chain on chain: `GroveAnchor` requires each new anchor to
  extend `plotHead[plotId]`, so a changing `plotId` starts a fresh chain every time
  and strands the previous one with `plotSteward` frozen on the old key.

---

## Recommendation

**Do not ship A alone.** Its honest scope sentence — it protects growers who never
publish — describes a population the rest of the system exists to move people out
of, and A alone carries the entire recovery cost of B for a fraction of the
benefit.

**B subsumes A**: a commitment is a salted hash, so doing B does A. If either
ships, ship B, with `label` absent by default and no bare-name lookup path.

**Settle recovery first.** Both changes convert a risk the grower can already
mitigate by choosing a better name into one she cannot mitigate at all, and the
failure mode ends in an unclaimable pledge against living trees. The wallet-derived
salt is the option worth pricing, and it is blocked on the determinism question
above.

Until then the shipped position stands and is honest: the interface says a short
name can be worked out from its hash, and advises picking one the grower would not
mind a stranger guessing.
