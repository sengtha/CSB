const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySuite, ID_ALICE, ID_BOB } = require("./fixtures");

/**
 * Does an UNMODIFIED DeFi protocol run against CSB's compliance-gated token?
 *
 * This is the experiment behind design principle P2 — "identity is enforced
 * below the contract layer, so standard DeFi contracts deploy unmodified". That
 * claim is easy to state and was, until this file, untested.
 *
 * "Unmodified" is meant literally. The Uniswap V2 factory, pair and router
 * bytecode here comes from the published npm artifacts (@uniswap/v2-core,
 * @uniswap/v2-periphery) with no recompilation and no source changes. The pair
 * init-code hash of the published core matches the value hardcoded in the
 * published router, so the two halves are the genuine upstream pair rather than
 * a locally rebuilt approximation.
 *
 * These tests record what actually happens, including the parts that are
 * awkward for the design. Three findings, in order of how much they matter:
 *
 *   1. Uniswap deploys and runs. No source change is needed.
 *   2. The pair contract must be marked a KHRt system contract, and it cannot be
 *      marked before it exists. createPair() succeeds because it moves no
 *      tokens; the first transfer into the pair reverts. The whitelist step
 *      therefore has to happen between pool creation and first use — a window in
 *      which an ordinary DeFi front-end would simply appear broken.
 *   3. LP TOKENS ESCAPE THE PERIMETER. UniswapV2ERC20 has no compliance hooks,
 *      so a pool share — a transferable claim on pooled KHRt — moves freely to
 *      an address with no KYC. Redemption is still blocked, but the claim
 *      circulates. Base-layer transaction gating does not reach this: on the
 *      real chain the recipient would need to be on txAllowList, but that is a
 *      much weaker condition than holding an active KYC attestation, and any
 *      allowlisted address can hold the claim regardless of tier or freeze
 *      status.
 *
 * Finding 3 is the substantive result. An unmodified AMM turns a
 * compliance-gated asset into an unrestricted derivative of itself.
 */
const FACTORY = require("@uniswap/v2-core/build/UniswapV2Factory.json");
const PAIR = require("@uniswap/v2-core/build/UniswapV2Pair.json");
const ERC20 = require("@uniswap/v2-core/build/ERC20.json");

const hex = (b) => (b.startsWith("0x") ? b : "0x" + b);

/** Deploy from a published artifact, exactly as shipped. */
async function deployUpstream(artifact, args, signer) {
  const f = new ethers.ContractFactory(artifact.abi, hex(artifact.bytecode), signer);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c;
}

async function ammFixture() {
  const s = await deploySuite();
  await s.identity.connect(s.idAuthority).register(s.alice.address, ID_ALICE, 2);
  await s.identity.connect(s.idAuthority).register(s.bob.address, ID_BOB, 2);

  // Uniswap V2, straight from the published artifacts.
  const factory = await deployUpstream(FACTORY, [s.council.address], s.council);

  // A plain, compliance-free ERC20 to pair against — this stands in for any
  // ordinary token on the chain, and isolates KHRt's rules as the only variable.
  const plain = await deployUpstream(ERC20, [ethers.parseEther("1000000")], s.alice);

  await s.khr.connect(s.issuer).issue(s.alice.address, 1_000_000_00);
  return { ...s, factory, plain };
}

