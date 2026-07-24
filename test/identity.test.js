const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySuite, ID_ALICE, PAYMENT_REF } = require("./fixtures");

describe("IdentityRegistry", function () {
  it("Identity Authority registers an address with an active attestation", async function () {
    const { identity, idAuthority, alice } = await loadFixture(deploySuite);
    await identity.connect(idAuthority).register(alice.address, ID_ALICE, 2);

    expect(await identity.isActive(alice.address)).to.equal(true);
    expect(await identity.tierOf(alice.address)).to.equal(2);
    expect(await identity.addressCount(ID_ALICE)).to.equal(1);
  });

  it("rejects registration from non-issuers (only Identity Authority issues identity)", async function () {
    const { identity, council, alice } = await loadFixture(deploySuite);
    await expect(
      identity.connect(council).register(alice.address, ID_ALICE, 2)
    ).to.be.revertedWithCustomError(identity, "AccessControlUnauthorizedAccount");
  });

  it("defaults to one address per identity", async function () {
    const { identity, idAuthority, alice, bob } = await loadFixture(deploySuite);
    await identity.connect(idAuthority).register(alice.address, ID_ALICE, 2);
    await expect(
      identity.connect(idAuthority).register(bob.address, ID_ALICE, 2)
    ).to.be.revertedWithCustomError(identity, "QuotaExceeded");
  });

  it("grants extra addresses after a paid quota increase", async function () {
    const { identity, idAuthority, alice, bob } = await loadFixture(deploySuite);
    await identity.connect(idAuthority).register(alice.address, ID_ALICE, 2);

    await expect(identity.connect(idAuthority).increaseAddressQuota(ID_ALICE, 2, PAYMENT_REF))
      .to.emit(identity, "AddressQuotaIncreased")
      .withArgs(ID_ALICE, 2, PAYMENT_REF);

    await identity.connect(idAuthority).register(bob.address, ID_ALICE, 2);
    expect(await identity.addressCount(ID_ALICE)).to.equal(2);
  });

  it("revocation frees the identity's address slot", async function () {
    const { identity, idAuthority, alice, bob } = await loadFixture(deploySuite);
    await identity.connect(idAuthority).register(alice.address, ID_ALICE, 2);
    await identity.connect(idAuthority).revoke(alice.address);

    expect(await identity.isActive(alice.address)).to.equal(false);
    await identity.connect(idAuthority).register(bob.address, ID_ALICE, 1);
    expect(await identity.addressCount(ID_ALICE)).to.equal(1);
  });

  it("suspension deactivates and reactivation restores", async function () {
    const { identity, idAuthority, alice } = await loadFixture(deploySuite);
    await identity.connect(idAuthority).register(alice.address, ID_ALICE, 2);

    await identity.connect(idAuthority).suspend(alice.address);
    expect(await identity.isActive(alice.address)).to.equal(false);
    expect(await identity.tierOf(alice.address)).to.equal(0);

    await identity.connect(idAuthority).reactivate(alice.address);
    expect(await identity.isActive(alice.address)).to.equal(true);
  });
});
