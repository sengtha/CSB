const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySuite, ID_ALICE, ID_BOB } = require("./fixtures");

/**
 * LOCK RIEL, MINT FOREIGN CURRENCY.
 *
 * What replaced a token anybody could mint from nothing. The interesting failures
 * here are arithmetic, not access control: a decimal scale dropped somewhere in
 * `_rielValue` produces a number that is wrong by a factor of a hundred and looks
 * entirely plausible on a screen, and the first anyone would know is a position
 * liquidated that was never underwater. So the scaling is pinned against hand-
 * computed riel figures for currencies with DIFFERENT decimals — two, and zero —
 * because a formula that ignores the synth's scale passes every test written with
 * only one currency in it.
 *
 * The other thing tested here rather than argued: the oracle fails closed, which
 * means an outage must not trap anyone. Repaying and withdrawing free collateral
 * are the two operations that reduce risk, and both must survive a silent
 * publisher. Minting and withdrawing against live debt must not.
 *
 * Riel arithmetic, once, so the numbers below can be read:
 *   KHRt has 2 decimals and 1 whole KHRt = 1 riel, so 100_000_000 minor units is
 *   1,000,000 riel. The oracle quotes riel per WHOLE synth unit scaled by 1e18,
 *   matching the live market (scripts/oracle-deploy.js). 4000e18 is 4,000 riel to
 *   the dollar.
 */

const UNIT = 10n ** 18n;              // oracle scale, as deployed
const MAX_AGE = 172_800n;             // two days, as deployed
const REF = ethers.id("test-rate");

const USD = 4_000n * UNIT;            // 4,000 riel per dollar
const JPY = 27n * UNIT;               // 27 riel per yen

const ID_VAULT = ethers.id("identity-currency-vault");
const ID_CARL = ethers.id("identity-carl");