describe("Unmodified Uniswap V2 against a compliance-gated token", function () {
  it("finding 1: the published factory and pair bytecode deploy unchanged", async function () {
    const { factory } = await loadFixture(ammFixture);
    expect(await factory.getAddress()).to.be.properAddress;

    // The published core's pair init code is exactly what the published router
    // expects. If this ever drifts, the router computes the wrong pair address
    // and every route silently fails.
    expect(ethers.keccak256(hex(PAIR.bytecode))).to.equal(
      "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f"
    );
  });

  it("finding 2: createPair succeeds, but the pool cannot receive KHRt until whitelisted", async function () {
    const { factory, khr, plain, alice, council } = await loadFixture(ammFixture);

    // Creating the pool moves no tokens, so nothing checks compliance.
    await factory.createPair(khr.target, plain.target);
    const pairAddr = await factory.getPair(khr.target, plain.target);
    expect(pairAddr).to.not.equal(ethers.ZeroAddress);

    // The pool exists and is a perfectly ordinary contract — and it cannot hold
    // KHRt, because it holds no KYC attestation.
    await expect(
      khr.connect(alice).transfer(pairAddr, 1000_00)
    ).to.be.revertedWithCustomError(khr, "NotKycActive");

    // The council marks it a system contract. Note this is only possible AFTER
    // creation: the address is determined by CREATE2 at createPair() time.
    await khr.connect(council).setSystemContract(pairAddr, true);
    await khr.connect(alice).transfer(pairAddr, 1000_00);
    expect(await khr.balanceOf(pairAddr)).to.equal(1000_00);
  });

  it("provides liquidity and swaps once the pool is a system contract", async function () {
    const { factory, khr, plain, alice, bob, council } = await loadFixture(ammFixture);

    await factory.createPair(khr.target, plain.target);
    const pairAddr = await factory.getPair(khr.target, plain.target);
    await khr.connect(council).setSystemContract(pairAddr, true);
    const pair = new ethers.Contract(pairAddr, PAIR.abi, alice);

    // Add liquidity the low-level way: transfer both sides in, then mint.
    await khr.connect(alice).transfer(pairAddr, 100_000_00);
    await plain.connect(alice).transfer(pairAddr, ethers.parseEther("100000"));
    await pair.mint(alice.address);
    expect(await pair.balanceOf(alice.address)).to.be.greaterThan(0n);

    // Swap plain -> KHRt, out to a KYC'd recipient.
    const before = await khr.balanceOf(bob.address);
    await plain.connect(alice).transfer(pairAddr, ethers.parseEther("1000"));
    const token0 = await pair.token0();
    const khrIsToken0 = token0.toLowerCase() === khr.target.toLowerCase();
    const out = 900_00n; // conservative, well inside the curve
    await pair.swap(khrIsToken0 ? out : 0n, khrIsToken0 ? 0n : out, bob.address, "0x");

    expect(await khr.balanceOf(bob.address)).to.equal(before + out);
  });

  it("compliance holds at the pool edge: a swap out to a non-KYC'd address reverts", async function () {
    const { factory, khr, plain, alice, outsider, council } = await loadFixture(ammFixture);

    await factory.createPair(khr.target, plain.target);
    const pairAddr = await factory.getPair(khr.target, plain.target);
    await khr.connect(council).setSystemContract(pairAddr, true);
    const pair = new ethers.Contract(pairAddr, PAIR.abi, alice);

    await khr.connect(alice).transfer(pairAddr, 100_000_00);
    await plain.connect(alice).transfer(pairAddr, ethers.parseEther("100000"));
    await pair.mint(alice.address);

    await plain.connect(alice).transfer(pairAddr, ethers.parseEther("1000"));
    const khrIsToken0 = (await pair.token0()).toLowerCase() === khr.target.toLowerCase();

    // The AMM knows nothing about KYC. KHRt's own transfer hook stops it.
    await expect(
      pair.swap(khrIsToken0 ? 900_00n : 0n, khrIsToken0 ? 0n : 900_00n, outsider.address, "0x")
    ).to.be.reverted;
  });

  it("FINDING 3: LP tokens are a claim on pooled KHRt and move to non-KYC'd addresses freely", async function () {
    const { factory, khr, plain, alice, outsider, council } = await loadFixture(ammFixture);

    await factory.createPair(khr.target, plain.target);
    const pairAddr = await factory.getPair(khr.target, plain.target);
    await khr.connect(council).setSystemContract(pairAddr, true);
    const pair = new ethers.Contract(pairAddr, PAIR.abi, alice);

    await khr.connect(alice).transfer(pairAddr, 100_000_00);
    await plain.connect(alice).transfer(pairAddr, ethers.parseEther("100000"));
    await pair.mint(alice.address);

    const lp = await pair.balanceOf(alice.address);
    expect(lp).to.be.greaterThan(0n);

    // outsider holds NO KYC attestation and could not receive one riel of KHRt.
    expect(await khr.balanceOf(outsider.address)).to.equal(0n);
    await expect(khr.connect(alice).transfer(outsider.address, 1))
      .to.be.revertedWithCustomError(khr, "NotKycActive");

    // But the pool share transfers without objection: UniswapV2ERC20 has no
    // compliance hook, and nothing in the base layer reaches inside a token
    // that was never told about the identity registry.
    await pair.transfer(outsider.address, lp / 2n);
    expect(await pair.balanceOf(outsider.address)).to.equal(lp / 2n);

    // The perimeter still holds at redemption: burning to a non-KYC'd address
    // fails, because that is a KHRt transfer.
    const outsiderPair = pair.connect(outsider);
    await outsiderPair.transfer(pairAddr, lp / 4n);
    await expect(outsiderPair.burn(outsider.address)).to.be.reverted;

    // So the claim circulates outside the KYC perimeter even though the asset
    // cannot leave it. An unmodified AMM has produced an unrestricted
    // derivative of a restricted asset.
  });
});
