const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySuite, ID_ALICE, ID_BOB } = require("./fixtures");
const { deployAaveMarket } = require("../scripts/lib/aave");

/**
 * AN ADMINISTERED RATE, TESTED AS ONE.
 *
 * The lending market of `defi-aave.test.js` runs against Aave's own `PriceOracle`
 * test contract with a price set by hand, which is honest as a placeholder and
 * useless as anything else: nobody is accountable for the number, it never goes
 * stale, and a single call can reprice the whole market.
 *
 * `ReferenceRateOracle` is what an oracle for this chain should actually look like.
 * The authoritative rate for a domestic currency is published by an institution
 * rather than discovered by trading, so the design goal is not manipulation
 * resistance but ACCOUNTABILITY: every figure cites its source, a figure nobody has
 * refreshed stops being usable, one publication cannot move the rate far, and the
 * publisher cannot widen its own limits.
 *
 * The last test is the one that matters most for the project: Aave accepts it as a
 * drop-in, so the market can be repriced by an authority rather than by the
 * deployer's whim, with no change to Aave.
 */
describe("ReferenceRateOracle — an administered rate with discipline", function () {
  const UNIT = 10n ** 18n;
  const SRC = ethers.id("NBC-daily-reference-2026-07-30");
  const DAY = 24 * 60 * 60;

  async function fixture() {
    const s = await deploySuite();
    const [, , , , , , , publisher] = await ethers.getSigners();
    const oracle = await ethers.deployContract("ReferenceRateOracle", [
      s.council.address,      // governs the bounds
      publisher.address,      // publishes the rate — a different party
      s.khr.target,           // base currency
      UNIT,                   // base currency unit
      2 * DAY,                // maxAge: a rate older than two days stops answering
      1000,                   // maxDeviationBps: 10% per publication
    ]);
    return { ...s, oracle, publisher };
  }

  it("publishes a rate, and records where it came from", async function () {
    const { oracle, publisher, khr } = await loadFixture(fixture);

    await expect(oracle.connect(publisher).publish(khr.target, UNIT, SRC))
      .to.emit(oracle, "RatePublished");

    expect(await oracle.getAssetPrice(khr.target)).to.equal(UNIT);

    const [price, publishedAt, sourceRef, stale] = await oracle.describe(khr.target);
    expect(price).to.equal(UNIT);
    expect(sourceRef).to.equal(SRC);
    expect(stale).to.equal(false);
    expect(publishedAt).to.be.greaterThan(0);
  });

  it("refuses a publication with no citation, and refuses a zero price", async function () {
    const { oracle, publisher, khr } = await loadFixture(fixture);

    // The same discipline the enforcement contracts apply to court orders: an
    // administered number with no stated source is indistinguishable from an
    // invented one.
    await expect(oracle.connect(publisher).publish(khr.target, UNIT, ethers.ZeroHash))
      .to.be.revertedWithCustomError(oracle, "SourceRefRequired");
    await expect(oracle.connect(publisher).publish(khr.target, 0, SRC))
      .to.be.revertedWithCustomError(oracle, "InvalidPrice");
  });

  it("only the publisher publishes, and only the council sets the bounds", async function () {
    const { oracle, publisher, council, alice, khr } = await loadFixture(fixture);

    await expect(oracle.connect(alice).publish(khr.target, UNIT, SRC))
      .to.be.revertedWithCustomError(oracle, "AccessControlUnauthorizedAccount");

    // The point of separating the two: a publisher that could widen its own
    // deviation bound would not be bounded at all.
    await expect(oracle.connect(publisher).setBounds(DAY, 5000))
      .to.be.revertedWithCustomError(oracle, "AccessControlUnauthorizedAccount");
    await expect(oracle.connect(council).setBounds(DAY, 5000)).to.not.be.reverted;
    expect(await oracle.maxDeviationBps()).to.equal(5000);
  });

  it("bounds a single move, so one bad publication cannot reprice the system",
    async function () {
      const { oracle, publisher, khr } = await loadFixture(fixture);
      await oracle.connect(publisher).publish(khr.target, UNIT, SRC);

      // 10% is the configured ceiling. 20% is refused.
      const tooFar = (UNIT * 120n) / 100n;
      await expect(oracle.connect(publisher).publish(khr.target, tooFar, SRC))
        .to.be.revertedWithCustomError(oracle, "DeviationTooLarge");

      // Within the bound is fine, in either direction.
      await expect(oracle.connect(publisher).publish(khr.target, (UNIT * 109n) / 100n, SRC))
        .to.not.be.reverted;
      await expect(oracle.connect(publisher).publish(khr.target, UNIT, SRC))
        .to.not.be.reverted;

      // Worth recording as a cost rather than a feature: a genuine devaluation
      // larger than the bound cannot be published in one step. It must be walked,
      // or the council must widen the bound first — which is a deliberate, visible
      // act, and that is the trade being made.
    });

  it("the first publication is unbounded, or the oracle could never be initialised",
    async function () {
      const { oracle, publisher, khr } = await loadFixture(fixture);
      // Nothing to deviate from, so any positive price is accepted once.
      await expect(oracle.connect(publisher).publish(khr.target, UNIT * 1000n, SRC))
        .to.not.be.reverted;
    });

  it("goes stale and then REFUSES to answer, rather than serving an old number",
    async function () {
      const { oracle, publisher, khr } = await loadFixture(fixture);
      await oracle.connect(publisher).publish(khr.target, UNIT, SRC);

      expect(await oracle.isStale(khr.target)).to.equal(false);

      await time.increase(3 * DAY);

      expect(await oracle.isStale(khr.target)).to.equal(true);
      await expect(oracle.getAssetPrice(khr.target))
        .to.be.revertedWithCustomError(oracle, "RateStale");

      // describe() still answers, so an operator can see WHY without the read
      // reverting — monitor this rather than the price.
      const [price, , , stale] = await oracle.describe(khr.target);
      expect(price).to.equal(UNIT);
      expect(stale).to.equal(true);

      // A fresh publication revives it.
      await oracle.connect(publisher).publish(khr.target, UNIT, SRC);
      expect(await oracle.getAssetPrice(khr.target)).to.equal(UNIT);
    });

  it("an unset asset reverts rather than returning zero", async function () {
    const { oracle, gateway } = await loadFixture(fixture);
    // Returning 0 would be read by a lending market as "worthless", which is a
    // silently wrong answer rather than a refusal.
    await expect(oracle.getAssetPrice(gateway.target))
      .to.be.revertedWithCustomError(oracle, "RateNotSet");
  });

  it("the council can halt an asset, and the halt is loud", async function () {
    const { oracle, publisher, council, khr } = await loadFixture(fixture);
    await oracle.connect(publisher).publish(khr.target, UNIT, SRC);

    const reason = ethers.id("rate-withdrawn-pending-review");
    await expect(oracle.connect(council).clear(khr.target, reason))
      .to.emit(oracle, "RateCleared").withArgs(khr.target, reason);

    await expect(oracle.getAssetPrice(khr.target))
      .to.be.revertedWithCustomError(oracle, "RateNotSet");
  });

  it("AAVE ACCEPTS IT AS A DROP-IN, and the market reprices when the authority says so",
    async function () {
      const s = await loadFixture(fixture);
      await s.identity.connect(s.idAuthority).register(s.alice.address, ID_ALICE, 2);
      await s.identity.connect(s.idAuthority).register(s.bob.address, ID_BOB, 2);
      await s.khr.connect(s.issuer).issue(s.alice.address, 5_000_000_00);

      const aave = await deployAaveMarket(s.council, s.khr.target, 2);
      await s.khr.connect(s.council).setSystemContract(await aave.pool.getAddress(), true);
      await s.khr.connect(s.council).setSystemContract(await aave.aToken.getAddress(), true);

      await s.khr.connect(s.alice).approve(await aave.pool.getAddress(), 1_000_000_00);
      await aave.pool.connect(s.alice).supply(s.khr.target, 1_000_000_00, s.alice.address, 0);

      // Swap the hand-set test oracle for the administered one. Nothing in Aave
      // changes — only the address the addresses provider points at.
      await s.oracle.connect(s.publisher).publish(s.khr.target, UNIT, SRC);
      await (await aave.provider.setPriceOracle(s.oracle.target)).wait();

      const before = await aave.pool.getUserAccountData(s.alice.address);
      expect(before.totalCollateralBase).to.be.greaterThan(0);

      // The authority publishes a lower rate; the market revalues. This is the
      // capability the hand-set oracle could not provide: a price that changes
      // because an accountable party said so, on the record, within a bound.
      await s.oracle.connect(s.publisher).publish(s.khr.target, (UNIT * 92n) / 100n, SRC);
      const after = await aave.pool.getUserAccountData(s.alice.address);

      // Check the MAGNITUDE, not just the direction: an 8% cut in the published
      // rate should move collateral by 8%. A `lessThan` alone would pass on any
      // decrease, including one caused by something other than the oracle.
      expect(after.totalCollateralBase).to.equal(before.totalCollateralBase * 92n / 100n);

      // And a stale rate halts the market rather than letting it trade on an old
      // number — fail-closed, as documented on the contract.
      await time.increase(3 * DAY);
      await expect(aave.pool.getUserAccountData(s.alice.address)).to.be.reverted;
    });
});
