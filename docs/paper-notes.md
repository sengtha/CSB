# Notes for the paper — provenance and open questions

Answers to specific questions about what has actually been run and what is
actually known. Written 2026-07-28. The point of this file is to keep claims
separable by evidence status, so nothing reaches a manuscript stronger than the
thing it rests on.

---

## 1. Has the Aave market been deployed on chain 8555?

**Answered "no" on 2026-07-28. That answer is now out of date: as of 2026-07-29 it
is deployed and in use on 8555, and two of the four findings are live-verified.**

| Experiment | Local | Chain 8555 |
|---|---|---|
| Unmodified Uniswap V2 | ✅ `test/defi-unmodified.test.js` | ✅ run 2026-07-28, output recorded |
| Unmodified Aave V3 — market deployed | ✅ `test/defi-aave.test.js` | ✅ **live**, measured 2026-07-29 |
| Aave: the perimeter holds on the ASSET | ✅ | ✅ **live**, measured 2026-07-29 |
| Aave: the RECEIPT escapes it | ✅ | ✅ **live**, measured 2026-07-29 |
| Aave: aTokens accrue for an unattested holder | ✅ | ❌ still local |
| Aave: liquidation blocked only by the debt asset | ✅ | ❌ still local |
| Aave deployment cost | ✅ | ❌ not captured |

**What is live, measured with `scripts/aave-diagnose.js` on chain 8555:** reserve
active, not frozen, not paused; borrowing enabled; LTV 75%, liquidation threshold
80%; reserve id 0; decimals 2; 580,000.01 aKHRt outstanding across three holders,
all KYC tier 2 with `txAllowList: enabled`; one holder carrying 50,000.01 of real
variable debt against 79,990.00 of collateral.

**Live, measured with `scripts/atoken-escape-test.js`**, twice, to the same
recipient `0x0Ebb8283bA8C207c832d6043858e98f10915Fbd9` (**no KYC attestation**,
**`txAllowList: none`**, holding nothing). In both, `KHRt.transfer` reverts and
`aKHRt.transfer` succeeds:

- from `0x93318de699311bc7bBd994298feb25335d124f6d` — KYC tier 2, no debt,
  10.00 aKHRt, transferring 1.00
- from `0x70E7601Ff820042Fe05c149aA94722A4fB44ba10` — KYC tier 2, 79,990.00 aKHRt,
  **carrying 50,000.01 of open variable debt**, transferring 100.00

The second is worth its own sentence in the paper: the export of exposure is not an
artifact of a debt-free holder. A borrower with a live collateralised position can
hand the receipt out while the debt stays behind, and the only thing bounding how
much is the borrower's own health factor — Aave refuses at code 35, a solvency
limit — not anything about the recipient.

**One challenge, and how it resolved (2026-07-30).** An executed MetaMask transfer
of 10 aKHRt to the unattested address **failed**
(`0x6e5f06a567d98bfec71bec3761ec964b0605242c8769cd80c71a6a709058a903`) while the
same sender moving the same amount to a KYC-active address confirmed. Measured with
`scripts/why-did-tx-fail.js`, the failure was a **gas shortfall, not a refusal**:
the call needed ~184,463 gas and was given 182,013. Replayed at the parent block
with the original limit it fails; with more gas at the same block it succeeds.

The confound that made the naive comparison misleading is worth a sentence in the
paper: a transfer to a recipient with a **zero** aToken balance costs 129,725 gas
versus 87,039 to an existing holder — **49% more** — because Aave enables collateral
for the recipient only on a first receipt. Two transfers a wallet displays
identically differ by half again in cost, so ordering and wallet display both fail
to distinguish gas from compliance.

Three limits to state rather than leave a reviewer to find:

1. The live node returns a bare `execution reverted` for the KHRt leg with no
   revert data. Locally the identical call decodes to `NotKycActive(0x0Ebb…)`. So
   the refusal is live-measured; the stated *reason* is inferred from the
   recipient's measured attestation status.
2. ~~It is an `eth_call` simulation, not an executed transfer.~~ **Closed
   2026-07-30.** Executed: tx
   `0xc5306114cca7210bfabbde99dce6e4f03b7e69e9e4aba4f120bb52b0685ad83a`, block 500,
   `status SUCCESS`, 183,469 gas of a 250,000 limit. The unattested recipient holds
   **20.00 aKHRt** on chain, KHRt balance 0.00, `txAllowList: none`. Citable by hash.

