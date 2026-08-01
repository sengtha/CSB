const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySuite, ID_ALICE, ID_BOB, ORDER_REF } = require("./fixtures");

/**
 * CAN THE PERIMETER BE EXTENDED TO THE CLAIM, AND WHAT DOES IT COST?
 *
 * Every other experiment here demonstrates the same gap from a different angle: a
 * protocol takes custody of a compliance-gated asset and issues a claim that
 * carries none of the asset's rules. Uniswap's LP share, Aave's aToken, and an
 * unmodified ERC-4626 vault share all behave identically, and the conclusion drawn
 * is that the remedy sits one layer above the base layer, at the point where the
 * claim is minted.
 *
 * That conclusion was, until this file, argued rather than demonstrated. Here it is
 * built and measured.
 *
 * THE CONTROL. `CompliantKHRtVault` differs from `KHRtVault` in exactly one way: a
 * single hook on the share, applying the same rule `KHRStablecoin` applies to the
 * asset. Same standard, same underlying, same tests. A difference in outcome is
 * therefore attributable to the rule's PLACEMENT and to nothing else, which is what
 * makes this a control rather than a fourth demonstration.
 *
 * What these tests establish:
 *
 *   1. The fix works, and it is small. Every escape route the unmodified vault
 *      leaves open is closed, including the single-call `receiver` handover that no
 *      rule about transaction senders could ever reach.
 *   2. THE FIX COSTS COMPOSABILITY, and the cost is measured rather than asserted.
 *      A gated share cannot enter any protocol that has not been individually
 *      exempted by the council — demonstrated by composing the compliant vault into
 *      an ordinary one, which reverts until the council acts, at which point the
 *      claim is once again held by an exempt contract and the question recurses.
 *   3. Enforcement reaches the claim too, which the unmodified vault could not
 *      offer: a frozen holder cannot move shares.
 *
 * What this is NOT. It is not a fix for third-party protocols. It works because the
 * vault is ours to write. Nothing here applies to Uniswap's pair or Aave's aToken
 * without forking them, which forfeits the "unmodified" property the architecture's
 * central claim rests on.
 */
