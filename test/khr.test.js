const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySuite, ID_ALICE, ID_BOB, ORDER_REF } = require("./fixtures");

async function suiteWithKyc() {
  const s = await deploySuite();
  await s.identity.connect(s.idAuthority).register(s.alice.address, ID_ALICE, 2);
  await s.identity.connect(s.idAuthority).register(s.bob.address, ID_BOB, 1);
  return s;
}

describe("KHRStablecoin", function () {
  it("issuer mints to a KYC'd account; transfers between KYC'd accounts work", async function () {
    const { khr, issuer, alice, bob } = await loadFixture(suiteWithKyc);
    await khr.connect(issuer).issue(alice.address, 100_000_00);
    await khr.connect(alice).transfer(bob.address, 40_000_00);

    expect(await khr.balanceOf(bob.address)).to.equal(40_000_00);
  });

  it("blocks minting or transfers to non-KYC'd accounts", async function () {
    const { khr, issuer, alice, outsider } = await loadFixture(suiteWithKyc);
    await expect(khr.connect(issuer).issue(outsider.address, 100)).to.be.revertedWithCustomError(
      khr,
      "NotKycActive"
    );

    await khr.connect(issuer).issue(alice.address, 100);
    await expect(khr.connect(alice).transfer(outsider.address, 50)).to.be.revertedWithCustomError(
      khr,
      "NotKycActive"
    );
  });

  it("KYC suspension immediately blocks an account's transfers", async function () {
    const { khr, identity, idAuthority, issuer, alice, bob } = await loadFixture(suiteWithKyc);
    await khr.connect(issuer).issue(alice.address, 100);
    await identity.connect(idAuthority).suspend(alice.address);

    await expect(khr.connect(alice).transfer(bob.address, 10)).to.be.revertedWithCustomError(
      khr,
      "NotKycActive"
    );
  });

  it("enforcement freeze blocks sending and receiving", async function () {
    const { khr, enforcement, enforcer, issuer, alice, bob } = await loadFixture(suiteWithKyc);
    await khr.connect(issuer).issue(alice.address, 100);
    await enforcement.connect(enforcer).freeze(alice.address, ORDER_REF);

    await expect(khr.connect(alice).transfer(bob.address, 10)).to.be.revertedWithCustomError(
      khr,
      "AccountFrozen"
    );
    await expect(khr.connect(issuer).issue(alice.address, 10)).to.be.revertedWithCustomError(
      khr,
      "AccountFrozen"
    );
  });

  it("confiscation works on a frozen account and requires an order reference", async function () {
    const { khr, enforcement, enforcer, issuer, alice, bob } = await loadFixture(suiteWithKyc);
    await khr.connect(issuer).issue(alice.address, 100);
    await enforcement.connect(enforcer).freeze(alice.address, ORDER_REF);

    await expect(
      khr.connect(enforcer).confiscate(alice.address, bob.address, 100, ethers.ZeroHash)
    ).to.be.revertedWithCustomError(khr, "OrderRefRequired");

    await expect(khr.connect(enforcer).confiscate(alice.address, bob.address, 100, ORDER_REF))
      .to.emit(khr, "Confiscated")
      .withArgs(alice.address, bob.address, 100, ORDER_REF);
    expect(await khr.balanceOf(bob.address)).to.equal(100);
  });

  it("Identity Authority cannot freeze and the enforcer cannot issue (separation of powers)", async function () {
    const { khr, enforcement, idAuthority, enforcer, alice } = await loadFixture(suiteWithKyc);
    await expect(
      enforcement.connect(idAuthority).freeze(alice.address, ORDER_REF)
    ).to.be.revertedWithCustomError(enforcement, "AccessControlUnauthorizedAccount");
    await expect(khr.connect(enforcer).issue(alice.address, 1)).to.be.revertedWithCustomError(
      khr,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("enforces per-transfer caps for capped tiers (bob is tier 1)", async function () {
    const { khr, council, issuer, alice, bob } = await loadFixture(suiteWithKyc);
    await khr.connect(council).setTierTransferCap(1, 10_000_00);
    await khr.connect(issuer).issue(bob.address, 50_000_00);

    await expect(khr.connect(bob).transfer(alice.address, 20_000_00)).to.be.revertedWithCustomError(
      khr,
      "TierCapExceeded"
    );
    await khr.connect(bob).transfer(alice.address, 10_000_00);
    expect(await khr.balanceOf(alice.address)).to.equal(10_000_00);
  });
});
