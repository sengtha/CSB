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
2. It is an `eth_call` simulation of live chain state, not an executed transfer.
   It establishes that the chain permits the transfer. It does not establish that
   one occurred, and leaves no on-chain record. One transaction would fix that.

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