describe("A COMPLIANT ERC-4626 vault — the control for the leak", function () {
  async function fixture() {
    const s = await deploySuite();
    await s.identity.connect(s.idAuthority).register(s.alice.address, ID_ALICE, 2);
    await s.identity.connect(s.idAuthority).register(s.bob.address, ID_BOB, 2);
    await s.khr.connect(s.issuer).issue(s.alice.address, 1_000_000_00);

    // The two vaults side by side, over the same asset.
    const plain = await ethers.deployContract("KHRtVault", [
      s.khr.target, "CSB KHRt Vault", "vKHRt",
    ]);
    const gated = await ethers.deployContract("CompliantKHRtVault", [
      s.khr.target, "CSB KHRt Vault (compliant)", "cvKHRt",
      s.identity.target, s.enforcement.target, s.council.address,
    ]);

    // Both need the same council grant to custody KHRt — the fix changes nothing
    // about the ASSET side, which is the point of holding it constant.
    await s.khr.connect(s.council).setSystemContract(plain.target, true);
    await s.khr.connect(s.council).setSystemContract(gated.target, true);

    await s.khr.connect(s.alice).approve(plain.target, 500_000_00);
    await s.khr.connect(s.alice).approve(gated.target, 500_000_00);
    await plain.connect(s.alice).deposit(100_000_00, s.alice.address);
    await gated.connect(s.alice).deposit(100_000_00, s.alice.address);

    return { ...s, plain, gated };
  }

  it("the gated vault still works normally for attested participants", async function () {
    const { gated, khr, alice, bob } = await loadFixture(fixture);

    expect(await gated.asset()).to.equal(khr.target);
    expect(await gated.balanceOf(alice.address)).to.equal(100_000_00);

    // Attested to attested moves freely; the rule is about identity, not friction.
    await expect(gated.connect(alice).transfer(bob.address, 1_000_00)).to.not.be.reverted;
    expect(await gated.balanceOf(bob.address)).to.equal(1_000_00);

    // And redemption to an attested address is unaffected.
    await expect(gated.connect(bob).redeem(1_000_00, bob.address, bob.address))
      .to.not.be.reverted;
  });

  it("A/B: the same share transfer leaks from the plain vault and is refused by the gated one",
    async function () {
      const { plain, gated, alice, outsider } = await loadFixture(fixture);

      // Identical call, identical amount, identical recipient. Only the vault differs.
      await expect(plain.connect(alice).transfer(outsider.address, 10_000)).to.not.be.reverted;
      expect(await plain.balanceOf(outsider.address)).to.equal(10_000);

      await expect(gated.connect(alice).transfer(outsider.address, 10_000))
        .to.be.revertedWithCustomError(gated, "NotKycActive")
        .withArgs(outsider.address);
      expect(await gated.balanceOf(outsider.address)).to.equal(0);
    });

  it("A/B: the single-call handover — the leak the base layer could never see — is closed",
    async function () {
      const { plain, gated, alice, outsider } = await loadFixture(fixture);

      // ERC-4626's `receiver` parameter lets an attested payer hand the claim
      // straight to an unattested address, with that address never sending
      // anything. txAllowList governs senders, so no configuration of it reaches
      // this. A share-level rule does.
      await expect(plain.connect(alice).deposit(10_00, outsider.address)).to.not.be.reverted;
      expect(await plain.balanceOf(outsider.address)).to.equal(10_00);

      await expect(gated.connect(alice).deposit(10_00, outsider.address))
        .to.be.revertedWithCustomError(gated, "NotKycActive")
        .withArgs(outsider.address);
      await expect(gated.connect(alice).mint(10_00, outsider.address))
        .to.be.revertedWithCustomError(gated, "NotKycActive")
        .withArgs(outsider.address);
      expect(await gated.balanceOf(outsider.address)).to.equal(0);
    });

  it("THE COST: a gated share cannot be composed, until the council exempts each counterparty",
    async function () {
      const { gated, alice, council, outsider } = await loadFixture(fixture);

      // An ordinary ERC-4626 vault over the compliant vault's shares — the most
      // basic composition there is, and the shape of every yield aggregator.
      const outer = await ethers.deployContract("KHRtVault", [
        gated.target, "Vault of vault", "vvKHRt",
      ]);

      await gated.connect(alice).approve(outer.target, 50_000_00);

      // It cannot hold the shares. The outer vault is a contract and holds no
      // attestation — exactly the position Uniswap's pair and Aave's aToken were in
      // with respect to KHRt, now reproduced one level further out.
      await expect(outer.connect(alice).deposit(10_000, alice.address))
        .to.be.revertedWithCustomError(gated, "NotKycActive")
        .withArgs(outer.target);

      // The council can restore composability, per counterparty, after the fact,
      // for an address that did not exist until it was deployed. This is the same
      // discretionary act the perimeter already required of it — the fix does not
      // introduce a new kind of decision, it multiplies an existing one.
      await gated.connect(council).setSystemContract(outer.target, true);
      await expect(outer.connect(alice).deposit(10_000, alice.address)).to.not.be.reverted;

      // And note what now holds the claim: an exempt contract whose own share is
      // ungated. The outer vault's shares carry no rule at all, so the question
      // this experiment asks recurses one level up.
      expect(await outer.balanceOf(alice.address)).to.equal(10_000);

      // Guard: a call to an address with no code does NOT revert, so an
      // unguarded "not reverted" assertion here would pass vacuously. An earlier
      // draft of this test called loadFixture a second time, which restored the
      // snapshot and left `outer` codeless — and the assertion below passed
      // against nothing. Check the code is there before trusting the result.
      expect(await ethers.provider.getCode(outer.target)).to.not.equal("0x");

      await expect(outer.connect(alice).transfer(outsider.address, 1_000)).to.not.be.reverted;
      expect(await outer.balanceOf(outsider.address)).to.equal(1_000);
    });

  it("enforcement reaches the claim: a frozen holder cannot move shares",
    async function () {
      const { gated, plain, alice, bob, enforcement, enforcer } = await loadFixture(fixture);
      await gated.connect(alice).transfer(bob.address, 10_000);
      await plain.connect(alice).transfer(bob.address, 10_000);

      await enforcement.connect(enforcer).freeze(bob.address, ORDER_REF);

      // The gated share obeys the freeze; the plain share does not know about it.
      await expect(gated.connect(bob).transfer(alice.address, 1_000))
        .to.be.revertedWithCustomError(gated, "AccountFrozen")
        .withArgs(bob.address);
      await expect(plain.connect(bob).transfer(alice.address, 1_000)).to.not.be.reverted;
    });

  it("a revoked holder is stranded: the share stops moving, which is the intended severity",
    async function () {
      const { gated, alice, bob, identity, idAuthority } = await loadFixture(fixture);
      await gated.connect(alice).transfer(bob.address, 10_000);

      await identity.connect(idAuthority).revoke(bob.address);

      // Bob keeps the balance and can do nothing with it — not transfer, not
      // redeem, because redemption burns the share and the burn checks the owner.
      // Worth recording plainly: extending the perimeter to the claim means a
      // revocation can strand a position, which the ungated share never does. That
      // is a policy choice presented as a technical one, and it should be made
      // deliberately.
      expect(await gated.balanceOf(bob.address)).to.equal(10_000);
      await expect(gated.connect(bob).transfer(alice.address, 1_000))
        .to.be.revertedWithCustomError(gated, "NotKycActive")
        .withArgs(bob.address);
      await expect(gated.connect(bob).redeem(1_000, bob.address, bob.address))
        .to.be.revertedWithCustomError(gated, "NotKycActive")
        .withArgs(bob.address);
    });
});
