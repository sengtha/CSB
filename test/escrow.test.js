const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Delivery escrow — one payment, many payees, settled atomically.
 *
 * The scenario: a customer orders food for 20,000 riel. That single payment is
 * really three — restaurant 15,000, rider 3,500, platform commission 1,500. The
 * split is agreed before the customer pays, and settles in one transaction on
 * confirmation.
 */
describe("PaymentEscrow — delivery split", function () {
  const KHR = (n) => BigInt(Math.round(n * 100)); // KHRt has 2 decimals

  async function deploy() {
    const [council, authority, issuer, arbiter, buyer, restaurant, rider, platform, outsider] =
      await ethers.getSigners();

    const identity = await ethers.deployContract("IdentityRegistry", [council.address, authority.address]);
    const enforcement = await ethers.deployContract("EnforcementRegistry", [council.address, council.address]);
    const khr = await ethers.deployContract("KHRStablecoin", [
      identity.target, enforcement.target, council.address, issuer.address,
    ]);
    const escrow = await ethers.deployContract("PaymentEscrow", [council.address, arbiter.address]);

    for (const s of [buyer, restaurant, rider, platform, issuer, outsider]) {
      await identity.connect(authority).register(s.address, ethers.id(`id-${s.address}`), 2);
    }
    // The escrow holds KHRt but has no personal identity, so the council vets it
    // the same way it vets a bridge adapter.
    await khr.connect(council).setSystemContract(escrow.target, true);
    await khr.connect(issuer).issue(buyer.address, KHR(100000));

    const now = (await ethers.provider.getBlock("latest")).timestamp;
    return {
      council, authority, issuer, arbiter, buyer, restaurant, rider, platform, outsider,
      identity, enforcement, khr, escrow, now,
    };
  }

  async function order(f, over = {}) {
    const payees = over.payees ?? [f.restaurant.address, f.rider.address, f.platform.address];
    const amounts = over.amounts ?? [KHR(15000), KHR(3500), KHR(1500)];
    const deadline = over.deadline ?? f.now + 3600;
    const tx = await f.escrow.connect(f.restaurant).createOrder(
      ethers.id("order/2026/0001"), f.buyer.address, f.khr.target, payees, amounts, deadline,
    );
    await tx.wait();
    return Number(await f.escrow.orderCount());
  }

  async function fundIt(f, id) {
    const o = await f.escrow.orderOf(id);
    await f.khr.connect(f.buyer).approve(f.escrow.target, o.total);
    await f.escrow.connect(f.buyer).fund(id);
    return o.total;
  }

  it("derives the total from the split, so they cannot disagree", async function () {
    const f = await deploy();
    const id = await order(f);
    const o = await f.escrow.orderOf(id);
    expect(o.total).to.equal(KHR(20000));
    const [payees, amounts] = await f.escrow.splitOf(id);
    expect(payees.length).to.equal(3);
    expect(amounts.reduce((a, b) => a + b, 0n)).to.equal(o.total);
  });

  it("shows the buyer exactly what each party gets, before paying", async function () {
    const f = await deploy();
    const id = await order(f);
    const [payees, amounts] = await f.escrow.splitOf(id);
    expect(payees[1]).to.equal(f.rider.address);
    expect(amounts[1]).to.equal(KHR(3500)); // the rider's fare is visible up front
    // Nothing has moved yet.
    expect(await f.khr.balanceOf(f.escrow.target)).to.equal(0n);
  });

  it("holds the money in escrow, not with the platform", async function () {
    const f = await deploy();
    const id = await order(f);
    await fundIt(f, id);
    expect(await f.khr.balanceOf(f.escrow.target)).to.equal(KHR(20000));
    expect(await f.khr.balanceOf(f.platform.address)).to.equal(0n);
    expect((await f.escrow.orderOf(id)).status).to.equal(2); // Funded
  });

  it("settles every payee in one transaction on confirmation", async function () {
    const f = await deploy();
    const id = await order(f);
    await fundIt(f, id);

    await expect(f.escrow.connect(f.buyer).confirmAndRelease(id))
      .to.emit(f.escrow, "OrderReleased").withArgs(id, f.buyer.address, 3, KHR(20000));

    expect(await f.khr.balanceOf(f.restaurant.address)).to.equal(KHR(15000));
    expect(await f.khr.balanceOf(f.rider.address)).to.equal(KHR(3500));
    expect(await f.khr.balanceOf(f.platform.address)).to.equal(KHR(1500));
    expect(await f.khr.balanceOf(f.escrow.target)).to.equal(0n);
  });

  it("only the buyer can confirm", async function () {
    const f = await deploy();
    const id = await order(f);
    await fundIt(f, id);
    await expect(f.escrow.connect(f.platform).confirmAndRelease(id))
      .to.be.revertedWithCustomError(f.escrow, "NotPayer");
  });

  it("lets the arbiter settle when the buyer goes silent", async function () {
    const f = await deploy();
    const id = await order(f);
    await fundIt(f, id);
    await f.escrow.connect(f.arbiter).releaseByArbiter(id, ethers.id("delivery photo confirmed"));
    expect(await f.khr.balanceOf(f.rider.address)).to.equal(KHR(3500));
  });

  it("requires a recorded reason for any arbiter decision", async function () {
    const f = await deploy();
    const id = await order(f);
    await fundIt(f, id);
    await expect(f.escrow.connect(f.arbiter).releaseByArbiter(id, ethers.ZeroHash))
      .to.be.revertedWithCustomError(f.escrow, "ReasonRequired");
    await expect(f.escrow.connect(f.arbiter).refundByArbiter(id, ethers.ZeroHash))
      .to.be.revertedWithCustomError(f.escrow, "ReasonRequired");
  });

  it("refunds the buyer when the order fails", async function () {
    const f = await deploy();
    const id = await order(f);
    await fundIt(f, id);
    const before = await f.khr.balanceOf(f.buyer.address);
    await f.escrow.connect(f.arbiter).refundByArbiter(id, ethers.id("never delivered"));
    expect(await f.khr.balanceOf(f.buyer.address)).to.equal(before + KHR(20000));
    expect(await f.khr.balanceOf(f.rider.address)).to.equal(0n);
  });

  it("lets the buyer reclaim after the deadline if nothing happened", async function () {
    const f = await deploy();
    const id = await order(f);
    await fundIt(f, id);

    await expect(f.escrow.connect(f.buyer).reclaimAfterDeadline(id))
      .to.be.revertedWithCustomError(f.escrow, "DeadlineNotReached");

    await ethers.provider.send("evm_increaseTime", [3700]);
    await ethers.provider.send("evm_mine", []);
    await f.escrow.connect(f.buyer).reclaimAfterDeadline(id);
    expect((await f.escrow.orderOf(id)).status).to.equal(4); // Refunded
  });

  it("a dispute blocks the buyer from reclaiming past the deadline", async function () {
    // Otherwise a buyer could receive the food, stall, and take the money back.
    const f = await deploy();
    const id = await order(f);
    await fundIt(f, id);
    await f.escrow.connect(f.rider).raiseDispute(id);

    await ethers.provider.send("evm_increaseTime", [3700]);
    await ethers.provider.send("evm_mine", []);
    await expect(f.escrow.connect(f.buyer).reclaimAfterDeadline(id))
      .to.be.revertedWithCustomError(f.escrow, "WrongStatus");

    // The arbiter still has both routes open.
    await f.escrow.connect(f.arbiter).releaseByArbiter(id, ethers.id("rider provided proof"));
    expect(await f.khr.balanceOf(f.rider.address)).to.equal(KHR(3500));
  });

  it("only a party to the order can dispute it", async function () {
    const f = await deploy();
    const id = await order(f);
    await fundIt(f, id);
    await expect(f.escrow.connect(f.outsider).raiseDispute(id))
      .to.be.revertedWithCustomError(f.escrow, "NotAParty");
  });

  it("cannot be released twice, or released before funding", async function () {
    const f = await deploy();
    const id = await order(f);
    await expect(f.escrow.connect(f.buyer).confirmAndRelease(id))
      .to.be.revertedWithCustomError(f.escrow, "WrongStatus");
    await fundIt(f, id);
    await f.escrow.connect(f.buyer).confirmAndRelease(id);
    await expect(f.escrow.connect(f.buyer).confirmAndRelease(id))
      .to.be.revertedWithCustomError(f.escrow, "WrongStatus");
  });

  // ------------------------------------------------- compliance interaction

  it("cannot pay a payee frozen by an enforcement order — the whole release fails", async function () {
    // Enforcement outranks the commercial obligation. Paying the other two and
    // stranding the rider's share would be worse: money with no owner and an
    // order that is neither settled nor refundable.
    const f = await deploy();
    const id = await order(f);
    await fundIt(f, id);
    await f.enforcement.connect(f.council).freeze(f.rider.address, ethers.id("court-order-12"));

    await expect(f.escrow.connect(f.buyer).confirmAndRelease(id))
      .to.be.revertedWithCustomError(f.khr, "AccountFrozen");

    // Nothing moved — not even to the payees who are in good standing.
    expect(await f.khr.balanceOf(f.restaurant.address)).to.equal(0n);
    expect(await f.khr.balanceOf(f.escrow.target)).to.equal(KHR(20000));

    // The arbiter's remaining route is to return the buyer's money.
    await f.escrow.connect(f.arbiter).refundByArbiter(id, ethers.id("payee frozen"));
    expect(await f.khr.balanceOf(f.escrow.target)).to.equal(0n);
  });

  it("cannot pay a payee whose KYC was revoked", async function () {
    const f = await deploy();
    const id = await order(f);
    await fundIt(f, id);
    await f.identity.connect(f.authority).revoke(f.platform.address);

    await expect(f.escrow.connect(f.buyer).confirmAndRelease(id))
      .to.be.revertedWithCustomError(f.khr, "NotKycActive");
  });

  it("rejects malformed orders", async function () {
    const f = await deploy();
    const good = [f.restaurant.address, f.rider.address];
    await expect(f.escrow.createOrder(ethers.id("x"), f.buyer.address, f.khr.target, [], [], f.now + 60))
      .to.be.revertedWithCustomError(f.escrow, "PayeesRequired");
    await expect(f.escrow.createOrder(ethers.id("x"), f.buyer.address, f.khr.target, good, [KHR(1)], f.now + 60))
      .to.be.revertedWithCustomError(f.escrow, "LengthMismatch");
    await expect(f.escrow.createOrder(ethers.id("x"), f.buyer.address, f.khr.target, good, [KHR(1), 0], f.now + 60))
      .to.be.revertedWithCustomError(f.escrow, "ZeroAmount");
    await expect(f.escrow.createOrder(ethers.id("x"), f.buyer.address, f.khr.target, good, [KHR(1), KHR(1)], f.now - 1))
      .to.be.revertedWithCustomError(f.escrow, "DeadlineInPast");
  });

  it("answers canRelease before anyone signs", async function () {
    const f = await deploy();
    const id = await order(f);
    let [ok, why] = await f.escrow.canRelease(id);
    expect(ok).to.equal(false);
    expect(why).to.contain("not awaiting release");
    await fundIt(f, id);
    [ok] = await f.escrow.canRelease(id);
    expect(ok).to.equal(true);
  });

  it("handles many payees in a single settlement", async function () {
    // A group order splitting across several vendors plus the rider.
    const f = await deploy();
    const payees = [f.restaurant, f.rider, f.platform, f.outsider].map((s) => s.address);
    const amounts = [KHR(5000), KHR(2000), KHR(1000), KHR(2000)];
    const id = await order(f, { payees, amounts });
    await fundIt(f, id);
    await f.escrow.connect(f.buyer).confirmAndRelease(id);
    expect(await f.khr.balanceOf(f.outsider.address)).to.equal(KHR(2000));
    expect(await f.khr.balanceOf(f.escrow.target)).to.equal(0n);
  });
});