**A further live reading, sharper than the escape itself.** The same address shows
`flagged as using collateral: true`, `totalCollateralBase` 2.0e19 and
`availableBorrowsBase` 1.5e19 — **15.00 KHRt of borrowing power** (20.00 at 75% LTV;
arithmetic checked against the oracle's 1e18 per whole KHRt). Aave has not merely let
an unattested address hold a claim, it has **enrolled it as a collateralised borrower
eligible to draw on the reserve.**

It cannot exercise that while `txAllowList: none` blocks every transaction from it.
But the capacity is already computed and held in protocol state, and it activates on
allow-list admission — which the audit shows can occur through operator provisioning
with no attestation ever issued (4 of 20 addresses on this chain). So the inertness
argument should be stated as **"cannot move it yet"**, not "cannot move it". That is
a better sentence for the paper than either the bare escape or an unqualified
inertness claim, because it names what stands between the exposure and its
realisation: a single administrative act, held by the state, that the deployment
already performs for reasons unrelated to identity.

**Accrual is live at the holder level, not merely in aggregate.** Two readings a day
apart, with the escape run's 20.00 transfer accounted for: `0xC52D98D0…` went
500,000.01 → 500,000.04 (**+0.03**) and `0x70E7601F…` went 79,970.00 → 79,970.01
(**+0.01**), neither having transacted; the pool total went 580,000.01 → 580,000.05
(**+0.04**).

Two independent reasons this is accrual and not a transfer, both worth giving in the
paper because the first alone is not quite sufficient:

1. An aToken transfer **cannot change total supply** — it moves scaled balances and
   leaves `scaledTotalSupply` untouched — so +0.04 can only be the liquidity index
   advancing.
2. The increments are distributed **in proportion to holdings**. At the implied index
   growth of 6.9e-8, expected increments are +0.0345 and +0.0055, rounding to the
   observed +0.03 and +0.01. Proportionality is the signature of an index update;
   transfers do not produce it.

**The leaked holding accrues too, but below display precision — say it exactly this
way.** An aToken balance is `scaledBalance × index` and the index applies to all
holders identically, so the unattested address's 20.00 is growing at 1.4e-6 per
interval, needing roughly **7,250 intervals to move one 0.01 unit**. Accrual at the
leaked holding is therefore a *mathematical consequence of a live-demonstrated
mechanism*, not a separate observation; `balanceOf` truncating to two decimals is what
hides it. The bound is the token's precision at this utilisation, not the mechanism.

Avoid both weaker and stronger formulations: "accrual is local" now claims less than is
known, and "the leaked holding was observed to grow" claims more.

**Addresses for Appendix A** are recorded in `docs/defi.md` §Appendix — all nine
validated as correctly-checksummed and distinct. The `Pool` entry is the proxy;
the implementation address is not usable. One caveat recorded there and worth
repeating: the live deployment's `note` field cites "docs/paper §5.4", a path that
does not exist in this repository, so the live market was deployed by a slightly
different revision of `scripts/aave-live.js` than the committed one. The reserve
parameters were re-read from the chain and match — base any reproducibility claim
on those readings, not on the note.

**Still local, so do not promote these:** the accrual finding, the liquidation finding, and the cost. On the
hardhat network the allow-list precompiles are mocked, which is why finding 3 was
worth re-doing live — and on 8555 the recipient's `txAllowList: none` is a real
precompile reading, not a mock.

**The superseded answer**, kept because the paper may already cite it:

What exists for Aave:

- `test/defi-aave.test.js` — the full market against the contract suite on the
  hardhat network, where the allow-list precompiles are **mocked**. All four
  findings come from here.
- A validation run of `scripts/aave-live.js` against a local hardhat node
  (chain **31337**), performed only to prove the script works end to end,
  including its idempotency guard. Not chain 8555.

So the Aave section should stay a local result. That is weaker in one specific
way worth stating rather than hiding: on the hardhat network `txAllowList` is a
mock, so the sharpest version of the finding — *the holder's allow-list role is
`none`, the chain will not accept any transaction from it* — is established for
Uniswap only. For Aave, "unverified holder" means no KYC attestation, which is
still the substantive claim, but the base-layer precompile was not in the loop.

**To promote it**, run on the VM and paste the output:

```bash
source ops/csb-env.sh
npx hardhat run scripts/aave-live.js --network csbRemote
```

It prints every address and the real total cost, and writes an `aave` block into
`app/deployments.json`. Then:

- add pool / aToken / oracle / debt-token addresses to the appendix
- replace the estimated Aave cost in `docs/defi.md` with the measured figure
- re-run the four findings against the live market before calling them live —
  deploying there does not by itself make the *findings* live

**Check whether this is still true** before writing anything:

```bash
node -e "console.log(require('./app/deployments.json').aave ?? 'no live Aave market')"
```

---

## 2. Were the earlier chain freezes the same fault as the 2026-07-28 incident?

**Unresolved, and it cannot be settled from the evidence that exists.** What can
be said is narrower than either document currently claims, and more useful.

### What the two documents said

`docs/deployment-status.md` (before correction): single- and two-validator
deployments "repeatedly stopped producing blocks after limited activity (height
frozen, no recovery from restart or from adding a validator afterwards)", and the
three-validator deploy cured it. Conclusion drawn: **validator count**.

