const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

const MEMO = ethers.id("invoice-001");
const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

async function payFixture() {
  const [council, payer, payee, fund, other] = await ethers.getSigners();
  const pay = await ethers.deployContract("RielPay", [council.address, fund.address]);
  return { pay, council, payer, payee, fund, other };
}

describe("RielPay", function () {
  it("is free by default (no levy) — pays the full amount", async function () {
    const { pay, payer, payee, fund } = await loadFixture(payFixture);
    const amount = ethers.parseEther("100");
    const payeeBefore = await ethers.provider.getBalance(payee.address);
    const fundBefore = await ethers.provider.getBalance(fund.address);

    await expect(pay.connect(payer).pay(payee.address, MEMO, { value: amount }))
      .to.emit(pay, "Paid").withArgs(payer.address, payee.address, amount, 0, MEMO);

    expect(await ethers.provider.getBalance(payee.address)).to.equal(payeeBefore + amount);
    expect(await ethers.provider.getBalance(fund.address)).to.equal(fundBefore); // fund untouched
    expect(await pay.totalRaised()).to.equal(0);
  });

  it("routes the configured levy to the public fund and the rest to the payee", async function () {
    const { pay, council, payer, payee, fund } = await loadFixture(payFixture);
    await pay.connect(council).setLevy(100, fund.address); // 1%
    const amount = ethers.parseEther("100");
    const levy = amount / 100n; // 1 tRIEL
    const net = amount - levy;
    const payeeBefore = await ethers.provider.getBalance(payee.address);
    const fundBefore = await ethers.provider.getBalance(fund.address);

    await pay.connect(payer).pay(payee.address, ZERO, { value: amount });

    expect(await ethers.provider.getBalance(payee.address)).to.equal(payeeBefore + net);
    expect(await ethers.provider.getBalance(fund.address)).to.equal(fundBefore + levy);
    expect(await pay.totalRaised()).to.equal(levy);
    expect(await pay.quoteLevy(payer.address, payee.address, amount)).to.equal(levy);
  });

  it("exempts a party from the levy (e.g. citizen P2P)", async function () {
    const { pay, council, payer, payee, fund } = await loadFixture(payFixture);
    await pay.connect(council).setLevy(200, fund.address); // 2%
    await pay.connect(council).setExempt(payee.address, true);
    const amount = ethers.parseEther("50");
    const fundBefore = await ethers.provider.getBalance(fund.address);

    await pay.connect(payer).pay(payee.address, ZERO, { value: amount });
    expect(await ethers.provider.getBalance(fund.address)).to.equal(fundBefore); // exempt → no levy
  });

  it("caps the levy at MAX_LEVY_BPS", async function () {
    const { pay, council, fund } = await loadFixture(payFixture);
    await expect(pay.connect(council).setLevy(1001, fund.address))
      .to.be.revertedWithCustomError(pay, "LevyTooHigh");
    await expect(pay.connect(council).setLevy(1000, fund.address)).to.not.be.reverted; // 10% ok
  });

  it("only the council can set the levy or exemptions", async function () {
    const { pay, payer, fund } = await loadFixture(payFixture);
    await expect(pay.connect(payer).setLevy(100, fund.address))
      .to.be.revertedWithCustomError(pay, "AccessControlUnauthorizedAccount");
    await expect(pay.connect(payer).setExempt(payer.address, true))
      .to.be.revertedWithCustomError(pay, "AccessControlUnauthorizedAccount");
  });

  it("can be paused by the council (circuit breaker)", async function () {
    const { pay, council, payer, payee } = await loadFixture(payFixture);
    await pay.connect(council).pause();
    await expect(pay.connect(payer).pay(payee.address, ZERO, { value: 1n }))
      .to.be.revertedWithCustomError(pay, "EnforcedPause");
    await pay.connect(council).unpause();
    await expect(pay.connect(payer).pay(payee.address, ZERO, { value: 1n })).to.not.be.reverted;
  });

  it("rejects zero amount and zero recipient", async function () {
    const { pay, payer, payee } = await loadFixture(payFixture);
    await expect(pay.connect(payer).pay(payee.address, ZERO, { value: 0n }))
      .to.be.revertedWithCustomError(pay, "ZeroAmount");
    await expect(pay.connect(payer).pay(ethers.ZeroAddress, ZERO, { value: 1n }))
      .to.be.revertedWithCustomError(pay, "ZeroAddress");
  });
});
