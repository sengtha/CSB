# Foreign currency on CSB

Lock riel, issue dollars. Or yen, or euro — the mechanism does not care which,
and that is most of the point.

- Contracts: `contracts/currency/CurrencyVault.sol`,
  `contracts/currency/SyntheticCurrency.sol`
- Deploy: `npx hardhat run scripts/deploy-currency-vault.js --network csbRemote`
- Tests: `test/currency-vault.test.js` — 36, weighted towards the arithmetic that
  would be wrong silently rather than visibly
- UI: `/currency.html`

## What it replaced, and why that mattered

The only dollar on this chain was `USDx`: Aave's `MintableERC20`, whose `mint()`
has no access control. Anyone could create any amount. Three things followed.

Its **supply was arbitrary**, so the KHRt/USDx pool price was a number with
nothing behind it — a traded rate is only as meaningful as the scarcity of both
sides, and one side had none. It was simultaneously an **Aave reserve at 75%
LTV**, so anyone could mint a pile, post it, and borrow out the riel side
(`docs/defi.md`). And it was outside the compliance perimeter entirely, because
nothing about it checked identity.

The fix is not a better test token. It is **origination**: every unit of khUSD
that exists was minted against KHRt locked in a vault, so total supply is an
arithmetic consequence of the vault's books rather than a decision anybody makes.
The tests assert those two numbers stay equal.

## Riel is the collateral, not the peg

Every design of this shape elsewhere locks dollars to mint something local. Doing
it in reverse is the whole claim of a sovereign chain: **the riel is base money
here**, and foreign currency is the derived, collateralised, capped thing. A chain
settling in USDC cannot make that claim; this one can, and the direction of the
collateral is where it is made concrete rather than asserted.

## It is the same shape as `RielConverter`, plus a price

The converter locks KHRt and mints tRIEL one for one. With no exchange rate there
is no way to become undercollateralised and nothing to liquidate. Add a rate
between two different currencies and price risk appears — which is where the
ratios, the liquidation path and the ceiling all come from. Everything below
follows from that single difference.

| | |
|---|---|
| **Collateral** | KHRt, always. Measured on arrival, because the transfer levy means less can land than was sent — crediting the requested amount would book collateral the vault does not hold, and the shortfall would surface on whoever withdrew last. |
| **To issue** | 150%. |
| **Liquidation** | Below 125%, anyone holding the currency may close part of the position and take that much collateral plus **10%**. |
| **Ceiling** | Per currency, hard, in minor units. See below — this is the control that matters. |
| **Interest** | None. A position left alone stays where it was left unless the published rate moves. |

## The ceiling is what makes it safe, not the ratio

A collateral ratio protects against a price that **moves**. It does nothing about
a price that is **wrong**, and CSB's rates are published by a role against thin
markets — `docs/oracle.md` is explicit that they are instrumentation, not
valuation.

So each currency carries a hard debt ceiling: whatever the oracle says, the chain
cannot issue more than a stated amount. That bounds the damage from a bad rate in
a way no ratio can, and it is the first control to reach for if this is ever
pointed at anything that matters. The starting ceilings are deliberately small —
100,000 khUSD, 10,000,000 khJPY, 100,000 khEUR.

## Failing closed, and what it costs

The rate oracle reverts when a price is stale, so **minting and withdrawing
collateral stop** when nobody is republishing. That is right. Two consequences
follow, and both are tested.

**Liquidation stops too.** An underwater position cannot be closed while the
oracle is silent, so an outage freezes bad debt in place instead of clearing it.
That is the cost of refusing to trade on a number nobody stands behind, and it is
a liveness duty attached to whoever holds `RATE_PUBLISHER_ROLE`.

**Repaying never consults the price.** Reducing your own risk must not be blocked
by the thing that made you risky — that would be the one moment the mechanism
refuses the one action that helps. And once a position has no debt, withdrawing
asks the oracle nothing either, so a stale rate can never trap collateral that
secures nothing. Repay, then withdraw, works during a total oracle outage.