`docs/incident-2026-07-28.md`: the L1's validator ran out of P-Chain fee balance
under ACP-77 and was deactivated; connected stake fell to 0%; the chain accepted
transactions and finalised none, for ~14 hours. Conclusion: **fee-balance
exhaustion**.

The symptoms described are the same: height frozen, transactions accepted,
restarts ineffective.

### What is now established

**The validator-count explanation is falsified for the current chain.** The chain
described as having "three validators from birth" in fact runs **one** registered
validator (`platform.getCurrentValidators`, measured 2026-07-28: a single entry,
`NodeID-BoRS383b4Z9ZdsJSVUcnrXNCXh5Qj93ux`, weight 100). It ran for days, carried
the full deploy, seed and levy sequence, an ICTT bridge in both directions, and a
Uniswap deployment. So "one validator wedges, three do not" cannot be the
mechanism, because the working chain is a one-validator chain.

That is a real correction and it stands on measurement.

### What is NOT established

**That the earlier freezes were fee-balance exhaustion.** That is a hypothesis
consistent with the symptom, not a finding. Against it:

- The earlier chains were freshly deployed, and a fresh ACP-77 validator starts
  with a funded balance. Draining it takes time — the observed rate on this chain
  is roughly 0.017 AVAX in a few hours, so a chain that froze *soon* after
  deployment is unlikely to have drained unless it was funded minimally. Nobody
  recorded how much those validators were funded with.
- There are competing candidates with the same signature. One is documented in
  `ops/csb-apply-l1-config.sh`: an invalid `eth-apis` entry (`internal-txpool`)
  caused the chain's HTTP handlers to fail to build, so the RPC answered 404 while
  the node looked healthy. Another is the watchdog, which for a period restarted
  the cluster on a misread signal and, in this incident, restarted a live node
  every ~15 minutes for hours.
- No `getCurrentValidators` output, no balance readings and no node logs survive
  from those deployments. The VM was rebuilt on 2026-07-24.

### What would settle it

Nothing retrospective. It needs a fresh instance of the failure with the
diagnostics that were missing:

1. `platform.getCurrentValidators` for the subnet at the moment of the freeze —
   validator count, and each validator's `balance`.
