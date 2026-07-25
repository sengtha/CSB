const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Tokenized land title (ERC-3643 model) + third-party collateral use.
 *
 * Two claims under test:
 *  1. Only a regulated registrar can bring a title on chain, and the token
 *     refuses to settle with anyone the national identity layer has not verified.
 *  2. Once it exists, an unrelated lending contract can take it as collateral —
 *     the composability argument for putting titles on a shared ledger.
 */
describe("Land title — ERC-3643 tokenized parcel", function () {
  const PARCEL = ethers.id("parcel/phnom-penh/khan-x/12345");

  async function deploy() {
    const [council, authority, landAuthority, issuer, owner, buyer, lender, retail, stranger] =
      await ethers.getSigners();

    const identity = await ethers.deployContract("IdentityRegistry", [council.address, authority.address]);
    const enforcement = await ethers.deployContract("EnforcementRegistry", [council.address, council.address]);
    const khr = await ethers.deployContract("KHRStablecoin", [
      identity.target, enforcement.target, council.address, issuer.address,
    ]);
    const registry = await ethers.deployContract("LandTitleRegistry", [
      identity.target, enforcement.target, council.address, landAuthority.address,
    ]);

    // Tier 3 = business/KYB, tier 2 = full KYC, tier 1 = capped retail.
    await identity.connect(authority).register(owner.address, ethers.id("id-owner"), 3);
    await identity.connect(authority).register(buyer.address, ethers.id("id-buyer"), 3);
    await identity.connect(authority).register(lender.address, ethers.id("id-lender"), 4);
    await identity.connect(authority).register(retail.address, ethers.id("id-retail"), 1);
    await identity.connect(authority).register(issuer.address, ethers.id("id-issuer"), 4);
    // `stranger` is deliberately never registered.

    return { council, authority, landAuthority, issuer, owner, buyer, lender, retail, stranger,
             identity, enforcement, khr, registry };
  }

  function params(over = {}) {
    return {
      parcelId: PARCEL,
      name: "Land Title 12345",
      symbol: "LT12345",
      location: "Sangkat Example, Khan X",
      titleURI: "ipfs://deed-hash-placeholder",
      areaSqm: 450,
      totalShares: 10_000n,
      minimumTier: 2,
      firstOwner: over.firstOwner,
      ...over,
    };
  }

  async function tokenize(f, over = {}) {
    const p = params({ firstOwner: f.owner.address, ...over });
    const tx = await f.registry.connect(f.landAuthority).tokenizeParcel(p);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return f.registry.interface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "ParcelTokenized");
    return ethers.getContractAt("LandTitleToken", ev.args.token);
  }

  it("only the land authority can tokenize a parcel", async function () {
    const f = await deploy();
    await expect(f.registry.connect(f.owner).tokenizeParcel(params({ firstOwner: f.owner.address })))
      .to.be.revertedWithCustomError(f.registry, "AccessControlUnauthorizedAccount");
  });

  it("issues the whole parcel as shares to the recorded owner", async function () {
    const f = await deploy();
    const title = await tokenize(f);
    expect(await title.totalSupply()).to.equal(10_000n);
    expect(await title.balanceOf(f.owner.address)).to.equal(10_000n);
    expect(await title.parcelId()).to.equal(PARCEL);
    expect(await title.decimals()).to.equal(0);
    expect(await f.registry.isRegisteredTitle(title.target)).to.equal(true);
  });

  it("refuses to tokenize the same parcel twice", async function () {
    const f = await deploy();
    await tokenize(f);
    await expect(f.registry.connect(f.landAuthority).tokenizeParcel(params({ firstOwner: f.owner.address })))
      .to.be.revertedWithCustomError(f.registry, "ParcelAlreadyTokenized");
  });

  it("hands ongoing agent powers to the registrar, not the registry contract", async function () {
    const f = await deploy();
    const title = await tokenize(f);
    const AGENT = await title.AGENT_ROLE();
    expect(await title.hasRole(AGENT, f.landAuthority.address)).to.equal(true);
    expect(await title.hasRole(AGENT, f.registry.target)).to.equal(false);
  });

  it("settles a sale between two verified parties", async function () {
    const f = await deploy();
    const title = await tokenize(f);
    await title.connect(f.owner).transfer(f.buyer.address, 2_500n);
    expect(await title.balanceOf(f.buyer.address)).to.equal(2_500n); // a quarter of the parcel
    expect(await title.balanceOf(f.owner.address)).to.equal(7_500n);
  });

  it("cannot settle with an address the identity layer does not know", async function () {
    const f = await deploy();
    const title = await tokenize(f);
    await expect(title.connect(f.owner).transfer(f.stranger.address, 1n))
      .to.be.revertedWithCustomError(title, "NotVerified");
  });

  it("enforces a minimum KYC tier to hold land", async function () {
    const f = await deploy();
    const title = await tokenize(f);
    await expect(title.connect(f.owner).transfer(f.retail.address, 1n))
      .to.be.revertedWithCustomError(title, "TierTooLow");
  });

  it("answers canTransfer before anyone signs", async function () {
    const f = await deploy();
    const title = await tokenize(f);
    expect((await title.canTransfer(f.owner.address, f.buyer.address, 100n))[0]).to.equal(true);
    const [ok, why] = await title.canTransfer(f.owner.address, f.retail.address, 100n);
    expect(ok).to.equal(false);
    expect(why).to.contain("tier is too low");
  });

  it("respects an enforcement freeze", async function () {
    const f = await deploy();
    const title = await tokenize(f);
    await f.enforcement.connect(f.council).freeze(f.buyer.address, ethers.id("order-9"));
    await expect(title.connect(f.owner).transfer(f.buyer.address, 1n))
      .to.be.revertedWithCustomError(title, "AccountFrozen");
  });

  it("lets the registrar execute a court order against a frozen holder", async function () {
    const f = await deploy();
    const title = await tokenize(f);
    await title.connect(f.landAuthority).setAddressFrozen(f.owner.address, true);
    await expect(title.connect(f.owner).transfer(f.buyer.address, 1n))
      .to.be.revertedWithCustomError(title, "AccountFrozen");

    await title.connect(f.landAuthority).forcedTransfer(f.owner.address, f.buyer.address, 4_000n, ethers.id("court-77"));
    expect(await title.balanceOf(f.buyer.address)).to.equal(4_000n);
  });

  it("requires an order reference for forced transfers", async function () {
    const f = await deploy();
    const title = await tokenize(f);
    await expect(title.connect(f.landAuthority).forcedTransfer(f.owner.address, f.buyer.address, 1n, ethers.ZeroHash))
      .to.be.revertedWithCustomError(title, "OrderRefRequired");
  });

  it("recovers a lost key only to the same registered identity", async function () {
    const f = await deploy();
    const title = await tokenize(f);
    const replacement = ethers.Wallet.createRandom().address;

    // A different person's address is not a valid recovery target.
    await expect(title.connect(f.landAuthority).recoveryAddress(f.owner.address, f.buyer.address, ethers.id("r1")))
      .to.be.revertedWithCustomError(title, "NotVerified");

    // Same identity, second address slot — the legitimate case.
    await f.identity.connect(f.authority).increaseAddressQuota(ethers.id("id-owner"), 2, ethers.id("fee-1"));
    await f.identity.connect(f.authority).register(replacement, ethers.id("id-owner"), 3);
    await title.connect(f.landAuthority).recoveryAddress(f.owner.address, replacement, ethers.id("r2"));

    expect(await title.balanceOf(replacement)).to.equal(10_000n);
    expect(await title.balanceOf(f.owner.address)).to.equal(0n);
  });

  it("locks pledged shares without freezing the whole holding", async function () {
    const f = await deploy();
    const title = await tokenize(f);
    await title.connect(f.landAuthority).freezeShares(f.owner.address, 8_000n);

    // The unpledged remainder still moves.
    await title.connect(f.owner).transfer(f.buyer.address, 2_000n);
    // The pledged part does not.
    await expect(title.connect(f.owner).transfer(f.buyer.address, 1n))
      .to.be.revertedWithCustomError(title, "SharesLocked");
  });

  // ------------------------------------------------------------ composability

  describe("used as collateral by an unrelated lender", function () {
    async function withVault() {
      const f = await deploy();
      const title = await tokenize(f);
      const vault = await ethers.deployContract("LandCollateralVault", [
        f.registry.target, f.khr.target, f.council.address, f.lender.address,
      ]);
      // A contract has no national identity, so both tokens need it vetted
      // before it can custody anything: the council for KHRt, and the land
      // registrar (admin of the title it issued) for the land shares.
      await f.khr.connect(f.council).setSystemContract(vault.target, true);
      await title.connect(f.landAuthority).setApprovedCustodian(vault.target, true);
      await f.khr.connect(f.issuer).issue(f.lender.address, 100_000_00n);
      await f.khr.connect(f.lender).approve(vault.target, 100_000_00n);
      await vault.connect(f.lender).fund(100_000_00n);
      return { ...f, title, vault };
    }

    it("lends KHRt against land shares and returns them on repayment", async function () {
      const f = await withVault();
      await f.title.connect(f.owner).approve(f.vault.target, 5_000n);
      const due = (await ethers.provider.getBlock("latest")).timestamp + 3600;

      await f.vault.connect(f.lender).openLoan(f.owner.address, f.title.target, 5_000n, 20_000_00n, due);
      expect(await f.title.balanceOf(f.vault.target)).to.equal(5_000n);
      expect(await f.khr.balanceOf(f.owner.address)).to.equal(20_000_00n);

      await f.khr.connect(f.owner).approve(f.vault.target, 20_000_00n);
      await f.vault.connect(f.owner).repay(1);
      expect(await f.title.balanceOf(f.owner.address)).to.equal(10_000n);
    });

    it("refuses collateral that is not a registry-issued title", async function () {
      // The check that stops a convincing lookalike being pledged.
      const f = await withVault();
      const fake = await ethers.deployContract("LandTitleToken", [{
        name: "Fake Title", symbol: "FAKE", parcelId: ethers.id("not-real"),
        titleURI: "", minimumTier: 2, identity: f.identity.target,
        enforcement: f.enforcement.target, authorityAdmin: f.owner.address, agent: f.owner.address,
        firstOwner: f.owner.address, initialShares: 1_000n,
      }]);
      await fake.connect(f.owner).approve(f.vault.target, 1_000n);

      const due = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await expect(f.vault.connect(f.lender).openLoan(f.owner.address, fake.target, 1_000n, 1_00n, due))
        .to.be.revertedWithCustomError(f.vault, "NotARegisteredTitle");
    });

    it("will not seize before the loan is actually due", async function () {
      const f = await withVault();
      await f.title.connect(f.owner).approve(f.vault.target, 5_000n);
      const due = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await f.vault.connect(f.lender).openLoan(f.owner.address, f.title.target, 5_000n, 20_000_00n, due);

      await expect(f.vault.connect(f.lender).seize(1, f.lender.address))
        .to.be.revertedWithCustomError(f.vault, "NotYetDue");
    });

    it("seizes after default, and the title's own rules still apply", async function () {
      const f = await withVault();
      await f.title.connect(f.owner).approve(f.vault.target, 5_000n);
      const due = (await ethers.provider.getBlock("latest")).timestamp + 60;
      await f.vault.connect(f.lender).openLoan(f.owner.address, f.title.target, 5_000n, 20_000_00n, due);

      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      // Seizure cannot route land to an unverified address — compliance binds
      // the lender exactly as it binds everyone else.
      await expect(f.vault.connect(f.lender).seize(1, f.stranger.address))
        .to.be.revertedWithCustomError(f.title, "NotVerified");

      await f.vault.connect(f.lender).seize(1, f.lender.address);
      expect(await f.title.balanceOf(f.lender.address)).to.equal(5_000n);
    });

    it("only the borrower can repay their own loan", async function () {
      const f = await withVault();
      await f.title.connect(f.owner).approve(f.vault.target, 5_000n);
      const due = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await f.vault.connect(f.lender).openLoan(f.owner.address, f.title.target, 5_000n, 20_000_00n, due);

      await f.khr.connect(f.issuer).issue(f.buyer.address, 20_000_00n);
      await f.khr.connect(f.buyer).approve(f.vault.target, 20_000_00n);
      await expect(f.vault.connect(f.buyer).repay(1))
        .to.be.revertedWithCustomError(f.vault, "NotBorrower");
    });
  });
});
