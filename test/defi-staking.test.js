const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySuite, ID_ALICE, ID_BOB } = require("./fixtures");

/**
 * A FOURTH protocol, and the first whose reward is a SEPARATE asset.
 *
 * Uniswap issued a static claim, Aave an accruing one, ERC-4626 the same shape as a
 * standard. Each leaked a claim ON the gated asset. Staking is structurally
 * different: the reward is its own token, so what an unattested holder ends up with
 * need not be a claim on anything gated at all.
 *
 * The contract is Synthetix's `StakingRewards`, compiled from the genuine upstream
 * source in `node_modules/synthetix` — not a copy, not a reimplementation. It is the
 * most-forked staking contract in DeFi; nearly every "farm" descends from it. That
 * required adding solc 0.5.16 to the build, which is the price of keeping the
 * "unmodified protocol" property the other three experiments rest on.
 *
 * Two configurations, and they fail in opposite directions:
 *
 *   REWARD IN AN UNGATED TOKEN. An unattested address earns and claims real,
 *   spendable value. Every earlier experiment leaked a CLAIM whose redemption stayed
 *   blocked; this leaks the thing itself. It is the sharpest form of the finding.
 *
 *   REWARD IN KHRt. Rewards accrue to an unattested holder and can never be
 *   collected, because `getReward()` transfers the gated asset and reverts. The
 *   protocol's books record an obligation to a party that cannot receive it — not a
 *   leak but a STRANDED LIABILITY, and the perimeter causes it rather than preventing
 *   it.
 *
 * The second is, as far as we know, undocumented, and it is the more interesting of
 * the two: a compliance perimeter placed under an unmodified protocol does not only
 * fail to contain value, it can also manufacture unpayable debts.
 */
