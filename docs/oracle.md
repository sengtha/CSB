# Prices on a sovereign chain

CSB had no price feed. The Aave market ran against Aave's own `PriceOracle` test
contract with a number set by hand at deployment — honest as a placeholder, useless
as anything else: nobody was accountable for it, it never expired, and one call
could reprice the whole market.

`contracts/oracle/ReferenceRateOracle.sol` replaces it. Tests:
`test/oracle-reference-rate.test.js`.

---

## Why this is not a normal DeFi oracle

Public-chain oracles aggregate market data because no participant is authoritative.
That is the right design when the price is a fact to be discovered.

On a sovereign chain the authoritative number for the domestic currency is
**administered**: the central bank publishes a daily reference rate, and in a highly
dollarized economy that rate is the nominal anchor rather than an observation of
trading. So the honest oracle here reports a published figure faithfully and is
auditable about its provenance — close to the opposite of the manipulation
resistance a public oracle optimises for.

This contract therefore **trusts its publisher completely**. What it adds over "an
address sets a number" is the discipline that makes an administered rate auditable:

| | |
|---|---|
| **Cited source** | every publication carries a `sourceRef` — the same on-chain citation pattern the enforcement contracts use for court orders. A figure with no stated source is indistinguishable from an invented one. |
| **Expiry** | a rate goes stale and then *stops answering*, so no market trades on last week's number. |
| **Bounded moves** | one publication cannot move the rate more than `maxDeviationBps`, so a single mistaken or compromised post cannot reprice the system. |
| **Split roles** | `RATE_PUBLISHER_ROLE` publishes; the council sets the bounds. A publisher that could widen its own limits would not be bounded. |
| **Circuit breaker** | the council can `clear` an asset, halting anything that reads it. |

---

## It fails closed, and that costs something

When a rate is unset or stale, `getAssetPrice` **reverts**. A lending market reading
a stale price is worse than one that halts, so halting is right.

But be clear about the consequence: **if nobody republishes within `maxAge`, every
Aave read reverts** — supply, borrow, withdraw, liquidate, and the health factor in
the app. An administrative duty becomes a liveness dependency, and a market can be
halted by forgetting.

Monitor the freshness, not the price:

```solidity
oracle.isStale(asset)      // true when getAssetPrice would refuse
oracle.describe(asset)     // price, publishedAt, sourceRef, stale — never reverts
```

---

## Deploying

```bash
source ops/csb-env.sh
npx hardhat run scripts/oracle-deploy.js --network csbRemote
```

Optional environment: `CSB_RATE_PUBLISHER` (default: the deployer),
`CSB_MAX_AGE` (default 172800 = 2 days), `CSB_MAX_DEV_BPS` (default 1000 = 10%),
and `CSB_WIRE_AAVE=1`.

Deploying alone **changes nothing**. Wiring Aave is opt-in because it is what
introduces the fail-closed behaviour above. The script prints the previous oracle
address so the change can be reverted.

The initial rate published is 1e18 — exactly what the live market already reads — so
wiring it in **does not revalue any position**. What changes is who may set the
number and under what discipline, not the number.

> **If the publisher and the council are the same address, the separation this
> contract is built for is not exercised.** The script says so at deploy time. On the
> current deployment they are the same key, like every other role
> (`README.md`, "What the deployment is not").

---

## What is still missing

**One asset, one rate, and the rate is parity.** The market prices KHRt against
itself, so the oracle currently changes nothing economically — it changes who is
accountable. A second listed asset at a genuinely different price is what would make
the lending market a real one, and would let liquidation be demonstrated by moving a
price rather than by tightening the liquidation threshold.

---

# The market rate, beside it

`contracts/oracle/UniswapV2TwapOracle.sol` reads the time-weighted price straight
out of a Uniswap V2 pair. No publisher, no off-chain infrastructure, no new trust:
V2 pairs already accumulate `price0CumulativeLast`, and the pool it reads was
deployed by `scripts/defi-experiment.js` for an unrelated experiment.

It implements the same `getAssetPrice` interface, so the two oracles are directly
swappable and directly comparable.

**The comparison is the point.** One reports what an authority says the rate is; the
other reports what the chain's own market did. Neither substitutes for the other,
and the gap between them is the sovereign monetary question in miniature — readable
off the ledger rather than surveyed. `test/oracle-twap.test.js` demonstrates it: a
pool trading at 4,000 against a published rate of 4,200 gives a divergence of 500
basis points, computed on chain.

### Do not price a lending market with this one

A TWAP costs as much to manipulate as the liquidity behind it, and the CSB pool is
small. A longer window raises the attack cost and makes the price staler; neither
end of that trade is safe here. **This is a measurement instrument on this chain, not
a valuation source.** The administered oracle is the one to wire into Aave; this one
is for observing what the market says while it does.

### Deploying and feeding it

```bash
source ops/csb-env.sh
npx hardhat run scripts/experiments-live.js --network csbRemote   # deploys it against defi.pair
npx hardhat run scripts/twap-update.js --network csbRemote        # then, periodically
```

**A TWAP is not a feed, and this is the part that catches people.** The pair
accumulates the time-weighted price by itself, but somebody has to read that
accumulator and divide, or there is no average to quote. `update()` is
permissionless — anyone may call it, which is what makes the price trustless — but
"anyone can" is not "someone does". On this chain that someone is a cron entry or a
person running `twap-update.js`.

If nobody does, reads revert with `AverageStale` once the last update is older than
`maxAge` (a week, as deployed). That is the oracle failing closed, and it is
deliberate: a stale market price is worse than none, because it still looks like an
answer. Running the script too often is harmless — a call inside `minWindow` reverts
with `WindowTooShort`, which the script detects and reports as a no-op rather than an
error, so it can sit in a cron entry without generating noise.

`experiments-live.js` deliberately does **not** point Aave at this oracle, for the
reason immediately above.

### Two implementation notes worth keeping

**It is not Uniswap's oracle library.** The `UniswapV2OracleLibrary` in v2-periphery
is written for Solidity <0.8 and its correctness *depends* on arithmetic wrapping —
its own comments say "subtraction overflow is desired". Under 0.8 those operations
revert instead of wrapping, so compiling it unchanged would give a contract that
reverts exactly when the accumulator or the uint32 clock wraps: rarely, and years
after deployment. The arithmetic is reimplemented with `unchecked` at the three
places where wrapping is intended and nowhere else.

**Precision is bounded at one raw base unit.** UQ112x112 truncates, so a quote can
sit up to one raw unit of the base token below the exact ratio — with KHRt's two
decimals, 0.01 riel. A pool holding exactly 4,000 KHRt per counterpart quotes
3,999.99. This is inherent to the representation, Uniswap's own oracle has it too,
and it is always a floor rather than an overstatement. The tests assert the bound and
assert the direction, because asserting exact equality would be asserting something
the fixed-point representation cannot deliver.

### Still missing

**A live comparison.** Both findings above are local results. The deployment scripts
exist — `oracle-deploy.js` for the administered rate, `experiments-live.js` for the
TWAP — but the measurement that is actually worth publishing is the *divergence over
time* between the two on 8555, and that needs the TWAP fed on a schedule for long
enough to have a series. Nothing here reports that yet.

**Importing a real external price re-creates the dependency the design contains.**
A Chainlink feed could be relayed from Fuji over the existing ICM path. It would give
genuine market data and would make the chain's valuations depend on a chain CSB does
not control — and note the asymmetry: the egress gateway governs value *leaving*,
while nothing governs *prices arriving*, and a price is a far smaller thing to
compromise than a token bridge.
