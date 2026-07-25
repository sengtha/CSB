const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deploySuite, ID_ALICE } = require("./fixtures");

// KHRt has 2 decimals, native tRIEL has 18 → scale = 10**(18-2).
const SCALE = 10n ** 16n;
const DEAD = "0x000000000000000000000000000000000000dEaD";

async function converterFixture() {
  const s = await deploySuite();
  await s.identity.connect(s.idAuthority).register(s.alice.address, ID_ALICE, 2);
  await s.khr.connect(s.issuer).issue(s.alice.address, 1_000_000_00); // 1,000,000.00 KHRt

  const minter = await ethers.deployContract("MockNativeMinter");
  await s.council.sendTransaction({ to: minter.target, value: ethers.parseEther("2000") }); // float to "mint" from

  const converter = await ethers.deployContract("RielConverter", [s.council.address, minter.target]);
  await s.khr.connect(s.council).setSystemContract(converter.target, true); // custody KHRt without KYC
  await converter.connect(s.council).setApproved(s.khr.target, true);
  return { ...s, converter, minter };
}

describe("RielConverter", function () {
  it("wraps tokenized riel into tRIEL 1:1 (decimal-scaled) and locks the collateral", async function () {
    const { converter, khr, alice } = await loadFixture(converterFixture);
    const amount = 500_00n; // 500.00 KHRt
    await khr.connect(alice).approve(converter.target, amount);

    const before = await ethers.provider.getBalance(alice.address);
    const rc = await (await converter.connect(alice).wrap(khr.target, amount)).wait();
    const after = await ethers.provider.getBalance(alice.address);

    const trielOut = amount * SCALE; // 500 tRIEL
    expect(after - before + rc.gasUsed * rc.gasPrice).to.equal(trielOut);
    expect(await khr.balanceOf(converter.target)).to.equal(amount); // collateral locked
    expect(await khr.balanceOf(alice.address)).to.equal(1_000_000_00n - amount);
  });

  it("unwraps tRIEL back to tokenized riel, burning the tRIEL", async function () {
    const { converter, khr, alice } = await loadFixture(converterFixture);
    const amount = 500_00n;
    await khr.connect(alice).approve(converter.target, amount);
    await converter.connect(alice).wrap(khr.target, amount);
    const trielIn = amount * SCALE;

    const khrBefore = await khr.balanceOf(alice.address);
    const burnBefore = await ethers.provider.getBalance(DEAD);

    await expect(converter.connect(alice).unwrap(khr.target, amount, { value: trielIn }))
      .to.emit(converter, "Unwrapped").withArgs(alice.address, khr.target, amount, trielIn);

    expect(await khr.balanceOf(alice.address)).to.equal(khrBefore + amount); // collateral released
    expect(await khr.balanceOf(converter.target)).to.equal(0n);
    expect(await ethers.provider.getBalance(DEAD)).to.equal(burnBefore + trielIn); // tRIEL burned
  });

  it("rejects wrapping a token the council has not approved", async function () {
    const { converter, khr, council, alice } = await loadFixture(converterFixture);
    await converter.connect(council).setApproved(khr.target, false);
    await khr.connect(alice).approve(converter.target, 100n);
    await expect(converter.connect(alice).wrap(khr.target, 100n))
      .to.be.revertedWithCustomError(converter, "TokenNotApproved");
  });

  it("rejects unwrap with the wrong tRIEL value", async function () {
    const { converter, khr, alice } = await loadFixture(converterFixture);
    const amount = 100_00n;
    await khr.connect(alice).approve(converter.target, amount);
    await converter.connect(alice).wrap(khr.target, amount);
    await expect(converter.connect(alice).unwrap(khr.target, amount, { value: 1n }))
      .to.be.revertedWithCustomError(converter, "WrongValue");
  });

  it("only the council can approve tokens", async function () {
    const { converter, khr, alice } = await loadFixture(converterFixture);
    await expect(converter.connect(alice).setApproved(khr.target, true))
      .to.be.revertedWithCustomError(converter, "AccessControlUnauthorizedAccount");
  });

  it("KYC gating carries through conversion: a non-KYC'd account cannot wrap", async function () {
    const { converter, khr, outsider } = await loadFixture(converterFixture);
    await khr.connect(outsider).approve(converter.target, 100n);
    await expect(converter.connect(outsider).wrap(khr.target, 100n))
      .to.be.revertedWithCustomError(khr, "NotKycActive");
  });
});
