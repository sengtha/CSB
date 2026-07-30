# Running real DeFi on CSB

Two unmodified protocols run on CSB against KHRt: **Uniswap V2** (an AMM) and
**Aave V3** (a lending market). Unmodified is meant literally — the bytecode is
the published npm artifacts, not recompiled, not forked to be compliance-aware.

They are here to answer a question the architecture asserts but never tested:
*does enforcing identity below the contract layer let standard DeFi run while
every participant stays known?* The first half is true. The second half is not,
and §"What this proves" below says exactly how.

---

## Uniswap V2 — a liquidity pool

**Deploy**

```bash
source ops/csb-env.sh
npx hardhat run scripts/defi-experiment.js --network csbRemote
```

~316 tRIEL. Deploys `UniswapV2Factory`, a plain test ERC-20 to pair against, and
a KHRt pool; runs the whole experiment and prints per-step gas.

**Use** — DeFi → Liquidity pool (`defi.html`). Reserves, price, and a swap that
goes straight to the pair contract, so it works whether or not a router was
deployed.

**Reproduce locally** — `npx hardhat test test/defi-unmodified.test.js`

---

## Aave V3 — a lending market

**Deploy**

```bash
source ops/csb-env.sh
npx hardhat run scripts/aave-live.js --network csbRemote
```

