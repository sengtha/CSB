const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * ID Poor — assigned spend target ("programmable money").
 *
 * The scenario: an assistance programme pays a household a monthly food
 * transfer. The money must reach a licensed food merchant. It must NOT be usable
 * to repay a moneylender — which is the failure mode targeted cash assistance
 * exists to prevent, and the reason the rule has to live in the money rather
 * than in a report written afterwards.
 */
describe("ID Poor — assigned spend target", function () {
  const FOOD = 1 << 0;
  const MEDICINE = 1 << 1;
  const EDUCATION = 1 << 2;

  async function deploy() {
    const [council, authority, issuer, household, grocer, pharmacy, lender, otherHousehold] =
      await ethers.getSigners();

    const identity = await ethers.deployContract("IdentityRegistry", [council.address, authority.address]);
    const enforcement = await ethers.deployContract("EnforcementRegistry", [council.address, council.address]);
    const khr = await ethers.deployContract("KHRStablecoin", [
      identity.target, enforcement.target, council.address, issuer.address,
    ]);
    const merchants = await ethers.deployContract("MerchantRegistry", [council.address, authority.address]);
    const programs = await ethers.deployContract("SocialProgramRegistry", [
      merchants.target, council.address, authority.address,
    ]);

    // Everyone transacting needs KYC — the aid rules sit on top of that, not instead of it.
    for (const s of [household, grocer, pharmacy, lender, otherHousehold, issuer]) {
      await identity.connect(authority).register(s.address, ethers.id(`id-${s.address}`), 2);
    }

    await merchants.connect(authority).registerMerchant(grocer.address, FOOD, "Psar Thmei grocery");
    await merchants.connect(authority).registerMerchant(pharmacy.address, MEDICINE, "Pharmacy");
    // The lender is deliberately NOT registered as any kind of merchant.

    await khr.connect(council).setSpendPolicy(programs.target);
    const tx = await programs.connect(authority).createProgram("Food assistance", FOOD, 0);
    await tx.wait();
    const programId = 1;

    return {
      council, authority, issuer, household, grocer, pharmacy, lender, otherHousehold,
      identity, enforcement, khr, merchants, programs, programId,
    };
  }

  const KHR = (n) => BigInt(Math.round(n * 100)); // 2 decimals

  it("lets assistance reach a licensed food merchant", async function () {
    const { khr, issuer, household, grocer, programId } = await deploy();
    await khr.connect(issuer).issueRestricted(household.address, KHR(50000), programId);

    expect(await khr.balanceOf(household.address)).to.equal(KHR(50000));
    expect(await khr.restrictedBalance(household.address)).to.equal(KHR(50000));
    expect(await khr.unrestrictedBalanceOf(household.address)).to.equal(0n);

    await expect(khr.connect(household).transfer(grocer.address, KHR(12000)))
      .to.emit(khr, "RestrictedSpent")
      .withArgs(household.address, grocer.address, KHR(12000), programId);

    expect(await khr.balanceOf(grocer.address)).to.equal(KHR(12000));
    expect(await khr.restrictedBalance(household.address)).to.equal(KHR(38000));
  });

  it("refuses to let assistance be paid to a moneylender", async function () {
    const { khr, issuer, household, lender, programId } = await deploy();
    await khr.connect(issuer).issueRestricted(household.address, KHR(50000), programId);

    await expect(khr.connect(household).transfer(lender.address, KHR(10000)))
      .to.be.revertedWithCustomError(khr, "SpendTargetNotPermitted")
      .withArgs(household.address, lender.address, KHR(10000), 0n, programId);

    expect(await khr.balanceOf(lender.address)).to.equal(0n);
  });

  it("refuses a merchant in the wrong category", async function () {
    // Food assistance at a pharmacy: a real merchant, wrong licence.
    const { khr, issuer, household, pharmacy, programId } = await deploy();
    await khr.connect(issuer).issueRestricted(household.address, KHR(50000), programId);

    await expect(khr.connect(household).transfer(pharmacy.address, KHR(1000)))
      .to.be.revertedWithCustomError(khr, "SpendTargetNotPermitted");
  });

  it("still lets the household spend its OWN money anywhere, including on debt", async function () {
    // The point of the earmark is to direct assistance, not to control the
    // person. Money they earned stays theirs.
    const { khr, issuer, household, lender, programId } = await deploy();
    await khr.connect(issuer).issueRestricted(household.address, KHR(50000), programId);
    await khr.connect(issuer).issue(household.address, KHR(8000)); // wages, unrestricted

    expect(await khr.unrestrictedBalanceOf(household.address)).to.equal(KHR(8000));

    await khr.connect(household).transfer(lender.address, KHR(8000));
    expect(await khr.balanceOf(lender.address)).to.equal(KHR(8000));
    // The earmark is untouched.
    expect(await khr.restrictedBalance(household.address)).to.equal(KHR(50000));
  });

  it("will not let an unrestricted payment eat into the earmark", async function () {
    const { khr, issuer, household, lender, programId } = await deploy();
    await khr.connect(issuer).issueRestricted(household.address, KHR(50000), programId);
    await khr.connect(issuer).issue(household.address, KHR(8000));

    // 8,000 of their own money is available; 9,000 would have to dip into aid.
    await expect(khr.connect(household).transfer(lender.address, KHR(9000)))
      .to.be.revertedWithCustomError(khr, "SpendTargetNotPermitted")
      .withArgs(household.address, lender.address, KHR(9000), KHR(8000), programId);
  });

  it("spends the earmark first at a permitted merchant, then own money", async function () {
    const { khr, issuer, household, grocer, programId } = await deploy();
    await khr.connect(issuer).issueRestricted(household.address, KHR(100), programId);
    await khr.connect(issuer).issue(household.address, KHR(500));

    await khr.connect(household).transfer(grocer.address, KHR(300));

    // Aid consumed entirely; the rest came from their own balance.
    expect(await khr.restrictedBalance(household.address)).to.equal(0n);
    expect(await khr.balanceOf(household.address)).to.equal(KHR(300));
    expect(await khr.unrestrictedBalanceOf(household.address)).to.equal(KHR(300));
  });

  it("does not make the earmark contagious — the merchant receives ordinary money", async function () {
    const { khr, issuer, household, grocer, lender, programId } = await deploy();
    await khr.connect(issuer).issueRestricted(household.address, KHR(5000), programId);
    await khr.connect(household).transfer(grocer.address, KHR(5000));

    expect(await khr.restrictedBalance(grocer.address)).to.equal(0n);
    // The grocer can bank the takings like any other business.
    await khr.connect(grocer).transfer(lender.address, KHR(5000));
    expect(await khr.balanceOf(lender.address)).to.equal(KHR(5000));
  });

  it("blocks spending once the programme expires, and can be clawed back", async function () {
    const { khr, issuer, authority, household, grocer, programs, programId } = await deploy();
    await khr.connect(issuer).issueRestricted(household.address, KHR(20000), programId);

    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await programs.connect(authority).updateProgram(programId, FOOD, now + 100);
    await ethers.provider.send("evm_increaseTime", [200]);
    await ethers.provider.send("evm_mine", []);

    expect(await programs.isProgramActive(programId)).to.equal(false);
    await expect(khr.connect(household).transfer(grocer.address, KHR(100)))
      .to.be.revertedWithCustomError(khr, "SpendTargetNotPermitted");

    // Unspent assistance returns to the issuer when the programme closes.
    await expect(khr.connect(issuer).clawbackRestricted(household.address, KHR(20000), ethers.id("programme closed")))
      .to.emit(khr, "RestrictedClawedBack");
    expect(await khr.balanceOf(household.address)).to.equal(0n);
    expect(await khr.balanceOf(issuer.address)).to.equal(KHR(20000));
  });

  it("limits clawback to the earmark — never the household's own money", async function () {
    const { khr, issuer, household, programId } = await deploy();
    await khr.connect(issuer).issueRestricted(household.address, KHR(1000), programId);
    await khr.connect(issuer).issue(household.address, KHR(4000)); // their own

    await expect(khr.connect(issuer).clawbackRestricted(household.address, KHR(1500), ethers.id("x")))
      .to.be.revertedWithCustomError(khr, "RestrictedBalanceExceeded");

    await khr.connect(issuer).clawbackRestricted(household.address, KHR(1000), ethers.id("x"));
    expect(await khr.balanceOf(household.address)).to.equal(KHR(4000));
  });

  it("does not levy the public-good fee on assistance spending", async function () {
    const { khr, council, issuer, household, grocer, otherHousehold, programId } = await deploy();
    await khr.connect(council).setTransferLevy(KHR(1), otherHousehold.address);
    await khr.connect(issuer).issueRestricted(household.address, KHR(5000), programId);

    await khr.connect(household).transfer(grocer.address, KHR(1000));
    // Full amount reaches the grocer; the fee is not taken out of aid.
    expect(await khr.balanceOf(grocer.address)).to.equal(KHR(1000));
    expect(await khr.totalLevied()).to.equal(0n);
  });

  it("suspending a merchant's licence stops assistance reaching them immediately", async function () {
    const { khr, issuer, authority, household, grocer, merchants, programId } = await deploy();
    await khr.connect(issuer).issueRestricted(household.address, KHR(5000), programId);
    await merchants.connect(authority).setSuspended(grocer.address, true);

    await expect(khr.connect(household).transfer(grocer.address, KHR(100)))
      .to.be.revertedWithCustomError(khr, "SpendTargetNotPermitted");

    await merchants.connect(authority).setSuspended(grocer.address, false);
    await khr.connect(household).transfer(grocer.address, KHR(100));
    expect(await khr.balanceOf(grocer.address)).to.equal(KHR(100));
  });

  it("explains refusals in words a wallet can show", async function () {
    const { khr, issuer, household, lender, pharmacy, grocer, programId } = await deploy();
    await khr.connect(issuer).issueRestricted(household.address, KHR(5000), programId);

    const [okGrocer] = await khr.canSpend(household.address, grocer.address, KHR(100));
    expect(okGrocer).to.equal(true);

    const [okLender, whyLender] = await khr.canSpend(household.address, lender.address, KHR(100));
    expect(okLender).to.equal(false);
    expect(whyLender).to.equal("the recipient is not a registered merchant");

    const [okPharm, whyPharm] = await khr.canSpend(household.address, pharmacy.address, KHR(100));
    expect(okPharm).to.equal(false);
    expect(whyPharm).to.contain("permitted categories");
  });

  it("supports multi-category programmes", async function () {
    const { khr, issuer, authority, household, grocer, pharmacy, programs } = await deploy();
    await programs.connect(authority).createProgram("Food + medicine", FOOD | MEDICINE, 0);
    const pid = 2;
    await khr.connect(issuer).issueRestricted(household.address, KHR(9000), pid);

    await khr.connect(household).transfer(grocer.address, KHR(1000));
    await khr.connect(household).transfer(pharmacy.address, KHR(1000));
    expect(await khr.balanceOf(pharmacy.address)).to.equal(KHR(1000));
  });

  it("keeps aid rules on top of KYC, not instead of it", async function () {
    // An unregistered merchant address can't receive at all, aid or not.
    const { khr, issuer, household, programId } = await deploy();
    const stranger = ethers.Wallet.createRandom().address;
    await khr.connect(issuer).issueRestricted(household.address, KHR(5000), programId);
    await expect(khr.connect(household).transfer(stranger, KHR(10)))
      .to.be.revertedWithCustomError(khr, "NotKycActive");
  });

  it("refuses to relabel an unspent earmark under a different programme", async function () {
    const { khr, issuer, authority, household, programs, programId } = await deploy();
    await programs.connect(authority).createProgram("School fees", EDUCATION, 0);
    await khr.connect(issuer).issueRestricted(household.address, KHR(1000), programId);

    await expect(khr.connect(issuer).issueRestricted(household.address, KHR(1000), 2))
      .to.be.revertedWithCustomError(khr, "ProgramRequired");

    // Topping up the SAME programme is fine.
    await khr.connect(issuer).issueRestricted(household.address, KHR(1000), programId);
    expect(await khr.restrictedBalance(household.address)).to.equal(KHR(2000));
  });

  it("only the issuer can create earmarks or claw them back", async function () {
    const { khr, household, grocer, programId } = await deploy();
    await expect(khr.connect(household).issueRestricted(grocer.address, KHR(100), programId))
      .to.be.revertedWithCustomError(khr, "AccessControlUnauthorizedAccount");
    await expect(khr.connect(household).clawbackRestricted(grocer.address, KHR(1), ethers.id("x")))
      .to.be.revertedWithCustomError(khr, "AccessControlUnauthorizedAccount");
  });

  it("only the registrar can license merchants, only policy admin can set rules", async function () {
    const { merchants, programs, household } = await deploy();
    await expect(merchants.connect(household).registerMerchant(household.address, FOOD, "self-dealt"))
      .to.be.revertedWithCustomError(merchants, "AccessControlUnauthorizedAccount");
    await expect(programs.connect(household).createProgram("mine", FOOD, 0))
      .to.be.revertedWithCustomError(programs, "AccessControlUnauthorizedAccount");
  });

  it("enforcement still overrides everything, earmark included", async function () {
    const { khr, council, issuer, household, grocer, programId } = await deploy();
    await khr.connect(council).grantRole(await khr.ENFORCER_ROLE(), council.address);
    await khr.connect(issuer).issueRestricted(household.address, KHR(5000), programId);

    await khr.connect(council).confiscate(household.address, grocer.address, KHR(5000), ethers.id("order-1"));
    expect(await khr.balanceOf(grocer.address)).to.equal(KHR(5000));
  });
});
