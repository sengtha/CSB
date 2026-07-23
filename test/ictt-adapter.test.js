const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySuite, ID_ALICE, DEST_CHAIN } = require("./fixtures");

// Fuji C-Chain blockchainID (verify against current docs before real deployment)
const FUJI_C_BLOCKCHAIN_ID = "0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5";
const REMOTE = "0x" + "22".repeat(20);
const RECIPIENT = "0x" + "11".repeat(20);
const GAS_LIMIT = 250_000n;

async function suiteWithIctt() {
  const s = await deploySuite();
  await s.identity.connect(s.moi).register(s.alice.address, ID_ALICE, 2);
  await s.khr.connect(s.issuer).issue(s.alice.address, 1_000_000_00);

  const tokenHome = await ethers.deployContract("MockTokenTransferrer", [s.khr.target]);
  const ictt = await ethers.deployContract("ICTTBridgeAdapter", [
    s.khr.target,
    tokenHome.target,
    s.council.address,
  ]);
  await ictt.connect(s.council).setGateway(s.gateway.target);
  await ictt.connect(s.council).setRoute(DEST_CHAIN, FUJI_C_BLOCKCHAIN_ID, REMOTE, GAS_LIMIT);

  // Neither the adapter nor the TokenHome has personal KYC — both are vetted system contracts.
  await s.khr.connect(s.council).setSystemContract(ictt.target, true);
  await s.khr.connect(s.council).setSystemContract(tokenHome.target, true);

  await s.gateway.connect(s.council).setTokenPolicy(s.khr.target, true, 2, 0, ictt.target);
  return { ...s, tokenHome, ictt };
}

describe("ICTTBridgeAdapter", function () {
  it("forwards an egress into the ICTT TokenHome with the configured route", async function () {
    const { gateway, khr, tokenHome, ictt, alice } = await loadFixture(suiteWithIctt);
    await khr.connect(alice).approve(gateway.target, 500_00);

    await expect(gateway.connect(alice).requestEgress(khr.target, 500_00, DEST_CHAIN, RECIPIENT))
      .to.emit(ictt, "BridgeSend")
      .withArgs(khr.target, 500_00, DEST_CHAIN, ethers.getAddress(RECIPIENT), alice.address);

    // Tokens ended up locked in the TokenHome, not stranded in the adapter.
    expect(await khr.balanceOf(tokenHome.target)).to.equal(500_00);
    expect(await khr.balanceOf(ictt.target)).to.equal(0);

    const input = await tokenHome.lastInput();
    expect(input.destinationBlockchainID).to.equal(FUJI_C_BLOCKCHAIN_ID);
    expect(input.destinationTokenTransferrerAddress).to.equal(ethers.getAddress(REMOTE));
    expect(input.recipient).to.equal(ethers.getAddress(RECIPIENT));
    expect(input.requiredGasLimit).to.equal(GAS_LIMIT);
    expect(input.primaryFee).to.equal(0);
    expect(await tokenHome.lastAmount()).to.equal(500_00);
  });

  it("rejects destinations without a configured route", async function () {
    const { gateway, khr, ictt, alice } = await loadFixture(suiteWithIctt);
    const unknownChain = ethers.id("ethereum-mainnet");
    await khr.connect(alice).approve(gateway.target, 100);

    await expect(
      gateway.connect(alice).requestEgress(khr.target, 100, unknownChain, RECIPIENT)
    ).to.be.revertedWithCustomError(ictt, "RouteNotConfigured");
  });

  it("rejects malformed recipients and callers other than the gateway", async function () {
    const { gateway, khr, ictt, alice } = await loadFixture(suiteWithIctt);
    await khr.connect(alice).approve(gateway.target, 100);

    await expect(
      gateway.connect(alice).requestEgress(khr.target, 100, DEST_CHAIN, "0x1234")
    ).to.be.revertedWithCustomError(ictt, "BadRecipient");

    await expect(
      ictt.connect(alice).bridge(khr.target, 100, DEST_CHAIN, RECIPIENT, alice.address)
    ).to.be.revertedWithCustomError(ictt, "OnlyGateway");
  });

  it("only the council owner can configure routes and the gateway", async function () {
    const { ictt, alice } = await loadFixture(suiteWithIctt);
    await expect(
      ictt.connect(alice).setRoute(DEST_CHAIN, FUJI_C_BLOCKCHAIN_ID, REMOTE, GAS_LIMIT)
    ).to.be.revertedWithCustomError(ictt, "OwnableUnauthorizedAccount");
    await expect(ictt.connect(alice).setGateway(alice.address)).to.be.revertedWithCustomError(
      ictt,
      "OwnableUnauthorizedAccount"
    );
  });
});