## This one can be gated, and a bridged dollar cannot

`docs/architecture.md` §7.1 accepts that a bridged token arrives with no identity
hook, no freeze and no confiscation, because it is somebody else's contract minted
by somebody else's bridge. That acceptance is **forced, not chosen**.

A currency CSB issues itself has no such constraint. `SyntheticCurrency` checks
the identity registry on every transfer — including issuance, so minting to an
unattested address is refused as firmly as transferring to one. A currency that
could be created into a hand it may not then leave would be a hole in the
perimeter dressed as an issuance policy.

**This is the strongest argument for minting foreign currency here rather than
importing it, and it is worth more than the economics.** It is the only
dollar-denominated asset on the chain that sits inside the compliance perimeter
rather than beside it.

It also produces a protection nobody had to design: **liquidation is
permissionless in the contract and gated in practice**, because a liquidator must
hold the currency to burn it, and holding it requires an attestation. That is the
same accident `docs/defi.md` observed in Aave — except here it is deliberate.

## The CSB-specific parts

**The vault must be attested to hold KHRt**, the same wall the Uniswap pool, the
DAO escrow and every Safe hit. `deploy-currency-vault.js` registers it at tier 3
and deliberately does **not** `setSystemContract`, which would also exempt it from
the transfer levy and the tier caps. A vault should be as constrained as the
people using it.

**Only the vault mints.** There is no issuer role and no administrative mint on
`SyntheticCurrency`, and `vault` is immutable — a vault that could be repointed
would be an issuer role wearing a disguise.

**Decimals follow the currency.** khJPY has none, because the yen has no
circulating subunit and quoting it with two would invent one; khUSD and khEUR have
two. This is the same argument KHRt's two decimals rest on. It is also the thing
most likely to be silently wrong in any code that touches this, which is why the
tests price a 0-decimal currency and a 2-decimal one through the same expression:
a formula that ignores the synth's scale gives the yen answer as 2,700 riel
instead of 27 and leaves the dollar answer untouched, so testing only the dollar
would certify a broken vault.

## What it deliberately does not do

**No interest, no stability fee.** A CDP elsewhere charges one, both to price the
option and to steer the peg. There is no peg to steer here — the rate is
administered, not defended — so a fee would be revenue dressed as a mechanism.

**No auction.** Liquidation is a direct repay-and-seize at a fixed penalty. An
auction is better under real market conditions and needs bidders, which a chain
with a handful of allow-listed participants does not have.

**No close factor.** Once a position is below the threshold a liquidator may
repay all of it, not merely enough to restore it — so a position that dips 1%
under can be closed entirely and pay the full 10% penalty. Aave caps this at half
the debt. The cap is omitted here because with a handful of known participants and
an administered rate, a stuck position that nobody can fully clear is the more
likely failure than an over-eager liquidator; that trade would be wrong on a chain
with anonymous searchers on it.

**No oracle of its own.** It reads `ReferenceRateOracle`, the same administered
feed Aave reads. Inventing a second rate source would mean two numbers for the
same thing and no rule for which one is right.

## Reading a position

Everything on `/currency.html` comes from the vault's own views. The one figure
worth understanding is **liquidated if the rate passes**, computed as

```
rate_threshold = collateral × 10000 × 10^synthDecimals
               ÷ (liqThresholdBps × debt × 10^collateralDecimals)
```

in riel per whole unit. At 1,000,000 riel locked against 100 khUSD at a 125%
threshold, that is 8,000 riel to the dollar — twice the published rate, which is
what a 150% opening ratio buys.

The positions-at-risk table is built from the vault's `Minted` events, because
positions live in a mapping and mappings cannot be enumerated. If the node refuses
a wide `eth_getLogs`, the page says so rather than showing an empty table, which
would read as "nobody is at risk".
