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

> **The escape finding was disputed on 2026-07-30 and is now RESOLVED in its
> favour.** Kept here because the resolution is the more useful result.
>
> An executed MetaMask transfer of 10 aKHRt to the unattested
> `0x0Ebb8283bA8C207c832d6043858e98f10915Fbd9` **failed**
> (`0x6e5f06a567d98bfec71bec3761ec964b0605242c8769cd80c71a6a709058a903`), while the
> same sender moving the same amount to the KYC-active
> `0x93318de699311bc7bBd994298feb25335d124f6d` **confirmed**. That looked like the
> perimeter refusing the receipt, and contradicted the `eth_call` evidence.
>
> **It was gas.** Measured with `scripts/why-did-tx-fail.js`: the call needed
> **~184,463** gas and the wallet gave it **182,013** — short by **2,450**, about
> 1.3%. Replayed at the parent block with the original limit it fails; replayed at
> the same block with more gas it succeeds. So the contracts permitted the transfer
> and nothing refused it.
>
> **Why the wallet came up short, and why it fooled a like-for-like comparison.** An
> aKHRt transfer to a recipient whose aToken balance is **zero** costs **129,725**
> gas; to an address that **already holds** aKHRt, **87,039** — **42,686 more,
> about 49%** — because Aave calls `validateAutomaticUseAsCollateral` and writes a
> collateral bit only on a recipient's first receipt. Two transfers a wallet renders
> identically as "10 aKHRt" therefore differ by half again in cost. A wallet
> estimating per transaction can starve the expensive one while having ample gas for
> the cheap one **in either order**, so transaction ordering does not distinguish
> gas from compliance. The residual 1.3% shortfall is most likely Aave's liquidity
> index advancing between the estimate and execution, which shifts the
> scaled-balance arithmetic — probable, not measured.
>
> **Three methodological points worth carrying into the paper**, because each one
> nearly produced a wrong result here:
>
> 1. A wallet's "failed" is not evidence of a refusal. `gasUsed` at **96.3%** of the
>    limit is not the 100% of a top-level out-of-gas but the signature of an
>    **inner** call exhausting its EIP-150 63/64 allocation — and it reads, wrongly,
>    as "not a gas problem".
> 2. A replay must fix **both** the block and the gas limit. An earlier revision of
>    this diagnostic replayed at the right block with default gas and reported the
>    failure as unexplained, exonerating a gas fault.
> 3. An `eth_call` against `latest` is not evidence about a past block. That is what
>    produced the premature "confirmed live" claim this note replaces.

> **Status: market LIVE on chain 8555; finding statuses as marked.** This block said "local only" until 2026-07-29, which was true when
> written and is not now. Keep the distinction, because it is not all-or-nothing:
>
> | | Status |
> |---|---|
> | Market deployed and in use on 8555 | ✅ **live** — reserve active, LTV 75%, borrowing enabled, 580,000.01 aKHRt outstanding across three holders, one address carrying real variable debt |
> | Finding: the receipt escapes the perimeter | ✅ **live, and executed** — tx `0xc5306114…85ad83a`, block 500, `SUCCESS`; the unattested recipient holds 20.00 aKHRt on chain. Was disputed by an earlier failed transfer, measured to be a gas shortfall rather than a refusal. |
> | Finding: the perimeter holds on the asset | ✅ **live** — `KHRt.transfer` to the unattested address reverts. Not affected by the dispute; both the simulation and the executed transactions agree the asset does not move. |
> | Finding: the claim accrues | ✅ **live at the holder level**, with a precision bound — see below |
> | Finding on liquidation | ⚠️ still **local** (`test/defi-aave.test.js`, where the allow-list precompiles are mocked) |
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
| Recipient (both runs) | `0x0Ebb8283bA8C207c832d6043858e98f10915Fbd9` — **no KYC attestation**, **`txAllowList: none`**, holding nothing |
| Sender A | `0x93318de699311bc7bBd994298feb25335d124f6d` — KYC tier 2, `txAllowList: enabled`, 10.00 aKHRt, **no debt**. Transfer of 1.00: `KHRt` **reverts**, `aKHRt` **succeeds**. |
| Sender B | `0x70E7601Ff820042Fe05c149aA94722A4fB44ba10` — KYC tier 2, 79,990.00 aKHRt, **carrying 50,000.01 of open variable debt**. Transfer of 100.00: `KHRt` **reverts**, `aKHRt` **succeeds**. |

Sender B matters on its own. The leak is not an artifact of choosing a debt-free
holder: a borrower with a live, collateralised position can hand the receipt to an
unattested address while the debt stays behind. Aave will refuse the transfer once
it would push that sender's health factor below 1 — code 35, a debt limit, not a
compliance one — so the constraint on how much exposure can be exported is the
borrower's own solvency, and nothing to do with who the recipient is.

