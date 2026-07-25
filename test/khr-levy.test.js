const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deploySuite, ID_ALICE, ID_BOB } = require("./fixtures");

const ID_CHARITY = ethers.id("identity-charity");

async function levyFixture() {
  const s = await deploySuite();
  const charity = (await ethers.getSigners())[7];
  await s.identity.connect(s.idAuthority).register(s.alice.address, ID_ALICE, 2);
  await s.identity.connect(s.idAuthority).register(s.bob.address, ID_BOB, 2);
  await s.identity.connect(s.idAuthority).register(charity.address, ID_CHARITY, 2);
  await s.khr.connect(s.issuer).issue(s.alice.address, 1_000_000_00);
  return { ...s, charity };
}

describe("KHRStablecoin transfer levy (public-good)", function () {
  it("takes no levy by default — the full amount transfers", async function () {
    const { khr, alice, bob } = await loadFixture(levyFixture);
    await khr.connect(alice).transfer(bob.address, 100_00);
    expect(await khr.balanceOf(bob.address)).to.equal(100_00);
    expect(await khr.totalLevied()).to.equal(0);
  });

  it("routes a flat 1 KHRt levy to the fund on each transfer", async function () {
    const { khr, council, alice, bob, charity } = await loadFixture(levyFixture);
    await khr.connect(council).setTransferLevy(1_00, charity.address); // 1.00 KHRt = 1 riel
    await expect(khr.connect(alice).transfer(bob.address, 100_00))
      .to.emit(khr, "LevyCollected").withArgs(alice.address, charity.address, 1_00);
    expect(await khr.balanceOf(bob.address)).to.equal(99_00);      // 100 - 1
    expect(await khr.balanceOf(charity.address)).to.equal(1_00);
    expect(await khr.totalLevied()).to.equal(1_00);
  });

  it("exempts flagged accounts (e.g. citizen P2P)", async function () {
    const { khr, council, alice, bob, charity } = await loadFixture(levyFixture);
    await khr.connect(council).setTransferLevy(1_00, charity.address);
    await khr.connect(council).setLevyExempt(alice.address, true);
    await khr.connect(alice).transfer(bob.address, 100_00);
    expect(await khr.balanceOf(bob.address)).to.equal(100_00); // exempt → no fee
    expect(await khr.balanceOf(charity.address)).to.equal(0);
  });

  it("does not tax mint/issue or transfers to the fund itself", async function () {
    const { khr, issuer, council, alice, charity } = await loadFixture(levyFixture);
    await khr.connect(council).setTransferLevy(1_00, charity.address);
    await khr.connect(issuer).issue(charity.address, 500_00); // mint untaxed
    expect(await khr.balanceOf(charity.address)).to.equal(500_00);
    await khr.connect(alice).transfer(charity.address, 10_00); // to-fund untaxed
    expect(await khr.balanceOf(charity.address)).to.equal(510_00);
  });

  it("does not zero out transfers at or below the levy", async function () {
    const { khr, council, alice, bob, charity } = await loadFixture(levyFixture);
    await khr.connect(council).setTransferLevy(1_00, charity.address);
    await khr.connect(alice).transfer(bob.address, 1_00); // == levy → untaxed
    expect(await khr.balanceOf(bob.address)).to.equal(1_00);
    expect(await khr.balanceOf(charity.address)).to.equal(0);
  });

  it("only the council (admin) can set the levy, and a recipient is required", async function () {
    const { khr, council, alice, charity } = await loadFixture(levyFixture);
    await expect(khr.connect(alice).setTransferLevy(1_00, charity.address))
      .to.be.revertedWithCustomError(khr, "AccessControlUnauthorizedAccount");
    await expect(khr.connect(council).setTransferLevy(1_00, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(khr, "LevyRecipientRequired");
  });
});
