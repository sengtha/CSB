const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySuite, ID_ALICE, ID_BOB } = require("./fixtures");

/**
 * A THIRD protocol against the compliance-gated asset — this time a standard
 * rather than a product.
 *
 * The Uniswap and Aave experiments each established that one named protocol turns
 * a gated asset into an ungated claim on it. That is two data points, and the
 * obvious objection is that two protocols are not a survey. ERC-4626 answers the
 * objection differently: it is the standard interface for tokenized vaults, so a
 * result here is a result about the shape rather than about a product. Anything
 * implementing the standard behaves this way, because the standard's share token
 * is an ERC-20 and ERC-20 has no notion of identity.
 *
 * The vault under test adds nothing to OpenZeppelin's implementation — no state,
 * no functions, no overrides. See contracts/experiments/KHRtVault.sol.
 *
 * ERC-4626 also permits a systematic test that Uniswap and Aave did not. It
 * defines exactly four ways value moves — deposit, mint, withdraw, redeem — so
 * the perimeter can be probed at every entry point rather than at whichever one a
 * particular protocol happens to expose. That matters: a gate that holds on
 * `withdraw` and leaks on `redeem` would be a real defect, and only an exhaustive
 * check finds it.
 *
 * What these tests record:
 *
 *   1. The vault deploys and works. No source change, no compliance awareness.
 *   2. It cannot hold KHRt until the council grants it system-contract status,
 *      and it cannot be granted that before it exists. Same discretionary step
 *      Uniswap's pair and Aave's pool needed.
 *   3. THE ASSET IS GATED WHEREVER IT MOVES. `withdraw` and `redeem` to an
 *      unattested receiver revert on compliance specifically, not merely revert.
 *      An unattested address also cannot deposit — but that is the perimeter
 *      working one layer earlier, since it cannot hold the asset to deposit in the
 *      first place, and the revert is an allowance error rather than a compliance
 *      one. Recorded separately, because asserting "deposit reverts" and calling it
 *      a compliance result would claim a gate the vault does not have.
 *   3b. THE STANDARD HANDS EXPOSURE OVER IN ONE CALL. `deposit` and `mint` both
 *      take a `receiver`, so an attested party pays the gated asset in and an
 *      unattested party receives the claim, in a single transaction. This is
 *      sharper than the Uniswap and Aave leaks, which needed the claim to be
 *      acquired and then transferred: here the unattested address never appears as
 *      a sender at all.
 *   4. THE SHARE IS NOT GATED. It moves to an address that cannot receive a single
 *      riel of the underlying, exactly as an LP token and an aToken do, and can be
 *      passed on again from there.
 *
 * Findings 3 and 4 together are the point: the standard's *asset* path is
 * protected by the asset itself, and the standard's *share* path is protected by
 * nothing, and no vault built on this standard can be different. Finding 3b is why
 * the standard is worse than the products — the leak is a documented parameter of
 * the interface rather than an emergent consequence of composing two calls.
 */
