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

**No market-derived comparison yet.** The deployed Uniswap pair already stores
`price0CumulativeLast` / `price1CumulativeLast`, so a TWAP oracle needs no new
infrastructure. Running both — an administered rate and a market-derived one, over
the same asset, on the same chain — and reporting the divergence is the sovereign
monetary question in miniature, and nobody has published it. That is the obvious next
piece of work.

**Importing a real external price re-creates the dependency the design contains.**
A Chainlink feed could be relayed from Fuji over the existing ICM path. It would give
genuine market data and would make the chain's valuations depend on a chain CSB does
not control — and note the asymmetry: the egress gateway governs value *leaving*,
while nothing governs *prices arriving*, and a price is a far smaller thing to
compromise than a token bridge.
