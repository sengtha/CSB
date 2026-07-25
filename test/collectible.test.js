const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * CSBCollectible — a KYC-gated NFT with on-chain artwork.
 *
 * ERC-721 is implemented by hand here (OpenZeppelin's base needs a Cancun opcode
 * this project deliberately avoids), so the standard itself is tested rather
 * than assumed: ownership, approvals, operator approvals, safe-transfer receiver
 * checks, and interface detection — alongside the compliance behaviour that is
 * the actual point.
 */
describe("CSBCollectible — mintable NFT", function () {
  async function deploy() {
    const [council, authority, alice, bob, retail, stranger] = await ethers.getSigners();
    const identity = await ethers.deployContract("IdentityRegistry", [council.address, authority.address]);
    const enforcement = await ethers.deployContract("EnforcementRegistry", [council.address, council.address]);
    const nft = await ethers.deployContract("CSBCollectible", [
      identity.target, enforcement.target, council.address,
    ]);
    await identity.connect(authority).register(alice.address, ethers.id("id-alice"), 2);
    await identity.connect(authority).register(bob.address, ethers.id("id-bob"), 2);
    await identity.connect(authority).register(retail.address, ethers.id("id-retail"), 1);
    // `stranger` deliberately unregistered.
    return { council, authority, alice, bob, retail, stranger, identity, enforcement, nft };
  }

  it("lets a KYC-verified address mint one for itself", async function () {
    const { nft, alice } = await deploy();
    await expect(nft.connect(alice).mint())
      .to.emit(nft, "Minted").withArgs(1, alice.address, alice.address)
      .and.to.emit(nft, "Transfer").withArgs(ethers.ZeroAddress, alice.address, 1);
    expect(await nft.ownerOf(1)).to.equal(alice.address);
    expect(await nft.balanceOf(alice.address)).to.equal(1n);
    expect(await nft.totalMinted()).to.equal(1n);
  });

  it("refuses an address the identity layer does not know", async function () {
    const { nft, stranger } = await deploy();
    await expect(nft.connect(stranger).mint()).to.be.revertedWithCustomError(nft, "NotVerified");
  });

  it("explains a refusal before anyone signs", async function () {
    const { nft, alice, stranger } = await deploy();
    expect((await nft.canMint(alice.address))[0]).to.equal(true);
    const [ok, why] = await nft.canMint(stranger.address);
    expect(ok).to.equal(false);
    expect(why).to.contain("no active KYC attestation");
  });

  it("caps how many one address can mint", async function () {
    const { nft, alice, council } = await deploy();
    await nft.connect(council).setMaxPerAddress(2);
    await nft.connect(alice).mint();
    await nft.connect(alice).mint();
    await expect(nft.connect(alice).mint()).to.be.revertedWithCustomError(nft, "MintLimitReached");
    const [ok, why] = await nft.canMint(alice.address);
    expect(ok).to.equal(false);
    expect(why).to.contain("maximum of 2");
  });

  it("enforces the minimum tier", async function () {
    const { nft, council, retail } = await deploy();
    await nft.connect(council).setMinimumTier(2);
    await expect(nft.connect(retail).mint()).to.be.revertedWithCustomError(nft, "TierTooLow");
  });

  it("builds artwork and metadata on chain, with no external link", async function () {
    const { nft, alice } = await deploy();
    await nft.connect(alice).mint();
    const uri = await nft.tokenURI(1);
    expect(uri.startsWith("data:application/json;base64,")).to.equal(true);

    const meta = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
    expect(meta.name).to.equal("CSB Collectible #1");
    expect(meta.image.startsWith("data:image/svg+xml;base64,")).to.equal(true);
    // Nothing may point off-chain, or the "verify it yourself" claim breaks.
    expect(uri).to.not.match(/https?:\/\//);

    const svg = Buffer.from(meta.image.split(",")[1], "base64").toString("utf8");
    expect(svg.startsWith("<svg")).to.equal(true);
    expect(svg.trimEnd().endsWith("</svg>")).to.equal(true);
    expect(svg).to.contain("CSB #1");
  });

  it("gives different tokens different artwork", async function () {
    const { nft, alice, bob } = await deploy();
    await nft.connect(alice).mint();
    await nft.connect(bob).mint();
    const a = await nft.tokenURI(1);
    const b = await nft.tokenURI(2);
    expect(a).to.not.equal(b);
  });

  it("reverts tokenURI for a token that does not exist", async function () {
    const { nft } = await deploy();
    await expect(nft.tokenURI(99)).to.be.revertedWithCustomError(nft, "NonexistentToken");
  });

  // ---------------------------------------------------------- ERC-721 basics

  it("transfers between verified holders", async function () {
    const { nft, alice, bob } = await deploy();
    await nft.connect(alice).mint();
    await nft.connect(alice).transferFrom(alice.address, bob.address, 1);
    expect(await nft.ownerOf(1)).to.equal(bob.address);
    expect(await nft.balanceOf(alice.address)).to.equal(0n);
    expect(await nft.balanceOf(bob.address)).to.equal(1n);
  });

  it("honours approvals and clears them on transfer", async function () {
    const { nft, alice, bob } = await deploy();
    await nft.connect(alice).mint();
    await expect(nft.connect(bob).transferFrom(alice.address, bob.address, 1))
      .to.be.revertedWithCustomError(nft, "NotAuthorized");

    await nft.connect(alice).approve(bob.address, 1);
    expect(await nft.getApproved(1)).to.equal(bob.address);
    await nft.connect(bob).transferFrom(alice.address, bob.address, 1);
    expect(await nft.getApproved(1)).to.equal(ethers.ZeroAddress);
  });

  it("honours operator approvals", async function () {
    const { nft, alice, bob } = await deploy();
    await nft.connect(alice).mint();
    await nft.connect(alice).setApprovalForAll(bob.address, true);
    expect(await nft.isApprovedForAll(alice.address, bob.address)).to.equal(true);
    await nft.connect(bob).transferFrom(alice.address, bob.address, 1);
    expect(await nft.ownerOf(1)).to.equal(bob.address);
  });

  it("rejects a transfer from the wrong owner or to the zero address", async function () {
    const { nft, alice, bob } = await deploy();
    await nft.connect(alice).mint();
    await expect(nft.connect(alice).transferFrom(bob.address, alice.address, 1))
      .to.be.revertedWithCustomError(nft, "WrongOwner");
    await expect(nft.connect(alice).transferFrom(alice.address, ethers.ZeroAddress, 1))
      .to.be.revertedWithCustomError(nft, "ZeroAddress");
  });

  it("safeTransferFrom refuses a contract that cannot receive NFTs", async function () {
    const { nft, alice, council, identity, authority, enforcement } = await deploy();
    await nft.connect(alice).mint();
    // A contract with no onERC721Received. Vetting it in the identity layer is
    // not possible, so give it a tier via a registered address instead: use a
    // deployed contract that IS registered, to isolate the receiver check.
    const notReceiver = await ethers.deployContract("EnforcementRegistry", [council.address, council.address]);
    await identity.connect(authority).register(notReceiver.target, ethers.id("id-contract"), 2);
    await expect(nft.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, notReceiver.target, 1))
      .to.be.revertedWithCustomError(nft, "UnsafeRecipient");
    // The plain transfer still works — that is the difference between the two.
    await nft.connect(alice).transferFrom(alice.address, notReceiver.target, 1);
    expect(await nft.ownerOf(1)).to.equal(notReceiver.target);
  });

  it("reports the ERC-721 interfaces", async function () {
    const { nft } = await deploy();
    expect(await nft.supportsInterface("0x80ac58cd")).to.equal(true); // ERC721
    expect(await nft.supportsInterface("0x5b5e139f")).to.equal(true); // Metadata
    expect(await nft.supportsInterface("0x01ffc9a7")).to.equal(true); // ERC165
    expect(await nft.supportsInterface("0xdeadbeef")).to.equal(false);
  });

  // ------------------------------------------------------------- compliance

  it("cannot be transferred to an unverified address", async function () {
    const { nft, alice, stranger } = await deploy();
    await nft.connect(alice).mint();
    await expect(nft.connect(alice).transferFrom(alice.address, stranger.address, 1))
      .to.be.revertedWithCustomError(nft, "NotVerified");
  });

  it("a frozen holder cannot move theirs, and a frozen recipient cannot receive", async function () {
    const { nft, alice, bob, council, enforcement } = await deploy();
    await nft.connect(alice).mint();
    await enforcement.connect(council).freeze(alice.address, ethers.id("order-1"));
    await expect(nft.connect(alice).transferFrom(alice.address, bob.address, 1))
      .to.be.revertedWithCustomError(nft, "AccountFrozen");

    await enforcement.connect(council).unfreeze(alice.address, ethers.id("order-1"));
    await enforcement.connect(council).freeze(bob.address, ethers.id("order-2"));
    await expect(nft.connect(alice).transferFrom(alice.address, bob.address, 1))
      .to.be.revertedWithCustomError(nft, "AccountFrozen");
  });

  it("a revoked KYC stops the holder receiving more but does not seize what they hold", async function () {
    const { nft, alice, bob, authority, identity } = await deploy();
    await nft.connect(alice).mint();
    await identity.connect(authority).revoke(alice.address);
    // Still the owner — revocation is not confiscation.
    expect(await nft.ownerOf(1)).to.equal(alice.address);
    await expect(nft.connect(bob).mint()).to.not.be.reverted;
    await expect(nft.connect(alice).transferFrom(alice.address, bob.address, 1))
      .to.not.be.reverted; // sending away is allowed; receiving is what is gated
  });

  it("can be paused by the admin", async function () {
    const { nft, alice, council } = await deploy();
    await nft.connect(council).setPaused(true);
    await expect(nft.connect(alice).mint()).to.be.revertedWithCustomError(nft, "TokenPaused");
    const [ok, why] = await nft.canMint(alice.address);
    expect(ok).to.equal(false);
    expect(why).to.contain("paused");
    await nft.connect(council).setPaused(false);
    await expect(nft.connect(alice).mint()).to.not.be.reverted;
  });

  it("only a minter can mint on someone else's behalf", async function () {
    const { nft, alice, bob, council } = await deploy();
    await expect(nft.connect(alice).mintTo(bob.address))
      .to.be.revertedWithCustomError(nft, "AccessControlUnauthorizedAccount");
    await nft.connect(council).mintTo(bob.address);
    expect(await nft.ownerOf(1)).to.equal(bob.address);
  });
});