**Executed on chain, 2026-07-30.** No longer a simulation. The holder carrying open
variable debt transferred 20.00 aKHRt to the unattested address in transaction
`0xc5306114cca7210bfabbde99dce6e4f03b7e69e9e4aba4f120bb52b0685ad83a`, block 500,
`status SUCCESS`, 183,469 gas of a 250,000 limit. The recipient's balance is
therefore non-zero on chain and independently checkable:

```
0x0Ebb8283bA8C207c832d6043858e98f10915Fbd9
  supplied (aToken balance)     20.00
  wallet (underlying KHRt)       0.00
  compliance status              NO KYC ATTESTATION, txAllowList: none
```

The gas figure corroborates the earlier failure: 183,469 executed against the
182,013 the wallet had provided, which is why that attempt reverted.

**Aave granted it a collateral position.** The same reading shows
`flagged as using collateral: true`, `totalCollateralBase` 2.0e19 and
`availableBorrowsBase` 1.5e19 — **15.00 KHRt of borrowing power**, being 20.00 at
the 75% LTV, verified against the oracle price of 1e18 per whole KHRt. So the
protocol has not merely let an unattested address hold a claim; it has enrolled that
address as a collateralised borrower eligible to draw on the reserve.

It cannot exercise that today, because `txAllowList: none` means the chain accepts no
transaction from it. The position is nonetheless complete: the entitlement waits in
protocol state rather than needing to be established.

**Two administrative acts stand between the exposure and its realisation, and they are
not equally weighted.** An earlier version of this note said the capacity "activates
the moment the address is admitted to the allow-list". **That was wrong**, and the
distinction matters:

| Act | What it unlocks | Gate |
|---|---|---|
| Allow-list admission alone | **moving or selling the receipt** — an aKHRt transfer touches no gated asset | weak: the audit shows admission occurring through operator provisioning with no attestation issued (4 of 20 addresses on this chain) |
| Admission **plus** an attestation | **drawing on the reserve** | firm: `borrow()` calls `AToken.transferUnderlyingTo`, which is a KHRt transfer to the borrower, so KHRt's own hook checks the borrower's attestation |

Verified in `@aave/core-v3`: `BorrowLogic.executeBorrow` →
`transferUnderlyingTo(params.user, amount)` →
`IERC20(_underlyingAsset).safeTransfer(target, amount)`. So an unattested address
cannot draw on the reserve even once allow-listed — the drawdown is a transfer of the
gated asset and the perimeter holds on it, exactly as everywhere else.

Inertness is therefore "cannot move it **yet**", with the chokepoint on **resale**
weaker than the chokepoint on **drawdown**.

One limit remains: the live node returns a bare `execution reverted` for the refused
KHRt leg with no revert data, where the identical call against the local suite decodes
to `NotKycActive(0x0Ebb…)`. The refusal is live-measured; its stated reason is
inferred from the recipient's measured attestation status.

This is not patchable at the base layer. `txAllowList` governs who may send a
transaction, not who may hold a claim, and the claim is a contract that was never
told the identity registry exists.

### Lending makes it worse in two specific ways

**The claim compounds.** An aToken accrues interest. Over a simulated year with a
borrower paying, an unverified holder's balance grew — with no transaction by
anyone on its behalf. There is no event for the state to observe.

**Demonstrated live on 8555, 2026-07-30, at the holder level.** Between two readings
a day apart, with the 20.00 transfer of the escape run accounted for:

| Holder | adjusted before | after | change |
|---|---:|---:|---:|
| `0xC52D98D0…` | 500,000.01 | 500,000.04 | **+0.03** |
| `0x70E7601F…` | 79,970.00 | 79,970.01 | **+0.01** |
| `0x93318de6…` | 10.00 | 10.00 | +0.00 |
| `0x0Ebb8283…` (unattested) | 20.00 | 20.00 | +0.00 |
| pool total | 580,000.01 | 580,000.05 | **+0.04** |

Two things make this accrual rather than a transfer. **An aToken transfer cannot change
total supply** — it moves scaled balances and leaves `scaledTotalSupply` untouched — so
the +0.04 can only come from the liquidity index advancing. And the increments are
distributed **in proportion to holdings**: at the implied index growth of 6.9e-8, the
expected increments are +0.0345 and +0.0055, which round to the observed +0.03 and
+0.01. That proportionality is the signature of an index update; transfers do not
produce it. Two holders' balances grew with no transaction by them.