~2,270 tRIEL (measured locally; the live run's cost was not captured — see Costs)
and a few minutes. It is 31 transactions: Aave's
`Pool` exceeds the EIP-170 contract size limit on its own, so its logic lives in
eight external libraries that must be deployed and linked first, and `Pool` and
`PoolConfigurator` sit behind proxies owned by the addresses provider.

Idempotent — a second run reports the existing market rather than building a
parallel one. To deploy a fresh market, delete the `aave` block from
`app/deployments.json` first.

**Use** — DeFi → Lending (`lend.html`). Supplied and borrowed totals, live supply
and borrow APRs read from the reserve, your position with a health factor, and
supply / withdraw / borrow / repay.

**Reproduce locally** — `npx hardhat test test/defi-aave.test.js`

> **Status: LIVE on chain 8555, with two findings live-verified and two still
> local.** This block said "local only" until 2026-07-29, which was true when
> written and is not now. Keep the distinction, because it is not all-or-nothing:
>
> | | Status |
> |---|---|
> | Market deployed and in use on 8555 | ✅ **live** — reserve active, LTV 75%, borrowing enabled, 580,000.01 aKHRt outstanding across three holders, one address carrying real variable debt |
> | Finding: the receipt escapes the perimeter | ✅ **live** — see below |
> | Finding: the perimeter holds on the asset | ✅ **live** — measured in the same run, which is what makes the pair a finding rather than two separate claims |
> | Findings on accrual and on liquidation | ⚠️ still **local** (`test/defi-aave.test.js`, where the allow-list precompiles are mocked) |
> | Deployment cost | ⚠️ still a **local** measurement |
>
> Verify rather than trust this table:
> `npx hardhat run scripts/aave-diagnose.js --network csbRemote`

### Two things to know before you run it

**The prices are not real.** CSB has no price feeds, so the market uses Aave's own
`PriceOracle` test contract with a price set by hand at deployment. Interest rates
and health factors are correct arithmetic over a valuation nobody derived from a
market. It demonstrates mechanics; it is not a credit market anyone should trust.

**It grants real privileges.** Deploying marks the `Pool` and the `aToken` as KHRt
**system contracts**, which lets them custody KHRt without holding a KYC
attestation. That is the same power the bridge adapter has. The script prints the
revoke commands; run them when you are done demonstrating:

```
khr.setSystemContract("<pool>", false)
khr.setSystemContract("<aToken>", false)
```

---

## What this proves

### Standard DeFi does run unmodified

Both protocols deployed from published bytecode with no source change. To this
extent the architecture's claim holds, and it is not a small claim: it is what
separates this design from a closed CBDC.

### Contracts must be vetted, and cannot be vetted in advance

Neither protocol can custody KHRt until the council marks its contracts as system
contracts — and the addresses do not exist until the protocol creates them.
Uniswap's pair address is fixed by CREATE2 at `createPair()`; Aave's aToken at
`initReserves()`.

So a council action sits in the middle of what a front-end presents as one user
step, and the number of such actions scales with the protocol rather than with
anything the council controls: one per Uniswap pool, two per Aave reserve.
Automating it would be a standing delegation of exactly the power that the
separation-of-powers design exists to keep separate.

### The perimeter holds on the asset

Swapping or withdrawing KHRt out to an address with no attestation reverts. The
protocols know nothing about KYC; KHRt's own transfer hook stops it. No regulated
asset leaves this way, in either protocol.

### It does not hold on the receipt

LP tokens and aTokens are plain ERC-20s with no compliance hooks. Either can be
transferred to an address that could not receive a single riel of KHRt directly.
Redemption stays blocked — burning or withdrawing to an unverified address fails
— so the asset never escapes. **The economic exposure does.**

On the live chain the holder's position is starker than it sounds: the address in
the recorded Uniswap run holds a claim on pooled KHRt while its `txAllowList` role
is `none`, meaning the chain will not accept *any* transaction from it.

**Verified live for Aave on 2026-07-29, chain 8555.** This was a local result
until then. Measured with `scripts/atoken-escape-test.js`, which simulates both
transfers with `eth_call` and a `from` override — no key, nothing signed:

| | |
|---|---|
| Sender | `0x93318de699311bc7bBd994298feb25335d124f6d` — KYC active (tier 2), `txAllowList: enabled`, holding 10.00 aKHRt and no debt |
| Recipient | `0x0Ebb8283bA8C207c832d6043858e98f10915Fbd9` — **no KYC attestation**, **`txAllowList: none`**, holding nothing |
| `KHRt.transfer` (the asset) | **reverts** |
| `aKHRt.transfer` (the receipt) | **succeeds** |

Two limits on that, stated so nobody has to guess how strong it is. First, the
live node returns a bare `execution reverted` for the KHRt leg without revert
data; the local run decodes the same call to `NotKycActive(0x0Ebb…)`. So the
*refusal* is live-measured and the *stated reason* is inferred from the
recipient's measured status. Second, this is a simulation of chain state, not an
executed transfer — it establishes that the chain permits the transfer, not that
one happened. Executing it would leave an on-chain record; the sender holds
10.00 aKHRt, so it is one transaction away.

This is not patchable at the base layer. `txAllowList` governs who may send a
transaction, not who may hold a claim, and the claim is a contract that was never
told the identity registry exists.

### Lending makes it worse in two specific ways

**The claim compounds.** An aToken accrues interest. Over a simulated year with a
borrower paying, an unverified holder's balance grew — with no transaction by
anyone on its behalf. There is no event for the state to observe.

**One protection is an accident.** Aave lets anyone liquidate: `liquidationCall`
takes the liquidator from `msg.sender`. An unverified liquidator is nonetheless
blocked — because liquidating means repaying the debt, repaying means
transferring KHRt, and an unattested address cannot hold KHRt to pay with.

Nothing in CSB's design produced that. Denominate the debt in something ungated —
a bridged stablecoin, the native coin — and the same market lets an anonymous
party seize a KYC'd borrower's collateral, with no part of the design noticing.
A guarantee that holds by coincidence is worth auditing, not relying on.

And it only delays the leak: a KYC'd liquidator can take the collateral as
aTokens (`receiveAToken = true`) and pass those on. Same destination, one hop
later.

### The honest summary

**The perimeter governs custody. Composability governs exposure.** A design in
this family should say which of the two it is promising, because they are not the
same guarantee and only one of them is enforced.

---

## Costs

**Measured on chain 8555**, at the 1-riel fee policy (`minBaseFee` 47,619 gwei).
Gas is as executed; tRIEL is normalised to the policy floor, since the runs paid
hardhat's fixed 55,000 gwei.

| Operation | Gas | tRIEL | ≈ USD |
|---|---:|---:|---:|
| `UniswapV2Factory` deploy | 3,051,511 | 145.31 | $0.036 |
| Test ERC-20 deploy | 716,193 | 34.10 | $0.009 |
| `createPair` (deploys a pool) | 2,524,114 | 120.20 | $0.030 |
| `setSystemContract` (council) | 48,091 | 2.29 | $0.0006 |
| Add liquidity (`mint`) | 154,978 | 7.38 | $0.002 |
| Uniswap swap | 143,980 | 6.86 | $0.002 |
| **Whole Uniswap experiment** | | **316.14** | **$0.079** |

A complete AMM for about eight US cents is the intended effect of pricing gas for
inclusion rather than for congestion.

**Deployed on 8555, but the cost was not captured.** The market *is* live on 8555
(see the status block above), but nobody recorded what the deploy run printed, and
`scripts/aave-live.js` is idempotent so re-running it reports the existing market
rather than re-measuring. What follows is therefore still a **local** measurement:
standing up the market is **31 transactions and 47,709,671 gas**, which at the
47,619 gwei policy floor is **2,271.89 tRIEL ($0.568)**; the two
`setSystemContract` grants add 96,182 gas (4.58 tRIEL). Gas is deterministic for
identical bytecode, so these carry to 8555 at the same fee policy — but that is an
inference, not a live reading. To get a live figure, delete the `aave` block from
`app/deployments.json`, re-run on 8555, and record the total it prints.

(An earlier estimate of 950–1,200 tRIEL in this file was low by roughly half; it
was derived from an assumption of about twenty deployments rather than the 31 the
market actually takes.)

Note the same `feeManager` call that makes a payment cost one riel makes a
contract deployment cost 145. Gas as fiscal policy binds on deployment economics
too — the same mechanism that made ICM uninstallable until the floor was
temporarily lowered (see `docs/fuji-ictt.md` §1).

---

## Where the evidence lives

This document is the write-up. Everything in it is reproducible from:

- Tests: `test/defi-unmodified.test.js`, `test/defi-aave.test.js`
- Live scripts: `scripts/defi-experiment.js`, `scripts/aave-live.js`
- Shared Aave deployment helper: `scripts/lib/aave.js`

The tests are the authority for the findings — each one is written to fail if the
behaviour it describes stops being true.
