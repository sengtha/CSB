const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySuite, ID_ALICE, ID_BOB, ORDER_REF, DEST_CHAIN } = require("./fixtures");

const RECIPIENT = "0x" + "11".repeat(20); // recipient on the destination chain

async function suiteWithFunds() {
  const s = await deploySuite();
  await s.identity.connect(s.moi).register(s.alice.address, ID_ALICE, 2);
  await s.identity.connect(s.moi).register(s.bob.address, ID_BOB, 1);
  await s.khr.connect(s.issuer).issue(s.alice.address, 1_000_000_00);
  await s.khr.connect(s.issuer).issue(s.bob.address, 1_000_000_00);
  return s;
}

describe("EgressGateway", function () {
  it("refuses egress of non-permitted tokens", async function () {
    const { gateway, khr, alice } = await loadFixture(suiteWithFunds);
    await expect(
      gateway.connect(alice).requestEgress(khr.target, 100, DEST_CHAIN, RECIPIENT)
    ).to.be.revertedWithCustomError(gateway, "TokenNotPermitted");
  });

  it("bridges a permitted token for an eligible account into the adapter", async function () {
    const { gateway, adapter, khr, council, alice } = await loadFixture(suiteWithFunds);
    await gateway.connect(council).setTokenPolicy(khr.target, true, 2, 0, adapter.target);
    await khr.connect(alice).approve(gateway.target, 500_00);

    await expect(gateway.connect(alice).requestEgress(khr.target, 500_00, DEST_CHAIN, RECIPIENT))
      .to.emit(gateway, "EgressInitiated")
      .withArgs(alice.address, khr.target, 500_00, DEST_CHAIN, RECIPIENT)
      .and.to.emit(adapter, "BridgeSend");

    expect(await khr.balanceOf(adapter.target)).to.equal(500_00);
  });

  it("rejects accounts below the token's minimum tier (bob is tier 1)", async function () {
    const { gateway, adapter, khr, council, bob } = await loadFixture(suiteWithFunds);
    await gateway.connect(council).setTokenPolicy(khr.target, true, 2, 0, adapter.target);
    await khr.connect(bob).approve(gateway.target, 100);

    await expect(
      gateway.connect(bob).requestEgress(khr.target, 100, DEST_CHAIN, RECIPIENT)
    ).to.be.revertedWithCustomError(gateway, "TierTooLow");
  });

  it("rejects frozen accounts even when otherwise eligible", async function () {
    const { gateway, adapter, khr, enforcement, council, enforcer, alice } =
      await loadFixture(suiteWithFunds);
    await gateway.connect(council).setTokenPolicy(khr.target, true, 2, 0, adapter.target);
    await enforcement.connect(enforcer).freeze(alice.address, ORDER_REF);

    await expect(
      gateway.connect(alice).requestEgress(khr.target, 100, DEST_CHAIN, RECIPIENT)
    ).to.be.revertedWithCustomError(gateway, "AccountFrozen");
  });

  it("enforces the daily cap and resets it the next day", async function () {
    const { gateway, adapter, khr, council, alice } = await loadFixture(suiteWithFunds);
    await gateway.connect(council).setTokenPolicy(khr.target, true, 2, 1_000_00, adapter.target);
    await khr.connect(alice).approve(gateway.target, 3_000_00);

    await gateway.connect(alice).requestEgress(khr.target, 800_00, DEST_CHAIN, RECIPIENT);
    await expect(
      gateway.connect(alice).requestEgress(khr.target, 300_00, DEST_CHAIN, RECIPIENT)
    ).to.be.revertedWithCustomError(gateway, "DailyCapExceeded");

    await time.increase(24 * 60 * 60);
    await gateway.connect(alice).requestEgress(khr.target, 300_00, DEST_CHAIN, RECIPIENT);
    expect(await khr.balanceOf(adapter.target)).to.equal(1_100_00);
  });

  it("council can pause the gateway as a circuit breaker", async function () {
    const { gateway, adapter, khr, council, alice } = await loadFixture(suiteWithFunds);
    await gateway.connect(council).setTokenPolicy(khr.target, true, 2, 0, adapter.target);
    await gateway.connect(council).pause();
    await khr.connect(alice).approve(gateway.target, 100);

    await expect(
      gateway.connect(alice).requestEgress(khr.target, 100, DEST_CHAIN, RECIPIENT)
    ).to.be.revertedWithCustomError(gateway, "EnforcedPause");
  });

  it("only the gateway can drive the bridge adapter", async function () {
    const { adapter, khr, alice } = await loadFixture(suiteWithFunds);
    await expect(
      adapter.connect(alice).bridge(khr.target, 100, DEST_CHAIN, RECIPIENT, alice.address)
    ).to.be.revertedWithCustomError(adapter, "OnlyGateway");
  });
});