**The leaked holding accrues too, below display precision.** An aToken balance is
`scaledBalance × index`, and the index applies to every holder identically, so the
20.00 at the unattested address is growing as well — by 1.4e-6 per interval, which
needs about **7,250 intervals to move a single 0.01 unit**. So the accrual at the
leaked holding is a *mathematical consequence* of a demonstrated live mechanism, not a
separate observation, and `balanceOf` truncating to two decimals is what hides it. The
binding constraint is the token's precision at this utilisation, not the absence of the
mechanism.

State it that way rather than as "accrual is local", which claims less than is known,
and rather than as "the leaked holding was observed to grow", which claims more.

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

### Staking: the first protocol whose reward is a separate asset

`test/defi-staking.test.js` runs Synthetix's **`StakingRewards`** — the most-forked
staking contract in DeFi — compiled from the genuine upstream source in
`node_modules/synthetix`, not a copy or a reimplementation. That required adding solc
0.5.16 to the build, which is the price of keeping the "unmodified protocol" property
the other experiments rest on.

It is structurally different from the first three. Uniswap issued a static claim, Aave
an accruing one, ERC-4626 the same shape as a standard — each a claim **on** the gated
asset. Here the reward is its own token, and the two configurations fail in opposite
directions.

**Reward in an ungated token — the sharpest form of the leak.** An unattested address
stakes, earns, and **collects real spendable value**. Every earlier experiment leaked a
claim whose redemption stayed blocked; this leaks the thing itself, and it moves onward
freely with no gate anywhere.

**Reward in KHRt — a stranded liability, and the perimeter causes it.** Rewards accrue
to an unattested holder and can **never** be collected, because `getReward()` transfers
the gated asset and reverts. The protocol's books record an obligation to a party that
cannot receive it, and the debt keeps growing. This is not a leak. It is the opposite
failure, and as far as we know it is undocumented: **a compliance perimeter under an
unmodified protocol does not only fail to contain value, it can manufacture unpayable
debts.**

Three details worth carrying:

- **The compliance reason is destroyed before anyone sees it.** The revert arrives as
  `SafeERC20: low-level call failed`, not `NotKycActive`. Synthetix builds on
  OpenZeppelin 2.3.0, which predates custom errors: its `SafeERC20` makes a low-level
  call and checks only success, discarding the revert data. An operator or auditor sees
  a generic transfer failure with no on-chain indication that identity caused it. The
  test proves the cause independently rather than trusting the message.
- **`withdraw` works where `exit` fails.** The stake itself is ungated, so a stranded
  holder can retrieve it; `exit` additionally claims the reward and reverts. A
  front-end offering only "exit" would appear broken for that user while "withdraw"
  worked.
- **`StakingRewards` issues no transferable receipt.** The position is a mapping entry,
  not a token, so unlike the other three there is nothing to hand over. That is the one
  structural difference favouring the perimeter — and it is an accident of this
  contract's design, not something the architecture arranged.

### The remedy, built and measured

Everything above diagnoses. `contracts/experiments/CompliantKHRtVault.sol` is the
control: the **same** ERC-4626 over the **same** asset, differing in exactly one
hook — the rule `KHRStablecoin` applies to the asset, applied instead to the share.
A difference in outcome is therefore attributable to the rule's *placement* and to
nothing else. `test/defi-vault-compliant.test.js` runs both side by side.

**It works, and it is small.** Every escape route closes:

| Action, identical in both | Plain vault | Gated vault |
|---|---|---|
| transfer the share to an unattested address | **succeeds** | reverts `NotKycActive` |
| `deposit(assets, receiver=unattested)` — one call, holder never sends | **succeeds** | reverts `NotKycActive` |
| `mint(shares, receiver=unattested)` | **succeeds** | reverts `NotKycActive` |
| frozen holder moves the share | **succeeds** | reverts `AccountFrozen` |
| attested holder transfers, redeems | succeeds | succeeds |

The second row is the one the base layer could never reach. `txAllowList` governs
who *sends* a transaction, and in that call the unattested party sends nothing.

**Use** — DeFi → Vaults (`vaults.html`). Both vaults side by side with deposit and
redeem, plus a panel that simulates `deposit(assets, receiver)` against each with an
`eth_call` and reports which one accepts an unattested receiver. Simulated rather
than executed on purpose: running it for real against the plain vault would leave a
genuine unattested holder of a genuine claim on this chain.

**Use (staking)** — DeFi → Staking (`staking.html`). Both pools, stake and withdraw
and collect, and a check that asks whether a given address could actually be paid
what it is owed — which is the whole difference between the two configurations.

**And it costs composability, measured rather than asserted.** Compose the gated
vault into an ordinary one — the shape of every yield aggregator — and the deposit
reverts, because the outer vault is a contract holding no attestation. Exactly the
position Uniswap's pair and Aave's aToken were in with respect to KHRt, reproduced
one level further out. The council can restore it with `setSystemContract` per
counterparty, after the fact, for an address that did not exist until it was
deployed. **The fix does not introduce a new kind of decision; it multiplies an
existing one.**