describe("Unmodified ERC-4626 vault against a compliance-gated token", function () {
  async function vaultFixture() {
    const s = await deploySuite();
    await s.identity.connect(s.idAuthority).register(s.alice.address, ID_ALICE, 2);
    await s.identity.connect(s.idAuthority).register(s.bob.address, ID_BOB, 2);
    await s.khr.connect(s.issuer).issue(s.alice.address, 1_000_000_00);
    await s.khr.connect(s.issuer).issue(s.bob.address, 100_000_00);

    const vault = await ethers.deployContract("KHRtVault", [
      s.khr.target, "CSB KHRt Vault", "vKHRt",
    ]);
    return { ...s, vault };
  }

  /** The vault vetted and funded, so share-side behaviour can be examined. */
  async function fundedFixture() {
    const f = await vaultFixture();
    await f.khr.connect(f.council).setSystemContract(f.vault.target, true);
    await f.khr.connect(f.alice).approve(f.vault.target, 500_000_00);
    await f.vault.connect(f.alice).deposit(500_000_00, f.alice.address);
    return f;
  }

  it("finding 1: the standard's implementation deploys unmodified and works", async function () {
    const { vault, khr, alice, council } = await loadFixture(vaultFixture);

    expect(await vault.asset()).to.equal(khr.target);
    expect(await vault.decimals()).to.equal(await khr.decimals());

    await khr.connect(council).setSystemContract(vault.target, true);
    await khr.connect(alice).approve(vault.target, 1_000_00);
    await vault.connect(alice).deposit(1_000_00, alice.address);

    // 1:1 on an empty vault, which is the standard's defined behaviour.
    expect(await vault.balanceOf(alice.address)).to.equal(1_000_00);
    expect(await vault.totalAssets()).to.equal(1_000_00);
  });

  it("finding 2: the vault cannot hold KHRt until vetted, and cannot be vetted before it exists",
    async function () {
      const { vault, khr, alice, council } = await loadFixture(vaultFixture);

      // Deployment itself is fine — it moves no tokens, so no compliance check runs.
      expect(await ethers.provider.getCode(vault.target)).to.not.equal("0x");

      await khr.connect(alice).approve(vault.target, 1_000_00);
      await expect(vault.connect(alice).deposit(1_000_00, alice.address))
        .to.be.revertedWithCustomError(khr, "NotKycActive")
        .withArgs(vault.target);

      // The council's grant is what unblocks it, and the address it must name did
      // not exist until the deploy above.
      await khr.connect(council).setSystemContract(vault.target, true);
      await expect(vault.connect(alice).deposit(1_000_00, alice.address)).to.not.be.reverted;
    });

  it("FINDING 3: every path that moves the ASSET to an unattested address reverts on compliance",
    async function () {
      const { vault, khr, alice, outsider } = await loadFixture(fundedFixture);

      // The two paths that push the asset OUT. These are where regulated value
      // would escape, and each is asserted against the SPECIFIC compliance error
      // rather than "reverted" — a test that passes for the wrong reason is worse
      // than no test, and the check below exists because one nearly did.
      await expect(vault.connect(alice).withdraw(1_00, outsider.address, alice.address))
        .to.be.revertedWithCustomError(khr, "NotKycActive")
        .withArgs(outsider.address);
      await expect(vault.connect(alice).redeem(1_00, outsider.address, alice.address))
        .to.be.revertedWithCustomError(khr, "NotKycActive")
        .withArgs(outsider.address);

      expect(await khr.balanceOf(outsider.address)).to.equal(0);
    });

  it("an unattested address cannot deposit — but the gate is upstream, not in the vault",
    async function () {
      const { vault, khr, outsider } = await loadFixture(fundedFixture);

      // Worth stating precisely, because the obvious assertion is misleading. The
      // outsider's deposit does revert — but on ALLOWANCE, not on compliance,
      // because it has no KHRt to approve or spend in the first place. The
      // perimeter stopped it one layer earlier, when it could not acquire the
      // asset. Asserting "deposit reverts" and calling that a compliance result
      // would be claiming a gate the vault does not have.
      await expect(vault.connect(outsider).deposit(1_00, outsider.address))
        .to.be.revertedWithCustomError(khr, "ERC20InsufficientAllowance");

      expect(await khr.balanceOf(outsider.address)).to.equal(0);
    });

  it("FINDING 3b: the standard hands exposure to an unattested address in a SINGLE call",
    async function () {
      const { vault, khr, alice, outsider } = await loadFixture(fundedFixture);

      // fundedFixture spent alice's whole approval, so top it up — otherwise this
      // would fail on allowance and prove nothing about compliance.
      await khr.connect(alice).approve(vault.target, 100_000_00);

      // ERC-4626's deposit and mint both take a `receiver`. So an attested party
      // pays the gated asset in, and an unattested party receives the claim, in one
      // transaction. Unlike the Uniswap and Aave leaks, no separate transfer step is
      // needed, and the unattested address never appears as a sender at all.
      await expect(vault.connect(alice).deposit(10_00, outsider.address)).to.not.be.reverted;
      expect(await vault.balanceOf(outsider.address)).to.equal(10_00);

      await expect(vault.connect(alice).mint(5_00, outsider.address)).to.not.be.reverted;
      expect(await vault.balanceOf(outsider.address)).to.equal(15_00);

      // It holds a claim on pooled KHRt while holding none of the asset, and while
      // having taken no action whatsoever.
      expect(await khr.balanceOf(outsider.address)).to.equal(0);
      expect(await vault.convertToAssets(15_00)).to.be.greaterThan(0);
    });

  it("FINDING 4: the share is gated at none of them — it reaches an unattested address",
    async function () {
      const { vault, khr, alice, outsider } = await loadFixture(fundedFixture);

      // The outsider cannot hold one unit of the underlying.
      await expect(khr.connect(alice).transfer(outsider.address, 1))
        .to.be.revertedWithCustomError(khr, "NotKycActive")
        .withArgs(outsider.address);

      // The share moves to the same address without complaint.
      await expect(vault.connect(alice).transfer(outsider.address, 10_000)).to.not.be.reverted;
      expect(await vault.balanceOf(outsider.address)).to.equal(10_000);

      // What it now holds is a claim on pooled KHRt, priced by the standard itself.
      expect(await vault.convertToAssets(10_000)).to.equal(10_000);
      expect(await khr.balanceOf(outsider.address)).to.equal(0);

      // The claim can be handed on again — nothing about the first hop was special.
      const further = ethers.Wallet.createRandom().address;
      await expect(vault.connect(outsider).transfer(further, 5_000)).to.not.be.reverted;
      expect(await vault.balanceOf(further)).to.equal(5_000);
    });

  it("redemption stays blocked, so the asset never follows the share out",
    async function () {
      const { vault, khr, alice, outsider } = await loadFixture(fundedFixture);
      await vault.connect(alice).transfer(outsider.address, 10_000);

      // The outsider holds shares and cannot turn them into KHRt, for itself or
      // for anyone else who could not hold KHRt either.
      await expect(vault.connect(outsider).redeem(10_000, outsider.address, outsider.address))
        .to.be.revertedWithCustomError(khr, "NotKycActive")
        .withArgs(outsider.address);

      // It CAN redeem to an attested address — which is the leak's settlement
      // route: the exposure is realised by someone who is identified, on behalf of
      // someone who is not.
      await expect(vault.connect(outsider).redeem(10_000, alice.address, outsider.address))
        .to.not.be.reverted;
      expect(await vault.balanceOf(outsider.address)).to.equal(0);
    });

  it("the leaked share appreciates: exposure grows with no action by the holder",
    async function () {
      const { vault, khr, alice, bob, outsider } = await loadFixture(fundedFixture);
      await vault.connect(alice).transfer(outsider.address, 10_000);

      const before = await vault.convertToAssets(10_000);

      // Anyone can donate to a 4626 vault by sending the asset directly; yield in a
      // real vault arrives the same way. No transaction touches the outsider.
      await khr.connect(bob).transfer(vault.target, 50_000_00);

      const after = await vault.convertToAssets(10_000);
      expect(after).to.be.greaterThan(before);

      // The share count did not change. Only what it is worth did.
      expect(await vault.balanceOf(outsider.address)).to.equal(10_000);
    });
});