describe("CurrencyVault — riel in, foreign currency out", function () {
  async function fixture() {
    const s = await deploySuite();
    const { identity, khr, council, idAuthority, issuer, alice, bob, outsider } = s;

    await identity.connect(idAuthority).register(alice.address, ID_ALICE, 2);
    await identity.connect(idAuthority).register(bob.address, ID_BOB, 2);
    await khr.connect(issuer).issue(alice.address, 100_000_000n);   // 1,000,000 riel
    await khr.connect(issuer).issue(bob.address, 100_000_000n);

    // Deviation bound disabled: these tests move the rate deliberately and by a
    // lot, which is the publisher's discipline rather than the vault's.
    const oracle = await ethers.deployContract("ReferenceRateOracle", [
      council.address, council.address, khr.target, UNIT, MAX_AGE, 0n,
    ]);

    const vault = await ethers.deployContract("CurrencyVault", [
      khr.target, oracle.target, council.address,
    ]);

    // The vault custodies KHRt, and KHRt will not move to an address the registry
    // does not know — the same wall every other protocol on this chain hits. It is
    // attested, deliberately not made a system contract: a vault should be as
    // constrained as the people using it.
    await identity.connect(idAuthority).register(vault.target, ID_VAULT, 3);

    const khUSD = await ethers.deployContract("SyntheticCurrency", [
      "CSB Synthetic US Dollar", "khUSD", 2, identity.target, vault.target,
    ]);
    const khJPY = await ethers.deployContract("SyntheticCurrency", [
      "CSB Synthetic Japanese Yen", "khJPY", 0, identity.target, vault.target,
    ]);

    await oracle.connect(council).publish(khUSD.target, USD, REF);
    await oracle.connect(council).publish(khJPY.target, JPY, REF);

    // 150% to mint, liquidatable below 125%, 10% penalty, 1,000,000 dollar ceiling.
    await vault.connect(council).addCurrency(khUSD.target, 15_000, 12_500, 1_000, 100_000_000n);
    await vault.connect(council).addCurrency(khJPY.target, 15_000, 12_500, 1_000, 1_000_000_000n);

    return { ...s, oracle, vault, khUSD, khJPY, USD_ID: 0n, JPY_ID: 1n, outsider };
  }

  // ------------------------------------------------------------------ registration

  describe("registering a currency", function () {
    it("refuses a synth that names a different vault", async function () {
      const { vault, identity, council, outsider } = await loadFixture(fixture);
      const stray = await ethers.deployContract("SyntheticCurrency", [
        "Stray", "STRAY", 2, identity.target, outsider.address,
      ]);
      await expect(vault.connect(council).addCurrency(stray.target, 15_000, 12_500, 1_000, 1n))
        .to.be.revertedWithCustomError(vault, "BadParameters");
    });

    it("refuses a threshold at or above the minting ratio", async function () {
      const { vault, khUSD, council } = await loadFixture(fixture);
      // Equal would mean every position is liquidatable the instant it opens.
      await expect(vault.connect(council).addCurrency(khUSD.target, 15_000, 15_000, 1_000, 1n))
        .to.be.revertedWithCustomError(vault, "BadParameters");
      await expect(vault.connect(council).addCurrency(khUSD.target, 15_000, 16_000, 1_000, 1n))
        .to.be.revertedWithCustomError(vault, "BadParameters");
    });

    it("refuses a threshold below par and a penalty above 50%", async function () {
      const { vault, khUSD, council } = await loadFixture(fixture);
      await expect(vault.connect(council).addCurrency(khUSD.target, 15_000, 9_999, 1_000, 1n))
        .to.be.revertedWithCustomError(vault, "BadParameters");
      await expect(vault.connect(council).addCurrency(khUSD.target, 15_000, 12_500, 5_001, 1n))
        .to.be.revertedWithCustomError(vault, "BadParameters");
    });

    it("is not open to anyone", async function () {
      const { vault, khUSD, alice } = await loadFixture(fixture);
      await expect(vault.connect(alice).addCurrency(khUSD.target, 15_000, 12_500, 1_000, 1n))
        .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("records both currencies with their own decimals", async function () {
      const { vault } = await loadFixture(fixture);
      expect(await vault.currencyCount()).to.equal(2n);
      expect((await vault.currencyAt(0n)).synthDecimals).to.equal(2);
      expect((await vault.currencyAt(1n)).synthDecimals).to.equal(0);
      await expect(vault.currencyAt(2n)).to.be.revertedWithCustomError(vault, "NoSuchCurrency");
    });
  });

  // ------------------------------------------------------------------- the scaling

  describe("valuing debt in riel", function () {
    /**
     * The whole reason two currencies with different decimals exist in this file.
     * A formula that forgets `10 ** synthDecimals` gives the yen answer as 2,700
     * riel instead of 27 and the dollar answer unchanged, so testing the dollar
     * alone would certify a broken vault.
     */
    it("one dollar is 4,000 riel and one yen is 27, from the same expression", async function () {
      const { vault } = await loadFixture(fixture);
      // 1 khUSD = 100 minor units (2dp) -> 4,000 riel -> 400,000 KHRt minor units
      expect(await vault.rielValueOf(0n, 100n)).to.equal(400_000n);
      // 1 khJPY = 1 minor unit (0dp) -> 27 riel -> 2,700 KHRt minor units
      expect(await vault.rielValueOf(1n, 1n)).to.equal(2_700n);
    });

    it("keeps the fractional riel of a sub-unit debt", async function () {
      const { vault } = await loadFixture(fixture);
      // One US cent is 40 riel exactly; multiplying before dividing keeps it.
      expect(await vault.rielValueOf(0n, 1n)).to.equal(4_000n);
    });

    it("reports a debt-free position as infinitely collateralised", async function () {
      const { vault, alice } = await loadFixture(fixture);
      expect(await vault.ratioBps(0n, alice.address)).to.equal(ethers.MaxUint256);
    });
  });

  // --------------------------------------------------------------------- opening

  describe("opening a position", function () {
    it("locks riel, issues dollars, and reports the ratio", async function () {
      const { vault, khr, khUSD, alice } = await loadFixture(fixture);
      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).open(0n, 100_000_000n, 10_000n);   // 1,000,000 riel : 100 khUSD

      const p = await vault.positionOf(0n, alice.address);
      expect(p.collateral).to.equal(100_000_000n);
      expect(p.debt).to.equal(10_000n);
      expect(await khUSD.balanceOf(alice.address)).to.equal(10_000n);
      expect(await khr.balanceOf(vault.target)).to.equal(100_000_000n);
      // 1,000,000 riel against 400,000 of debt is 250%.
      expect(await vault.ratioBps(0n, alice.address)).to.equal(25_000n);
      expect((await vault.currencyAt(0n)).totalDebt).to.equal(10_000n);
    });

    it("refuses to mint past the collateral ratio", async function () {
      const { vault, khr, alice } = await loadFixture(fixture);
      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).deposit(0n, 100_000_000n);

      // 1,000,000 riel at 150% supports 666,666 riel of debt = 166.66 khUSD.
      const max = await vault.maxDebt(0n, alice.address);
      expect(max).to.equal(16_666n);
      await expect(vault.connect(alice).mint(0n, max + 1n))
        .to.be.revertedWithCustomError(vault, "Undercollateralised");
      await expect(vault.connect(alice).mint(0n, max)).to.not.be.reverted;
      expect(await vault.ratioBps(0n, alice.address)).to.be.gte(15_000n);
    });

    it("refuses a position on a currency that does not exist", async function () {
      const { vault, alice } = await loadFixture(fixture);
      await expect(vault.connect(alice).deposit(7n, 1n))
        .to.be.revertedWithCustomError(vault, "NoSuchCurrency");
    });

    it("credits what arrived, not what was asked for", async function () {
      const { vault, khr, council, alice, bob } = await loadFixture(fixture);
      // KHRt takes a flat levy on transfer. Booking the requested amount would
      // credit collateral the vault does not hold, and the shortfall would land
      // on whoever withdrew last.
      await khr.connect(council).setTransferLevy(500n, bob.address);   // 5 riel
      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).deposit(0n, 100_000_000n);

      const p = await vault.positionOf(0n, alice.address);
      expect(p.collateral).to.equal(100_000_000n - 500n);
      expect(p.collateral).to.equal(await khr.balanceOf(vault.target));
    });

    it("refuses a zero deposit and a zero mint", async function () {
      const { vault, alice } = await loadFixture(fixture);
      await expect(vault.connect(alice).deposit(0n, 0n))
        .to.be.revertedWithCustomError(vault, "NothingToDo");
      await expect(vault.connect(alice).mint(0n, 0n))
        .to.be.revertedWithCustomError(vault, "NothingToDo");
    });
  });

  // ------------------------------------------------------------------ the ceiling

  describe("the debt ceiling", function () {
    /**
     * The control that actually bounds a wrong oracle. A ratio protects against a
     * price that moves; nothing about a ratio protects against a price that is
     * simply wrong, and CSB's rates are published by a role against thin markets.
     */
    it("binds even when the position is enormously overcollateralised", async function () {
      const { vault, khr, council, alice } = await loadFixture(fixture);
      await vault.connect(council).configureCurrency(0n, 15_000, 12_500, 1_000, 5_000n, false);

      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).deposit(0n, 100_000_000n);

      await expect(vault.connect(alice).mint(0n, 5_001n))
        .to.be.revertedWithCustomError(vault, "DebtCeilingReached")
        .withArgs(5_000n, 5_001n);
      await vault.connect(alice).mint(0n, 5_000n);
      await expect(vault.connect(alice).mint(0n, 1n))
        .to.be.revertedWithCustomError(vault, "DebtCeilingReached");
    });

    it("frees room again when debt is repaid", async function () {
      const { vault, khr, council, alice } = await loadFixture(fixture);
      await vault.connect(council).configureCurrency(0n, 15_000, 12_500, 1_000, 5_000n, false);
      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).open(0n, 100_000_000n, 5_000n);

      await vault.connect(alice).repay(0n, 2_000n);
      expect((await vault.currencyAt(0n)).totalDebt).to.equal(3_000n);
      await expect(vault.connect(alice).mint(0n, 2_000n)).to.not.be.reverted;
    });

    it("stops minting when paused, without touching anything else", async function () {
      const { vault, khr, council, alice } = await loadFixture(fixture);
      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).open(0n, 100_000_000n, 10_000n);

      await vault.connect(council).configureCurrency(0n, 15_000, 12_500, 1_000, 100_000_000n, true);
      await expect(vault.connect(alice).mint(0n, 1n))
        .to.be.revertedWithCustomError(vault, "MintingPaused");
      // Repaying and unwinding stay open — a pause is not a trap.
      await expect(vault.connect(alice).repay(0n, 10_000n)).to.not.be.reverted;
      await expect(vault.connect(alice).withdraw(0n, 100_000_000n)).to.not.be.reverted;
    });
  });

  // ------------------------------------------------------------------- unwinding

  describe("repaying and withdrawing", function () {
    it("burns the synth and releases the riel", async function () {
      const { vault, khr, khUSD, alice } = await loadFixture(fixture);
      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).open(0n, 100_000_000n, 10_000n);

      await vault.connect(alice).repay(0n, 10_000n);
      expect(await khUSD.balanceOf(alice.address)).to.equal(0n);
      expect(await khUSD.totalSupply()).to.equal(0n);

      await vault.connect(alice).withdraw(0n, 100_000_000n);
      expect(await khr.balanceOf(alice.address)).to.equal(100_000_000n);
      expect(await khr.balanceOf(vault.target)).to.equal(0n);
    });

    it("will not release collateral that is still securing debt", async function () {
      const { vault, khr, alice } = await loadFixture(fixture);
      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).open(0n, 100_000_000n, 10_000n);

      // 400,000 riel of debt at 150% needs 600,000 riel locked; 400,001 is too much
      // to take out.
      await expect(vault.connect(alice).withdraw(0n, 40_000_100n))
        .to.be.revertedWithCustomError(vault, "Undercollateralised");
      await expect(vault.connect(alice).withdraw(0n, 40_000_000n)).to.not.be.reverted;
      expect(await vault.ratioBps(0n, alice.address)).to.equal(15_000n);
    });

    it("refuses to repay more than is owed, and to withdraw more than is held", async function () {
      const { vault, khr, alice } = await loadFixture(fixture);
      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).open(0n, 100_000_000n, 10_000n);

      await expect(vault.connect(alice).repay(0n, 10_001n))
        .to.be.revertedWithCustomError(vault, "RepayExceedsDebt").withArgs(10_000n, 10_001n);
      await expect(vault.connect(alice).withdraw(0n, 100_000_001n))
        .to.be.revertedWithCustomError(vault, "InsufficientCollateral");
    });
  });

  // ----------------------------------------------------------- the oracle is out

  describe("when the publisher goes quiet", function () {
    async function stale() {
      const f = await loadFixture(fixture);
      await f.khr.connect(f.alice).approve(f.vault.target, 100_000_000n);
      await f.vault.connect(f.alice).open(0n, 100_000_000n, 10_000n);
      await time.increase(MAX_AGE + 1n);
      return f;
    }

    it("stops minting and stops releasing collateral against live debt", async function () {
      const { vault, oracle, alice } = await stale();
      await expect(vault.connect(alice).mint(0n, 1n))
        .to.be.revertedWithCustomError(oracle, "RateStale");
      await expect(vault.connect(alice).withdraw(0n, 1n))
        .to.be.revertedWithCustomError(oracle, "RateStale");
    });

    it("lets the borrower out anyway: repay, then withdraw", async function () {
      const { vault, khr, alice } = await stale();
      // The one operation that must never be blocked by the thing that made you
      // risky. Repay consults no price at all, and once the debt is gone there is
      // no ratio left to check.
      await vault.connect(alice).repay(0n, 10_000n);
      await vault.connect(alice).withdraw(0n, 100_000_000n);
      expect(await khr.balanceOf(alice.address)).to.equal(100_000_000n);
    });

    it("freezes liquidation too — the cost of failing closed, stated", async function () {
      const { vault, oracle, bob } = await stale();
      // An underwater position cannot be cleared while nobody is republishing. This
      // is not a bug to be fixed by returning a last-known price; it is the price
      // of refusing to trade on a number nobody stands behind.
      await expect(vault.connect(bob).liquidate(0n, bob.address, 1n))
        .to.be.revertedWithCustomError(vault, "NothingToDo");
    });

    it("a currency the oracle never priced cannot be borrowed at all", async function () {
      const { vault, oracle, khr, identity, council, idAuthority, alice } = await loadFixture(fixture);
      const khEUR = await ethers.deployContract("SyntheticCurrency", [
        "CSB Synthetic Euro", "khEUR", 2, identity.target, vault.target,
      ]);
      await vault.connect(council).addCurrency(khEUR.target, 15_000, 12_500, 1_000, 1_000_000n);
      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).deposit(2n, 100_000_000n);
      await expect(vault.connect(alice).mint(2n, 1n))
        .to.be.revertedWithCustomError(oracle, "RateNotSet");
      // And the collateral is not stranded by that.
      await expect(vault.connect(alice).withdraw(2n, 100_000_000n)).to.not.be.reverted;
    });
  });

  // ------------------------------------------------------------------ liquidation

  describe("liquidation", function () {
    async function underwater() {
      const f = await loadFixture(fixture);
      const { vault, khr, oracle, council, alice, bob } = f;
      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).open(0n, 100_000_000n, 10_000n);   // 100 khUSD at 250%
      await khr.connect(bob).approve(vault.target, 100_000_000n);
      await vault.connect(bob).open(0n, 100_000_000n, 10_000n);     // bob holds dollars to burn

      // The riel weakens to 8,500 to the dollar. Alice's 400,000 riel of debt is
      // now 850,000 against 1,000,000 locked: 117.6%, below the 125% threshold.
      await oracle.connect(council).publish(f.khUSD.target, 8_500n * UNIT, REF);
      return f;
    }

    it("refuses while the position is above the threshold", async function () {
      const { vault, khr, alice, bob, khUSD } = await loadFixture(fixture);
      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).open(0n, 100_000_000n, 10_000n);
      await khr.connect(bob).approve(vault.target, 100_000_000n);
      await vault.connect(bob).open(0n, 100_000_000n, 10_000n);

      await expect(vault.connect(bob).liquidate(0n, alice.address, 1_000n))
        .to.be.revertedWithCustomError(vault, "NotLiquidatable").withArgs(25_000n, 12_500n);
      expect(await khUSD.balanceOf(bob.address)).to.equal(10_000n);
    });

    it("pays the liquidator the debt's riel value plus the penalty", async function () {
      const { vault, khr, khUSD, alice, bob } = await underwater();
      expect(await vault.ratioBps(0n, alice.address)).to.equal(11_764n);

      await vault.connect(bob).liquidate(0n, alice.address, 5_000n);   // 50 khUSD

      // 50 khUSD at 8,500 is 425,000 riel; +10% penalty is 467,500.
      const seized = 46_750_000n;
      expect(await khr.balanceOf(bob.address)).to.equal(seized);
      expect(await khUSD.balanceOf(bob.address)).to.equal(5_000n);

      const p = await vault.positionOf(0n, alice.address);
      expect(p.debt).to.equal(5_000n);
      expect(p.collateral).to.equal(100_000_000n - seized);
      // Alice keeps the dollars she borrowed — liquidation takes collateral, not
      // the proceeds.
      expect(await khUSD.balanceOf(alice.address)).to.equal(10_000n);
      // System debt falls with the position's.
      expect((await vault.currencyAt(0n)).totalDebt).to.equal(15_000n);
    });

    it("restores the position above the threshold, so a partial close is enough", async function () {
      const { vault, alice, bob } = await underwater();
      await vault.connect(bob).liquidate(0n, alice.address, 5_000n);
      // 532,500 riel against 425,000 of debt.
      expect(await vault.ratioBps(0n, alice.address)).to.equal(12_529n);
      await expect(vault.connect(bob).liquidate(0n, alice.address, 1n))
        .to.be.revertedWithCustomError(vault, "NotLiquidatable");
    });

    it("takes everything and no more when the penalty exceeds what is left", async function () {
      const { vault, oracle, khr, khUSD, council, alice, bob } = await underwater();
      await vault.connect(bob).liquidate(0n, alice.address, 5_000n);
      const left = (await vault.positionOf(0n, alice.address)).collateral;

      // A catastrophic repricing: 50 khUSD is now worth far more than the whole
      // remaining position. Reverting here would leave the debt outstanding with
      // nobody able to clear it, which is worse than an incomplete recovery.
      await oracle.connect(council).publish(khUSD.target, 100_000n * UNIT, REF);
      const before = await khr.balanceOf(bob.address);

      await vault.connect(bob).liquidate(0n, alice.address, 5_000n);

      expect(await khr.balanceOf(bob.address) - before).to.equal(left);
      const p = await vault.positionOf(0n, alice.address);
      expect(p.collateral).to.equal(0n);
      expect(p.debt).to.equal(0n);
    });

    it("refuses to repay more of a position than it owes, or to touch a clean one", async function () {
      const { vault, alice, bob, outsider } = await underwater();
      await expect(vault.connect(bob).liquidate(0n, alice.address, 10_001n))
        .to.be.revertedWithCustomError(vault, "RepayExceedsDebt");
      await expect(vault.connect(bob).liquidate(0n, outsider.address, 1n))
        .to.be.revertedWithCustomError(vault, "NothingToDo");
    });

    it("is open to anyone the chain already knows, and to nobody else", async function () {
      const { vault, identity, khUSD, idAuthority, alice, bob, outsider } = await underwater();
      // Permissionless in the contract, gated in practice by the synth: a
      // liquidator must HOLD the currency, and the currency checks the registry.
      // The same accidental protection docs/defi.md found in Aave, except here it
      // is deliberate.
      await identity.connect(idAuthority).register(outsider.address, ID_CARL, 2);
      await khUSD.connect(bob).transfer(outsider.address, 6_000n);
      await expect(vault.connect(outsider).liquidate(0n, alice.address, 5_000n)).to.not.be.reverted;

      // Revoked, the same holder cannot burn — so cannot liquidate. Bob's own
      // position is underwater at the same price, so the ratio check passes and
      // the refusal is unambiguously the registry's.
      await identity.connect(idAuthority).revoke(outsider.address);
      await expect(vault.connect(outsider).liquidate(0n, bob.address, 1_000n))
        .to.be.revertedWithCustomError(khUSD, "NotKycActive").withArgs(outsider.address);
    });
  });

  // -------------------------------------------------------------- two currencies

  describe("more than one currency at a time", function () {
    it("keeps positions and ceilings separate", async function () {
      const { vault, khr, khUSD, khJPY, alice } = await loadFixture(fixture);
      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).open(0n, 50_000_000n, 5_000n);        // 50 khUSD
      await vault.connect(alice).open(1n, 50_000_000n, 10_000n);       // 10,000 khJPY

      expect(await khUSD.balanceOf(alice.address)).to.equal(5_000n);
      expect(await khJPY.balanceOf(alice.address)).to.equal(10_000n);
      // 500,000 riel against 200,000 (50 x 4,000) is 250%.
      expect(await vault.ratioBps(0n, alice.address)).to.equal(25_000n);
      // 500,000 riel against 270,000 (10,000 x 27) is 185%.
      expect(await vault.ratioBps(1n, alice.address)).to.equal(18_518n);

      // Repaying the dollar position leaves the yen one exactly where it was.
      await vault.connect(alice).repay(0n, 5_000n);
      expect((await vault.positionOf(1n, alice.address)).debt).to.equal(10_000n);
      expect((await vault.currencyAt(1n)).totalDebt).to.equal(10_000n);
    });

    it("a currency with no decimals prices the same way as one with two", async function () {
      const { vault, khr, alice } = await loadFixture(fixture);
      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).deposit(1n, 100_000_000n);
      // 1,000,000 riel at 150% supports 666,666 riel = 24,691 yen at 27 riel each.
      expect(await vault.maxDebt(1n, alice.address)).to.equal(24_691n);
      await expect(vault.connect(alice).mint(1n, 24_692n))
        .to.be.revertedWithCustomError(vault, "Undercollateralised");
      await expect(vault.connect(alice).mint(1n, 24_691n)).to.not.be.reverted;
    });
  });

  // -------------------------------------------------------------------- the synth

  describe("SyntheticCurrency", function () {
    it("has no issuer but the vault", async function () {
      const { khUSD, council, alice } = await loadFixture(fixture);
      await expect(khUSD.connect(council).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(khUSD, "OnlyVault");
      await expect(khUSD.connect(alice).burn(alice.address, 1n))
        .to.be.revertedWithCustomError(khUSD, "OnlyVault");
    });

    it("checks the registry on issuance, not only on transfer", async function () {
      const { identity, council, outsider } = await loadFixture(fixture);
      // A synth whose "vault" is an EOA, so issuance can be called directly. A
      // currency that could be minted into a hand it may not then leave would be a
      // hole in the perimeter dressed as an issuance policy.
      const probe = await ethers.deployContract("SyntheticCurrency", [
        "Probe", "PRB", 2, identity.target, council.address,
      ]);
      await expect(probe.connect(council).mint(outsider.address, 1n))
        .to.be.revertedWithCustomError(probe, "NotKycActive").withArgs(outsider.address);
    });

    it("refuses to move to an address the registry does not know", async function () {
      const { vault, khr, khUSD, alice, outsider } = await loadFixture(fixture);
      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).open(0n, 100_000_000n, 10_000n);
      await expect(khUSD.connect(alice).transfer(outsider.address, 1n))
        .to.be.revertedWithCustomError(khUSD, "NotKycActive").withArgs(outsider.address);
    });

    it("carries the decimals it was given", async function () {
      const { khUSD, khJPY } = await loadFixture(fixture);
      expect(await khUSD.decimals()).to.equal(2);
      expect(await khJPY.decimals()).to.equal(0);
      expect(await khUSD.symbol()).to.equal("khUSD");
    });

    it("total supply is the vault's books and nothing else", async function () {
      const { vault, khr, khUSD, alice, bob } = await loadFixture(fixture);
      await khr.connect(alice).approve(vault.target, 100_000_000n);
      await vault.connect(alice).open(0n, 100_000_000n, 10_000n);
      await khr.connect(bob).approve(vault.target, 100_000_000n);
      await vault.connect(bob).open(0n, 60_000_000n, 4_000n);
      expect(await khUSD.totalSupply()).to.equal((await vault.currencyAt(0n)).totalDebt);
      await vault.connect(alice).repay(0n, 3_000n);
      expect(await khUSD.totalSupply()).to.equal((await vault.currencyAt(0n)).totalDebt);
    });
  });
});