Two consequences worth stating rather than discovering later:

- **The question recurses.** Once the outer vault is exempted, *its* shares are
  ungated, and the leak reappears one level up. Each layer of composition needs its
  own gate, or the perimeter ends wherever the gating stopped.
- **A revocation can strand a position.** A revoked holder of a gated share cannot
  transfer it *or* redeem it, because the burn checks the owner. The ungated share
  never does this. That is a policy choice wearing technical clothes, and it should
  be made deliberately.

**What this is not.** It is not a fix for third-party protocols. It works because
the vault is ours to write. Nothing here applies to Uniswap's pair or Aave's aToken
without forking them, which forfeits the "unmodified" property the whole argument
rests on. **The remedy is available exactly where the state controls the code, and
unavailable exactly where composability is the reason for having an open contract
layer.**

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

## Appendix — live contract addresses, chain 8555

Recorded 2026-07-29 from `app/deployments.json`. All nine validated as
correctly-checksummed distinct addresses. Chain ID 8555; the blockchain ID is in
`docs/deployment-status.md`.

**Uniswap V2** — see `scripts/defi-experiment.js` output recorded in
`app/deployments.json` under `defi`.

**Aave V3** (unmodified `@aave/core-v3` 1.19.3):

| Contract | Address |
|---|---|
| `Pool` (proxy — call this one) | `0x57B4f7562Ab046CbBa6315a7F60B1e4d7727566F` |
| `PoolConfigurator` (proxy) | `0x2057B2e2E309535791B79be871A9ca309F54b058` |
| `PoolAddressesProvider` | `0xaDeac5a998Cd6FBE8CF7386d5ce2Ac8E404f152b` |
| `ACLManager` | `0xaC0954c9c7F7fF287bC9F3c829702700d102384e` |
| `PriceOracle` (**test contract, hand-set price**) | `0xe44CBb78ce8D48CAA86ec172Beec121d80a0E2E1` |
| `AToken` — aKHRt | `0xaCE9cdDb2CFcb92FF613E9330D5241fC66586e8D` |
| `VariableDebtToken` | `0xB814576D66F08287cb60f21Bc29aB15d198701E8` |
| `StableDebtToken` | `0x71E7F92318B60632f5620A2B00D812F8141D42E7` |
| Underlying — KHRt (2 decimals) | `0xEAE160F6f9a4D626A5A94402E87F0EB7f89A88C1` |

Reserve parameters, read from the chain on 2026-07-29 and consistent with what
`scripts/lib/aave.js` sets: active, not frozen, not paused; borrowing enabled;
LTV 75%; liquidation threshold 80%; reserve id 0; decimals 2. The oracle price
implied by `getUserAccountData` is 1e18 per whole KHRt, matching the
`setAssetPrice` call in that helper.

Two things to note if these are cited:

- **The `Pool` address is the proxy.** The implementation address is not usable —
  calling it directly appears to work and then reverts on anything touching state,
  because the implementation's own storage is empty.
- **The recorded `note` field on this deployment reads "See docs/paper §5.4",**
  which is not a path in this repository (`scripts/aave-live.js` writes
  "See docs/defi.md"). So the live market was deployed by a slightly different
  revision of that script than the one now committed. The reserve parameters above
  were re-read from the chain rather than assumed, and they match — but a
  reproduction claim should rest on those readings, not on the note.

Re-read any of this instead of trusting it:

```bash
npx hardhat run scripts/aave-diagnose.js --network csbRemote
```

---

## Where the evidence lives

This document is the write-up. Everything in it is reproducible from:

- Tests: `test/defi-unmodified.test.js`, `test/defi-aave.test.js`,
  `test/defi-vault.test.js`, `test/defi-vault-compliant.test.js`,
  `test/defi-staking.test.js`
- Live scripts: `scripts/defi-experiment.js` (Uniswap), `scripts/aave-live.js`
  (Aave), `scripts/experiments-live.js` (both ERC-4626 vaults, the TWAP oracle,
  and the two staking pools)
- Shared Aave deployment helper: `scripts/lib/aave.js`

`experiments-live.js` is idempotent per module — each block is skipped if
`deployments.json` already records it with code at that address, so a re-run after a
partial failure resumes rather than duplicating. `CSB_SKIP=staking,twap` skips
modules deliberately. It grants three contracts KHRt system-contract status (both
vaults and the KHRt-reward staking pool), which is a real privilege on a live chain,
and prints the `setSystemContract(..., false)` revoke command for each one at the
end.

The tests are the authority for the findings — each one is written to fail if the
behaviour it describes stops being true.
