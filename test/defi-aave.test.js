const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySuite, ID_ALICE, ID_BOB } = require("./fixtures");
const { deployAaveMarket } = require("../scripts/lib/aave");

/**
 * A second unmodified protocol, this time a lending market.
 *
 * test/defi-unmodified.test.js showed that an AMM turns a compliance-gated asset
 * into an unrestricted claim on itself. One protocol is an anecdote. This asks
 * whether the same thing happens in a structurally different protocol, and
 * whether lending adds failure modes an AMM cannot show.
 *
 * It does, and there are three that matter:
 *
 *   THE RECEIPT GROWS. An aToken is not a static claim like an LP share — it
 *   accrues interest. An unverified holder's exposure therefore increases with
 *   no further transaction by anyone. The perimeter is not merely leaking a
 *   position; it is leaking a yield-bearing one.
 *
 *   COLLATERAL BACKS SOMEONE ELSE'S DEBT. Supplying KHRt and borrowing against
 *   it means the pool's KHRt is now encumbered. A holder of aKHRt outside the
 *   perimeter has a claim on assets that secure a loan they are not party to.
 *
 *   LIQUIDATION IS PERMISSIONLESS BY DESIGN. Aave lets anyone repay a bad
 *   position and take the collateral. Whether the liquidator must be KYC'd is a
 *   question CSB's design has never been asked, and the answer is not obviously
 *   the one anybody intended.
 *
 * Everything below is the published @aave/core-v3 bytecode, unrecompiled. The
 * oracle is Aave's own test PriceOracle with hand-set prices — a real necessity
 * on a chain with no feeds, and a real limitation on what these results mean.
 */
async function aaveFixture() {
  const s = await deploySuite();
  await s.identity.connect(s.idAuthority).register(s.alice.address, ID_ALICE, 2);
  await s.identity.connect(s.idAuthority).register(s.bob.address, ID_BOB, 2);
  await s.khr.connect(s.issuer).issue(s.alice.address, 10_000_000_00);
  await s.khr.connect(s.issuer).issue(s.bob.address, 10_000_000_00);

  const aave = await deployAaveMarket(s.council, s.khr.target, 2);
  return { ...s, aave };
}

/** The pool and its aToken custody KHRt, so both need vetting. */
async function vetAaveContracts(s) {
  for (const addr of [await s.aave.pool.getAddress(), await s.aave.aToken.getAddress()]) {
    await s.khr.connect(s.council).setSystemContract(addr, true);
  }
}