2. The RPC's actual reply. A well-formed error (`chain is not done
   bootstrapping`) points at consensus; a 404 points at the route-registration
   fault; silence points at the process.
3. `percentConnected` from `/ext/health`.
4. Whether any automated restarter was running.

`ops/csb-watchdog.sh` now records (1) and (2) on a timer, so a recurrence should
be diagnosable rather than reconstructed.

### How to write this up

The honest and, I think, stronger framing is not "we misdiagnosed and the real
cause was X". It is:

> An operational failure was attributed to insufficient validator count. The
> attribution was recorded in the project's own status document and used to
> justify a redeployment. It was later falsified by direct measurement — the
> chain credited with the fix had one validator, not three — while the fault it
> was invoked to explain recurred under a mechanism (ACP-77 fee-balance
> exhaustion) that is independent of validator count. The original cause remains
> undetermined because the diagnostics needed to distinguish the candidates were
> not collected at the time.

That makes three points a reviewer can use: a plausible explanation that predicts
correctly can still be wrong; the operational telemetry a sovereign L1 needs is
not the telemetry a server needs, because the failure mode is economic and lives
on another chain; and an automated remediator can destroy the evidence required to
diagnose the fault it was installed to catch.

Do not write that the earlier freezes *were* balance exhaustion. That claim is not
supported.

---

## 3. The gap that matters more than the aToken finding

**Revoking a KYC attestation does not stop the address transacting.** Measured by
reading the code and confirmed by `scripts/audit-allowlist.js`:
`IdentityRegistry.revoke()` and `suspend()` change only the attestation; nothing
calls `setNone` on the `txAllowList` precompile, and allow-list entries are granted
and removed by hand.

Why this is the sharper version of the composability finding:

- For an address that is **not** allow-listed, an aToken holding is **inert**. It
  cannot send any transaction, so it can never transfer, approve, or redeem; nobody
  else can move the balance because it can never grant an approval; and Aave's only
  involuntary transfer (`transferOnLiquidation`) requires the holder to have debt.
  Selling the private key does not help — the buyer inherits an address that still
  cannot transact. **Realising the value requires re-entering the perimeter, which
  the council controls.** So that leak is one-way and terminal.
- For an address that **is** allow-listed but holds no active attestation — a
  revoked or suspended one — the same holding **is** realisable: it can move the
  receipt and call `pool.withdraw(asset, amount, attestedAddress)` to convert it
  into real KHRt in an attested party's hands.

**Audited on chain 8555, 2026-07-30** (`scripts/audit-allowlist.js`, blocks 0–500,
20 distinct addresses):

| | |
|---|---|
| can transact AND attested | 16 |
| can transact, **revoked or suspended** | **0** |
| can transact, never attested | 4 |
| cannot transact | 0 |

**The gap is latent, not realised.** No address has had an attestation withdrawn on
this chain, so nothing currently exploits the decoupling — it becomes real at the
first revocation. State that as measured, and do not imply the leak is in use.

Two of the four never-attested addresses are identified, and both are ICM
infrastructure rather than participants:

| Address | What it is | Evidence |
|---|---|---|
| `0x618FEdD9A45a8C456812ecAAE70C671c6249DfaC` | ICM/Teleporter **deterministic deployer** | needed the deployer allow-list to install `TeleporterMessenger`; `docs/fuji-ictt.md` |
| `0x416d4DE5333F31E950C73c92c52C9b8A36e1cE2B` | the **ICM relayer** | its only call target is `0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf`, the ICM Messenger (`docs/deployment-status.md`); holds 11,979 tRIEL, consistent with paying gas to deliver messages |

The remaining two are **not** infrastructure, and an earlier draft of this note
said none of the four had touched a participant-facing asset. That was wrong:

| Address | Called | Identified as |
|---|---|---|
| `0x0E1A7Bc8A24c9ac6EB89343668EECa4F11dA88ae` | `0xb8571bdd0fBA0790CDB5D9D28C75C877486F046c` | a token with symbol **KHRt** |
| `0x6aD62D8cE5Cb79316BdA435d5841c993C63f6255` | `0xa7f089C3…`, `0x4f54f0D9…` | two tokens with symbol **LAND1** |

Two things to resolve before either is described in the paper:

1. **`0xb8571bdd…` is not the `KHRStablecoin` in `deployments.json`** — that is
   `0xEAE160F6f9a4D626A5A94402E87F0EB7f89A88C1`, which the audit resolves by name.
   So a second contract on 8555 reports symbol KHRt. Most likely an earlier
   deployment left in place, but that is a guess, and an orphaned KHRt is worth
   knowing about independently of this audit.
2. **Calling a participant-facing asset does not by itself make an address a
   participant.** The land registrar and the KHRt issuer are institutional
   addresses that administer these contracts and legitimately hold no personal KYC
   attestation. What separates the cases is *which function* was called and *what
   role* the address holds — `issue`/`confiscate`/`grantRole` with a matching role
   is an operator; `transfer`/`approve`/`supply` without one is a participant.

**RESOLVED 2026-07-30: not a compliance breach. A redeploy forked the perimeter.**

The calls succeeded — 4 transfers on the KHRt-symbol token, `transfer` and `approve`
on both LAND1 tokens, none reverted, and neither sender holds any role. But all
three tokens are gated by `0x446BE7b37954b0BFB2c42162832C7c2f2876a101`, **not** the
chain's current `0xa33a4C897ce417DD05042e1f9dC35A5550b5f5a9`, and both senders are
**Active in that older registry**. The gate worked exactly as written; it was
consulting a different register of who is verified.

### The finding this actually is, and it is a better one

An entire earlier deployment of the suite is **still live on chain 8555** — its own
`IdentityRegistry`, its own KHRt, two LAND1 land-title tokens — carrying its own
attestations, and people transacted on it. The current Identity Authority has no
authority over any of it, because the reference is immutable:

```solidity
IdentityRegistry public immutable identity;   // KHRStablecoin.sol:28, LandTitleToken.sol:42
```

So **redeploying the suite does not replace the compliance perimeter — it forks
it.** Consequences worth stating precisely:

- Revocation, suspension, freezing and confiscation by the current authority are
  **inoperative** on the orphaned assets. It holds no role on the registry they obey.
- The state's own view of "who is verified" — the current registry — **does not
  cover** holders of the orphaned assets. They read as unattested while transacting
  legitimately under the old regime. That is why this looked like a breach.
- Nothing on chain marks the orphan as superseded. Two tokens both answer `symbol()`
  with `KHRt`, and only an off-chain record distinguishes them.

The generalisation for the paper: **a compliance perimeter bound at deployment time
by an immutable reference is per-asset, and upgrading the authority silently
partitions it.** Identity is enforced against whichever register each asset was
wired to when it was created, not against the state's current one. This is an
upgrade-governance failure mode specific to putting regulatory authority in
contracts, and it is invisible to every test — the suite has 206 passing tests and
every one of them exercises a single, freshly-wired deployment.

### Remediation, and the honest limit on it

`scripts/orphan-check.js` reports, for an orphaned token, its supply, where that
supply sits, each holder's status in the registry the token actually obeys, and
whether any address still holds a role capable of stopping it. Whether it can be
neutralised at all depends on that last point — if nobody holds a role on the old
registry or token, it cannot be stopped, and the deployment record must say so
rather than imply the perimeter covers it.

**Measured on 8555, 2026-07-30.** The orphaned KHRt holds **6,156,000.00** across
**7 holders**, all `Active` in the orphaned registry, with no pause function. It is
remediable: the deployer retains `DEFAULT_ADMIN_ROLE` and `ISSUER_ROLE` on both the
orphaned token and the orphaned registry, so revoking those attestations would render
the whole supply untransferable.

**The sharpest sentence available from this, and it should go in the paper:**
remediation is possible only because a single key holds every role on both
deployments — the very concentration the design exists to eliminate. Under the
intended arrangement, where different institutions hold different roles and a
redeploy hands the new registry to a new authority, nobody need hold the old
registry's issuer role and the orphan would be **permanently** unfixable. So the
recovery path here depends on the design not yet being implemented, and implementing
the separation of powers correctly would *remove* it. A reviewer can check that claim
against the roles on chain.

The design fix is not to redeploy more carefully. It is to stop binding the
reference immutably: a registry behind a proxy at a fixed address, or a settable
reference under council control, means a later authority inherits the assets instead
of forking away from them. That trades immutability for governability, which is a
real trade and belongs in the paper as one.

The audit reports the rest, so this is answerable rather than arguable: per call
target it prints each selector, classified `PARTICIPANT` / `admin` / `read`, and
checks `hasRole` for `DEFAULT_ADMIN_ROLE`, `ISSUER_ROLE`, `ENFORCER_ROLE`,
`AGENT_ROLE` and `REGISTRAR_ROLE` on that contract. Re-run it and read the
selectors before drawing a conclusion.

So the honest claim is not "the perimeter fails on receipts" but something more
precise and more defensible:

> Identity is enforced on custody of the regulated asset and on every transaction
> sender. It is not enforced on derivative claims. An unattested holder of such a
> claim cannot realise it without an allow-list grant, which the state controls —
> unless the address retains an allow-list entry after its attestation was
> withdrawn, which the current implementation permits because the two gates are not
> wired together.

What to recommend rather than a fork: do not make the aToken compliance-aware,
because that costs the "unmodified DeFi runs here" property that separates this
design from a closed CBDC. Close the revocation gap instead, and reframe the
guarantee as **observability** — every allow-list holder and every aToken holder is
enumerable on this chain, so the state can always see who holds exposure and act.
That is a claim no public chain can make, and it survives a reviewer who punctures
the universal-KYC claim.

---

## Standing caveats for anything quoted from this repo

- **Validator count: one.** Three nodes, one registered validator. No fault
  tolerance. Verify with `platform.getCurrentValidators`.
- **The Aave oracle is a hand-set test contract.** No price feeds exist on CSB.
  Interest rates and health factors are real arithmetic over an unreal valuation.
- **Aave findings are local; Uniswap findings are live.** See §1.
- **Test count and contract count move.** Regenerate with `npx hardhat test`
  rather than quoting a number from a document.
- **Recovery**: no account abstraction exists. `LandTitleToken.recoveryAddress`
  and `KHRStablecoin.confiscate` are the only paths, both role-gated with an
  on-chain order reference; native tRIEL has none.
- **Ingress is ungated.** The egress gateway has no inbound counterpart.
