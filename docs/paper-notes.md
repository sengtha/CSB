# Notes for the paper — provenance and open questions

Answers to specific questions about what has actually been run and what is
actually known. Written 2026-07-28. The point of this file is to keep claims
separable by evidence status, so nothing reaches a manuscript stronger than the
thing it rests on.

---

## 1. Has the Aave market been deployed on chain 8555?

**No. It is a local result.**

| Experiment | Local | Chain 8555 |
|---|---|---|
| Unmodified Uniswap V2 | ✅ `test/defi-unmodified.test.js` | ✅ run 2026-07-28, output recorded |
| Unmodified Aave V3 | ✅ `test/defi-aave.test.js` | ❌ **not run** |

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