describe("Unmodified Aave V3 against a compliance-gated token", function () {
  it("finding 1: the published Aave V3 bytecode deploys and lists KHRt as a reserve", async function () {
    const { aave, khr } = await loadFixture(aaveFixture);
    const data = await aave.pool.getReserveData(khr.target);
    expect(data.aTokenAddress).to.not.equal(ethers.ZeroAddress);
    expect(await aave.aToken.symbol()).to.equal("aKHRt");
    // Nothing was forked or patched to get here.
  });

  it("finding 2: supply fails until the pool and aToken are vetted, and they cannot be vetted in advance", async function () {
    const { aave, khr, alice, council } = await loadFixture(aaveFixture);
    await khr.connect(alice).approve(await aave.pool.getAddress(), 1_000_00);

    // The aToken address does not exist until initReserves creates it, exactly
    // as with the Uniswap pair. The council is again asked to authorise an
    // address that the protocol chose.
    await expect(
      aave.pool.connect(alice).supply(khr.target, 1_000_00, alice.address, 0)
    ).to.be.reverted;

    await vetAaveContracts({ aave, khr, council });
    await aave.pool.connect(alice).supply(khr.target, 1_000_00, alice.address, 0);
    expect(await aave.aToken.balanceOf(alice.address)).to.be.greaterThan(0n);
  });

  it("compliance holds where the asset itself moves: withdrawing to a non-KYC'd address reverts", async function () {
    const s = await loadFixture(aaveFixture);
    const { aave, khr, alice, outsider } = s;
    await vetAaveContracts(s);
    await khr.connect(alice).approve(await aave.pool.getAddress(), 1_000_00);
    await aave.pool.connect(alice).supply(khr.target, 1_000_00, alice.address, 0);

    // withdraw() moves real KHRt, so KHRt's own rules apply.
    await expect(
      aave.pool.connect(alice).withdraw(khr.target, 500_00, outsider.address)
    ).to.be.reverted;
  });

  it("FINDING 3: aTokens reach a non-KYC'd address, and unlike an LP share they accrue", async function () {
    const s = await loadFixture(aaveFixture);
    const { aave, khr, alice, bob, outsider } = s;
    await vetAaveContracts(s);

    await khr.connect(alice).approve(await aave.pool.getAddress(), 5_000_000_00);
    await aave.pool.connect(alice).supply(khr.target, 5_000_000_00, alice.address, 0);

    // The outsider cannot hold one unit of KHRt.
    await expect(khr.connect(alice).transfer(outsider.address, 1))
      .to.be.revertedWithCustomError(khr, "NotKycActive");

    // It can hold a claim on five million of it.
    const half = (await aave.aToken.balanceOf(alice.address)) / 2n;
    await aave.aToken.connect(alice).transfer(outsider.address, half);
    const held = await aave.aToken.balanceOf(outsider.address);
    expect(held).to.be.greaterThan(0n);
    expect(await khr.balanceOf(outsider.address)).to.equal(0n);

    // Now make the pool earn: bob borrows, which is what pays interest.
    // Approve more than he supplies — the "poke" below is another supply, and an
    // allowance sized exactly to the first one leaves nothing for it.
    await khr.connect(bob).approve(await aave.pool.getAddress(), 2_000_000_00);
    await aave.pool.connect(bob).supply(khr.target, 1_000_000_00, bob.address, 0);
    await aave.pool.connect(bob).borrow(khr.target, 500_000_00, 2, 0, bob.address);

    // Time passes. Nobody transacts on the outsider's behalf.
    await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    // Poke the reserve so indices update.
    await aave.pool.connect(bob).supply(khr.target, 1_00, bob.address, 0);

    const after = await aave.aToken.balanceOf(outsider.address);
    expect(after).to.be.greaterThan(held);
    // An address with no identity, that cannot transact on this chain and cannot
    // receive a single riel, is now owed MORE than it was — without acting.
  });

  it("FINDING 4: liquidation is permissionless in Aave, but the ASSET blocks a non-KYC'd liquidator", async function () {
    const s = await loadFixture(aaveFixture);
    const { aave, khr, alice, bob, outsider, council } = s;
    await vetAaveContracts(s);

    await khr.connect(alice).approve(await aave.pool.getAddress(), 5_000_000_00);
    await aave.pool.connect(alice).supply(khr.target, 5_000_000_00, alice.address, 0);
    await khr.connect(bob).approve(await aave.pool.getAddress(), 1_000_000_00);
    await aave.pool.connect(bob).supply(khr.target, 1_000_000_00, bob.address, 0);
    await aave.pool.connect(bob).borrow(khr.target, 700_000_00, 2, 0, bob.address);

    // Put bob underwater. Collateral and debt are the same asset here, so moving
    // the price changes nothing — tightening the liquidation threshold is the
    // honest lever in a single-asset market.
    await aave.configurator.connect(council)
      .configureReserveAsCollateral(khr.target, 5500, 6000, 10500);
    const { healthFactor } = await aave.pool.getUserAccountData(bob.address);
    expect(healthFactor).to.be.lessThan(ethers.parseUnits("1", 18));

    // Aave itself imposes no permission on who may liquidate: liquidationCall
    // takes the liquidator from msg.sender.
    //
    // The outsider nonetheless cannot do it — but NOT because Aave or CSB's
    // governance stopped it. Liquidating means paying the debt, which means
    // transferring KHRt, and an address with no attestation cannot hold KHRt to
    // pay with. The compliance perimeter blocks this by accident of what
    // liquidation requires, not by design.
    await expect(
      aave.pool.connect(outsider)
        .liquidationCall(khr.target, khr.target, bob.address, 100_00, false)
    ).to.be.reverted;

    // A KYC'd liquidator succeeds, and may elect to be paid in aTokens.
    const before = await aave.aToken.balanceOf(alice.address);
    await khr.connect(alice).approve(await aave.pool.getAddress(), 200_000_00);
    await aave.pool.connect(alice)
      .liquidationCall(khr.target, khr.target, bob.address, 100_000_00, true);
    expect(await aave.aToken.balanceOf(alice.address)).to.be.greaterThan(before);

    // And those aTokens are transferable to the outsider like any other, so the
    // seized collateral still ends up as an unrestricted claim held outside the
    // perimeter — one hop later than finding 3, by a different route.
    const seized = await aave.aToken.balanceOf(alice.address);
    await aave.aToken.connect(alice).transfer(outsider.address, seized / 4n);
    expect(await aave.aToken.balanceOf(outsider.address)).to.be.greaterThan(0n);
  });
});