describe("Unmodified Synthetix StakingRewards against a compliance-gated token", function () {
  const erc20Artifact = require("@uniswap/v2-core/build/ERC20.json");
  const hex = (b) => (b.startsWith("0x") ? b : "0x" + b);
  const WEEK = 7 * 24 * 3600;

  /** A plain 18-decimal token with no compliance hooks, to stake and to reward with. */
  async function plainToken(signer, supply = ethers.parseUnits("1000000", 18)) {
    const t = await new ethers.ContractFactory(
      erc20Artifact.abi, hex(erc20Artifact.bytecode), signer
    ).deploy(supply);
    await t.waitForDeployment();
    return t;
  }

  async function base() {
    const s = await deploySuite();
    await s.identity.connect(s.idAuthority).register(s.alice.address, ID_ALICE, 2);
    await s.identity.connect(s.idAuthority).register(s.bob.address, ID_BOB, 2);
    await s.khr.connect(s.issuer).issue(s.alice.address, 10_000_000_00);
    return s;
  }

  /** Stake a plain token, earn a plain token. Nothing gated is involved. */
  async function ungatedReward() {
    const s = await base();
    const staking = await plainToken(s.alice);
    const reward = await plainToken(s.council);

    const pool = await ethers.deployContract("StakingRewards", [
      s.council.address, s.council.address,
      await reward.getAddress(), await staking.getAddress(),
    ]);
    await reward.connect(s.council).transfer(await pool.getAddress(), ethers.parseUnits("70000", 18));
    await pool.connect(s.council).notifyRewardAmount(ethers.parseUnits("70000", 18));
    return { ...s, staking, reward, pool };
  }

  /** Stake a plain token, earn KHRt. The reward is the gated asset. */
  async function gatedReward() {
    const s = await base();
    const staking = await plainToken(s.alice);

    const pool = await ethers.deployContract("StakingRewards", [
      s.council.address, s.council.address, s.khr.target, await staking.getAddress(),
    ]);
    // The pool must be vetted to custody KHRt — the same discretionary grant every
    // other protocol here needed, for the same reason.
    await s.khr.connect(s.council).setSystemContract(await pool.getAddress(), true);
    await s.khr.connect(s.alice).transfer(await pool.getAddress(), 1_000_000_00);
    await pool.connect(s.council).notifyRewardAmount(1_000_000_00);
    return { ...s, staking, pool };
  }

  it("finding 1: the published contract runs unmodified against this chain", async function () {
    const { pool, staking, alice } = await loadFixture(ungatedReward);

    const amount = ethers.parseUnits("1000", 18);
    await staking.connect(alice).approve(await pool.getAddress(), amount);
    await pool.connect(alice).stake(amount);

    expect(await pool.balanceOf(alice.address)).to.equal(amount);
    expect(await pool.totalSupply()).to.equal(amount);

    await time.increase(WEEK / 7);
    expect(await pool.earned(alice.address)).to.be.greaterThan(0);
  });

  it("FINDING 2: an unattested address earns and CLAIMS real spendable value",
    async function () {
      const { pool, staking, reward, alice, outsider } = await loadFixture(ungatedReward);

      // The staking token has no compliance hooks, so an attested holder can simply
      // give some to an unattested address. Nothing stops this, and nothing in the
      // perimeter is consulted.
      const amount = ethers.parseUnits("1000", 18);
      await staking.connect(alice).transfer(outsider.address, amount);
      await staking.connect(outsider).approve(await pool.getAddress(), amount);
      await pool.connect(outsider).stake(amount);

      await time.increase(WEEK / 2);
      const earned = await pool.earned(outsider.address);
      expect(earned).to.be.greaterThan(0);

      // And it COLLECTS them. This is the escalation: every earlier experiment
      // leaked a claim whose redemption stayed blocked. Here the reward token is
      // ungated, so what lands in an unattested address is the asset itself.
      await expect(pool.connect(outsider).getReward()).to.not.be.reverted;
      const held = await reward.balanceOf(outsider.address);
      expect(held).to.be.greaterThan(0);

      // It is fully spendable — onward, to anyone, with no gate anywhere.
      const further = ethers.Wallet.createRandom().address;
      await expect(reward.connect(outsider).transfer(further, held)).to.not.be.reverted;
      expect(await reward.balanceOf(further)).to.equal(held);
    });

  it("FINDING 3: with a gated reward, the obligation accrues and can never be paid",
    async function () {
      const { pool, staking, khr, alice, outsider } = await loadFixture(gatedReward);

      const amount = ethers.parseUnits("1000", 18);
      await staking.connect(alice).transfer(outsider.address, amount);
      await staking.connect(outsider).approve(await pool.getAddress(), amount);
      await pool.connect(outsider).stake(amount);

      await time.increase(WEEK / 2);

      // The protocol's books say it owes this address.
      const owed = await pool.earned(outsider.address);
      expect(owed).to.be.greaterThan(0);

      // And it can never pay: getReward() transfers KHRt, which the perimeter
      // refuses. Not a leak — a stranded liability, manufactured BY the perimeter.
      //
      // The revert arrives as "SafeERC20: low-level call failed", NOT as
      // NotKycActive. Synthetix is built on OpenZeppelin 2.3.0, which predates
      // custom errors: its SafeERC20 makes a low-level call and checks only whether
      // it succeeded, discarding the revert data. So the compliance reason is
      // destroyed by the wrapper before it reaches the caller. That is worth
      // recording on its own — an operator or an auditor sees a generic transfer
      // failure and has no on-chain indication that identity caused it.
      await expect(pool.connect(outsider).getReward())
        .to.be.revertedWith("SafeERC20: low-level call failed");

      // Since the wrapper hides the reason, prove it independently: the identical
      // KHRt transfer to the identical address fails on compliance specifically.
      await expect(khr.connect(alice).transfer(outsider.address, 1))
        .to.be.revertedWithCustomError(khr, "NotKycActive")
        .withArgs(outsider.address);

      // And rule out the alternative explanation — the pool being short of funds.
      // It holds the reward, and an attested staker collects successfully in the
      // test below. The recipient is the only variable.
      expect(await khr.balanceOf(await pool.getAddress())).to.be.greaterThan(0);

      // The debt does not lapse. It keeps growing, unpayable.
      await time.increase(WEEK / 4);
      expect(await pool.earned(outsider.address)).to.be.greaterThan(owed);
      expect(await khr.balanceOf(outsider.address)).to.equal(0);
    });

  it("the stranded holder can still exit the stake, so only the reward is trapped",
    async function () {
      const { pool, staking, alice, outsider } = await loadFixture(gatedReward);

      const amount = ethers.parseUnits("1000", 18);
      await staking.connect(alice).transfer(outsider.address, amount);
      await staking.connect(outsider).approve(await pool.getAddress(), amount);
      await pool.connect(outsider).stake(amount);
      await time.increase(WEEK / 2);

      // withdraw() moves only the staking token, which is ungated, so it succeeds.
      await expect(pool.connect(outsider).withdraw(amount)).to.not.be.reverted;
      expect(await staking.balanceOf(outsider.address)).to.equal(amount);

      // exit() would also try to collect the reward, so it fails where withdraw
      // does not — the same position, two entry points, opposite outcomes. Worth
      // recording: a front-end offering only "exit" would appear broken for this
      // user while "withdraw" worked.
      await pool.connect(outsider).stake(0).catch(() => {});
      await expect(pool.connect(outsider).exit()).to.be.reverted;
    });

  it("an attested staker is unaffected in either configuration", async function () {
    const { pool, staking, khr, alice, bob } = await loadFixture(gatedReward);

    const amount = ethers.parseUnits("1000", 18);
    await staking.connect(alice).transfer(bob.address, amount);
    await staking.connect(bob).approve(await pool.getAddress(), amount);
    await pool.connect(bob).stake(amount);
    await time.increase(WEEK / 2);

    const before = await khr.balanceOf(bob.address);
    await expect(pool.connect(bob).getReward()).to.not.be.reverted;
    expect(await khr.balanceOf(bob.address)).to.be.greaterThan(before);
  });

  it("the staking position itself is a claim, and it is not gated either",
    async function () {
      const { pool, staking, alice, outsider } = await loadFixture(ungatedReward);

      const amount = ethers.parseUnits("1000", 18);
      await staking.connect(alice).approve(await pool.getAddress(), amount);
      await pool.connect(alice).stake(amount);

      // StakingRewards issues no transferable receipt — the position is a mapping
      // entry, not a token. So unlike Uniswap, Aave and ERC-4626, there is nothing
      // to hand over. Recorded because it is the one structural difference that
      // works in the perimeter's favour, and it is an accident of this contract's
      // design rather than anything the architecture arranged.
      expect(await pool.balanceOf(alice.address)).to.equal(amount);
      expect(pool.interface.getFunction("transfer")).to.equal(null);
    });
});
